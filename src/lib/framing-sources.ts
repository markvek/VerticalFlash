import { basename } from "path";
import { findLibraryFile } from "./library-store";
import { readProjectMeta } from "./project-meta";
import { cutdownSourceShots } from "./cutdown-build";
import type { Analysis } from "./analysis-schema";
import type { PreviewSource } from "./framing-schema";

export interface FrameSource extends PreviewSource { path: string }

// Expand assembled master ranges back into uploads, retaining shot-relative offsets.
export async function originalSources(path: string, start: number, end: number, offset = 0): Promise<FrameSource[]> {
  const fallback: FrameSource = { path, url: `/api/downloads/${encodeURIComponent(basename(path))}`, start, end, offset };
  const meta = await readProjectMeta(path);
  if (meta?.kind !== "master") return [fallback];
  const spans: FrameSource[] = [];
  let cursor = start;
  for (const clip of [...meta.sourceClips].sort((a, b) => a.start - b.start)) {
    const a = Math.max(start, clip.start, cursor);
    const b = Math.min(end, clip.end);
    if (b <= a) continue;
    if (a > cursor + 0.001) spans.push({ ...fallback, start: cursor, end: a, offset: offset + cursor - start, warning: "Original mapping unavailable; using the assembled crop." });
    const original = await findLibraryFile(clip.filename);
    spans.push(original
      ? { path: original, url: `/api/library/clips/${encodeURIComponent(clip.filename)}`, start: a - clip.start, end: b - clip.start, offset: offset + a - start }
      : { ...fallback, start: a, end: b, offset: offset + a - start, warning: `Original upload unavailable: ${clip.filename}. Using the assembled crop.` });
    cursor = b;
  }
  if (cursor < end - 0.001) spans.push({ ...fallback, start: cursor, offset: offset + cursor - start, warning: "Original mapping unavailable; using the assembled crop." });
  return spans;
}

export async function shotSources(videoPath: string, analysis: Analysis): Promise<Record<string, FrameSource[]>> {
  const meta = await readProjectMeta(videoPath);
  const cutdown = meta?.kind === "cutdown" ? await cutdownSourceShots(meta) : null;
  const result: Record<string, FrameSource[]> = {};
  for (const shot of analysis.shots) {
    const source = cutdown?.[shot.index];
    if (source) {
      const end = source.start + shot.end_time - shot.start_time;
      result[String(shot.index)] = await originalSources(source.path, source.start, end);
      if (meta?.kind === "cutdown" && meta.beats[shot.index]?.source) {
        result[String(shot.index)] = [{ ...source, end, offset: 0, url: `/api/library/clips/${encodeURIComponent(source.filename)}` }];
      }
    } else {
      result[String(shot.index)] = await originalSources(videoPath, shot.source_start ?? shot.start_time, shot.source_end ?? shot.end_time);
      if (cutdown) result[String(shot.index)].forEach(s => { s.warning = "Original footage unavailable; using the assembled crop."; });
    }
  }
  return result;
}
