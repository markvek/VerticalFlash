import { z } from "zod";
import { join } from "path";
import { Type } from "@google/genai";
import { GENERATED_DIR, libraryClipPath, sidecarPath } from "./paths";
export { GENERATED_DIR } from "./paths";

// Per-shot AI clip generation (Gemini Omni). Generated mp4s live outside the
// clip library on purpose: they are shot-shaped, single-purpose files, and
// the library folder feeds the matching catalog, the /library browser, and the
// batch analyzer — none of which should see them.

export function generationPath(videoId: string): string {
  return sidecarPath(videoId, "generation");
}

export function generatedClipDir(videoId: string): string {
  return join(GENERATED_DIR, videoId);
}

// Attempt files are named per shot so a generated clip can never be claimed
// by any other shot: gen_s<shot>_a<attempt>.mp4
export function generatedClipName(shot: number, attempt: number): string {
  return `gen_s${shot}_a${attempt}.mp4`;
}

const GENERATED_NAME = /^gen_s\d+_a\d+\.mp4$/;

export function isGeneratedClip(filename: string): boolean {
  return GENERATED_NAME.test(filename);
}

// The one seam the renderer needs: generated clips resolve into the
// per-video generated dir, everything else into the clip library.
export function resolveClipPath(videoId: string, filename: string): string {
  return isGeneratedClip(filename)
    ? join(generatedClipDir(videoId), filename)
    : libraryClipPath(filename);
}

export const GENERATION_KINDS = ["generate", "extend"] as const;

export const GenerationAttemptZ = z.object({
  // 1-based, per shot
  attempt: z.number(),
  kind: z.enum(GENERATION_KINDS),
  // The exact creative text sent (reference preamble excluded — it is
  // appended server-side at call time)
  prompt: z.string(),
  // extend: the library clip whose tail was continued; null for generate
  source_clip: z.string().nullable(),
  // Library filenames whose trimmed excerpts went along as character refs
  reference_files: z.array(z.string()),
  // Basename inside generated/<videoId>/; null when the attempt failed
  file: z.string().nullable(),
  // ffprobe of the output
  duration: z.number().nullable(),
  interaction_id: z.string().nullable(),
  status: z.enum(["ready", "failed"]),
  error: z.string().nullable(),
  // interaction.usage persisted verbatim for the cost readout
  usage: z.record(z.unknown()).optional(),
  // Billed seconds of generated video (= output duration when known)
  video_seconds: z.number().nullable(),
  model: z.string(),
  createdAt: z.string(),
});

export type GenerationAttempt = z.infer<typeof GenerationAttemptZ>;

export const ShotGenerationZ = z.object({
  shot_index: z.number(),
  // Current editable generation prompt for this shot
  prompt: z.string(),
  // "user" survives batch re-drafts (unless forced)
  prompt_source: z.enum(["gemini", "user"]),
  // "generating" is persisted before the Gemini call so a page refresh can
  // show in-flight state; entries older than ~15 min are treated as failed
  // (the server restarted mid-call)
  status: z.enum(["idle", "generating", "ready", "failed"]),
  startedAt: z.string().nullable().optional(),
  // Basename of the accepted attempt's file (also mirrored into the
  // recommendations file as a source:"generated" selection)
  accepted_file: z.string().nullable(),
  attempts: z.array(GenerationAttemptZ),
});

export type ShotGeneration = z.infer<typeof ShotGenerationZ>;

// Full stored sidecar: analysis/<videoId>.generation.json
export const ShotGenerationsZ = z.object({
  videoId: z.string(),
  updatedAt: z.string(),
  promptsGeneratedAt: z.string().nullable(),
  promptModel: z.string().nullable(),
  promptUsage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  // shot_index (as a string key) -> that shot's generation state; sparse
  shots: z.record(ShotGenerationZ),
});

export type ShotGenerations = z.infer<typeof ShotGenerationsZ>;

export function emptyGenerations(videoId: string): ShotGenerations {
  return {
    videoId,
    updatedAt: new Date().toISOString(),
    promptsGeneratedAt: null,
    promptModel: null,
    shots: {},
  };
}

// What the batch prompt-drafting text call returns
export const GeminiGenPromptsZ = z.object({
  prompts: z.array(
    z.object({
      shot_index: z.number(),
      prompt: z.string(),
    })
  ),
});

export type GeminiGenPrompts = z.infer<typeof GeminiGenPromptsZ>;

// Gemini structured-output schema — keep in sync with GeminiGenPromptsZ
export const geminiGenPromptsResponseSchema = {
  type: Type.OBJECT,
  required: ["prompts"],
  properties: {
    prompts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["shot_index", "prompt"],
        properties: {
          shot_index: {
            type: Type.NUMBER,
            description: "The shot's index, copied exactly from the input",
          },
          prompt: {
            type: Type.STRING,
            description:
              "A self-contained text-to-video generation prompt for this shot",
          },
        },
      },
    },
  },
};
