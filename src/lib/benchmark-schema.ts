import { z } from "zod";

export const BENCHMARK_PROVIDERS = [
  "gemini",
  "openai",
  "claude",
  "grok",
] as const;

export const BenchmarkProviderZ = z.enum(BENCHMARK_PROVIDERS);
export type BenchmarkProvider = z.infer<typeof BenchmarkProviderZ>;

export const BENCHMARK_STAGES = [
  "tagging",
  "matching",
  "storyboarding",
  "editing_broll",
] as const;

export const BenchmarkStageZ = z.enum(BENCHMARK_STAGES);
export type BenchmarkStage = z.infer<typeof BenchmarkStageZ>;

export const HUMAN_SCORE_METRICS = [
  "hook",
  "pacing",
  "clarity",
  "polish",
  "broll_fit",
] as const;

export const HumanScoreMetricZ = z.enum(HUMAN_SCORE_METRICS);
export type HumanScoreMetric = z.infer<typeof HumanScoreMetricZ>;

export const BenchmarkFilenameZ = z
  .string()
  .min(1)
  .regex(/^[^/\\]+$/)
  .refine((value) => value !== "." && value !== "..", "Invalid filename");

export const BENCHMARK_PROVIDER_OPTIONS: Array<{
  id: BenchmarkProvider;
  label: string;
  modelLabel: string;
}> = [
  { id: "gemini", label: "Gemini", modelLabel: "Current Gemini adapter" },
  { id: "openai", label: "OpenAI", modelLabel: "Planned OpenAI adapter" },
  { id: "claude", label: "Claude", modelLabel: "Planned Anthropic adapter" },
  { id: "grok", label: "Grok", modelLabel: "Planned xAI adapter" },
];

export const BENCHMARK_STAGE_OPTIONS: Array<{
  id: BenchmarkStage;
  label: string;
}> = [
  { id: "tagging", label: "Tagging" },
  { id: "matching", label: "Matching" },
  { id: "storyboarding", label: "Storyboarding" },
  { id: "editing_broll", label: "Editing + B-roll" },
];

export const BenchmarkSourceZ = z.object({
  filename: BenchmarkFilenameZ,
  videoId: z.string().nullable(),
  displayName: z.string().min(1),
  durationSeconds: z.number().nullable(),
});

export const BenchmarkVariantZ = z.object({
  id: z.string().min(1),
  provider: BenchmarkProviderZ,
  blindLabel: z.string().min(1),
  status: z.enum(["waiting", "ready", "failed"]),
  model: z.string().nullable(),
  output: z
    .object({
      filename: BenchmarkFilenameZ,
      videoId: z.string().nullable(),
      displayName: z.string().min(1),
      assignedAt: z.string(),
    })
    .nullable(),
  technicalScore: z.number().min(0).max(100).nullable(),
  aiJudgeScore: z.number().min(0).max(100).nullable(),
  humanScore: z.number().min(0).max(100).nullable(),
  error: z.string().nullable(),
});

export const HumanVariantReviewZ = z.object({
  variantId: z.string().min(1),
  scores: z.object(
    Object.fromEntries(
      HUMAN_SCORE_METRICS.map((metric) => [metric, z.number().int().min(1).max(10)])
    ) as Record<HumanScoreMetric, z.ZodNumber>
  ),
  wouldPost: z.boolean(),
  notes: z.string().max(2000),
});

export const BenchmarkHumanReviewZ = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  reviewer: z.string().min(1),
  winnerVariantId: z.string().nullable(),
  reviews: z.array(HumanVariantReviewZ).min(1),
});

export const BenchmarkRunZ = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["draft", "ready", "reviewed"]),
  source: BenchmarkSourceZ,
  stages: z.array(BenchmarkStageZ).min(1),
  providers: z.array(BenchmarkProviderZ).min(1),
  fairness: z.object({
    inputLockedAt: z.string(),
    blindLabelsLocked: z.boolean(),
    sameRendererRequired: z.boolean(),
    samePromptContractRequired: z.boolean(),
  }),
  variants: z.array(BenchmarkVariantZ).min(1),
  humanReviews: z.array(BenchmarkHumanReviewZ),
});

export type BenchmarkSource = z.infer<typeof BenchmarkSourceZ>;
export type BenchmarkVariant = z.infer<typeof BenchmarkVariantZ>;
export type BenchmarkRun = z.infer<typeof BenchmarkRunZ>;
export type BenchmarkHumanReview = z.infer<typeof BenchmarkHumanReviewZ>;
export type HumanVariantReview = z.infer<typeof HumanVariantReviewZ>;

export function benchmarkProviderLabel(provider: BenchmarkProvider): string {
  return BENCHMARK_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}

export function benchmarkStageLabel(stage: BenchmarkStage): string {
  return BENCHMARK_STAGE_OPTIONS.find((option) => option.id === stage)?.label ?? stage;
}
