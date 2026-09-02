import { z } from "zod";
import { Type } from "@google/genai";

// What the Gemini caption call returns: caption options plus a wider pool
// of hashtag candidates (TikHub sizing then picks the best 5)
export const GeminiCaptionsZ = z.object({
  captions: z
    .array(
      z.object({
        text: z.string(),
        angle: z.string(),
      })
    )
    .min(1)
    .max(5),
  hashtag_candidates: z
    .array(
      z.object({
        tag: z.string(),
        reason: z.string(),
      })
    )
    .min(1)
    .max(12),
});

export type GeminiCaptions = z.infer<typeof GeminiCaptionsZ>;

// Gemini structured-output schema — keep in sync with GeminiCaptionsZ
export const geminiCaptionsResponseSchema = {
  type: Type.OBJECT,
  required: ["captions", "hashtag_candidates"],
  properties: {
    captions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["text", "angle"],
        properties: {
          text: {
            type: Type.STRING,
            description:
              "The caption text, ready to paste — no hashtags in it (they are listed separately)",
          },
          angle: {
            type: Type.STRING,
            description:
              "2-4 word label for the caption's approach (e.g. 'relatable first-person', 'product tease', 'trend hook')",
          },
        },
      },
    },
    hashtag_candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["tag", "reason"],
        properties: {
          tag: {
            type: Type.STRING,
            description:
              "Hashtag WITHOUT the # symbol, lowercase, no spaces (e.g. 'cutecaraccessories')",
          },
          reason: {
            type: Type.STRING,
            description: "Short phrase: why this tag fits this video",
          },
        },
      },
    },
  },
};

// One recommended hashtag after TikHub sizing
export const CaptionHashtagZ = z.object({
  tag: z.string(), // no leading '#'
  reason: z.string(),
  // Where the tag came from: the original video's own tags, or Gemini
  source: z.enum(["original", "gemini"]),
  // Lifetime tag stats from TikHub (null = lookup failed or skipped)
  viewCount: z.number().nullable(),
  videoCount: z.number().nullable(),
  // Sweet-spot zone from the scan logic: "in" (10M-500M views) is the
  // target; "too-big" tags bury you, "too-small" barely circulate
  zone: z.enum(["in", "too-small", "too-big", "unknown"]),
});

export type CaptionHashtag = z.infer<typeof CaptionHashtagZ>;

// Full stored captions file: analysis/<videoId>.captions.json
export const CaptionsZ = z.object({
  videoId: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  captions: z.array(
    z.object({
      text: z.string(),
      angle: z.string(),
    })
  ),
  // At most 5, best first
  hashtags: z.array(CaptionHashtagZ).max(5),
  // Whether TikHub sizing ran (false = no API key or every lookup failed;
  // hashtags then keep Gemini's order with null stats)
  tikhubChecked: z.boolean(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
});

export type Captions = z.infer<typeof CaptionsZ>;
