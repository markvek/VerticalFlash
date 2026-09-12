import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
const exec = promisify(execFile);
let root: string;
let paths: typeof import("../src/lib/paths");
let api: typeof import("../src/app/api/analyze/[videoId]/timeline/route");
const id = "timeline-fixture";
const context = { params: Promise.resolve({ videoId: id }) };
const url = `http://localhost/api/analyze/${id}/timeline`;
const get = async () => (await api.GET(new NextRequest(url), context)).json();
const patch = async (version: string, operation: unknown) => api.PATCH(new NextRequest(url, { method: "PATCH", body: JSON.stringify({ version, operation }) }), context);
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "verticalflash-timeline-"));
  process.env.DATA_DIR = root;
  paths = await import("../src/lib/paths");
  await paths.ensureDataDirs();
  api = await import("../src/app/api/analyze/[videoId]/timeline/route");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(paths.EDITING_DIR, `${id}.mp4`)]);
  const shots = [0, 2, 4].map((start_time, index) => ({ index, start_time, end_time: start_time + 2, description: `clip ${index}`, on_screen_text: `overlay ${index}`, spoken_text: `words ${index}`, camera_style: "static", screenshot: `/api/analysis-shot/${id}/${index}` }));
  await fs.writeFile(paths.analysisPath(id), JSON.stringify({ videoId: id, analyzedAt: "2026-01-01", model: "fixture", summary: "", hook_description: "", format: "tutorial", tags: [], music: { title: "", author: "", usage: "original_audio_talking", usage_note: "" }, full_transcript: "words 0 words 1 words 2", shots }));
  await fs.writeFile(paths.sidecarPath(id, "edit-notes"), JSON.stringify({ videoId: id, notes: { "0": "A", "2": "C" }, updatedAt: "" }));
  await fs.writeFile(paths.sidecarPath(id, "text-overlays"), JSON.stringify({ videoId: id, shots: { "0": { text: "First", include: true } } }));
  await fs.writeFile(paths.sidecarPath(id, "recommendations"), JSON.stringify({ videoId: id, generatedAt: "2026-01-01", model: "fixture", clipsConsidered: 0, shots: shots.map(s => ({ shot_index: s.index, keep_source: true, selected_filename: null, recommendations: [] })) }));
});
after(() => fs.rm(root, { recursive: true, force: true }));

test("API saves imports, moves all settings, persists undo/redo, and rejects stale requests", async () => {
  let state = await get();
  assert.equal(state.sources[0].max, 6);
  const initialVersion = state.version;
  const res = await patch(state.version, { type: "move", index: 2, to: 0 });
  assert.equal(res.status, 200);
  state = await res.json();
  assert.equal(state.analysis.shots[0].spoken_text, "words 2");
  assert.equal(state.analysis.shots[0].source_start, 4);
  assert.equal(state.analysis.shots[0].screenshot, `/api/analysis-shot/${id}/0`);
  assert.deepEqual(state.sidecars["edit-notes"].notes, { "0": "C", "1": "A" });
  assert.equal(state.sidecars["text-overlays"].shots["1"].text, "First");
  assert.equal(state.canUndo, true);
  assert.equal((await patch(initialVersion, { type: "remove", index: 0 })).status, 409);
  state = await get(); // Undo remains available after a reload.
  state = await (await patch(state.version, { type: "trim", index: 0, start: 4.5, end: 5.5 })).json();
  assert.deepEqual(state.analysis.shots.map((s: { start_time: number; end_time: number }) => [s.start_time, s.end_time]), [[0, 1], [1, 3], [3, 5]]);
  state = await (await patch(state.version, { type: "remove", index: 1 })).json();
  assert.equal(state.analysis.shots.length, 2);
  assert.deepEqual(state.sidecars["text-overlays"].shots, {});
  state = await (await patch(state.version, { type: "undo" })).json();
  assert.equal(state.analysis.shots.length, 3);
  assert.equal(state.sidecars["text-overlays"].shots["1"].text, "First");
  state = await (await patch(state.version, { type: "redo" })).json();
  assert.equal(state.analysis.shots.length, 2);
  const invalid = await patch(state.version, { type: "trim", index: 0, start: 0, end: 8 });
  assert.equal(invalid.status, 400);
  assert.equal((await get()).version, state.version);
  // A different panel's later changes must survive an undo attempt.
  await fs.writeFile(paths.sidecarPath(id, "edit-notes"), JSON.stringify({ videoId: id, notes: { "0": "newer note" }, updatedAt: "now" }));
  state = await get();
  assert.equal(state.canUndo, false);
  assert.equal((await patch(state.version, { type: "undo" })).status, 400);
});

test("saved source ranges drive preview and a real rendered export", async () => {
  const state = await get();
  const { shotSources } = await import("../src/lib/framing-sources");
  const { renderRemake } = await import("../src/lib/render-remake");
  const { probeDuration } = await import("../src/lib/master-assemble");
  const path = join(paths.EDITING_DIR, `${id}.mp4`);
  const originalSources = await shotSources(path, state.analysis);
  assert.equal(originalSources["0"][0].start, 4.5);
  const manifest = await renderRemake({ videoId: id, analysis: state.analysis, recs: state.sidecars.recommendations,
    sourceVideo: `${id}.mp4`, library: { videos: [], lastUpdated: new Date().toISOString() }, editNotes: {}, burnText: false, audio: "original", originalSources,
    sourceShots: state.analysis.shots.map((s: { source_start: number; source_end: number }) => ({ path, filename: `${id}.mp4`, start: s.source_start, end: s.source_end })) });
  assert.equal(manifest.shots.length, 2);
  assert.equal(manifest.audio, "original");
  assert(manifest.shots.every(s => s.clip_source === "source"));
  assert(Math.abs((await probeDuration(join(paths.RENDERS_DIR, `${id}.mp4`)))! - 3) < 0.15);
  assert(!manifest.warnings.some(w => /failed/i.test(w)), manifest.warnings.join("\n"));
});

test("storyboard edits update word text, source bounds, B-roll, and beat metadata together", async () => {
  const masterId = "master-timeline";
  const shortId = "short-timeline";
  const ctx = { params: Promise.resolve({ videoId: shortId }) };
  const shortUrl = `http://localhost/api/analyze/${shortId}/timeline`;
  const readState = async () => (await api.GET(new NextRequest(shortUrl), ctx)).json();
  const change = async (version: string, operation: unknown) => api.PATCH(new NextRequest(shortUrl, { method: "PATCH", body: JSON.stringify({ version, operation }) }), ctx);
  const now = new Date().toISOString();
  for (const target of [join(paths.STORYBOARDS_DIR, `${masterId}.mp4`), join(paths.EDITING_DIR, `${shortId}.mp4`), join(paths.LIBRARY_DIR, "attached.mp4")]) await fs.copyFile(join(paths.EDITING_DIR, `${id}.mp4`), target);
  await fs.mkdir(join(paths.STORYBOARDS_DIR, masterId, "footage"), { recursive: true });
  await fs.writeFile(join(paths.STORYBOARDS_DIR, masterId, "footage", "manifest.json"), JSON.stringify({ videoId: masterId, items: [{ clip: { filename: "attached.mp4", createdAt: now, updatedAt: now }, duration: 6, offset: 10, addedAt: now, segments: [], transcript: "Attached speech", timing: "whole_clip", included: true }] }));
  const words = ["One", "two.", "Three", "four.", "Five", "six."].map((word, i) => ({ i, word, start: i + 0.1, end: i + 0.8, score: 1, interpolated: false }));
  await fs.writeFile(paths.sidecarPath(masterId, "segments"), JSON.stringify({ words, sentences: [] }));
  const meta = { kind: "cutdown", masterId, masterFilename: `${masterId}.mp4`, storyboardId: "story", title: "Fixture", hookLine: "One two.", targetDuration: 4, timingSource: "whisperx", createdAt: now,
    beats: [ { section: "hook", source_start: 0, source_end: 2, start: 0, end: 2, text: "One two.", on_screen_text: "Hook", show: "source" },
      { section: "end", source: { filename: "attached.mp4", offset: 10 }, source_start: 11, source_end: 13, start: 2, end: 4, text: "Attached speech", on_screen_text: "End", show: "source" } ] };
  await fs.writeFile(join(paths.EDITING_DIR, `${shortId}.mp4.metadata.json`), JSON.stringify(meta));
  const { analysisFromCutdown } = await import("../src/lib/cutdown-build");
  // Validate through the production metadata schema.
  const { CutdownProjectMetaZ } = await import("../src/lib/project-meta");
  await fs.writeFile(paths.analysisPath(shortId), JSON.stringify(analysisFromCutdown(shortId, CutdownProjectMetaZ.parse(meta), 4)));
  const segment = { id: "word-roll", anchor: { kind: "words", shot_index: 0, start_word: 0, end_word: 1 }, clip: { filename: "attached.mp4", clip_start: 0, source: "library" }, status: "placed", phrase: "One two.", description: null, candidates: [], createdAt: now };
  await fs.writeFile(paths.sidecarPath(shortId, "broll"), JSON.stringify({ videoId: shortId, updatedAt: now, segments: [segment] }));
  const { DEFAULT_FRAMING } = await import("../src/lib/framing-schema");
  await fs.writeFile(paths.sidecarPath(shortId, "framing"), JSON.stringify({ version: 1, revision: 0, videoId: shortId, updatedAt: now, shots: { "0": DEFAULT_FRAMING }, broll: {} }));
  let state = await readState();
  assert.equal(state.sources[1].min, 10);
  assert.equal(state.sources[1].max, 16);
  assert.equal(state.sources[1].url, "/api/library/clips/attached.mp4");
  state = await (await change(state.version, { type: "trim", index: 0, start: 0, end: 3 })).json();
  assert.equal(state.analysis.shots[0].spoken_text, "One two. Three");
  assert.equal(state.project.beats[0].text, "One two. Three");
  assert.equal(state.project.beats[1].start, 3);
  state = await (await change(state.version, { type: "move", index: 0, to: 1 })).json();
  assert.equal(state.project.beats[0].source.filename, "attached.mp4");
  assert.equal(state.analysis.shots[1].source_start, 0);
  assert.equal(state.sidecars.broll.segments[0].anchor.shot_index, 1);
  assert.deepEqual(state.sidecars.framing.shots["1"], DEFAULT_FRAMING);
  assert.equal((await change(state.version, { type: "trim", index: 0, start: 9, end: 13 })).status, 400);
  state = await (await change(state.version, { type: "trim", index: 0, start: 12, end: 15 })).json();
  assert.equal(state.analysis.shots[0].spoken_text, "Attached speech");
  assert.equal(state.project.beats[0].source_start, 12);
  state = await (await change(state.version, { type: "remove", index: 1 })).json();
  assert.equal(state.sidecars.broll.segments.length, 0);
  state = await (await change(state.version, { type: "undo" })).json();
  assert.equal(state.sidecars.broll.segments[0].anchor.shot_index, 1);
  assert.equal(state.project.beats[1].text, "One two. Three");
});
