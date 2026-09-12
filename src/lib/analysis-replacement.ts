import { readStoryboards } from "./storyboard-store";
import { promises as fs } from "fs";
import { analysisPath, sidecarPath } from "./paths";

// Indexed edits cannot be safely attached to a newly detected set of shots.
// Require a fresh project once edits or storyboard ideas exist, preserving
// the old project's analysis, generation history, and media unchanged.
export async function assertAnalysisReplaceable(videoId: string) {
  try { await fs.access(analysisPath(videoId)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if ((await readStoryboards(videoId))?.storyboards.length) throw new Error("This project has saved storyboard ideas. Create a fresh project from the footage to analyze it again; existing ideas and edits are preserved.");
  const analysis = JSON.parse(await fs.readFile(analysisPath(videoId), "utf8"));
  if (analysis.shotsEditedAt) throw new Error("This project has timeline edits. Create a fresh project from the footage to analyze it again; the current edit is preserved.");
  for (const kind of ["recommendations", "generation", "edit-notes", "text-overlays", "framing", "broll", "storyboards"]) {
    try { await fs.access(sidecarPath(videoId, kind)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("This project has saved shot edits or storyboard ideas. Create a fresh project from the footage to analyze it again; existing selections, text, and notes are preserved.");
  }
}
