import { z } from "zod";
import { ModelChoiceZ, modelId } from "./models/schema";
import { StoryboardRequestZ, StoryboardZ } from "./segments-schema";

const FilenameZ = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^/\\]+$/)
  .refine((s) => !s.startsWith(".") && !s.includes(".."), "Invalid filename");
export const StoryboardBenchmarkInputZ = z
  .object({
    requestId: z.string().uuid(),
    comparisonMode: z.enum(["providers", "models"]).optional(),
    clips: z.array(FilenameZ).min(1).max(20),
    title: z.string().trim().min(1).max(100),
    timingEngine: z.enum(["whisperx", "gemini"]).nullable(),
    request: StoryboardRequestZ.extend({ count: z.literal(1) }),
    brollClips: z.array(FilenameZ).max(20),
    models: z.array(ModelChoiceZ).length(4),
  })
  .superRefine((v, ctx) => {
    if (
      v.comparisonMode === "providers" &&
      new Set(v.models.map((model) => model.provider)).size !== 4
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Provider comparison requires one model each from Gemini, OpenAI, Claude, and xAI/Grok",
      });
    if (new Set(v.models.map(modelId)).size !== 4)
      ctx.addIssue({ code: "custom", message: "Choose four distinct models" });
    if (v.request.lengths.length !== 1)
      ctx.addIssue({
        code: "custom",
        message: "Use one shared target duration",
      });
    if (v.request.allow_broll && !v.brollClips.length)
      ctx.addIssue({
        code: "custom",
        message: "Choose B-roll clips or turn B-roll off",
      });
    if (!v.request.allow_broll && v.brollClips.length)
      ctx.addIssue({
        code: "custom",
        message: "B-roll must be empty when disabled",
      });
    if (
      new Set(v.clips).size !== v.clips.length ||
      new Set(v.brollClips).size !== v.brollClips.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Clip selections must be unique",
      });
    if (v.brollClips.some((c) => v.clips.includes(c)))
      ctx.addIssue({
        code: "custom",
        message: "Core footage cannot also be in the B-roll pool",
      });
  });
export type StoryboardBenchmarkInput = z.infer<
  typeof StoryboardBenchmarkInputZ
>;
export const BrollDecisionZ = z.object({
  beat: z.number().int().nonnegative(),
  filename: FilenameZ.nullable(),
  clipStart: z.number().nonnegative().nullable(),
  reason: z.string().min(1),
});
export type BrollDecision = z.infer<typeof BrollDecisionZ>;
export const BenchmarkExecutionZ = z.object({
  input: StoryboardBenchmarkInputZ,
  workerId: z.string(),
  status: z.enum(["queued", "preparing", "running", "complete", "failed"]),
  error: z.string().nullable(),
  inputHash: z.string().nullable(),
  preparationModel: z.string().nullable(),
});
export const BenchmarkArtifactZ = z.object({
  stage: z.enum([
    "queued",
    "storyboarding",
    "building",
    "matching",
    "rendering",
    "ready",
    "failed",
  ]),
  storyboard: StoryboardZ.optional(),
  broll: z.array(BrollDecisionZ).optional(),
  edit: z
    .object({
      filename: FilenameZ,
      videoId: z.string(),
      displayName: z.string(),
      duration: z.number(),
    })
    .optional(),
  elapsedMs: z.number().optional(),
  usage: z
    .array(
      z.object({
        model: z.string(),
        promptTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      }),
    )
    .optional(),
});
