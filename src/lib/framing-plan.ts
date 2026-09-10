import { promises as fs } from "fs";
import { basename } from "path";
import type { Analysis } from "./analysis-schema";
import type { PreviewSource } from "./framing-schema";
import { sidecarPath } from "./paths";
import { ShotRecommendationsZ } from "./recommendation-schema";
import { loadLibrary } from "./library-store";
import { isGeneratedClip, resolveClipPath } from "./generation-schema";
import { probeDuration } from "./master-assemble";
import { planShots } from "./render-remake";

// Use the export planner for clip choice and timing. Previewing never invokes
// the optional AI stages that interpret fix notes or choose missing trims.
export async function previewSources(videoId: string, path: string, analysis: Analysis, originals: Record<string, PreviewSource[]>) {
  let raw: string;
  try { raw = await fs.readFile(sidecarPath(videoId, "recommendations"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return originals; throw error; }
  const recs = ShotRecommendationsZ.parse(JSON.parse(raw));
  const library = await loadLibrary();
  const files = new Set(recs.shots.flatMap(s => [...s.recommendations.map(r => r.filename), ...(s.selected_filename ? [s.selected_filename] : [])]));
  const durations = new Map<string, number | null>();
  for (const file of files) durations.set(file, await probeDuration(resolveClipPath(videoId, file)));
  const times = new Map(library.videos.map(v => [v.filename, v.analysis?.time_of_day ?? null]));
  const { planned } = planShots(analysis, recs, basename(path), durations, times, new Map(), []);
  const result: Record<string, PreviewSource[]> = {};
  for (const shot of planned) {
    if (shot.clip_source === "source") { result[String(shot.shot_index)] = originals[String(shot.shot_index)] ?? []; continue; }
    if (!shot.clip) { result[String(shot.shot_index)] = []; continue; }
    const duration = durations.get(shot.clip);
    const maxStart = duration == null ? Infinity : shot.fill && shot.fill !== "black" ? Math.max(0, duration - 0.2) : Math.max(0, duration - shot.duration);
    const start = Math.max(0, Math.min(shot.trim_start ?? 0, maxStart));
    const available = duration == null ? shot.duration : Math.min(duration - start, shot.duration);
    result[String(shot.shot_index)] = [{
      url: isGeneratedClip(shot.clip) ? `/api/generated/${videoId}/${encodeURIComponent(shot.clip)}` : `/api/library/clips/${encodeURIComponent(shot.clip)}`,
      start, end: start + shot.duration, offset: 0,
      playback: { available, fill: shot.fill === "loop" || shot.fill === "slow_mo" || shot.fill === "black" ? shot.fill : "clone" },
      ...(shot.trim_start == null ? { warning: "Clip timing has not been picked yet; export may choose a different moment." } : {}),
    }];
  }
  return result;
}
