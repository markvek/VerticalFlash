import { z } from "zod";
import { Type } from "@google/genai";
import { STORYBOARD_SECTIONS, TIMING_SOURCES } from "./project-kinds";
import { MUSIC_USAGES, VIDEO_FORMATS } from "./analysis-schema";

// Storyboard flow schemas. Isomorphic: client components import the types
// (the Gemini `Type` enum is a plain object, safe to bundle). Keep this
// module free of fs/path imports; the sidecar path helpers live in
// master-analyze.ts and storyboard-plan.ts.
//
// A master's analysis produces analysis/<id>.segments.json: the word-timed
// transcript (WhisperX) or Gemini's approximate timing, the silences, and
// Gemini's reading of the transcript as segments with roles and hook
// scores. Storyboards (analysis/<id>.storyboards.json) are hook → main →
// end beat lists cut from those segments.

export const SEGMENT_ROLES = [
  "hook",
  "claim",
  "demo",
  "proof",
  "objection",
  "cta",
  "filler",
] as const;

export type SegmentRole = (typeof SEGMENT_ROLES)[number];

export const WordZ = z.object({
  // 0-based index into the words array; prompts refer to words by this
  i: z.number(),
  word: z.string(),
  start: z.number(),
  end: z.number(),
  // Alignment confidence when the aligner reports one
  score: z.number().nullable(),
  // WhisperX could not align this word (numbers, symbols); its times are
  // spread between its timed neighbours
  interpolated: z.boolean(),
});

export type Word = z.infer<typeof WordZ>;

export const SilenceZ = z.object({
  start: z.number(),
  end: z.number(),
});

export type Silence = z.infer<typeof SilenceZ>;

// A sentence as the transcriber split it (WhisperX segment)
export const SentenceZ = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  start_word: z.number(),
  end_word: z.number(),
});

export type Sentence = z.infer<typeof SentenceZ>;

export const FootageSourceZ = z.object({
  filename: z.string().min(1),
  // Position of this clip in the storyboard's virtual source timeline.
  offset: z.number().nonnegative(),
});
export type FootageSource = z.infer<typeof FootageSourceZ>;

export const SegmentZ = z.object({
  source: FootageSourceZ.optional(),
  thumbnail: z.string().optional(),
  index: z.number(),
  // Resolved cut times in master seconds
  start_time: z.number(),
  end_time: z.number(),
  // The word range the times came from (null in Gemini-timing mode)
  start_word: z.number().nullable(),
  end_word: z.number().nullable(),
  text: z.string(),
  topic: z.string(),
  role: z.enum(SEGMENT_ROLES),
  hook_score: z.number(),
  standalone: z.boolean(),
  on_screen_text_idea: z.string(),
});

export type Segment = z.infer<typeof SegmentZ>;

export const MasterSegmentsZ = z.object({
  videoId: z.string(),
  analyzedAt: z.string(),
  model: z.string(),
  timing_source: z.enum(TIMING_SOURCES),
  whisperx: z
    .object({
      model: z.string(),
      version: z.string(),
      durationMs: z.number(),
    })
    .nullable(),
  // Empty in Gemini-timing mode
  words: z.array(WordZ),
  sentences: z.array(SentenceZ),
  silences: z.array(SilenceZ),
  full_transcript: z.string(),
  segments: z.array(SegmentZ),
  // Why the timing engine fell back, when it did
  timing_note: z.string().nullable(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
});

export type MasterSegments = z.infer<typeof MasterSegmentsZ>;

// ---- Gemini: master segmentation ------------------------------------------

// Video-level fields Gemini returns alongside the segments (mirrors the
// standard analysis so a derived Analysis can be written)
const geminiSegmentVideoFieldsZ = {
  summary: z.string(),
  hook_description: z.string(),
  format: z.enum(VIDEO_FORMATS),
  tags: z.array(z.string()).min(1),
  music_usage: z.enum(MUSIC_USAGES),
  music_usage_note: z.string(),
};

const geminiSegmentCommonZ = {
  text: z.string(),
  topic: z.string(),
  role: z.enum(SEGMENT_ROLES),
  hook_score: z.number().min(0).max(10),
  standalone: z.boolean(),
  on_screen_text_idea: z.string(),
};

// WhisperX mode: Gemini refers to word indices, never seconds
export const GeminiWordSegmentsZ = z.object({
  ...geminiSegmentVideoFieldsZ,
  segments: z
    .array(
      z.object({
        start_word: z.number().int(),
        end_word: z.number().int(),
        ...geminiSegmentCommonZ,
      })
    )
    .min(1)
    .max(80),
});

export type GeminiWordSegments = z.infer<typeof GeminiWordSegmentsZ>;

// Gemini mode: plain decimal seconds (approximate), plus the transcript
export const GeminiTimeSegmentsZ = z.object({
  ...geminiSegmentVideoFieldsZ,
  full_transcript: z.string(),
  segments: z
    .array(
      z.object({
        start_time: z.number(),
        end_time: z.number(),
        ...geminiSegmentCommonZ,
      })
    )
    .min(1)
    .max(80),
});

export type GeminiTimeSegments = z.infer<typeof GeminiTimeSegmentsZ>;

const segmentCommonProperties = {
  text: {
    type: Type.STRING,
    description: "The segment's words, copied verbatim from the transcript",
  },
  topic: { type: Type.STRING, description: "3-6 word label for what this segment is about" },
  role: {
    type: Type.STRING,
    enum: [...SEGMENT_ROLES],
    description:
      "hook = a scroll-stopping opener; claim = a benefit or promise; demo = showing/using the product; proof = evidence, numbers, testimonial; objection = raising and answering a doubt; cta = call to action or closing payoff; filler = throat-clearing, tangents, repeats",
  },
  hook_score: {
    type: Type.NUMBER,
    description:
      "0-10: how well this segment would work as the FIRST thing a stranger hears (curiosity, tension, a bold claim). 8+ is rare.",
  },
  standalone: {
    type: Type.BOOLEAN,
    description: "true if the segment makes sense with no context before it",
  },
  on_screen_text_idea: {
    type: Type.STRING,
    description: "Max 8 words of on-screen text for this segment, or empty string",
  },
};

const segmentVideoProperties = {
  summary: { type: Type.STRING },
  hook_description: { type: Type.STRING },
  format: { type: Type.STRING, enum: [...VIDEO_FORMATS] },
  tags: { type: Type.ARRAY, items: { type: Type.STRING } },
  music_usage: { type: Type.STRING, enum: [...MUSIC_USAGES] },
  music_usage_note: { type: Type.STRING },
};

const segmentVideoRequired = [
  "summary",
  "hook_description",
  "format",
  "tags",
  "music_usage",
  "music_usage_note",
];

export const geminiWordSegmentsResponseSchema = {
  type: Type.OBJECT,
  required: [...segmentVideoRequired, "segments"],
  properties: {
    ...segmentVideoProperties,
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "start_word",
          "end_word",
          "text",
          "topic",
          "role",
          "hook_score",
          "standalone",
          "on_screen_text_idea",
        ],
        properties: {
          start_word: {
            type: Type.INTEGER,
            description: "Index of the segment's first word (from the numbered transcript)",
          },
          end_word: {
            type: Type.INTEGER,
            description: "Index of the segment's last word, inclusive",
          },
          ...segmentCommonProperties,
        },
      },
    },
  },
};

export const geminiTimeSegmentsResponseSchema = {
  type: Type.OBJECT,
  required: [...segmentVideoRequired, "full_transcript", "segments"],
  properties: {
    ...segmentVideoProperties,
    full_transcript: { type: Type.STRING },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "start_time",
          "end_time",
          "text",
          "topic",
          "role",
          "hook_score",
          "standalone",
          "on_screen_text_idea",
        ],
        properties: {
          start_time: {
            type: Type.NUMBER,
            description:
              "Segment start in plain decimal SECONDS from video start. NEVER minutes or MM.SS notation.",
          },
          end_time: {
            type: Type.NUMBER,
            description:
              "Segment end in plain decimal SECONDS from video start. NEVER minutes or MM.SS notation.",
          },
          ...segmentCommonProperties,
        },
      },
    },
  },
};

// ---- Storyboards ------------------------------------------------------------

export const PACINGS = ["fast", "standard", "detailed"] as const;
export type Pacing = (typeof PACINGS)[number];

// Beat length bounds per pacing, in seconds
export const PACING_BOUNDS: Record<Pacing, { min: number; max: number }> = {
  fast: { min: 1.5, max: 4 },
  standard: { min: 2.5, max: 7 },
  detailed: { min: 4, max: 12 },
};

export const STORYBOARD_MIN_COUNT = 1;
export const STORYBOARD_MAX_COUNT = 5;
export const STORYBOARD_DEFAULT_COUNT = 3;
export const STORYBOARD_DEFAULT_SECONDS = 22;
export const STORYBOARD_MIN_SECONDS = 5;
export const STORYBOARD_MAX_SECONDS = 180;

export const StoryboardRequestZ = z.object({
  count: z.number().int().min(STORYBOARD_MIN_COUNT).max(STORYBOARD_MAX_COUNT),
  // One entry = the same length for every idea; otherwise one per idea
  lengths: z
    .array(z.number().min(STORYBOARD_MIN_SECONDS).max(STORYBOARD_MAX_SECONDS))
    .min(1)
    .max(STORYBOARD_MAX_COUNT),
  pacing: z.enum(PACINGS),
  allow_broll: z.boolean(),
  brief: z.string().max(500),
});

export type StoryboardRequest = z.infer<typeof StoryboardRequestZ>;

export const BeatZ = z.object({
  source: FootageSourceZ.optional(),
  thumbnail: z.string().optional(),
  fix_note: z.string().max(2000).optional(),
  section: z.enum(STORYBOARD_SECTIONS),
  // Resolved master seconds
  start: z.number(),
  end: z.number(),
  start_word: z.number().nullable(),
  end_word: z.number().nullable(),
  text: z.string(),
  on_screen_text: z.string(),
  // "source" = the master's own footage; "broll" = a library clip over the
  // master's voice (only when the request allowed B-roll)
  show: z.enum(["source", "broll"]),
  broll_hint: z
    .object({
      description: z.string(),
      tags: z.array(z.string()),
    })
    .nullable(),
});

export type Beat = z.infer<typeof BeatZ>;

export const StoryboardZ = z.object({
  id: z.string(),
  revision: z.number().int().positive().optional(),
  title: z.string(),
  hook_line: z.string(),
  angle: z.string(),
  target_seconds: z.number(),
  estimated_seconds: z.number(),
  beats: z.array(BeatZ).min(1),
});

export type Storyboard = z.infer<typeof StoryboardZ>;

export const MasterStoryboardsZ = z.object({
  videoId: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  timing_source: z.enum(TIMING_SOURCES),
  request: StoryboardRequestZ,
  storyboards: z.array(StoryboardZ),
  // Storyboard ids already accepted → the short's filename
  accepted: z.record(z.string()).optional(),
  editing_projects: z.record(z.array(z.string())).optional(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
});

export type MasterStoryboards = z.infer<typeof MasterStoryboardsZ>;

// What Gemini returns for storyboards. Beats reference words (WhisperX
// mode) or seconds (Gemini mode); the server resolves both to times.
const geminiBeatCommonZ = {
  section: z.enum(STORYBOARD_SECTIONS),
  on_screen_text: z.string(),
  show: z.enum(["source", "broll"]),
  broll_description: z.string(),
  broll_tags: z.array(z.string()),
};

const geminiStoryboardCommonZ = {
  title: z.string(),
  hook_line: z.string(),
  angle: z.string(),
  target_seconds: z.number(),
};

export const GeminiWordStoryboardsZ = z.object({
  storyboards: z
    .array(
      z.object({
        ...geminiStoryboardCommonZ,
        beats: z
          .array(
            z.object({
              start_word: z.number().int(),
              end_word: z.number().int(),
              ...geminiBeatCommonZ,
            })
          )
          .min(1),
      })
    )
    .min(1),
});

export type GeminiWordStoryboards = z.infer<typeof GeminiWordStoryboardsZ>;

export const GeminiTimeStoryboardsZ = z.object({
  storyboards: z
    .array(
      z.object({
        ...geminiStoryboardCommonZ,
        beats: z
          .array(
            z.object({
              start_time: z.number(),
              end_time: z.number(),
              ...geminiBeatCommonZ,
            })
          )
          .min(1),
      })
    )
    .min(1),
});

export type GeminiTimeStoryboards = z.infer<typeof GeminiTimeStoryboardsZ>;

const beatCommonProperties = {
  section: {
    type: Type.STRING,
    enum: [...STORYBOARD_SECTIONS],
    description: "hook = the opener, main = the body, end = the payoff or call to action",
  },
  on_screen_text: {
    type: Type.STRING,
    description: "Max 8 words of on-screen text, or empty string",
  },
  show: {
    type: Type.STRING,
    enum: ["source", "broll"],
    description:
      "source = show the speaker/master footage; broll = cover this beat with a library clip while the voice continues (only when B-roll is allowed)",
  },
  broll_description: {
    type: Type.STRING,
    description: "For show=broll: one sentence of what the B-roll should show (concrete, matchable). Empty string otherwise.",
  },
  broll_tags: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: "For show=broll: 3-6 lowercase tags reusing the library vocabulary. Empty otherwise.",
  },
};

const storyboardCommonProperties = {
  title: { type: Type.STRING, description: "3-6 word working title" },
  hook_line: {
    type: Type.STRING,
    description: "The first spoken line of the short, copied verbatim",
  },
  angle: {
    type: Type.STRING,
    description: "One sentence: why this hook and structure should hold viewers",
  },
  target_seconds: {
    type: Type.NUMBER,
    description: "The target length this storyboard was built for, copied from the request",
  },
};

export const geminiWordStoryboardsResponseSchema = {
  type: Type.OBJECT,
  required: ["storyboards"],
  properties: {
    storyboards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["title", "hook_line", "angle", "target_seconds", "beats"],
        properties: {
          ...storyboardCommonProperties,
          beats: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: [
                "start_word",
                "end_word",
                "section",
                "on_screen_text",
                "show",
                "broll_description",
                "broll_tags",
              ],
              properties: {
                start_word: {
                  type: Type.INTEGER,
                  description: "Index of the beat's first word (from the numbered transcript)",
                },
                end_word: {
                  type: Type.INTEGER,
                  description: "Index of the beat's last word, inclusive",
                },
                ...beatCommonProperties,
              },
            },
          },
        },
      },
    },
  },
};

export const geminiTimeStoryboardsResponseSchema = {
  type: Type.OBJECT,
  required: ["storyboards"],
  properties: {
    storyboards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["title", "hook_line", "angle", "target_seconds", "beats"],
        properties: {
          ...storyboardCommonProperties,
          beats: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: [
                "start_time",
                "end_time",
                "section",
                "on_screen_text",
                "show",
                "broll_description",
                "broll_tags",
              ],
              properties: {
                start_time: {
                  type: Type.NUMBER,
                  description:
                    "Beat start in the MASTER, plain decimal seconds. Must equal a segment's start_time from the list.",
                },
                end_time: {
                  type: Type.NUMBER,
                  description:
                    "Beat end in the MASTER, plain decimal seconds. Must equal a segment's end_time from the list.",
                },
                ...beatCommonProperties,
              },
            },
          },
        },
      },
    },
  },
};
