import { z } from "zod";
import { FootageSourceZ } from "./segments-schema";

export const REVIEW_CRITERIA = ["hook", "audience", "clarity", "payoff", "shareability"] as const;
const assessment = z.object({ score: z.number().int().min(1).max(5), reason: z.string().min(1).max(1000) });
const timedSuggestion = {
  beat_index: z.number().int().nonnegative(),
  offset: z.number().finite().nonnegative(),
  duration: z.number().finite().positive().max(8),
  reason: z.string().min(1).max(1000),
};
export const ViralityOutputZ = z.object({
  summary: z.string().min(1).max(2000),
  assessments: z.object({ hook: assessment, audience: assessment, clarity: assessment, payoff: assessment, shareability: assessment }),
  improvements: z.array(z.object({ beat_index: z.number().int().nonnegative(), title: z.string().min(1).max(150), reason: z.string().min(1).max(1000) })).max(3),
  alternative_hooks: z.array(z.object({ segment_index: z.number().int().nonnegative(), reason: z.string().min(1).max(1000) })).max(3),
  text: z.array(z.object({ ...timedSuggestion, text: z.string().trim().min(1).max(160) })).max(12),
  broll: z.array(z.object({ ...timedSuggestion, description: z.string().min(1).max(1000) })).max(8),
});
export type ViralityOutput = z.infer<typeof ViralityOutputZ>;
export const ViralityReviewZ = ViralityOutputZ.extend({
  id: z.string(), storyboardId: z.string(), revision: z.number().int().positive(),
  inputHash: z.string(), createdAt: z.string(), model: z.string(), rubricVersion: z.literal(1),
  hooks: z.array(z.object({ text: z.string(), start: z.number(), end: z.number(), source: FootageSourceZ.optional(), reason: z.string() })),
});
export type ViralityReview = z.infer<typeof ViralityReviewZ>;
export const StoryboardHandoffZ = z.object({
  add_text: z.boolean().default(false),
  add_broll: z.boolean().default(false),
});
export type StoryboardHandoff = z.infer<typeof StoryboardHandoffZ>;
