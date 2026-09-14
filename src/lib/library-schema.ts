import { z } from "zod";
import { Type } from "@google/genai";
import { CAMERA_STYLES, TIME_OF_DAY } from "./analysis-schema";
import { categoryIds, type BrandConfig } from "./brand";

// Schema for the brand's clip library (<libraryDir>/.metadata.json). This
// module is isomorphic: client components import its types.

export const CLIP_LOCATIONS = [
  "interior",
  "exterior",
  "mixed",
  "unclear",
] as const;

// What Gemini returns for a library clip (server adds analyzedAt/model).
// `category` is a plain string in the persisted schema so editing the
// category list in brand.config.json never invalidates old analyses; the
// live Gemini response is constrained by buildClipResponseSchema().
export const ClipGeminiAnalysisZ = z.object({
  location: z.enum(CLIP_LOCATIONS),
  product_present: z.boolean(),
  product_note: z.string(),
  time_of_day: z.enum(TIME_OF_DAY),
  camera_action: z.enum(CAMERA_STYLES),
  category: z.string(),
  spoken_text: z.string(),
  description: z.string(),
  suggested_tags: z.array(z.string()),
});

export type ClipGeminiAnalysis = z.infer<typeof ClipGeminiAnalysisZ>;

export const ClipAnalysisZ = ClipGeminiAnalysisZ.extend({
  analyzedAt: z.string(),
  model: z.string(),
  usage: z.record(z.unknown()).optional(),
});

export type ClipAnalysis = z.infer<typeof ClipAnalysisZ>;

// Gemini structured-output schema — keep in sync with ClipGeminiAnalysisZ
export function buildClipResponseSchema(brand: BrandConfig) {
  return {
    type: Type.OBJECT,
    required: [
      "location",
      "product_present",
      "product_note",
      "time_of_day",
      "camera_action",
      "category",
      "spoken_text",
      "description",
      "suggested_tags",
    ],
    properties: {
      location: { type: Type.STRING, enum: [...CLIP_LOCATIONS] },
      product_present: { type: Type.BOOLEAN },
      product_note: {
        type: Type.STRING,
        description: `Where/how ${brand.product.shortName} appears in frame; empty string if not present`,
      },
      time_of_day: { type: Type.STRING, enum: [...TIME_OF_DAY] },
      camera_action: { type: Type.STRING, enum: [...CAMERA_STYLES] },
      category: { type: Type.STRING, enum: categoryIds(brand) },
      spoken_text: {
        type: Type.STRING,
        description:
          "Verbatim transcript of anything spoken; empty string if silent/music-only",
      },
      description: { type: Type.STRING },
      suggested_tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
  };
}

export const LibraryClipZ = z.object({
  filename: z.string(),
  date: z.string().datetime().optional().nullable(),
  tags: z.array(z.string()).optional(),
  rejected_tags: z.array(z.string()).optional(),
  description: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  duration: z.number().optional().nullable(),
  analysis: ClipAnalysisZ.optional().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type LibraryClip = z.infer<typeof LibraryClipZ>;

export const ClipLibraryZ = z.object({
  videos: z.array(LibraryClipZ),
  lastUpdated: z.string().datetime(),
});

export type ClipLibrary = z.infer<typeof ClipLibraryZ>;

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv"] as const;

export const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};
