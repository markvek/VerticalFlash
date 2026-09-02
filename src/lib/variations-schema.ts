import { z } from "zod";
import { Type } from "@google/genai";
import { sidecarPath } from "./paths";

// AI-suggested improvements for an alternate version of one of the account's
// own published posts, grounded in that post's real TikTok stats. Stored in
// analysis/<videoId>.variations.json (videoId = the published aweme id).

export const VARIATION_KINDS = ["hook", "shot_swap", "caption", "pacing"] as const;
export type VariationKind = (typeof VARIATION_KINDS)[number];

export const VARIATION_STATUSES = ["proposed", "applied", "dismissed"] as const;
export type VariationStatus = (typeof VARIATION_STATUSES)[number];

// The published post's facts at generation time (from /api/tiktok/videos,
// TikHub completion data already merged in when available)
export const PublishedSourceZ = z.object({
  publishedId: z.string(),
  title: z.string(),
  shareUrl: z.string().optional(),
  // Integer seconds
  duration: z.number(),
  // Unix seconds
  createTime: z.number(),
  viewCount: z.number(),
  likeCount: z.number(),
  commentCount: z.number(),
  shareCount: z.number(),
  // 0–100, from TikHub; null/absent when the sync hasn't run
  completionRate: z.number().nullable().optional(),
  newFollowersGained: z.number().nullable().optional(),
  // How the rest of the account performs, so "good" has a reference point
  benchmark: z
    .object({
      videoCount: z.number(),
      medianViews: z.number(),
      medianCompletionRate: z.number().nullable(),
    })
    .optional(),
});

export type PublishedSource = z.infer<typeof PublishedSourceZ>;

// What the Gemini call returns
export const GeminiVariationsZ = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z.enum(VARIATION_KINDS),
        shot_index: z.number(),
        title: z.string(),
        rationale: z.string(),
        fix_note: z.string(),
        clip: z.string(),
        text: z.string(),
      })
    )
    .min(1)
    .max(12),
});

export type GeminiVariations = z.infer<typeof GeminiVariationsZ>;

// Gemini structured-output schema — keep in sync with GeminiVariationsZ
export const geminiVariationsResponseSchema = {
  type: Type.OBJECT,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "kind",
          "shot_index",
          "title",
          "rationale",
          "fix_note",
          "clip",
          "text",
        ],
        properties: {
          kind: { type: Type.STRING, enum: [...VARIATION_KINDS] },
          shot_index: {
            type: Type.NUMBER,
            description:
              "0-based index of the shot this applies to, copied from the input; -1 when it applies to the whole video (captions, overall pacing)",
          },
          title: {
            type: Type.STRING,
            description: "Short imperative headline, max 10 words",
          },
          rationale: {
            type: Type.STRING,
            description:
              "1-2 sentences tying the suggestion to a specific number in the post's stats",
          },
          fix_note: {
            type: Type.STRING,
            description:
              "A renderer fix note phrased ONLY in terms of the renderer's abilities (name the exact library clip filename, fill mode, start second, reuse, lighting). Empty string when the idea can't be executed by the renderer.",
          },
          clip: {
            type: Type.STRING,
            description:
              "Exact library filename the fix note swaps in, copied from the LIBRARY list; empty string otherwise",
          },
          text: {
            type: Type.STRING,
            description:
              "For caption: the full caption ready to paste (no hashtags). For hook: the suggested opening on-screen text. Empty otherwise.",
          },
        },
      },
    },
  },
};

// One stored suggestion
export const VariationZ = z.object({
  id: z.string(),
  kind: z.enum(VARIATION_KINDS),
  // null = whole-video suggestion
  shot_index: z.number().nullable(),
  title: z.string(),
  rationale: z.string(),
  // Ready-made fix note for /edit-notes; null = advisory only
  fix_note: z.string().nullable(),
  // Library clip the fix note names (validated against the library)
  clip: z.string().nullable(),
  // Copyable caption / on-screen text
  text: z.string().nullable(),
  status: z.enum(VARIATION_STATUSES),
  appliedAt: z.string().nullable().optional(),
});

export type Variation = z.infer<typeof VariationZ>;

// Full stored file: analysis/<videoId>.variations.json
export const VariationsZ = z.object({
  videoId: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  source: PublishedSourceZ,
  suggestions: z.array(VariationZ),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
});

export type Variations = z.infer<typeof VariationsZ>;

export function variationsPath(videoId: string): string {
  return sidecarPath(videoId, "variations");
}

// A suggestion the renderer can execute via a fix note (vs. advisory-only)
export function isActionable(v: Pick<Variation, "fix_note" | "shot_index">): boolean {
  return v.fix_note != null && v.fix_note.length > 0 && v.shot_index != null;
}
