import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

let root: string;
let paths: typeof import("../src/lib/paths");
const now = "2026-01-01T12:00:00.000Z";
const id = "workflow-fixture";
const context = { params: Promise.resolve({ videoId: id }) };
const request = (url: string, body?: unknown, method = "POST") => new NextRequest(`http://localhost${url}`, body === undefined ? undefined : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bytes = Buffer.from("0000ftypisom0000original-export");
const rawAnalysis = { videoId: id, analyzedAt: now, model: "fixture", summary: "Fixture", hook_description: "Hook", format: "tutorial", tags: [], music: { title: "", author: "", usage: "original", usage_note: "" }, full_transcript: "Hello", shots: [{ index: 0, start_time: 0, end_time: 2, description: "Product", on_screen_text: "", spoken_text: "Hello", camera_style: "static", screenshot: "" }] };

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "vf-workflow-regressions-"));
  process.env.DATA_DIR = root;
  paths = await import("../src/lib/paths");
  await paths.ensureDataDirs();
  await fs.writeFile(join(paths.EDITING_DIR, `${id}.mp4`), bytes);
  await fs.writeFile(paths.analysisPath(id), JSON.stringify(rawAnalysis));
});
after(() => fs.rm(root, { recursive: true, force: true }));

test("human corrections reach planning; empty fields clear; concurrent changes and absent footage retain metadata", async () => {
  const api = await import("../src/app/api/library/route");
  const store = await import("../src/lib/library-store");
  const schema = await import("../src/lib/library-schema");
  const { loadCatalogSummary } = await import("../src/lib/shot-plan");
  const clip = { filename: "product.mp4", date: now, source: "camera", description: "AI old", tags: ["old"], duration: 2, createdAt: now, updatedAt: now, analysis: { location: "interior", product_present: true, product_note: "visible", time_of_day: "morning", camera_action: "static", category: "product_showcase", spoken_text: "Wrong transcript", description: "AI old", suggested_tags: ["old"], analyzedAt: now, model: "fixture" } };
  await fs.writeFile(join(paths.LIBRARY_DIR, clip.filename), bytes);
  await store.saveLibrary(schema.ClipLibraryZ.parse({ videos: [clip, { ...clip, filename: "offline.mp4", source: "preserve me" }], lastUpdated: now }));
  const corrected = await api.POST(request("/api/library", { filename: clip.filename, description: "Correct product", tags: ["Human"], spoken_text: "Correct words" }));
  assert.equal(corrected.status, 200, JSON.stringify(await corrected.clone().json()));
  assert.equal((await loadCatalogSummary()).find(c => c.filename === clip.filename)?.description, "Correct product");
  let saved = (await store.loadLibrary()).videos.find(c => c.filename === clip.filename)!;
  assert.deepEqual(schema.clipTags(saved), ["human"]);
  assert.equal(schema.clipTranscript(saved), "Correct words");
  assert.equal(saved.analysis?.description, "AI old", "original AI evidence is retained");
  const responses = await Promise.all([
    api.POST(request("/api/library", { filename: clip.filename, description: null, source: null, date: null })),
    api.POST(request("/api/library", { filename: clip.filename, tags: [] })),
  ]);
  assert(responses.every(r => r.ok));
  const library = await store.loadLibrary(); saved = library.videos.find(c => c.filename === clip.filename)!;
  assert.equal(schema.clipDescription(saved), ""); assert.deepEqual(schema.clipTags(saved), []);
  assert.equal(saved.source, null); assert.equal(saved.date, null);
  assert.equal(library.videos.find(c => c.filename === "offline.mp4")?.source, "preserve me");
});

test("corrupt catalogs are never replaced by empty data; recovery preserves damaged bytes", async () => {
  const store = await import("../src/lib/library-store");
  const valid = await store.loadLibrary(); await store.saveLibrary(valid);
  const backup = await fs.readFile(`${paths.LIBRARY_METADATA_FILE}.bak`, "utf8");
  await fs.writeFile(paths.LIBRARY_METADATA_FILE, "{broken");
  await assert.rejects(store.loadLibrary, /preserved/);
  await assert.rejects(() => store.saveLibrary(valid), /preserved/);
  assert.equal(await fs.readFile(paths.LIBRARY_METADATA_FILE, "utf8"), "{broken");
  assert.equal(await fs.readFile(`${paths.LIBRARY_METADATA_FILE}.bak`, "utf8"), backup);
  await store.restoreLibraryBackup();
  const preserved = (await fs.readdir(paths.LIBRARY_DIR)).find(f => f.includes(".preserved-"))!;
  assert.equal(await fs.readFile(join(paths.LIBRARY_DIR, preserved), "utf8"), "{broken");
  assert.deepEqual(await store.loadLibrary(), valid);
});

test("export revision includes every editable sidecar and changed source media", async () => {
  const { editRevision } = await import("../src/lib/export-state");
  const original = await editRevision(id);
  for (const kind of ["recommendations", "framing", "broll", "edit-notes", "text-overlays", "model-selection", "export-options"]) {
    const path = paths.sidecarPath(id, kind);
    await fs.writeFile(path, JSON.stringify({ changed: kind }));
    assert.notEqual(await editRevision(id), original, kind);
    await fs.rm(path);
  }
  const clip = join(paths.LIBRARY_DIR, "product.mp4"); await fs.appendFile(clip, "changed media");
  assert.notEqual(await editRevision(id), original);
});

test("immutable exports survive re-rendering; stale downloads are rejected while previews remain readable", async () => {
  const { archiveExport, editRevision, exportState, exportPaths, exportIssues } = await import("../src/lib/export-state");
  const { RenderManifestZ, RENDER_SETTINGS } = await import("../src/lib/render-schema");
  const media = await import("../src/app/api/renders/[videoId]/route");
  const options = { audio: "none" as const, music_filename: null, burn_text: false };
  const manifest = RenderManifestZ.parse({ videoId: id, renderedAt: now, sourceVideo: `${id}.mp4`, output: `${id}.mp4`, durationSeconds: 2, settings: RENDER_SETTINGS, recommendationsGeneratedAt: now, clipsConsidered: 0, audio: "none", time_mode: "none", time_target: null, warnings: [], shots: [] });
  const current = join(paths.RENDERS_DIR, `${id}.mp4`);
  await fs.writeFile(current, bytes);
  const first = await archiveExport(current, manifest, await editRevision(id), options);
  await fs.writeFile(join(paths.RENDERS_DIR, `${id}.render.json`), JSON.stringify(first));
  assert.equal((await exportState(first)).ready, true);
  let response = await media.GET(request(`/api/renders/${id}?export=${first.exportId}&download=1`), context);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /attachment/);
  await fs.writeFile(current, Buffer.from("0000ftypisom0000new-export"));
  assert.deepEqual(await fs.readFile(exportPaths(id, first.exportId!).video), bytes);
  await fs.writeFile(paths.sidecarPath(id, "edit-notes"), JSON.stringify({ notes: { 0: "Zoom in" } }));
  response = await media.GET(request(`/api/renders/${id}?export=${first.exportId}&download=1`), context);
  assert.equal(response.status, 409);
  assert.equal((await media.GET(request(`/api/renders/${id}?export=${first.exportId}`), context)).status, 200);
  assert(exportIssues({ shots: [], warnings: ["Text rendering failed — rendered without it"], audio: "none" }, options).length);
  assert(exportIssues({ shots: [], warnings: [], audio: "none" }, { ...options, audio: "original" }).length);
});

test("publication links use historical uploaded duration and can be confirmed or unlinked", async () => {
  const { recordPublish, readPublishStore } = await import("../src/lib/publish-store");
  const api = await import("../src/app/api/published-matches/route");
  const latestPath = join(paths.RENDERS_DIR, `${id}.render.json`);
  const original = JSON.parse(await fs.readFile(latestPath, "utf8"));
  await recordPublish({ videoId: id, publishId: "upload-original", status: "SEND_TO_USER_INBOX", exportId: original.exportId });
  await fs.writeFile(latestPath, JSON.stringify({ ...original, durationSeconds: 40, exportId: undefined }));
  const history = (await readPublishStore()).publishes[0];
  assert.equal(history.durationSeconds, 2); assert.equal(history.exportId, original.exportId);
  const videos = [{ id: "published", title: "", duration: 2, createTime: Date.parse(history.uploadedAt) / 1000 + 60 }];
  let response: Response = await api.POST(request("/api/published-matches", { videos }));
  assert.equal((await response.json()).matches[0].exportId, original.exportId);
  response = await api.PATCH(request("/api/published-matches", { publishedId: "published", videoId: id, exportId: original.exportId }, "PATCH"));
  assert.equal(response.status, 200);
  assert.equal((await (await api.POST(request("/api/published-matches", { videos }))).json()).matches[0].confirmed, true);
  await api.PATCH(request("/api/published-matches", { publishedId: "published", videoId: null }, "PATCH"));
  assert.deepEqual((await (await api.POST(request("/api/published-matches", { videos }))).json()).matches, []);
});

test("stored activity rejects duplicate work and preserves restart and retry history", async () => {
  const activity = await import("../src/lib/workflow-activity");
  const first = (await activity.beginActivity(id, "Render preview"))!;
  assert.equal(await activity.beginActivity(id, "Render preview"), null);
  await fs.writeFile(join(root, "workflow-activity", `${first.id}.json`), JSON.stringify({ ...first, worker: "previous-server" }));
  assert.equal((await activity.readActivity(id)).find(r => r.id === first.id)?.status, "interrupted");
  const retry = (await activity.beginActivity(id, "Render preview"))!;
  assert.equal(retry.attempt, 2);
  await activity.finishActivity(retry, null, 2);
  const summary = activity.activitySummary(await activity.readActivity(id));
  assert.equal(summary.exportsWithIssues, 1); assert.equal(summary.failures["Render preview"], 1);
});

test("new analyses have stable shot IDs and existing indexed edits block reanalysis", async () => {
  const { AnalysisZ } = await import("../src/lib/analysis-schema");
  const { assertAnalysisReplaceable } = await import("../src/lib/analysis-replacement");
  const original = AnalysisZ.parse(rawAnalysis), reloaded = AnalysisZ.parse(rawAnalysis);
  assert.equal(original.shots[0].id, reloaded.shots[0].id);
  assert.equal(AnalysisZ.parse({ ...original, shots: [{ ...original.shots[0], index: 3, end_time: 1 }] }).shots[0].id, original.shots[0].id);
  await assert.rejects(() => assertAnalysisReplaceable(id), /preserved/);
  await fs.rm(paths.sidecarPath(id, "edit-notes"));
  await assertAnalysisReplaceable(id);
});

test("generation attempts record the exact submitted prompt and preserve concurrent human edits", async () => {
  const { executeGenerationAttempt } = await import("../src/lib/generation-run");
  const store = await import("../src/lib/generation-store");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  const operation = executeGenerationAttempt({ videoId: id, shotIndex: 0, kind: "generate", prompt: "Exact submitted prompt", sourceClip: null, referenceFiles: [], targetSeconds: 2, run: async () => { started(); await pending; return { file: "gen_s0_a1.mp4", duration: 2, interactionId: "fixture", videoSeconds: 2 }; } });
  await began;
  await store.mutateGenerations(id, current => { store.getOrCreateShot(current, 0).prompt = "A newer draft"; });
  release(); await operation;
  const saved = await store.loadGenerations(id);
  assert.equal(saved.shots["0"].prompt, "A newer draft");
  assert.equal(saved.shots["0"].attempts[0].prompt, "Exact submitted prompt");
});

test("AI judge rejects missing or invented scores; metric cohorts separate age and duration", async () => {
  const { parseJudgeResponse } = await import("../src/lib/benchmark-ai-judge");
  const { matchesCohort } = await import("../src/lib/metric-cohorts");
  assert.throws(() => parseJudgeResponse('{"winner":"A","variants":[{"label":"A"}]}', ["A"]));
  const score = { label: "A", virality: 70, hook: 7, pacing: 6, clarity: 8, polish: 5, broll_fit: 5, wouldPost: false, rationale: "Text assessment" };
  assert.equal(parseJudgeResponse(JSON.stringify({ winner: "A", variants: [score] }), ["A"]).variants[0].virality, 70);
  assert.throws(() => parseJudgeResponse(JSON.stringify({ winner: "A", variants: [score, score] }), ["A", "B"]));
  const observed = Date.parse(now), video = { createTime: observed / 1000 - 3 * 86400, duration: 20 };
  assert(matchesCohort(video, "week", "medium", observed));
  assert(!matchesCohort(video, "month", "medium", observed));
  assert(!matchesCohort(video, "week", "short", observed));
});

test("failed search requests return an error instead of an empty successful scan", async () => {
  const { POST } = await import("../src/app/api/scan/route");
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Fixture unavailable"); };
  try {
    const response = await POST(request("/api/scan", { hashtags: "fixture", expand: false }));
    assert.equal(response.status, 502); assert.match((await response.json()).error, /Could not search hashtag/);
  } finally { globalThis.fetch = previous; }
});
