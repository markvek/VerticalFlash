import { z } from "zod";
export const ExportOptionsZ = z.object({
  audio: z.enum(["music", "original", "none"]),
  music_filename: z.string().nullable(),
  burn_text: z.boolean(),
});
export type ExportOptions = z.infer<typeof ExportOptionsZ>;
