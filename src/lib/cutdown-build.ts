import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { EDITING_DIR } from "./paths";
import { AnalysisZ, type Analysis } from "./analysis-schema";
import type { CutdownBeat, CutdownProjectMeta, MasterProjectMeta } from "./project-meta";
import type { MasterSegments, Storyboard } from "./segments-schema";
import {
  concatSegments,
  normalizeClip,
  probeDuration,
  setDisplayName,
} from "./master-assemble";
import { extractScreenshots } from "./analysis-screenshots";
import { ANALYSIS_DIR, analysisPath, sidecarPath } from "./paths";
import { readAttachedFootage, resolveStoryboardBeat } from "./storyboard-footage";
import { findDownloadFile } from "./download-files";
import { findLibraryFile } from "./library-store";

// Accepting a storyboard: the beats are trimmed out of the master (video +
// audio) and joined into a new editing/ project whose source IS the
// footage, so the editor, renderer ("original" audio, keep_source shots),
// captions, fork, and upload all work unchanged. No Gemini call.

const SECTION_LABEL: Record<CutdownBeat["section"], string> = {
  hook: "Hook",
  main: "Main",
  end: "End",
};

export interface BuildCutdownInput {
  masterPath: string;
  masterId: string;
  masterFilename: string;
  masterMeta: MasterProjectMeta;
  segments: MasterSegments;
  storyboard: Storyboard;
}

export interface BuildCutdownResult {
  filename: string;
  videoId: string;
  displayName: string;
  duration: number;
}

// The editor's analysis, written straight from the beats
export function analysisFromCutdown(
  videoId: string,
  meta: CutdownProjectMeta,
  duration: number
): Analysis {
  const shots = meta.beats.map((b, i) => ({
    index: i,
    start_time: b.start,
    end_time: i === meta.beats.length - 1 ? duration : b.end,
    source_start: b.source_start,
    source_end: b.source_end,
    ...(b.source ? { source_clip: b.source.filename } : {}),
    description: `${SECTION_LABEL[b.section]} — ${
      b.show === "broll" ? "B-roll over the voice: " : "speaker on camera: "
    }${b.text.split(/\s+/).slice(0, 12).join(" ")}`.slice(0, 200),
    on_screen_text: b.on_screen_text,
    spoken_text: b.text,
    camera_style: "static",
    time_of_day: "unclear",
    tags: [
      b.section,
      b.show === "broll" ? "b-roll" : "talking head",
      "original footage",
    ],
    screenshot: `/api/analysis-shot/${videoId}/${i}`,
  }));
  return AnalysisZ.parse({
    videoId,
    analyzedAt: new Date().toISOString(),
    model: "storyboard",
    summary: `${meta.title}: ${meta.beats.length} beats cut from the master (hook → main → end).`,
    hook_description: meta.hookLine,
    format: "storytime",
    tags: ["storyboard", "talking head", "original footage"],
    music: {
      title: "",
      author: "",
      usage: "original_audio_talking",
      usage_note: "The speaker's own audio, carried from the master",
    },
    full_transcript: meta.beats.map((b) => b.text).join(" "),
    shots,
  });
}

// Shorts cut before source ranges were written into the analysis get them
// from the metadata's beats (1:1 by index)
export function withSourceRanges(analysis: Analysis, meta: CutdownProjectMeta): Analysis {
  return {
    ...analysis,
    shots: analysis.shots.map((shot, i) => {
      const beat = meta.beats[i];
      if (!beat) return shot;
      return {
        ...shot,
        source_start: shot.source_start ?? beat.source_start,
        source_end: shot.source_end ?? beat.source_end,
        ...(beat.source ? { source_clip: shot.source_clip ?? beat.source.filename } : {}),
      };
    }),
  };
}

// Where each beat's footage lives on disk, with file-local times: the
// master itself, or an attached library clip rebased by its offset. The
// render and the timeline editor cut from here, not from the short mp4.
export interface SourceShot {
  path: string;
  filename: string;
  start: number;
  end: number;
  // Legal window for edits, in the storyboard's virtual timeline
  bounds: { min: number; max: number };
}

export async function cutdownSourceShots(
  meta: CutdownProjectMeta
): Promise<Array<SourceShot | null>> {
  const master = await findDownloadFile(meta.masterId);
  const masterDuration = master ? await probeDuration(master.path) : null;
  const attached = await readAttachedFootage(meta.masterId).catch(() => []);
  const results: Array<SourceShot | null> = [];
  for (const beat of meta.beats) {
    if (beat.source) {
      const item = attached.find(
        (a) => a.clip.filename === beat.source!.filename && a.offset === beat.source!.offset
      );
      const local = item ? await findLibraryFile(item.clip.filename) : null;
      if (!item || !local) {
        results.push(null);
        continue;
      }
      results.push({
        path: local,
        filename: item.clip.filename,
        start: beat.source_start - item.offset,
        end: beat.source_end - item.offset,
        bounds: { min: item.offset, max: item.offset + item.duration },
      });
    } else if (master && masterDuration) {
      results.push({
        path: master.path,
        filename: master.filename,
        start: beat.source_start,
        end: beat.source_end,
        bounds: { min: 0, max: masterDuration },
      });
    } else {
      results.push(null);
    }
  }
  return results;
}

// Every source beat renders from the short's own video; B-roll beats start
// empty and go through the normal matcher
export function recommendationsFromCutdown(videoId: string, meta: CutdownProjectMeta) {
  return {
    videoId,
    generatedAt: new Date().toISOString(),
    model: "storyboard",
    clipsConsidered: 0,
    shots: meta.beats.map((b, i) => ({
      shot_index: i,
      recommendations: [],
      selected_filename: null,
      keep_source: b.show === "source",
    })),
  };
}

export async function writeCutdownArtifacts(
  videoPath: string,
  videoId: string,
  meta: CutdownProjectMeta,
  duration: number
): Promise<Analysis> {
  const analysis = analysisFromCutdown(videoId, meta, duration);
  await extractScreenshots(videoPath, videoId, analysis.shots, duration);
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  await fs.writeFile(analysisPath(videoId), JSON.stringify(analysis, null, 2));
  return analysis;
}

export async function buildCutdown(input: BuildCutdownInput): Promise<BuildCutdownResult> {
  const { storyboard } = input;
  const videoId = `short-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const filename = `${videoId}.mp4`;
  const videoPath = join(EDITING_DIR, filename);
  await fs.mkdir(EDITING_DIR, { recursive: true });
  const workDir = join(EDITING_DIR, `.work-${videoId}`);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  try {
    // Beats that follow each other in the master (their lead/tail windows
    // touch or overlap) are cut as ONE continuous piece, so the join never
    // repeats a sliver of audio; each beat still gets its own span on the
    // short's timeline
    const groups: Array<typeof storyboard.beats> = [];
    for (const beat of storyboard.beats) {
      const current = groups[groups.length - 1];
      const prev = current?.[current.length - 1];
      if (prev && prev.source?.filename === beat.source?.filename && prev.source?.offset === beat.source?.offset && beat.start <= prev.end + 0.05 && beat.start >= prev.start) {
        current.push(beat);
      } else {
        groups.push([beat]);
      }
    }

    const segPaths: string[] = [];
    const beats: CutdownBeat[] = [];
    let cursor = 0;
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const groupStart = group[0].start;
      const groupEnd = group[group.length - 1].end;
      const segPath = join(workDir, `beat_${String(g).padStart(2, "0")}.mp4`);
      for (const beat of group) await resolveStoryboardBeat(input.masterId, beat, input.masterPath);
      const source = await resolveStoryboardBeat(input.masterId, { ...group[0], end: groupEnd }, input.masterPath);
      await normalizeClip(source.path, segPath, {
        start: source.start,
        duration: Math.max(0.1, groupEnd - groupStart),
        crf: 18,
      });
      const segDuration = await probeDuration(segPath);
      if (segDuration == null) {
        throw new Error(
          `Could not cut beats at ${groupStart.toFixed(2)}s → ${groupEnd.toFixed(2)}s`
        );
      }
      for (let k = 0; k < group.length; k++) {
        const beat = group[k];
        const next = group[k + 1];
        const start = cursor + (beat.start - groupStart);
        const end = next ? cursor + (next.start - groupStart) : cursor + segDuration;
        beats.push({
          section: beat.section,
          source_start: beat.start,
          source_end: beat.end,
          source: beat.source,
          fix_note: beat.fix_note,
          start: Math.round(start * 1000) / 1000,
          end: Math.round(Math.max(end, start + 0.05) * 1000) / 1000,
          text: beat.text,
          on_screen_text: beat.on_screen_text,
          show: beat.show,
        });
      }
      cursor += segDuration;
      segPaths.push(segPath);
    }

    if (segPaths.length === 1) {
      await fs.rename(segPaths[0], videoPath);
    } else {
      const outPath = join(workDir, "short.mp4");
      await concatSegments(segPaths, outPath, workDir);
      await fs.rename(outPath, videoPath);
    }
    const duration = (await probeDuration(videoPath)) ?? cursor;

    const now = new Date().toISOString();
    const meta: CutdownProjectMeta & Record<string, unknown> = {
      kind: "cutdown",
      masterId: input.masterId,
      masterFilename: input.masterFilename,
      storyboardId: storyboard.id,
      storyboardSnapshot: structuredClone(storyboard),
      title: storyboard.title,
      hookLine: storyboard.hook_line,
      targetDuration: storyboard.target_seconds,
      timingSource: input.segments.timing_source,
      createdAt: now,
      beats,
      caption: storyboard.hook_line,
      savedAt: now,
    };
    await fs.writeFile(`${videoPath}.metadata.json`, JSON.stringify(meta, null, 2));

    await writeCutdownArtifacts(videoPath, videoId, meta, duration);
    await fs.writeFile(
      sidecarPath(videoId, "recommendations"),
      JSON.stringify(recommendationsFromCutdown(videoId, meta), null, 2)
    );

    const displayName = `✂️ ${storyboard.hook_line || storyboard.title}`.slice(0, 100);
    const notes = Object.fromEntries(beats.flatMap((beat, index) => beat.fix_note?.trim() ? [[String(index), beat.fix_note.trim()]] : []));
    if (Object.keys(notes).length) {
      await fs.writeFile(sidecarPath(videoId, "edit-notes"), JSON.stringify({ videoId, notes, updatedAt: now }, null, 2));
    }
    await setDisplayName(filename, displayName);

    return { filename, videoId, displayName, duration };
  } catch (error) {
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(`${videoPath}.metadata.json`).catch(() => {});
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
