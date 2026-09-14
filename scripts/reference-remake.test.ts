import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { seedReferenceDraft } from "../src/lib/reference-draft";
import type { Analysis } from "../src/lib/analysis-schema";
import type { Recommendation, ShotRecommendations } from "../src/lib/recommendation-schema";

const exec = promisify(execFile);
let root: string;
let paths: typeof import("../src/lib/paths");
let api: typeof import("../src/app/api/analyze/[videoId]/recommendations/route");
const id = "900000001";
const context = { params: Promise.resolve({ videoId: id }) };
const req = (body: unknown) => new NextRequest(`http://localhost/api/analyze/${id}/recommendations`, { method: "PATCH", body: JSON.stringify(body) });
const rec = (filename: string, confidence: Recommendation["confidence"] = "strong"): Recommendation => ({ filename, confidence, duration: 4, reason: "Product close-up", source: "gemini", tag_overlap: ["product"], score: 4, trim_start: 1, trim_end: 3, moment_note: "Product revealed" });
const analysis: Analysis = { videoId: id, analyzedAt: "2026-09-01", taggedAt: "2026-09-01", model: "fixture", summary: "Reference", hook_description: "Reveal", format: "tutorial", tags: [], music: { title: "", author: "", usage: "original_audio_talking", usage_note: "" }, full_transcript: "hello again", shots: [0, 2].map((start_time, index) => ({ index, start_time, end_time: start_time + 2, description: "Product close-up", on_screen_text: "", spoken_text: "hello", camera_style: "static", screenshot: "" })) };
const matches = (): ShotRecommendations => ({ videoId: id, generatedAt: "2026-09-01", model: "fixture", clipsConsidered: 2, shots: [0, 1].map(shot_index => ({ shot_index, recommendations: [rec("red.mp4"), rec("green.mp4")] })) });
const read = async () => JSON.parse(await fs.readFile(paths.sidecarPath(id, "recommendations"), "utf8")) as ShotRecommendations;
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "reference-remake-")); process.env.DATA_DIR = root;
  paths = await import("../src/lib/paths"); await paths.ensureDataDirs();
  api = await import("../src/app/api/analyze/[videoId]/recommendations/route");
  for (const color of ["red", "green", "blue"]) {
    const file = color === "blue" ? join(paths.DOWNLOADS_DIR, `${id}.mp4`) : join(paths.LIBRARY_DIR, `${color}.mp4`);
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=90x160:r=30:d=4`, "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  }
  await fs.writeFile(paths.analysisPath(id), JSON.stringify(analysis));
  await fs.writeFile(paths.LIBRARY_METADATA_FILE, JSON.stringify({ videos: [], lastUpdated: "2026-09-01T00:00:00.000Z" }));
  await fs.writeFile(paths.sidecarPath(id, "recommendations"), JSON.stringify(seedReferenceDraft(analysis, matches())));
});
after(() => fs.rm(root, { recursive: true, force: true }));

test("automatic draft prefers distinct usable library moments and marks unresolved slots", () => {
  const draft = seedReferenceDraft(analysis, matches());
  assert.deepEqual(draft.shots.map(s => s.selected_filename), ["red.mp4", "green.mp4"]);
  assert(draft.shots.every(s => s.choice_origin === "automatic" && !s.keep_source));
  const bad = matches();
  bad.shots[0].recommendations = [{ ...rec("weak.mp4", "weak") }, { ...rec("short.mp4"), duration: 1 }, { ...rec("untrimmed.mp4"), trim_start: null, trim_end: null }];
  const unresolved = seedReferenceDraft(analysis, bad);
  assert.equal(unresolved.shots[0].keep_source, true);
  assert.equal(unresolved.shots[0].needs_replacement, true);
});

test("rematching retains confirmed clips, exact trims, and explicit originals even if a file disappears", () => {
  const prior = seedReferenceDraft(analysis, matches());
  prior.shots[0].choice_origin = "user";
  prior.shots[0].recommendations[0].trim_start = 0.5;
  prior.shots[0].recommendations[0].trim_end = 2.5;
  prior.shots[1].choice_origin = "user"; prior.shots[1].keep_source = true;
  const fresh = matches(); fresh.shots.forEach(s => { s.recommendations = []; });
  const next = seedReferenceDraft(analysis, fresh, prior);
  assert.equal(next.shots[0].selected_filename, "red.mp4");
  assert.equal(next.shots[0].recommendations[0].trim_start, 0.5);
  assert.equal(next.shots[1].keep_source, true);
});

test("selection clears the original override, persists exact timing, and supports reload/undo/redo", async () => {
  const { referenceHistory } = await import("../src/lib/reference-selection");
  assert.equal((await api.PATCH(req({ shot_index: 0, keep_source: true }), context)).status, 200);
  const selected = await api.PATCH(req({ shot_index: 0, filename: "green.mp4", trim_start: 0.5 }), context);
  assert.equal(selected.status, 200, JSON.stringify(await selected.clone().json()));
  let current = await read();
  assert.equal(current.shots[0].keep_source, false);
  assert.equal(current.shots[0].choice_origin, "user");
  assert.equal(current.shots[0].recommendations.find(r => r.filename === "green.mp4")!.trim_start, 0.5);
  assert.equal((await referenceHistory(id)).canUndo, true);
  current = (await referenceHistory(id, "undo")).recommendations;
  assert.equal(current.shots[0].keep_source, true);
  current = (await referenceHistory(id, "redo")).recommendations;
  assert.equal(current.shots[0].selected_filename, "green.mp4");
  assert.equal(current.shots[0].keep_source, false);
  const invalid = await api.PATCH(req({ shot_index: 0.5, filename: "red.mp4" }), context);
  assert.equal(invalid.status, 400);
  const pastEnd = await api.PATCH(req({ shot_index: 0, filename: "red.mp4", trim_start: 3 }), context);
  assert.equal(pastEnd.status, 400);
  assert.equal((await read()).shots[0].selected_filename, "green.mp4");
});

test("confirmed duplicate choices agree across draft preview and real exported frames, preserving audio", async () => {
  const recs = await read();
  const { previewSources } = await import("../src/lib/framing-plan");
  const { shotSources } = await import("../src/lib/framing-sources");
  const { renderRemake, planShots } = await import("../src/lib/render-remake");
  const { referenceExportIssues } = await import("../src/lib/reference-selection");
  const path = join(paths.DOWNLOADS_DIR, `${id}.mp4`);
  const originals = await shotSources(path, analysis);
  const sources = await previewSources(id, path, analysis, originals);
  assert.equal(sources[0][0].url, "/api/library/clips/green.mp4");
  assert.equal(sources[0][0].start, 0.5);
  assert.equal(sources[1][0].url, "/api/library/clips/green.mp4");
  assert.deepEqual(await referenceExportIssues(analysis, recs), []);
  const planned = planShots(analysis, recs, `${id}.mp4`, new Map([["red.mp4", 4], ["green.mp4", 4]]), new Map(), new Map(), []);
  assert(planned.planned.every(s => s.clip === "green.mp4"));
  const manifest = await renderRemake({ videoId: id, analysis, recs, sourceVideo: `${id}.mp4`, library: { videos: [], lastUpdated: "2026-09-01T00:00:00.000Z" }, editNotes: {}, burnText: false, audio: "original", originalSources: originals });
  assert.equal(manifest.audio, "original");
  assert(manifest.shots.every(s => s.clip === "green.mp4"));
  const output = join(paths.RENDERS_DIR, `${id}.mp4`);
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", output]);
  const probe = JSON.parse(stdout);
  assert(Math.abs(Number(probe.format.duration) - 4) < 0.15);
  assert(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio"));
  for (const time of [1, 3]) {
    const frame = await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
    assert(frame.stdout[1] > frame.stdout[0] + 40 && frame.stdout[1] > frame.stdout[2] + 40, `frame at ${time}s should be green`);
  }
  await fs.rename(join(paths.LIBRARY_DIR, "green.mp4"), join(root, "green.mp4"));
  assert((await referenceExportIssues(analysis, recs)).length === 2);
  const missing = planShots(analysis, recs, `${id}.mp4`, new Map([["red.mp4", 4], ["green.mp4", null]]), new Map(), new Map(), []);
  assert(missing.planned.every(s => s.clip_source === "source"), "missing choice must not silently select a different library clip");
  await fs.rename(join(root, "green.mp4"), join(paths.LIBRARY_DIR, "green.mp4"));
});

test("import requests reuse the project and saved preparation; empty libraries produce a recoverable draft", async () => {
  const { startReferenceImport, runReferenceImport, readReferenceImport } = await import("../src/lib/reference-import");
  const [first, repeated] = await Promise.all([startReferenceImport(id), startReferenceImport(id)]);
  assert.equal(first.filename, `${id}.mp4`);
  assert.deepEqual(first, repeated);
  await Promise.all([runReferenceImport(id), runReferenceImport(id)]);
  assert.equal((await readReferenceImport(id))?.status, "ready");
  // Empty library matching uses no model calls and leaves user decisions intact.
  const response = await api.POST(new NextRequest(`http://localhost/api/analyze/${id}/recommendations`, { method: "POST" }), context);
  assert.equal(response.status, 200);
  const draft: ShotRecommendations = await response.json();
  assert.equal(draft.shots[0].selected_filename, "green.mp4");
  assert.equal(draft.shots[1].needs_replacement, true);
  const { referenceExportIssues } = await import("../src/lib/reference-selection");
  assert.match((await referenceExportIssues(analysis, draft)).join(";"), /Keep original/);
});

test("generation only changes the active visual after acceptance, and acceptance clears Keep original", async () => {
  const { generatedClipDir, generationPath, emptyGenerations } = await import("../src/lib/generation-schema");
  const { POST: accept } = await import("../src/app/api/analyze/[videoId]/generation/accept/route");
  await api.PATCH(req({ shot_index: 1, keep_source: true }), context);
  const generated = emptyGenerations(id);
  const filename = "gen_s1_a1.mp4";
  await fs.mkdir(generatedClipDir(id), { recursive: true });
  await fs.copyFile(join(paths.LIBRARY_DIR, "red.mp4"), join(generatedClipDir(id), filename));
  generated.shots["1"] = { shot_index: 1, prompt: "Product close-up", prompt_source: "user", status: "ready", accepted_file: null,
    attempts: [{ attempt: 1, kind: "generate", prompt: "Product close-up", source_clip: null, reference_files: [], file: filename, duration: 4, interaction_id: null, status: "ready", error: null, video_seconds: 4, model: "fixture", createdAt: "2026-09-01" }] };
  await fs.writeFile(generationPath(id), JSON.stringify(generated));
  assert.equal((await read()).shots[1].keep_source, true);
  const response = await accept(new NextRequest(`http://localhost/api/analyze/${id}/generation/accept`, { method: "POST", body: JSON.stringify({ shot_index: 1, attempt: 1 }) }), context);
  assert.equal(response.status, 200);
  const current = await read();
  assert.equal(current.shots[1].selected_filename, filename);
  assert.equal(current.shots[1].choice_origin, "generated");
  assert.equal(current.shots[1].keep_source, false);
  const { referenceHistory } = await import("../src/lib/reference-selection");
  assert.equal((await referenceHistory(id, "undo")).recommendations.shots[1].keep_source, true);
});

test("restart recovery resumes saved analysis and matching without downloading or analyzing again", async () => {
  const { readReferenceImport, startReferenceImport, runReferenceImport } = await import("../src/lib/reference-import");
  const job = await readReferenceImport(id);
  await fs.writeFile(paths.sidecarPath(id, "reference-import"), JSON.stringify({ ...job, workerId: "previous-server", status: "matching" }));
  assert.equal((await readReferenceImport(id))?.status, "failed");
  const before = await fs.readFile(paths.analysisPath(id), "utf8");
  await startReferenceImport(id);
  await runReferenceImport(id);
  assert.equal((await readReferenceImport(id))?.status, "ready");
  assert.equal(await fs.readFile(paths.analysisPath(id), "utf8"), before);
});
