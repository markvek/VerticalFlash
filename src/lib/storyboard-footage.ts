import { clipDescription } from "@/lib/library-metadata";
import { promises as fs } from "fs";
import { join, sep } from "path";
import { randomUUID } from "crypto";
import { findDownloadFile, listProjectFiles } from "./download-files";
import { readProjectMeta } from "./project-meta";
import { readMasterSegments } from "./master-analyze";
import { scanLibrary, findLibraryFile } from "./library-store";
import { ANALYSIS_DIR, LIBRARY_DIR, STORYBOARDS_DIR, analysisPath } from "./paths";
import { probeDuration } from "./master-assemble";
import { isValidVideoId, extractVideoId } from "./video-id";
import { AnalysisZ } from "./analysis-schema";
import { StoryboardFootageZ, type FootageCandidate, type AttachedFootage } from "./storyboard-footage-schema";
import type { Beat, MasterSegments, Segment } from "./segments-schema";

function manifestPath(videoId: string) {
  if (!isValidVideoId(videoId)) throw new Error("Invalid project ID");
  return join(STORYBOARDS_DIR, videoId, "footage", "manifest.json");
}

export async function readAttachedFootage(videoId: string): Promise<AttachedFootage[]> {
  try {
    return StoryboardFootageZ.parse(JSON.parse(await fs.readFile(manifestPath(videoId), "utf8"))).items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function thumbnails(videoId: string, segments: Segment[]): Promise<Segment[]> {
  let analysis;
  try { analysis = AnalysisZ.parse(JSON.parse(await fs.readFile(analysisPath(videoId), "utf8"))); }
  catch { return segments; }
  return Promise.all(segments.map(async (segment) => {
    const shot = analysis.shots.find((shot) => segment.start_time >= shot.start_time && segment.start_time < shot.end_time);
    if (!shot) return segment;
    const exists = await fs.access(join(ANALYSIS_DIR, videoId, `shot_${shot.index}.jpg`)).then(() => true, () => false);
    return exists ? { ...segment, thumbnail: `/api/analysis-shot/${videoId}/${shot.index}` } : segment;
  }));
}

export async function listStoryboardFootage(videoId: string): Promise<FootageCandidate[]> {
  const file = await findDownloadFile(videoId);
  const master = file ? await readProjectMeta(file.path) : null;
  if (master?.kind !== "master") throw new Error("Storyboard project not found");
  const attached = await readAttachedFootage(videoId);
  const included = new Set([...master.sourceClips.map((clip) => clip.filename), ...attached.map((item) => item.clip.filename)]);
  const saved = new Map<string, { segments: Segment[]; analyzedAt: string }>();
  // Transcripts from previous storyboard projects are reusable analysis of
  // their original library clips. Rebase only segments wholly in that clip.
  for (const source of await listProjectFiles()) {
    const meta = await readProjectMeta(source.path);
    const id = extractVideoId(source.filename);
    if (meta?.kind !== "master" || !id || !isValidVideoId(id)) continue;
    const transcript = await readMasterSegments(id);
    if (!transcript) continue;
    const illustrated = await thumbnails(id, transcript.segments);
    for (const clip of meta.sourceClips) {
      if ((saved.get(clip.filename)?.analyzedAt ?? "") >= transcript.analyzedAt) continue;
      const segments = illustrated.filter((segment) => segment.start_time >= clip.start - 0.01 && segment.end_time <= clip.end + 0.01)
        .map((segment, index) => ({ ...segment, index, start_time: Math.max(0, segment.start_time - clip.start), end_time: segment.end_time - clip.start, start_word: null, end_word: null }));
      if (segments.length) saved.set(clip.filename, { segments, analyzedAt: transcript.analyzedAt });
    }
  }
  const library = await scanLibrary();
  return Promise.all(library.videos.map(async (clip): Promise<FootageCandidate> => {
    const path = await findLibraryFile(clip.filename);
    const duration = clip.duration && clip.duration > 0 ? clip.duration : path ? await probeDuration(path) : null;
    const timed = saved.get(clip.filename)?.segments ?? [];
    const transcript = timed.length ? timed.map((segment) => segment.text).join(" ") : clip.analysis?.spoken_text ?? "";
    const segments: Segment[] = timed.length ? timed : clip.analysis && duration ? [{
      index: 0, start_time: 0, end_time: duration, start_word: null, end_word: null,
      text: transcript, topic: clipDescription(clip), role: "demo", hook_score: 0,
      standalone: true, on_screen_text_idea: "",
    }] : [];
    return { clip, duration, segments, transcript, timing: timed.length ? "saved_segments" : segments.length ? "whole_clip" : "unavailable", included: included.has(clip.filename) };
  }));
}

const state = globalThis as typeof globalThis & { storyboardFootageLocks?: Map<string, Promise<unknown>> };
const locks = state.storyboardFootageLocks ??= new Map<string, Promise<unknown>>();

export async function includeStoryboardFootage(videoId: string, filename: string): Promise<AttachedFootage[]> {
  const previous = locks.get(videoId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const candidate = (await listStoryboardFootage(videoId)).find((item) => item.clip.filename === filename);
    if (!candidate) throw new Error("Footage not found in the local library");
    const items = await readAttachedFootage(videoId);
    if (candidate.included) return items;
    if (!candidate.duration || !candidate.segments.length) throw new Error("Analyze this footage before adding it to the storyboard");
    const file = await findDownloadFile(videoId);
    const duration = file ? await probeDuration(file.path) : null;
    if (!duration) throw new Error("Could not read the storyboard source");
    const offset = Math.max(duration, ...items.map((item) => item.offset + item.duration));
    const updated = [...items, { ...candidate, duration: candidate.duration, included: true, offset, addedAt: new Date().toISOString() }];
    const path = manifestPath(videoId);
    await fs.mkdir(join(STORYBOARDS_DIR, videoId, "footage"), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(StoryboardFootageZ.parse({ videoId, items: updated }), null, 2));
      await fs.rename(temporary, path);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return updated;
  });
  locks.set(videoId, next);
  try { return await next; }
  finally { if (locks.get(videoId) === next) locks.delete(videoId); }
}

export async function readStoryboardSegments(videoId: string): Promise<MasterSegments | null> {
  const base = await readMasterSegments(videoId);
  if (!base) return null;
  const items = await readAttachedFootage(videoId);
  const segments = await thumbnails(videoId, base.segments);
  for (const item of items) {
    for (const segment of item.segments) segments.push({
      ...segment, index: Math.max(-1, ...segments.map((s) => s.index)) + 1,
      start_time: segment.start_time + item.offset, end_time: segment.end_time + item.offset,
      start_word: null, end_word: null, source: { filename: item.clip.filename, offset: item.offset },
    });
  }
  return { ...base, segments, full_transcript: [base.full_transcript, ...items.map((item) => `${item.clip.filename}\n${item.transcript}`)].join("\n\n") };
}

export async function resolveStoryboardBeat(videoId: string, beat: Beat, masterPath: string): Promise<{ path: string; start: number }> {
  let path = masterPath;
  let offset = 0;
  let duration: number | null;
  if (beat.source) {
    const source = beat.source;
    const item = (await readAttachedFootage(videoId)).find((item) => item.clip.filename === source.filename && item.offset === source.offset);
    if (!item) throw new Error("This footage is not included in the storyboard");
    const local = await findLibraryFile(item.clip.filename);
    if (!local) throw new Error(`Missing local footage: ${item.clip.filename}`);
    const [root, real] = await Promise.all([fs.realpath(LIBRARY_DIR), fs.realpath(local)]);
    if (!real.startsWith(`${root}${sep}`)) throw new Error("Invalid footage path");
    path = local;
    offset = item.offset;
    duration = item.duration;
  } else duration = await probeDuration(path);
  if (!duration || !Number.isFinite(beat.start) || !Number.isFinite(beat.end) || beat.start < offset - 0.01 || beat.end > offset + duration + 0.05 || beat.end <= beat.start) {
    throw new Error("Segment is outside its source footage");
  }
  return { path, start: Math.max(0, beat.start - offset) };
}
