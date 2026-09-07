import { z } from "zod";

export const MasterJobStatusZ = z.object({
  videoId: z.string(),
  filename: z.string(),
  title: z.string(),
  status: z.enum(["preparing", "analyzing", "ready", "failed"]),
  error: z.string().nullable(),
});

export type MasterJobStatus = z.infer<typeof MasterJobStatusZ>;
