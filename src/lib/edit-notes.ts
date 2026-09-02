import { z } from "zod";
import { sidecarPath } from "./paths";

// Free-text per-shot fix notes ("loop this clip to fill the shot",
// "use IMG_0072 instead") written in the render tab. Stored separately
// from recommendations so a re-match doesn't wipe them.
export const EditNotesZ = z.object({
  videoId: z.string(),
  // shot_index (as a string key) -> the user's note
  notes: z.record(z.string()),
  updatedAt: z.string(),
});

export type EditNotes = z.infer<typeof EditNotesZ>;

export function editNotesPath(videoId: string): string {
  return sidecarPath(videoId, "edit-notes");
}
