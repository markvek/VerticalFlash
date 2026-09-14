import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

let root: string;
let paths: typeof import("../src/lib/paths");
let library: typeof import("../src/lib/library-store");
let metadata: typeof import("../src/app/api/library/route");
const now = "2026-09-01T00:00:00.000Z";
const clip = { filename: "clip.mp4", date: now, source: "old source", description: "old human description", tags: ["car", "wrong"],
  createdAt: now, updatedAt: now, duration: 2, analysis: { location: "interior", product_present: false, product_note: "", time_of_day: "unclear", camera_action: "static", category: "demo", spoken_text: "", description: "old AI description", suggested_tags: ["car", "wrong"], analyzedAt: now, model: "fixture" } };
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "verticalflash-backend-"));
  process.env.DATA_DIR = root;
  paths = await import("../src/lib/paths");
  await paths.ensureDataDirs();
  library = await import("../src/lib/library-store");
  metadata = await import("../src/app/api/library/route");
  await fs.writeFile(join(paths.LIBRARY_DIR, clip.filename), "fixture");
  await fs.writeFile(paths.LIBRARY_METADATA_FILE, JSON.stringify({ videos: [clip], lastUpdated: now }));
});
after(() => fs.rm(root, { recursive: true, force: true }));
const patch = (body: unknown) => metadata.POST(new NextRequest("http://localhost/api/library", { method: "POST", body: JSON.stringify(body) }));

test("human corrections and rejected AI tags reach planning, and clearing differs from omission", async () => {
  assert.equal((await patch({ filename: clip.filename, description: "corrected description", tags: ["car"] })).status, 200);
  const { loadCatalogSummary } = await import("../src/lib/shot-plan");
  const { clipTags, clipDescription } = await import("../src/lib/library-metadata");
  let catalog = await loadCatalogSummary();
  assert.equal(catalog[0].description, "corrected description");
  assert.deepEqual(catalog[0].tags, ["car"]);
  let saved = (await library.loadLibrary()).videos[0];
  assert.deepEqual(saved.rejected_tags, ["wrong"]);
  assert.equal(saved.source, "old source");
  assert.deepEqual(clipTags({ ...saved, analysis: { ...saved.analysis!, suggested_tags: ["WRONG", "car", "new"] } }), ["car", "new"]);
  assert.equal((await patch({ filename: clip.filename, description: "", source: null, date: "" })).status, 200);
  saved = (await library.loadLibrary()).videos[0];
  assert.equal(saved.description, ""); assert.equal(saved.source, null); assert.equal(saved.date, null);
  catalog = await loadCatalogSummary();
  assert.equal(catalog[0].description, "");
  assert.equal(clipDescription({ ...saved, description: null }), "");
  assert.equal((await patch({ filename: clip.filename, tags: "not-an-array" })).status, 400);
  assert.equal((await patch({ filename: clip.filename, tags: ["car", "wrong"] })).status, 200);
  assert.deepEqual((await library.loadLibrary()).videos[0].rejected_tags, []);
});

test("damaged catalogs fail visibly without replacing the original or the valid backup", async () => {
  const valid = await fs.readFile(paths.LIBRARY_METADATA_FILE, "utf8");
  const backup = await fs.readFile(`${paths.LIBRARY_METADATA_FILE}.bak`, "utf8");
  assert.doesNotThrow(() => JSON.parse(backup));
  const damaged = '{"videos": [';
  await fs.writeFile(paths.LIBRARY_METADATA_FILE, damaged);
  await assert.rejects(library.loadLibrary(), library.LibraryRecoveryError);
  await assert.rejects(library.saveLibrary({ videos: [], lastUpdated: now }), library.LibraryRecoveryError);
  const res = await patch({ filename: clip.filename, description: "must not save" });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).recoveryRequired, true);
  assert.equal(await fs.readFile(paths.LIBRARY_METADATA_FILE, "utf8"), damaged);
  assert.equal(await fs.readFile(`${paths.LIBRARY_METADATA_FILE}.bak`, "utf8"), backup);
  await fs.writeFile(paths.LIBRARY_METADATA_FILE, valid);
});

test("render revisions cover every saved edit input and options, with a delivery gate", async () => {
  const { renderRevision, renderIsStale, renderDeliveryError } = await import("../src/lib/render-revision");
  const id = "revision-fixture";
  await fs.writeFile(join(paths.EDITING_DIR, `${id}.mp4`), "fixture");
  const options = { audio: "none" as const, music_filename: null, burn_text: true };
  const revision = await renderRevision(id, options);
  const manifest = { videoId: id, editRevision: revision, requestedOptions: options, status: "ready" } as import("../src/lib/render-schema").RenderManifest;
  assert.equal(await renderDeliveryError(manifest), null);
  for (const kind of ["recommendations", "edit-notes", "text-overlays", "framing", "broll", "model-selection"]) {
    await fs.writeFile(paths.sidecarPath(id, kind), JSON.stringify({ changed: kind }));
    assert.equal(await renderIsStale(manifest), true, kind);
    await fs.unlink(paths.sidecarPath(id, kind));
  }
  await fs.writeFile(paths.analysisPath(id), JSON.stringify({ shots: [{ on_screen_text: "new text" }] }));
  assert.equal(await renderIsStale(manifest), true);
  await fs.unlink(paths.analysisPath(id));
  assert.notEqual(await renderRevision(id, { ...options, audio: "music", music_filename: "song.mp3" }), revision);
  assert.notEqual(await renderRevision(id, { ...options, burn_text: false }), revision);
  assert.match((await renderDeliveryError({ ...manifest, status: "preview_with_issues" }))!, /Preview with issues/);
  assert.equal(await renderIsStale({ ...manifest, editRevision: undefined }), true);
});

test("a later upload cannot disqualify an earlier published version, and duplicates are not rival projects", async () => {
  const { matchPublished } = await import("../src/lib/match-published");
  const earlier = { videoId: "project", filename: "project.mp4", exportId: "old-export", publishId: "old-upload", durationSeconds: 10,
    renderedAt: now, uploadedAt: now, captionOptions: ["A great clip"] };
  const post = { id: "post", title: "A great clip", duration: 10, createTime: Date.parse("2026-09-02T00:00:00Z") / 1000 };
  const later = { ...earlier, exportId: "new-export", publishId: "new-upload", durationSeconds: 30, uploadedAt: "2026-09-10T00:00:00Z" };
  const matches = matchPublished([post], [later, earlier, { ...earlier, publishId: "duplicate" }]);
  assert.equal(matches.length, 1); assert.equal(matches[0].exportId, "old-export");
  assert.deepEqual(matchPublished([post], [earlier, { ...earlier, videoId: "other-project" }]), []);
});

test("failed searches return errors instead of a successful empty catalog", async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.TIKHUB_API_KEY;
  process.env.TIKHUB_API_KEY = "fixture";
  globalThis.fetch = async () => { throw new Error("fixture search unavailable"); };
  try {
    const { POST } = await import("../src/app/api/scan/route");
    const res = await POST(new NextRequest("http://localhost/api/scan", { method: "POST", body: JSON.stringify({ keywords: "backend-fixture-never-cached" }) }));
    assert.equal(res.status, 502); const body = await res.json(); assert.match(body.error, /Could not search/); assert.equal(body.errors.length, 1);
  } finally { globalThis.fetch = originalFetch; if (oldKey === undefined) delete process.env.TIKHUB_API_KEY; else process.env.TIKHUB_API_KEY = oldKey; }
});

const fixtureAnalysis = (videoId: string) => ({ videoId, analyzedAt: now, model: "fixture", summary: "", hook_description: "", format: "tutorial", tags: [], music: { title: "", author: "", usage: "original_audio_talking", usage_note: "" }, full_transcript: "", shots: [{ index: 0, start_time: 0, end_time: 1, description: "fixture shot", on_screen_text: "", spoken_text: "", camera_style: "static", screenshot: "" }] });

test("Generate uses the submitted prompt even when the stored prompt is older", async () => {
  const id = "exact-prompt";
  await fs.writeFile(paths.analysisPath(id), JSON.stringify(fixtureAnalysis(id)));
  const { loadGenerations, saveGenerations, getOrCreateShot } = await import("../src/lib/generation-store");
  const generations = await loadGenerations(id);
  getOrCreateShot(generations, 0).prompt = "old saved prompt";
  await saveGenerations(generations);
  const oldDryRun = process.env.GENAI_VIDEO_DRY_RUN;
  process.env.GENAI_VIDEO_DRY_RUN = "1";
  try {
    const { POST } = await import("../src/app/api/analyze/[videoId]/generation/generate/route");
    const context = { params: Promise.resolve({ videoId: id }) };
    const res = await POST(new NextRequest("http://localhost/generate", { method: "POST", body: JSON.stringify({ shot_index: 0, use_references: false, prompt: "exact edited prompt" }) }), context);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal((await res.json()).shots["0"].attempts[0].prompt, "exact edited prompt");
    const empty = await POST(new NextRequest("http://localhost/generate", { method: "POST", body: JSON.stringify({ shot_index: 0, prompt: " " }) }), context);
    assert.equal(empty.status, 400);
  } finally { if (oldDryRun === undefined) delete process.env.GENAI_VIDEO_DRY_RUN; else process.env.GENAI_VIDEO_DRY_RUN = oldDryRun; }
});

test("real exports are ready only when complete, and downloads reject stale revisions", async () => {
  const { execFileAsync } = await import("../src/lib/ffmpeg");
  const { POST } = await import("../src/app/api/analyze/[videoId]/render/route");
  const { GET: download } = await import("../src/app/api/renders/[videoId]/route");
  const id = "render-fixture";
  const context = { params: Promise.resolve({ videoId: id }) };
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=90x160:r=30:d=1", "-c:v", "libx264", join(paths.EDITING_DIR, `${id}.mp4`)]);
  await fs.writeFile(paths.analysisPath(id), JSON.stringify(fixtureAnalysis(id)));
  const recs = { videoId: id, generatedAt: now, model: "fixture", clipsConsidered: 1, shots: [{ shot_index: 0, keep_source: true, selected_filename: null, recommendations: [] }] };
  await fs.writeFile(paths.sidecarPath(id, "recommendations"), JSON.stringify(recs));
  const render = () => POST(new NextRequest("http://localhost/render", { method: "POST", body: JSON.stringify({ audio: "none", burn_text: false }) }), context);
  const response = await render();
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const manifest = await response.json();
  assert.equal(manifest.status, "ready", JSON.stringify(manifest.warnings));
  assert.equal(manifest.stale, false);
  const request = new NextRequest(`http://localhost/api/renders/${id}?download=1&exportId=${manifest.exportId}`);
  const ready = await download(request, context);
  assert.equal(ready.status, 200); assert.match(ready.headers.get("content-disposition")!, /attachment/);
  const outputPath = join(paths.RENDERS_DIR, `${id}.mp4`);
  const originalBytes = await fs.readFile(outputPath);
  await fs.writeFile(outputPath, "corrupted export bytes");
  assert.equal((await download(request, context)).status, 409);
  await fs.writeFile(outputPath, originalBytes);
  await fs.writeFile(paths.sidecarPath(id, "text-overlays"), JSON.stringify({ changed: "new text" }));
  assert.equal((await download(request, context)).status, 409);
  await fs.unlink(paths.sidecarPath(id, "text-overlays"));
  recs.shots[0].keep_source = false;
  await fs.writeFile(paths.sidecarPath(id, "recommendations"), JSON.stringify(recs));
  const incomplete = await (await render()).json();
  assert.equal(incomplete.status, "preview_with_issues");
  const { POST: upload } = await import("../src/app/api/tiktok/upload/route");
  const blockedUpload = await upload(new NextRequest("http://localhost/api/tiktok/upload", { method: "POST", body: JSON.stringify({ videoId: id }) }));
  assert.equal(blockedUpload.status, 409);
  assert.match((await blockedUpload.json()).error, /Preview with issues/);
  assert(incomplete.issues.some((issue: { shot_index: number }) => issue.shot_index === 0));
  assert.equal((await download(new NextRequest(`http://localhost/api/renders/${id}?download=1`), context)).status, 409);
});

test("suggestions create an independent edit before the first render", async () => {
  const id = "variation-fixture";
  await fs.writeFile(join(paths.EDITING_DIR, `${id}.mp4`), "fixture media");
  await fs.writeFile(paths.analysisPath(id), JSON.stringify(fixtureAnalysis(id)));
  const variations = { videoId: id, generatedAt: now, model: "fixture", source: { publishedId: "post", title: "caption", duration: 1, createTime: 1, viewCount: 10000, likeCount: 100, commentCount: 1, shareCount: 2 }, suggestions: [{ id: "hook-1", kind: "hook", shot_index: 0, title: "Better hook", rationale: "fixture", fix_note: null, clip: null, text: "New hook", status: "proposed" }] };
  await fs.writeFile(paths.sidecarPath(id, "variations"), JSON.stringify(variations));
  const { POST } = await import("../src/app/api/downloads/[filename]/fork/route");
  const res = await POST(new NextRequest("http://localhost/fork", { method: "POST", body: JSON.stringify({ variation_id: "hook-1" }) }), { params: Promise.resolve({ filename: `${id}.mp4` }) });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const fork = await res.json();
  assert.notEqual(fork.videoId, id);
  const overlay = JSON.parse(await fs.readFile(paths.sidecarPath(fork.videoId, "text-overlays"), "utf8"));
  assert.equal(overlay.shots["0"].text, "New hook");
  assert.equal(JSON.parse(await fs.readFile(paths.sidecarPath(id, "variations"), "utf8")).suggestions[0].status, "proposed");
  await assert.rejects(fs.access(join(paths.RENDERS_DIR, `${fork.videoId}.mp4`)));
});

test("historical candidates survive re-renders and users can confirm or reject attribution", async () => {
  const id = "history-fixture";
  await fs.writeFile(join(paths.EDITING_DIR, `${id}.mp4`), "fixture");
  await fs.writeFile(paths.PUBLISH_STORE_PATH, JSON.stringify({ version: 1, publishes: [
    { videoId: id, version: 1, publishId: "first-upload", exportId: "first-export", uploadedAt: now, renderedAt: now, durationSeconds: 10, captionOptions: ["First caption"], status: "SEND_TO_USER_INBOX" },
    { videoId: id, version: 1, publishId: "second-upload", exportId: "second-export", uploadedAt: "2026-09-10T00:00:00Z", renderedAt: "2026-09-10T00:00:00Z", durationSeconds: 30, captionOptions: ["Second caption"], status: "SEND_TO_USER_INBOX" },
  ] }));
  const api = await import("../src/app/api/published-matches/route");
  const videos = [{ id: "historical-post", title: "First caption", duration: 10, createTime: Date.parse("2026-09-02T00:00:00Z") / 1000 }];
  const matches = async () => (await (await api.POST(new NextRequest("http://localhost/published-matches", { method: "POST", body: JSON.stringify({ videos }) }))).json()).matches;
  assert.equal((await matches())[0].publishId, "first-upload");
  const update = (publishId: string | null) => api.PATCH(new NextRequest("http://localhost/published-matches", { method: "PATCH", body: JSON.stringify({ publishedId: videos[0].id, publishId }) }));
  assert.equal((await update("second-upload")).status, 200);
  assert.equal((await matches())[0].exportId, "second-export");
  assert.equal((await matches())[0].confirmed, true);
  assert.equal((await update(null)).status, 200);
  assert.deepEqual(await matches(), []);
  assert.equal((await update("nonexistent")).status, 404);
});

test("TikTok ingestion is pending until inbox delivery is confirmed", async () => {
  const { tiktokUploadState } = await import("../src/lib/tiktok-upload-state");
  assert.equal(tiktokUploadState("PROCESSING_UPLOAD").httpStatus, 202);
  assert.equal(tiktokUploadState("PROCESSING_UPLOAD").success, false);
  assert.match(tiktokUploadState("PROCESSING_UPLOAD").message, /still processing/);
  assert.equal(tiktokUploadState("SEND_TO_USER_INBOX").success, true);
  assert.equal(tiktokUploadState("PUBLISH_COMPLETE").processing, false);
});
