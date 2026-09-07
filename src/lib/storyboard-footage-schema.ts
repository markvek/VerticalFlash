import { z } from "zod";
import { SegmentZ } from "./segments-schema";
import { LibraryClipZ } from "./library-schema";

export const FootageCandidateZ = z.object({
  clip: LibraryClipZ,
  duration: z.number().positive().nullable(),
  segments: z.array(SegmentZ),
  transcript: z.string(),
  timing: z.enum(["saved_segments", "whole_clip", "unavailable"]),
  included: z.boolean(),
});
export type FootageCandidate = z.infer<typeof FootageCandidateZ>;

export const AttachedFootageZ = FootageCandidateZ.extend({
  duration: z.number().positive(),
  offset: z.number().nonnegative(),
  addedAt: z.string(),
});
export type AttachedFootage = z.infer<typeof AttachedFootageZ>;
export const StoryboardFootageZ = z.object({
  videoId: z.string(),
  items: z.array(AttachedFootageZ),
});
