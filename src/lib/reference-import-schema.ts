import { z } from "zod";
export const ReferenceImportZ = z.object({
  videoId: z.string().regex(/^\d+$/), filename: z.string(),
  status: z.enum(["downloading", "analyzing", "tagging", "matching", "ready", "failed"]),
  error: z.string().nullable(), updatedAt: z.string(), workerId: z.string(),
});
export type ReferenceImport = z.infer<typeof ReferenceImportZ>;
export const REFERENCE_STAGES = { downloading: "Downloading reference video…", analyzing: "Finding video segments…", tagging: "Understanding each segment…", matching: "Matching your clip library…", ready: "Replacement draft ready", failed: "Preparation needs attention" };
