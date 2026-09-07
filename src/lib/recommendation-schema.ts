import { z } from "zod";
import { Type } from "@google/genai";

export const MATCH_CONFIDENCES = ["strong", "moderate", "weak"] as const;
export const EDIT_INTENTS = ["locked", "recycle", "generate"] as const;

// What the Gemini text-only matching call returns
export const GeminiMatchesZ = z.object({
  matches: z.array(
    z.object({
      shot_index: z.number(),
      recommendations: z.array(
        z.object({
          filename: z.string(),
          confidence: z.enum(MATCH_CONFIDENCES),
          reason: z.string(),
        })
      ),
    })
  ),
});

export type GeminiMatches = z.infer<typeof GeminiMatchesZ>;

// Gemini structured-output schema — keep in sync with GeminiMatchesZ
export const geminiMatchesResponseSchema = {
  type: Type.OBJECT,
  required: ["matches"],
  properties: {
    matches: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["shot_index", "recommendations"],
        properties: {
          shot_index: {
            type: Type.NUMBER,
            description: "0-based index of the shot from the provided list",
          },
          recommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ["filename", "confidence", "reason"],
              properties: {
                filename: {
                  type: Type.STRING,
                  description:
                    "Exact filename of a clip from the provided library catalog",
                },
                confidence: {
                  type: Type.STRING,
                  enum: [...MATCH_CONFIDENCES],
                },
                reason: {
                  type: Type.STRING,
                  description:
                    "One short sentence: why this clip can play this shot's role",
                },
              },
            },
          },
        },
      },
    },
  },
};

// Second Gemini stage: watch a clip and pick the best start moment for
// each shot it was recommended for (window length = the shot's duration)
export const GeminiTrimZ = z.object({
  windows: z.array(
    z.object({
      shot_index: z.number(),
      start_time: z.number(),
      moment_note: z.string(),
    })
  ),
});

export type GeminiTrim = z.infer<typeof GeminiTrimZ>;

export const geminiTrimResponseSchema = {
  type: Type.OBJECT,
  required: ["windows"],
  properties: {
    windows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["shot_index", "start_time", "moment_note"],
        properties: {
          shot_index: {
            type: Type.NUMBER,
            description: "0-based index of the target shot from the list",
          },
          start_time: {
            type: Type.NUMBER,
            description:
              "Best start point WITHIN this clip, in plain decimal seconds from the clip's start (never minutes or MM.SS)",
          },
          moment_note: {
            type: Type.STRING,
            description:
              "Short phrase: what happens in the clip at this moment (e.g. 'duck placed on dashboard')",
          },
        },
      },
    },
  },
};

// One stored recommendation (Gemini semantic match and/or tag overlap)
export const RecommendationZ = z.object({
  filename: z.string(),
  duration: z.number().nullable(),
  confidence: z.enum(MATCH_CONFIDENCES),
  reason: z.string(),
  // "gemini" = semantic description match; "tags" = tag-overlap only;
  // "manual" = user picked the clip from the full library;
  // "generated" = AI-generated clip accepted for this shot
  source: z.enum(["gemini", "tags", "manual", "generated"]),
  tag_overlap: z.array(z.string()),
  score: z.number(),
  // Suggested in/out points within the clip, sized to the target shot
  // (null when the trim stage failed or was skipped)
  trim_start: z.number().nullable(),
  trim_end: z.number().nullable(),
  moment_note: z.string().nullable(),
});

export type Recommendation = z.infer<typeof RecommendationZ>;

// Full stored recommendations file: analysis/<videoId>.recommendations.json
export const ShotRecommendationsZ = z.object({
  videoId: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  clipsConsidered: z.number(),
  shots: z.array(
    z.object({
      shot_index: z.number(),
      recommendations: z.array(RecommendationZ),
      // User-confirmed clip choice for this shot (from the Select button)
      selected_filename: z.string().nullable().optional(),
      // User editing intent for remake iteration:
      // locked = preserve the current product/clip, recycle = find a new
      // library clip, generate = make a new AI clip for this shot.
      edit_intent: z.enum(EDIT_INTENTS).nullable().optional(),
      // true = render this shot from the project's own source video at the
      // shot's start_time/end_time, not from a library clip (storyboard
      // cutdowns set this for beats that show the speaker; any project can
      // flip it per shot). A fix note that names a clip still wins.
      keep_source: z.boolean().nullable().optional(),
    })
  ),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
});

export type ShotRecommendations = z.infer<typeof ShotRecommendationsZ>;
