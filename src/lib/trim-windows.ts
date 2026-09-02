import { promises as fs } from "fs";
import { join, extname } from "path";
import { createPartFromUri, createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "./gemini";
import { GeminiTrimZ, geminiTrimResponseSchema } from "./recommendation-schema";
import { LIBRARY_DIR } from "./paths";


const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

export interface TrimTarget {
  shot_index: number;
  duration: number;
  description: string;
  camera_style: string;
}

// Upload one clip and let Gemini pick, for each shot the clip was
// recommended for, the best start moment. The window is then cut to exactly
// the shot's duration so the clip fits the shot slot.
export async function generateTrimWindows(
  ai: GoogleGenAI,
  filename: string,
  clipDuration: number | null,
  targets: TrimTarget[]
): Promise<{
  windows: Map<number, { start: number; end: number; note: string }>;
  usage: Record<string, unknown> | undefined;
}> {
  const clipPath = join(LIBRARY_DIR, filename);
  await fs.access(clipPath);
  const mimeType = MIME_TYPES[extname(filename).toLowerCase()] || "video/mp4";

  let uploadedName: string | undefined;
  try {
    const uploaded = await ai.files.upload({
      file: clipPath,
      config: { mimeType },
    });
    uploadedName = uploaded.name;

    let file = uploaded;
    const deadline = Date.now() + 120_000;
    while (file.state !== "ACTIVE") {
      if (file.state === "FAILED") {
        throw new Error("Gemini file processing failed");
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for Gemini file to become ACTIVE");
      }
      await new Promise((r) => setTimeout(r, 2000));
      file = await ai.files.get({ name: uploadedName! });
    }

    const prompt = `This raw footage clip${
      clipDuration != null ? ` (${clipDuration.toFixed(1)}s long)` : ""
    } will be trimmed to stand in for shots of a reference video. For EACH
target shot below, watch the clip and choose the single best START moment
within it: the window beginning there and lasting the shot's duration should
best match the shot's description and camera movement. Prefer moments where
the action is clean (no fumbling, good framing).

Return start_time as plain decimal seconds from the clip's start — NEVER
minutes or MM.SS notation. Include every shot_index exactly once. If the
clip is shorter than a shot's duration, return 0 for that shot.

TARGET SHOTS:
${JSON.stringify(targets, null, 1)}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([
        createPartFromUri(file.uri!, file.mimeType || mimeType),
        prompt,
      ]),
      config: {
        responseMimeType: "application/json",
        responseSchema: geminiTrimResponseSchema,
      },
    });

    const parsed = GeminiTrimZ.parse(JSON.parse(response.text ?? ""));
    const targetByIndex = new Map(targets.map((t) => [t.shot_index, t]));
    const windows = new Map<number, { start: number; end: number; note: string }>();

    for (const w of parsed.windows) {
      const target = targetByIndex.get(w.shot_index);
      if (!target) continue;
      let start = Math.max(0, w.start_time);
      // The window is exactly the shot's length (or the whole clip if shorter)
      const length =
        clipDuration != null
          ? Math.min(target.duration, clipDuration)
          : target.duration;
      if (clipDuration != null && start + length > clipDuration) {
        start = Math.max(0, clipDuration - length);
      }
      windows.set(w.shot_index, {
        start: Math.round(start * 10) / 10,
        end: Math.round((start + length) * 10) / 10,
        note: w.moment_note,
      });
    }

    return {
      windows,
      usage: response.usageMetadata as Record<string, unknown> | undefined,
    };
  } finally {
    if (uploadedName) {
      try {
        await ai.files.delete({ name: uploadedName });
      } catch (cleanupError) {
        console.error("Failed to delete Gemini file:", cleanupError);
      }
    }
  }
}
