import { projectEditLocks as locks } from "@/lib/project-edit-lock";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import { AnalysisZ } from "@/lib/analysis-schema";
import { findDownloadFile } from "@/lib/download-files";
import { analysisPath, sidecarPath } from "@/lib/paths";
import { readProjectMeta } from "@/lib/project-meta";
import { cutdownSourceShots, withSourceRanges } from "@/lib/cutdown-build";
import { probeDuration } from "@/lib/master-assemble";
import { editTimeline, remapBroll, remapIndexed, remapRecord } from "@/lib/timeline-edit";
import { findLibraryFile } from "@/lib/library-store";
import { BrollTrackZ } from "@/lib/broll-schema";
import { listStoryboardFootage } from "@/lib/storyboard-footage";
import { clipDescription, clipTags } from "@/lib/library-metadata";
import { wordsForShot } from "@/lib/broll-resolve";
import { extractShotScreenshot } from "@/lib/analysis-screenshots";
import type { MasterSegments } from "@/lib/segments-schema";

export const maxDuration = 120;
const kinds = ["recommendations", "generation", "edit-notes", "text-overlays", "framing", "broll"] as const;
type Snapshot = Record<string, string | null>;
type History = { past: Snapshot[]; future: Snapshot[]; expected: string };
const operation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trim"), index: z.number().int().nonnegative(), start: z.number().finite(), end: z.number().finite() }),
  z.object({ type: z.literal("move"), index: z.number().int().nonnegative(), to: z.number().int().nonnegative() }),
  z.object({ type: z.literal("remove"), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal("insert"), index: z.number().int().nonnegative(), filename: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive() }),
  z.object({ type: z.literal("replace"), index: z.number().int().nonnegative(), filename: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive() }),
  z.object({ type: z.literal("broll"), index: z.number().int().nonnegative(), filename: z.string().min(1), start: z.number().finite().nonnegative(), end: z.number().finite().positive(), offset: z.number().finite().nonnegative().optional() }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
]);
const bodySchema = z.object({ version: z.string(), operation });

const read = async (path: string) => fs.readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
const hash = (snapshot: Snapshot) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2);

async function load(videoId: string) {
  const video = await findDownloadFile(videoId);
  if (!video) throw new Error("Video not found");
  const paths: Record<string, string> = { analysis: analysisPath(videoId), metadata: `${video.path}.metadata.json` };
  for (const kind of kinds) paths[kind] = sidecarPath(videoId, kind);
  const snapshot: Snapshot = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await read(path)])));
  let analysis = AnalysisZ.parse(JSON.parse(snapshot.analysis ?? "null"));
  const project = await readProjectMeta(video.path);
  if (project?.kind === "cutdown") analysis = withSourceRanges(analysis, project);
  analysis = { ...analysis, shots: analysis.shots.map(s => ({ ...s, source_start: s.source_start ?? s.start_time, source_end: s.source_end ?? s.end_time })) };
  const duration = await probeDuration(video.path);
  if (!duration) throw new Error("Cannot read source duration");
  const sources = project?.kind === "cutdown" ? await cutdownSourceShots(project) : analysis.shots.map(s => ({ path: video.path, filename: video.filename, start: s.source_start!, end: s.source_end!, bounds: { min: 0, max: duration } }));
  const segs: MasterSegments | null = JSON.parse(await read(sidecarPath(project?.kind === "cutdown" ? project.masterId : videoId, "segments")) ?? "null");
  const history: History = JSON.parse(await read(sidecarPath(videoId, "timeline-history")) ?? '{"past":[],"future":[],"expected":""}');
  const version = hash(snapshot);
  // An intervening edit in another panel must not be overwritten by undo.
  if (history.expected !== version) { history.past = []; history.future = []; }
  return { video, paths, snapshot, analysis, project, sources, segs, history, version };
}
function response(state: Awaited<ReturnType<typeof load>>) {
  return {
    analysis: state.analysis, project: state.project, version: state.version,
    canUndo: state.history.past.length > 0, canRedo: state.history.future.length > 0,
    sources: state.sources.map((s, i) => s ? {
      min: s.bounds.min, max: s.bounds.max,
      url: state.project?.kind === "cutdown" && state.project.beats[i]?.source
        ? `/api/library/clips/${encodeURIComponent(s.filename)}` : `/api/downloads/${encodeURIComponent(s.filename)}`,
    } : null),
    words: state.segs?.words ?? [], sentences: state.segs?.sentences ?? [],
    sidecars: Object.fromEntries(kinds.map(k => [k, JSON.parse(state.snapshot[k] ?? "null")])),
  };
}
// Stage the complete edit before publishing. Restore originals if a write
// fails; the history file participates in the same rollback.
async function publish(paths: Record<string, string>, next: Snapshot, before: Snapshot) {
  const staged = new Map<string, string>();
  const changed: string[] = [];
  try {
    for (const [key, path] of Object.entries(paths)) {
      if (next[key] === before[key]) continue;
      if (next[key] != null) {
        const tmp = `${path}.${randomUUID()}.tmp`;
        staged.set(key, tmp);
        await fs.writeFile(tmp, next[key]!);
      }
    }
    for (const [key, path] of Object.entries(paths)) {
      if (next[key] === before[key]) continue;
      changed.push(key);
      if (next[key] == null) await fs.rm(path, { force: true });
      else await fs.rename(staged.get(key)!, path);
    }
  } catch (error) {
    for (const key of changed.reverse()) {
      if (before[key] == null) await fs.rm(paths[key], { force: true });
      else await fs.writeFile(paths[key], before[key]!);
    }
    throw error;
  } finally {
    await Promise.all([...staged.values()].map(p => fs.rm(p, { force: true })));
  }
}
export async function GET(_request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video" }, { status: 400 });
  try { return NextResponse.json(response(await load(videoId))); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Cannot load timeline" }, { status: 400 }); }
}
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid video" }, { status: 400 });
  const previous = locks.get(videoId) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    try {
      const { version, operation: op } = bodySchema.parse(await request.json());
      const state = await load(videoId);
      if (version !== state.version) return NextResponse.json({ error: "The edit changed elsewhere. Reload the timeline and try again." }, { status: 409 });
      const { snapshot, analysis, project, sources, paths, history } = state;
      const next: Snapshot = { ...snapshot };
      if (op.type === "undo" || op.type === "redo") {
        const from = op.type === "undo" ? history.past : history.future;
        const target = from.pop();
        if (!target) throw new Error("No timeline change to undo or redo");
        (op.type === "undo" ? history.future : history.past).push(snapshot);
        Object.assign(next, target);
      } else if (op.type === "broll") {
        if (project?.kind !== "cutdown") throw new Error("Choose a storyboard edit before adding footage");
        const clip = (await listStoryboardFootage(project.masterId)).find(item => item.clip.filename === op.filename && item.included);
        const file = clip ? await findLibraryFile(op.filename) : null;
        const available = file ? await probeDuration(file) : null;
        const shot = analysis.shots[op.index];
        if (!shot || !available || op.end > available + 0.001) throw new Error("Choose an available footage range");
        const offset = op.offset ?? 0;
        const duration = Math.min(op.end - op.start, shot.end_time - shot.start_time - offset);
        if (duration < 0.5) throw new Error("B-roll needs at least 0.5 seconds within the selected shot");
        const current = JSON.parse(snapshot.broll ?? "null");
        next.broll = json(BrollTrackZ.parse({ videoId, updatedAt: new Date().toISOString(), segments: [...(current?.segments ?? []), {
          id: randomUUID(), anchor: { kind: "offset", shot_index: op.index, offset, duration },
          clip: { filename: op.filename, clip_start: op.start, source: "library" }, status: "placed", phrase: "", description: clipDescription(clip!.clip), candidates: [], createdAt: new Date().toISOString(),
        }] }));
        history.past = [...history.past, snapshot].slice(-20); history.future = [];
      } else {
        if (JSON.parse(snapshot.generation ?? "null")?.shots && Object.values(JSON.parse(snapshot.generation!).shots).some(s => (s as { status: string }).status === "generating")) throw new Error("Wait for clip generation to finish before editing the timeline");
        const before = analysis.shots.map(s => ({ ...s, source_start: s.source_start!, source_end: s.source_end! }));
        if (sources.some(s => !s)) throw new Error("Restore the missing source footage before editing clips");
        let inserted: typeof before[number] | undefined;
        if (op.type === "insert" || op.type === "replace") {
          if (project?.kind !== "cutdown") throw new Error("Choose a storyboard edit before inserting footage");
          const clip = (await listStoryboardFootage(project.masterId)).find(item => item.clip.filename === op.filename && item.included);
          const file = clip ? await findLibraryFile(op.filename) : null;
          const duration = file ? await probeDuration(file) : null;
          if (!clip || !duration || op.end > duration + 0.001) throw new Error("Choose an available source range from this project's footage");
          // Only reuse transcript segments wholly inside the selected range.
          // Untimed transcripts must not be presented as aligned word timings.
          const transcript = clip.segments.filter(segment => segment.start_time >= op.start && segment.end_time <= op.end + 0.001).map(segment => segment.text).join(" ");
          inserted = { index: op.index, source_start: op.start, source_end: op.end, source_clip: op.filename,
            start_time: 0, end_time: op.end - op.start, description: clipDescription(clip.clip), spoken_text: transcript,
            on_screen_text: "", camera_style: "other", time_of_day: "unclear", tags: clipTags(clip.clip), screenshot: "" };
        }
        const { shots, order } = editTimeline(before, op, sources.map(s => s!.bounds), inserted);
        if (op.type === "trim") {
          const s = shots[op.index];
          if (!s.source_clip && state.segs?.words.length) s.spoken_text = wordsForShot(state.segs.words, s).map(w => w.word).join(" ");
        }
        next.analysis = json({ ...analysis, shots: shots.map((s, i) => ({ ...s, screenshot: `/api/analysis-shot/${videoId}/${i}` })), full_transcript: shots.map(s => s.spoken_text).filter(Boolean).join(" ") });
        if (project?.kind === "cutdown") {
          const metadata = JSON.parse(snapshot.metadata!);
          metadata.beats = order.map((old, i) => ({ ...(old < 0 ? { source: { filename: inserted!.source_clip, offset: 0 }, section: "main", on_screen_text: "", show: "source" } : project.beats[old]), source_start: shots[i].source_start, source_end: shots[i].source_end, start: shots[i].start_time, end: shots[i].end_time, text: shots[i].spoken_text }));
          next.metadata = json(metadata);
        }
        for (const kind of kinds) {
          if (!snapshot[kind]) continue;
          const doc = JSON.parse(snapshot[kind]!);
          if (kind === "recommendations") {
            doc.shots = remapIndexed(doc.shots, order);
            if (inserted) doc.shots.push({ shot_index: op.index, recommendations: [], selected_filename: null, keep_source: true });
            doc.shots.sort((a: { shot_index: number }, b: { shot_index: number }) => a.shot_index - b.shot_index);
          }
          if (kind === "edit-notes") doc.notes = remapRecord(doc.notes, order);
          if (kind === "text-overlays" || kind === "framing") doc.shots = remapRecord(doc.shots, order);
          if (kind === "generation") doc.shots = Object.fromEntries(remapIndexed(Object.values(doc.shots) as Array<{ shot_index: number }>, order).map(s => [String(s.shot_index), s]));
          if (kind === "broll") doc.segments = remapBroll(doc.segments, order, before, shots, state.segs?.words);
          next[kind] = json(doc);
        }
        if (next.framing && next.broll) {
          const doc = JSON.parse(next.framing);
          const ids = new Set(JSON.parse(next.broll).segments.map((s: { id: string }) => s.id));
          doc.broll = Object.fromEntries(Object.entries(doc.broll).filter(([id]) => ids.has(id)));
          next.framing = json(doc);
        }
        history.past = [...history.past, snapshot].slice(-20); history.future = [];
      }
      const now = new Date().toISOString();
      const savedAnalysis = AnalysisZ.parse(JSON.parse(next.analysis!));
      next.analysis = json({ ...savedAnalysis, shotsEditedAt: now });
      if (next.framing) {
        const doc = JSON.parse(next.framing);
        doc.revision = (JSON.parse(snapshot.framing ?? "null")?.revision ?? 0) + 1;
        doc.updatedAt = now;
        next.framing = json(doc);
      }
      history.expected = hash(next);
      const historyPath = sidecarPath(videoId, "timeline-history");
      await publish({ ...paths, history: historyPath }, { ...next, history: json(history) }, { ...snapshot, history: await read(historyPath) });
      const saved = await load(videoId);
      // Refresh only indexes whose source frame changed (moves and undo
      // can change several; a trim normally changes just one).
      await Promise.all(saved.sources.map((s, i) => {
        const old = sources[i];
        return s && (!old || old.path !== s.path || old.start !== s.start || old.end !== s.end)
          ? extractShotScreenshot(s.path, videoId, i, (s.start + s.end) / 2).catch(() => {}) : Promise.resolve();
      }));
      return NextResponse.json(response(saved));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Cannot save timeline" }, { status: 400 });
    }
  });
  locks.set(videoId, task);
  try { return await task; } finally { if (locks.get(videoId) === task) locks.delete(videoId); }
}
