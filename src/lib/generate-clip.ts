import { promises as fs } from "fs";
import { execFileAsync } from "./ffmpeg";
import { CLIP_CATEGORY_IDS } from "./brand";
import { join, extname } from "path";
import type { GoogleGenAI } from "@google/genai";
import { GEMINI_VIDEO_MODEL } from "./gemini";
import { referencePreamble } from "./generation-prompts";
import {
  GENERATED_DIR,
  generatedClipDir,
  generatedClipName,
} from "./generation-schema";
import type { ClipLibrary } from "./library-schema";
import type { Analysis } from "./analysis-schema";
import { LIBRARY_DIR } from "./paths";

const REFS_DIR = join(GENERATED_DIR, ".refs");

// Omni limits: reference clips max 3 × 3s; extend input ≤10s
export const MAX_REFERENCE_CLIPS = 3;
export const REFERENCE_SECONDS = 3;
export const EXTEND_INPUT_SECONDS = 10;

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

function mimeFor(filename: string): string {
  return MIME_TYPES[extname(filename).toLowerCase()] || "video/mp4";
}

export async function probeDurationSeconds(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path,
    ]);
    const raw = parseFloat(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 10) / 10 : null;
  } catch {
    return null;
  }
}

// Shared Files-API upload + wait-until-ACTIVE (same loop as library-analyze
// and trim-windows, extracted for the generation calls)
export async function uploadFileActive(
  ai: GoogleGenAI,
  path: string,
  mimeType: string,
  activeDeadlineMs = 120_000
): Promise<{ name: string; uri: string; mimeType: string }> {
  const uploaded = await ai.files.upload({ file: path, config: { mimeType } });
  const name = uploaded.name!;
  let file = uploaded;
  const deadline = Date.now() + activeDeadlineMs;
  while (file.state !== "ACTIVE") {
    if (file.state === "FAILED") {
      throw new Error("Gemini file processing failed");
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for Gemini file to become ACTIVE");
    }
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name });
  }
  return { name, uri: file.uri!, mimeType: file.mimeType || mimeType };
}

type AnalysisShot = Analysis["shots"][number];

// day/night grouping, same collapse as the renderer's lighting logic
function toGroup(timeOfDay: string | null | undefined): "day" | "night" | null {
  switch (timeOfDay) {
    case "morning":
    case "midday":
    case "afternoon":
    case "golden_hour":
      return "day";
    case "night":
      return "night";
    default:
      return null;
  }
}

// Up to 3 library clips that actually show the product, to ride along as
// character references: product showcases first, matching lighting preferred
export function pickReferenceClips(
  library: ClipLibrary,
  shot: AnalysisShot
): string[] {
  const shotGroup = toGroup(shot.time_of_day);
  const candidates = library.videos.filter((v) => v.analysis?.product_present);
  const rank = (v: (typeof candidates)[number]): number => {
    let score = 0;
    if (v.analysis!.category === CLIP_CATEGORY_IDS.showcase) score += 2;
    const clipGroup = toGroup(v.analysis!.time_of_day);
    if (shotGroup && clipGroup === shotGroup) score += 1;
    return score;
  };
  return candidates
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, MAX_REFERENCE_CLIPS)
    .map((v) => v.filename);
}

// Cut the middle 3 seconds of each reference clip (Omni caps refs at 3s),
// cached so repeat generations don't re-encode
export async function prepareReferenceMedia(
  filenames: string[]
): Promise<string[]> {
  await fs.mkdir(REFS_DIR, { recursive: true });
  const out: string[] = [];
  for (const filename of filenames) {
    const src = join(LIBRARY_DIR, filename);
    const dst = join(REFS_DIR, `${filename}.3s.mp4`);
    try {
      await fs.access(dst);
      out.push(dst);
      continue;
    } catch {
      // not cached yet
    }
    try {
      const duration = (await probeDurationSeconds(src)) ?? REFERENCE_SECONDS;
      const start = Math.max(0, (duration - REFERENCE_SECONDS) / 2);
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss",
        start.toFixed(2),
        "-i",
        src,
        "-t",
        String(REFERENCE_SECONDS),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        dst,
      ]);
      out.push(dst);
    } catch (error) {
      console.error(`reference trim failed for ${filename}:`, error);
    }
  }
  return out;
}

export interface RunGenerationOptions {
  ai: GoogleGenAI;
  videoId: string;
  shotIndex: number;
  attempt: number;
  kind: "generate" | "extend";
  // The creative prompt (reference preamble is appended here)
  prompt: string;
  // Local paths of prepared ≤3s reference excerpts
  referencePaths?: string[];
  // extend: local path of the ≤10s source window
  sourceClipPath?: string;
  // Used by dry-run to size the placeholder
  targetSeconds: number;
}

export interface RunGenerationResult {
  file: string;
  duration: number | null;
  interactionId: string | null;
  usage?: Record<string, unknown>;
  videoSeconds: number | null;
}

// Total wall-clock budget for one generation, including queue time
const INTERACTION_DEADLINE_MS = 9 * 60 * 1000;

export async function runGeneration(
  opts: RunGenerationOptions
): Promise<RunGenerationResult> {
  const outDir = generatedClipDir(opts.videoId);
  await fs.mkdir(outDir, { recursive: true });
  const filename = generatedClipName(opts.shotIndex, opts.attempt);
  const outPath = join(outDir, filename);

  // Free end-to-end testing: synthesize a labeled test pattern instead of
  // calling the API
  if (process.env.GENAI_VIDEO_DRY_RUN === "1") {
    const seconds = Math.max(1, Math.ceil(opts.targetSeconds));
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=1080x1920:r=30:d=${seconds}`,
      "-vf",
      `drawtext=text='GEN shot ${opts.shotIndex} (${opts.kind})':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.6`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ]);
    return {
      file: filename,
      duration: await probeDurationSeconds(outPath),
      interactionId: `dry-run-${opts.shotIndex}-${opts.attempt}`,
      videoSeconds: null,
    };
  }

  const { ai } = opts;
  const uploadedNames: string[] = [];
  try {
    // Extend source first (it must precede refs so <VIDEO_REF_N> indexes in
    // the preamble line up with the reference blocks we describe). The SDK
    // doesn't export its VideoContent input type, so shape it structurally.
    const blocks: Array<{ type: "video"; uri: string; mime_type: string }> = [];
    if (opts.kind === "extend") {
      if (!opts.sourceClipPath) {
        throw new Error("extend requires a source clip");
      }
      const up = await uploadFileActive(ai, opts.sourceClipPath, "video/mp4");
      uploadedNames.push(up.name);
      blocks.push({ type: "video", uri: up.uri, mime_type: up.mimeType });
    }
    const refPaths = opts.kind === "generate" ? opts.referencePaths ?? [] : [];
    for (const path of refPaths) {
      const up = await uploadFileActive(ai, path, mimeFor(path));
      uploadedNames.push(up.name);
      blocks.push({ type: "video", uri: up.uri, mime_type: up.mimeType });
    }

    const promptText =
      opts.kind === "generate"
        ? opts.prompt + referencePreamble(refPaths.length)
        : opts.prompt;

    let interaction = await ai.interactions.create({
      model: GEMINI_VIDEO_MODEL,
      input: [{ type: "text", text: promptText }, ...blocks],
      response_format: {
        type: "video",
        aspect_ratio: "9:16",
        delivery: "uri",
        // The installed SDK's VideoResponseFormat doesn't type `resolution`
        // yet; the API accepts it (360p/720p/1080p/4k)
        resolution: "1080p",
      } as never,
      generation_config: {
        video_config: {
          task:
            opts.kind === "extend"
              ? "extend"
              : refPaths.length
                ? "reference_to_video"
                : "text_to_video",
        },
      },
    });

    // create usually returns a terminal interaction, but poll if queued
    const deadline = Date.now() + INTERACTION_DEADLINE_MS;
    while (
      interaction.status === "queued" ||
      interaction.status === "in_progress"
    ) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for video generation");
      }
      await new Promise((r) => setTimeout(r, 5000));
      interaction = await ai.interactions.get(interaction.id);
    }

    if (interaction.status !== "completed") {
      const detail = (interaction.errors ?? [])
        .map((e) => (typeof e === "object" ? JSON.stringify(e) : String(e)))
        .join("; ");
      throw new Error(
        `Video generation ${interaction.status}${detail ? `: ${detail}` : ""}`
      );
    }

    const video = interaction.output_video;
    if (!video?.uri && !video?.data) {
      throw new Error("Generation completed but returned no video");
    }

    if (video.uri) {
      // URI delivery: wait for the generated file to finish processing,
      // then download it
      const match = video.uri.match(/files\/([\w-]+)/);
      const name = match ? `files/${match[1]}` : video.uri;
      const fileDeadline = Date.now() + 120_000;
      for (;;) {
        const info = await ai.files.get({ name });
        if (info.state === "ACTIVE") break;
        if (info.state === "FAILED") {
          throw new Error("Generated video failed processing");
        }
        if (Date.now() > fileDeadline) {
          throw new Error("Timed out waiting for the generated video file");
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      await ai.files.download({ file: name, downloadPath: outPath });
    } else {
      await fs.writeFile(outPath, Buffer.from(video.data!, "base64"));
    }

    const duration = await probeDurationSeconds(outPath);
    const usage = interaction.usage
      ? (JSON.parse(JSON.stringify(interaction.usage)) as Record<
          string,
          unknown
        >)
      : undefined;

    return {
      file: filename,
      duration,
      interactionId: interaction.id ?? null,
      usage,
      videoSeconds: duration,
    };
  } finally {
    for (const name of uploadedNames) {
      try {
        await ai.files.delete({ name });
      } catch (cleanupError) {
        console.error("Failed to delete Gemini file:", cleanupError);
      }
    }
  }
}
