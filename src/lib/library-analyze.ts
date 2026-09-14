import { clipTags } from "./library-metadata";
import { extname } from "path";
import { createPartFromUri, createUserContent } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { getGeminiClient, GEMINI_MODEL } from "./gemini";
import { getBrandConfig } from "./config";
import { execFileAsync } from "./ffmpeg";
import type { BrandConfig } from "./brand";
import {
  buildClipResponseSchema,
  ClipGeminiAnalysisZ,
  VIDEO_MIME_TYPES,
  type ClipGeminiAnalysis,
  type LibraryClip,
} from "./library-schema";
import { findLibraryFile, loadLibrary, saveLibrary, withLibraryEdit } from "./library-store";

export { classifyGeminiError, type GeminiErrorKind } from "./gemini";
export { findLibraryFile, loadLibrary } from "./library-store";

// Real capture date + duration from the file's embedded metadata
async function probeVideo(
  videoPath: string
): Promise<{ creationTime: string | null; duration: number | null }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:format_tags=creation_time",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(stdout);
  const rawCreation = parsed?.format?.tags?.creation_time;
  const rawDuration = parseFloat(parsed?.format?.duration);

  let creationTime: string | null = null;
  if (rawCreation) {
    const d = new Date(rawCreation);
    if (!Number.isNaN(d.getTime())) creationTime = d.toISOString();
  }

  return {
    creationTime,
    duration: Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration * 10) / 10
      : null,
  };
}

function buildPrompt(brand: BrandConfig): string {
  const categoryLines = brand.categories
    .map((c) => `"${c.id}" (${c.description})`)
    .join(", ");

  return `You are cataloging a raw video clip for "${brand.name}" — a brand whose product
is ${brand.product.description}. Watch the ENTIRE clip (video + audio) and return
JSON matching the provided schema:

- location: where the clip was shot — "interior" (inside a car/building),
  "exterior" (outdoors), "mixed" if both, "unclear" if you can't tell.
- product_present: ${brand.product.presenceRule}.
- product_note: if present, one short sentence on where/how ${brand.product.shortName}
  appears. Empty string if absent.
- time_of_day: judge from lighting — "morning", "midday", "afternoon",
  "golden_hour", "night", "indoor_lighting" (artificial light, can't judge),
  or "unclear".
- camera_action: dominant camera movement — "static", "handheld", "pan",
  "zoom", "pov", "screen_recording", or "other".
- category: what kind of footage this is — ${categoryLines}.
- spoken_text: verbatim transcript of ANY words spoken in the clip.
  Empty string if nothing is said (silence or music only).
- description: 1-2 sentences of what the clip shows.
- suggested_tags: 6-10 short lowercase tags. ALWAYS include 1-2 tags
  describing the camera movement/technique — be specific about direction
  and motion (e.g. "zoom in", "zoom out", "pan left", "pan right",
  "tilt up", "stable shot", "handheld", "tracking shot", "whip pan",
  "slow push in"). The rest cover content, objects, setting, action
  (e.g. "dashboard", "desert road", "packing", "night drive").

Transcribe speech exactly as heard. Do not invent content — use "unclear"
enums and empty strings when you cannot tell.`;
}

async function generateAnalysis(
  ai: GoogleGenAI,
  fileUri: string,
  mimeType: string
): Promise<{
  analysis: ClipGeminiAnalysis;
  usage?: Record<string, unknown>;
}> {
  const brand = getBrandConfig();
  const basePrompt = buildPrompt(brand);
  const responseSchema = buildClipResponseSchema(brand);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: Your previous response was rejected (${
            lastError instanceof Error ? lastError.message : "invalid JSON"
          }). Return ONLY valid JSON matching the provided schema.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([
        createPartFromUri(fileUri, mimeType),
        prompt,
      ]),
      config: {
        responseMimeType: "application/json",
        responseSchema,
      },
    });

    const rawText = response.text ?? "";
    try {
      const analysis = ClipGeminiAnalysisZ.parse(JSON.parse(rawText));
      const usage = response.usageMetadata
        ? (JSON.parse(
            JSON.stringify(response.usageMetadata)
          ) as Record<string, unknown>)
        : undefined;
      return { analysis, usage };
    } catch (error) {
      lastError = error;
      console.error(
        `Clip analysis response failed validation (attempt ${attempt + 1}):`,
        error,
        "\nraw:",
        rawText.slice(0, 2000)
      );
    }
  }

  throw new Error(
    `Gemini returned an invalid analysis after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export interface AnalyzeResult {
  updated: LibraryClip;
  usage?: Record<string, unknown>;
}

export async function analyzeLibraryClip(
  filename: string,
  opts?: { activeDeadlineMs?: number }
): Promise<AnalyzeResult> {
  const videoPath = await findLibraryFile(filename);
  if (!videoPath) {
    throw new Error(`Video file not found: ${filename}`);
  }

  const ai = getGeminiClient();
  let uploadedName: string | undefined;
  try {
    // Exact capture date + duration come from the file itself, not Gemini
    const { creationTime, duration } = await probeVideo(videoPath);

    const mimeType =
      VIDEO_MIME_TYPES[extname(filename).toLowerCase()] || "video/mp4";

    const uploaded = await ai.files.upload({
      file: videoPath,
      config: { mimeType },
    });
    uploadedName = uploaded.name;

    let file = uploaded;
    const deadline = Date.now() + (opts?.activeDeadlineMs ?? 120_000);
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

    const { analysis, usage } = await generateAnalysis(
      ai,
      file.uri!,
      file.mimeType || mimeType
    );

    return await withLibraryEdit(async () => {
      // Auto-save: merge into .metadata.json (user tags are kept, deduped)
      const library = await loadLibrary();
      const now = new Date().toISOString();
      const existingIndex = library.videos.findIndex(
        (v) => v.filename === filename
      );
      const existing: LibraryClip | undefined =
        existingIndex !== -1 ? library.videos[existingIndex] : undefined;

      const mergedTags = clipTags({ ...existing, analysis } as LibraryClip);

      const updated: LibraryClip = {
        filename,
        createdAt: existing?.createdAt || now,
        source: existing?.source ?? null,
        // ffprobe wins only when the user hasn't set a value
        date: existing?.date !== undefined ? existing.date : creationTime,
        duration: existing?.duration ?? duration,
        description: existing?.description,
        rejected_tags: existing?.rejected_tags,
        tags: mergedTags,
        analysis: {
          ...analysis,
          analyzedAt: now,
          model: GEMINI_MODEL,
          ...(usage ? { usage } : {}),
        },
        updatedAt: now,
      };

      if (existingIndex !== -1) {
        library.videos[existingIndex] = updated;
      } else {
        library.videos.push(updated);
      }
      library.lastUpdated = now;

      await saveLibrary(library);

      return { updated, usage };
    });
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
