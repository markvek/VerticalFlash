import { z } from "zod";
import { Type } from "@google/genai";
import { MATCH_CONFIDENCES } from "./recommendation-schema";
import { sidecarPath } from "./paths";

// The B-roll track of a short: visual segments that sit on top of the
// speaker. A segment is anchored to the voice, not to the clock — by the
// words it covers in the master transcript (cutdowns) or by an offset into
// its shot (projects without word timing) — so re-timing a shot on the
// timeline keeps its B-roll on the same words. Seconds are derived at
// preview and render time (see broll-resolve.ts).

export const BrollAnchorZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("words"),
    shot_index: z.number().int().nonnegative(),
    start_word: z.number().int().nonnegative(),
    end_word: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("offset"),
    shot_index: z.number().int().nonnegative(),
    // Seconds from the shot's start on the short's timeline
    offset: z.number().nonnegative(),
    duration: z.number().positive(),
  }),
]);
export type BrollAnchor = z.infer<typeof BrollAnchorZ>;

// A clip proposed for a segment by the matcher (or picked by hand)
export const BrollCandidateZ = z.object({
  filename: z.string(),
  duration: z.number().nullable(),
  confidence: z.enum(MATCH_CONFIDENCES),
  reason: z.string(),
  // Suggested start moment within the clip (null until the trim stage ran)
  clip_start: z.number().nullable(),
  moment_note: z.string().nullable(),
});
export type BrollCandidate = z.infer<typeof BrollCandidateZ>;

export const BrollClipZ = z.object({
  filename: z.string(),
  // Where in the clip the segment starts playing (null = from the top)
  clip_start: z.number().nullable(),
  source: z.enum(["library", "generated"]),
});
export type BrollClip = z.infer<typeof BrollClipZ>;

export const BrollSegmentZ = z.object({
  id: z.string().min(1),
  anchor: BrollAnchorZ,
  // null = placeholder: "B-roll goes here", no clip picked yet
  clip: BrollClipZ.nullable(),
  // "suggested" segments come from the moment finder and are not rendered
  // until accepted
  status: z.enum(["suggested", "placed"]),
  // The covered words, cached for display (empty for offset anchors
  // without speech)
  phrase: z.string(),
  // What the B-roll should show (from the moment finder or a storyboard
  // hint); used as the matcher query alongside the phrase
  description: z.string().nullable(),
  candidates: z.array(BrollCandidateZ),
  createdAt: z.string(),
});
export type BrollSegment = z.infer<typeof BrollSegmentZ>;

export const BrollTrackZ = z.object({
  videoId: z.string(),
  updatedAt: z.string(),
  segments: z.array(BrollSegmentZ),
  // When the moment finder last ran, and with which model
  suggestedAt: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type BrollTrack = z.infer<typeof BrollTrackZ>;

export function brollPath(videoId: string): string {
  return sidecarPath(videoId, "broll");
}

export function emptyBrollTrack(videoId: string): BrollTrack {
  return { videoId, updatedAt: new Date(0).toISOString(), segments: [] };
}

// ---- Gemini: per-segment matching --------------------------------------

export const GeminiBrollMatchesZ = z.object({
  matches: z.array(
    z.object({
      segment: z.number().int(),
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
export type GeminiBrollMatches = z.infer<typeof GeminiBrollMatchesZ>;

export const geminiBrollMatchesResponseSchema = {
  type: Type.OBJECT,
  required: ["matches"],
  properties: {
    matches: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["segment", "recommendations"],
        properties: {
          segment: {
            type: Type.INTEGER,
            description: "The segment's number from the provided list",
          },
          recommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ["filename", "confidence", "reason"],
              properties: {
                filename: {
                  type: Type.STRING,
                  description: "Exact filename of a clip from the provided library catalog",
                },
                confidence: { type: Type.STRING, enum: [...MATCH_CONFIDENCES] },
                reason: {
                  type: Type.STRING,
                  description: "One short sentence: why this clip illustrates the phrase",
                },
              },
            },
          },
        },
      },
    },
  },
};

// ---- Gemini: B-roll moment finder ---------------------------------------

// Word mode (cutdowns with WhisperX timing): phrases are word ranges
export const GeminiBrollMomentsZ = z.object({
  moments: z.array(
    z.object({
      shot_index: z.number().int(),
      start_word: z.number().int(),
      end_word: z.number().int(),
      description: z.string(),
    })
  ),
});
export type GeminiBrollMoments = z.infer<typeof GeminiBrollMomentsZ>;

export const geminiBrollMomentsResponseSchema = {
  type: Type.OBJECT,
  required: ["moments"],
  properties: {
    moments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["shot_index", "start_word", "end_word", "description"],
        properties: {
          shot_index: { type: Type.INTEGER, description: "Shot the phrase belongs to" },
          start_word: { type: Type.INTEGER, description: "First word of the phrase (from the numbered transcript)" },
          end_word: { type: Type.INTEGER, description: "Last word of the phrase, inclusive" },
          description: {
            type: Type.STRING,
            description: "One concrete sentence of what the B-roll should show over this phrase",
          },
        },
      },
    },
  },
};

// Offset mode (no word timing): phrases are seconds into the shot
export const GeminiBrollMomentsOffsetZ = z.object({
  moments: z.array(
    z.object({
      shot_index: z.number().int(),
      offset: z.number(),
      duration: z.number(),
      description: z.string(),
    })
  ),
});

export const geminiBrollMomentsOffsetResponseSchema = {
  type: Type.OBJECT,
  required: ["moments"],
  properties: {
    moments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["shot_index", "offset", "duration", "description"],
        properties: {
          shot_index: { type: Type.INTEGER },
          offset: { type: Type.NUMBER, description: "Seconds into the shot where the B-roll starts" },
          duration: { type: Type.NUMBER, description: "Seconds of B-roll (1.5 to 5)" },
          description: { type: Type.STRING },
        },
      },
    },
  },
};
