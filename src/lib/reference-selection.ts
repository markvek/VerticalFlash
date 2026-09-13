import { promises as fs } from "fs";
import { createHash } from "crypto";
import { analysisPath, sidecarPath } from "./paths";
import { AnalysisZ } from "./analysis-schema";
import { ShotRecommendationsZ, type ShotRecommendations } from "./recommendation-schema";
import { atomicReferenceJson } from "./reference-import";
import { probeDuration } from "./master-assemble";
import { resolveClipPath } from "./generation-schema";

export async function prepareReferenceSelection(recs: ShotRecommendations, index: number, filename?: string | null, keepSource?: boolean | null, requestedStart?: number) {
  const shot = recs.shots.find(s => s.shot_index === index)!;
  if (keepSource === true || filename === null) {
    shot.keep_source = true; shot.needs_replacement = false; shot.choice_origin = "user";
    return;
  }
  if (filename === undefined && keepSource === undefined) return;
  const rec = shot.recommendations.find(r => r.filename === shot.selected_filename);
  if (!rec) throw new Error("Choose a replacement clip first");
  const analysis = AnalysisZ.parse(JSON.parse(await fs.readFile(analysisPath(recs.videoId), "utf8")));
  const segment = analysis.shots.find(s => s.index === index);
  if (!segment) throw new Error("Segment no longer exists");
  const duration = await probeDuration(resolveClipPath(recs.videoId, rec.filename));
  const seconds = segment.end_time - segment.start_time;
  if (duration == null) throw new Error("This clip is unavailable. Choose another clip.");
  if (duration < seconds - 0.001) throw new Error(`This segment needs ${seconds.toFixed(1)}s; the clip only has ${duration.toFixed(1)}s. Choose a longer clip or shorten the segment.`);
  if (requestedStart !== undefined && requestedStart + seconds > duration + 0.001) throw new Error("The selected moment is too close to the end of this clip. Choose an earlier start.");
  rec.duration = duration;
  // Manual picks use an explicit deterministic moment, editable in the
  // footage picker. Export never performs another AI trim for this choice.
  rec.trim_start = Math.max(0, Math.min(rec.trim_start ?? 0, duration - seconds));
  rec.trim_end = rec.trim_start + seconds;
  shot.keep_source = false; shot.needs_replacement = false;
  shot.choice_origin = rec.source === "generated" ? "generated" : "user";
}

type History = { past: ShotRecommendations[]; future: ShotRecommendations[]; expected: string };
async function revision(recs: ShotRecommendations) {
  return createHash("sha256").update(JSON.stringify(recs)).update(await fs.readFile(analysisPath(recs.videoId), "utf8")).digest("hex");
}
async function historyFor(recs: ShotRecommendations): Promise<History> {
  const raw = await fs.readFile(sidecarPath(recs.videoId, "replacement-history"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  const history: History = raw ? JSON.parse(raw) : { past: [], future: [], expected: "" };
  if (history.expected !== await revision(recs)) return { past: [], future: [], expected: "" };
  return history;
}
export async function saveReferenceRecommendations(recs: ShotRecommendations) {
  recs = ShotRecommendationsZ.parse(recs);
  const path = sidecarPath(recs.videoId, "recommendations");
  if (recs.mode === "reference") {
    const raw = await fs.readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    const previous = raw ? ShotRecommendationsZ.parse(JSON.parse(raw)) : null;
    const history = previous ? await historyFor(previous) : { past: [], future: [], expected: "" };
    if (previous && JSON.stringify(previous) !== JSON.stringify(recs)) history.past = [...history.past, previous].slice(-30);
    history.future = []; history.expected = await revision(recs);
    await atomicReferenceJson(sidecarPath(recs.videoId, "replacement-history"), history);
  }
  await atomicReferenceJson(path, ShotRecommendationsZ.parse(recs));
}
export async function referenceHistory(videoId: string, action?: "undo" | "redo") {
  const recs = ShotRecommendationsZ.parse(JSON.parse(await fs.readFile(sidecarPath(videoId, "recommendations"), "utf8")));
  if (recs.mode !== "reference") throw new Error("Not a reference edit");
  const history = await historyFor(recs);
  let current = recs;
  if (action) {
    const from = action === "undo" ? history.past : history.future;
    const target = from.pop();
    if (!target) throw new Error("No replacement change to undo or redo");
    (action === "undo" ? history.future : history.past).push(recs);
    current = ShotRecommendationsZ.parse(target);
    history.expected = await revision(current);
    await atomicReferenceJson(sidecarPath(videoId, "replacement-history"), history);
    await atomicReferenceJson(sidecarPath(videoId, "recommendations"), current);
  }
  return { recommendations: current, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}

export async function referenceExportIssues(analysis: { shots: Array<{ index: number; start_time: number; end_time: number }> }, recs: ShotRecommendations) {
  if (recs.mode !== "reference") return [];
  const issues: string[] = [];
  for (const segment of analysis.shots) {
    const shot = recs.shots.find(s => s.shot_index === segment.index);
    const label = `Segment ${segment.index + 1}`;
    if (!shot || shot.needs_replacement) { issues.push(`${label}: choose a replacement or Keep original`); continue; }
    if (shot.keep_source) continue;
    const rec = shot.recommendations.find(r => r.filename === shot.selected_filename);
    const duration = rec ? await probeDuration(resolveClipPath(recs.videoId, rec.filename)) : null;
    if (!rec || duration == null || rec.trim_start == null || duration - rec.trim_start < segment.end_time - segment.start_time - 0.001) issues.push(`${label}: replacement is missing or too short`);
  }
  return issues;
}
