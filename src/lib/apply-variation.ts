import { promises as fs } from "fs";
import { analysisPath, sidecarPath } from "./paths";
import { AnalysisZ } from "./analysis-schema";
import { EditNotesZ } from "./edit-notes";
import { TextOverlaysZ, DEFAULT_TEXT_STYLE } from "./text-overlays-schema";
import type { Variations, Variation } from "./variations-schema";

async function optionalJson(path: string) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

// Called only while creating a new fork; failures roll back the entire fork.
export async function applyVariation(videoId: string, variation: Variation, variations: Variations) {
  const analysis = AnalysisZ.parse(JSON.parse(await fs.readFile(analysisPath(videoId), "utf8")));
  const now = new Date().toISOString();
  if (variation.shot_index != null && !analysis.shots.some(s => s.index === variation.shot_index)) throw new Error("Suggested shot no longer exists. Regenerate suggestions.");
  if (variation.shot_index != null && variation.fix_note) {
    const path = sidecarPath(videoId, "edit-notes");
    const notes = EditNotesZ.parse(await optionalJson(path) ?? { videoId, updatedAt: now, notes: {} });
    const key = String(variation.shot_index);
    notes.notes[key] = [notes.notes[key], variation.fix_note].filter(Boolean).join("; ");
    notes.updatedAt = now;
    await fs.writeFile(path, JSON.stringify(notes, null, 2));
  }
  if (variation.kind === "hook" && variation.text && variation.shot_index != null) {
    const path = sidecarPath(videoId, "text-overlays");
    const overlays = TextOverlaysZ.parse(await optionalJson(path) ?? { videoId, updatedAt: now, style: DEFAULT_TEXT_STYLE, shots: {} });
    overlays.shots[String(variation.shot_index)] = { text: variation.text, include: true };
    overlays.updatedAt = now;
    await fs.writeFile(path, JSON.stringify(TextOverlaysZ.parse(overlays), null, 2));
  }
  if (variation.kind === "caption" && variation.text) {
    await fs.writeFile(sidecarPath(videoId, "captions"), JSON.stringify({ videoId, generatedAt: now,
      model: variations.model, captions: [{ text: variation.text, angle: variation.title }], hashtags: [], tikhubChecked: false }, null, 2));
  }
  const executable = !!(variation.shot_index != null && variation.fix_note) || !!(variation.text && (variation.kind === "caption" || (variation.kind === "hook" && variation.shot_index != null)));
  const forkVariations = { ...variations, videoId, suggestions: variations.suggestions.map(v => v.id === variation.id && executable ? { ...v, status: "applied", appliedAt: now } : v) };
  await fs.writeFile(sidecarPath(videoId, "variations"), JSON.stringify(forkVariations, null, 2));
}
