import { z } from "zod";
import { Type } from "@google/genai";

// Shared with the clip library schema (library-schema.ts imports from here —
// keep this module free of imports from it to avoid a require cycle)
export const TIME_OF_DAY = [
  "morning",
  "midday",
  "afternoon",
  "golden_hour",
  "night",
  "indoor_lighting",
  "unclear",
] as const;

export const CAMERA_STYLES = [
  "static",
  "handheld",
  "pan",
  "zoom",
  "pov",
  "screen_recording",
  "other",
] as const;

export const VIDEO_FORMATS = [
  "pov",
  "reveal",
  "transformation",
  "storytime",
  "haul",
  "tutorial",
  "skit",
  "reaction",
  "montage",
  "other",
] as const;

export const MUSIC_USAGES = [
  "background_music",
  "trending_sound_lipsync",
  "voiceover_over_music",
  "original_audio_talking",
  "sound_effect_driven",
] as const;

// What the model returns (server-side fields added afterwards)
export const GeminiAnalysisZ = z.object({
  summary: z.string(),
  hook_description: z.string(),
  format: z.enum(VIDEO_FORMATS),
  tags: z.array(z.string()).min(1),
  music_usage: z.enum(MUSIC_USAGES),
  music_usage_note: z.string(),
  full_transcript: z.string(),
  shots: z
    .array(
      z.object({
        start_time: z.number(),
        end_time: z.number(),
        description: z.string(),
        on_screen_text: z.string(),
        spoken_text: z.string(),
        camera_style: z.enum(CAMERA_STYLES),
        // Same enum as library clips so renders can match lighting
        time_of_day: z.enum(TIME_OF_DAY),
        tags: z.array(z.string()),
      })
    )
    .min(1)
    .max(15),
});

export type GeminiAnalysis = z.infer<typeof GeminiAnalysisZ>;

// Gemini structured-output schema — keep in sync with GeminiAnalysisZ
export const geminiResponseSchema = {
  type: Type.OBJECT,
  required: [
    "summary",
    "hook_description",
    "format",
    "tags",
    "music_usage",
    "music_usage_note",
    "full_transcript",
    "shots",
  ],
  properties: {
    summary: { type: Type.STRING },
    hook_description: { type: Type.STRING },
    format: { type: Type.STRING, enum: [...VIDEO_FORMATS] },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    music_usage: { type: Type.STRING, enum: [...MUSIC_USAGES] },
    music_usage_note: { type: Type.STRING },
    full_transcript: { type: Type.STRING },
    shots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "start_time",
          "end_time",
          "description",
          "on_screen_text",
          "spoken_text",
          "camera_style",
          "time_of_day",
          "tags",
        ],
        properties: {
          start_time: {
            type: Type.NUMBER,
            description:
              "Shot start in plain decimal SECONDS from video start (e.g. 12.5 = twelve and a half seconds). NEVER minutes or MM.SS notation.",
          },
          end_time: {
            type: Type.NUMBER,
            description:
              "Shot end in plain decimal SECONDS from video start. NEVER minutes or MM.SS notation.",
          },
          description: { type: Type.STRING },
          on_screen_text: { type: Type.STRING },
          spoken_text: { type: Type.STRING },
          camera_style: { type: Type.STRING, enum: [...CAMERA_STYLES] },
          time_of_day: {
            type: Type.STRING,
            enum: [...TIME_OF_DAY],
            description:
              "Judge from lighting: morning, midday, afternoon, golden_hour, night, indoor_lighting (artificial light, can't judge), or unclear",
          },
          tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "4-8 short lowercase tags for THIS shot: 1-2 camera movement/technique tags (e.g. 'pan left', 'zoom in', 'stable shot', 'handheld') plus content/object/action tags (e.g. 'steering wheel cover', 'pink', 'hand held product', 'store shelf')",
          },
        },
      },
    },
  },
};

// Full stored analysis (spec §5): model output + server-side fields
export const AnalysisZ = z.object({
  videoId: z.string(),
  analyzedAt: z.string(),
  model: z.string(),
  summary: z.string(),
  hook_description: z.string(),
  format: z.string(),
  tags: z.array(z.string()),
  music: z.object({
    title: z.string(),
    author: z.string(),
    usage: z.string(),
    usage_note: z.string(),
  }),
  full_transcript: z.string(),
  shots: z.array(
    z.object({
      id: z.string().optional(),
      index: z.number(),
      start_time: z.number(),
      end_time: z.number(),
      description: z.string(),
      on_screen_text: z.string(),
      spoken_text: z.string(),
      camera_style: z.string(),
      // Optional: analyses saved before this field existed lack it
      time_of_day: z.string().optional(),
      // Optional: analyses saved before per-shot tags existed lack this
      tags: z.array(z.string()).optional(),
      screenshot: z.string(),
      // Storyboard cutdowns: where this shot's footage lives in the
      // storyboard's source timeline (the master, or an attached clip named
      // by source_clip). The render cuts from there, so a length change is
      // just these numbers — the short mp4 is only a preview.
      source_start: z.number().optional(),
      source_end: z.number().optional(),
      source_clip: z.string().optional(),
    })
  ),
  // Set when shot times are edited on the timeline; a render older than
  // this is stale
  shotsEditedAt: z.string().optional(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  // Set by the secondary shot tag pass (round 2); absent until it runs.
  // Kept separate from `usage` so the round-1 cost readout stays truthful.
  taggedAt: z.string().optional(),
  tagModel: z.string().optional(),
  tagUsage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
}).transform(withShotIds);

// Legacy IDs are deterministic and remain stable when a shot moves or trims.
export function withShotIds<T extends { videoId: string; analyzedAt: string; shots: Array<{ id?: string; index: number }> }>(analysis: T): T {
  return { ...analysis, shots: analysis.shots.map(shot => ({ ...shot, id: shot.id ?? `${analysis.videoId}:${analysis.analyzedAt}:${shot.index}` })) };
}

export type Analysis = z.infer<typeof AnalysisZ>;

// What the shot tag pass returns (round 2 — tags only, no re-splitting)
export const GeminiShotTagsZ = z.object({
  shots: z
    .array(
      z.object({
        shot_index: z.number(),
        tags: z.array(z.string()).min(1).max(10),
      })
    )
    .min(1),
});

export type GeminiShotTags = z.infer<typeof GeminiShotTagsZ>;

// Gemini structured-output schema — keep in sync with GeminiShotTagsZ
export const geminiShotTagsResponseSchema = {
  type: Type.OBJECT,
  required: ["shots"],
  properties: {
    shots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["shot_index", "tags"],
        properties: {
          shot_index: {
            type: Type.NUMBER,
            description: "The shot's index, copied exactly from the input",
          },
          tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "4-8 short lowercase tags for THIS shot, preferring the provided controlled vocabulary verbatim",
          },
        },
      },
    },
  },
};
