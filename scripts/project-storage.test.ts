import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import type { MasterStoryboards, MasterSegments } from "../src/lib/segments-schema";

const exec = promisify(execFile);
let root: string;
let paths: typeof import("../src/lib/paths");
let store: typeof import("../src/lib/storyboard-store");
let media: typeof import("../src/lib/download-files");
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "verticalflash-project-test-"));
  process.env.DATA_DIR = root;
  process.env.STORYBOARD_DRY_RUN = "1";
  paths = await import("../src/lib/paths");
  store = await import("../src/lib/storyboard-store");
  media = await import("../src/lib/download-files");
  await paths.ensureDataDirs();
});
after(() => fs.rm(root, { recursive: true, force: true }));

const idea = {
  id: "sb-first", title: "First angle", angle: "An interview highlight", hook_line: "First sentence.",
  target_seconds: 6, estimated_seconds: 6,
  beats: [0, 2, 4].map((start, index) => ({
    section: (["hook", "main", "end"] as const)[index], start, end: start + 2,
    start_word: null, end_word: null, text: index === 0 ? "First sentence." : "Another sentence.",
    on_screen_text: "", show: "source" as const, broll_hint: null,
  })),
};
const document: MasterStoryboards = {
  videoId: "master-legacy", generatedAt: "2026-09-05T12:00:00.000Z", model: "test", timing_source: "gemini",
  request: { count: 1, lengths: [6], pacing: "standard", allow_broll: false, brief: "" },
  storyboards: [idea], accepted: { [idea.id]: "short-existing.mp4" },
};

test("legacy ideas, revisions, and concurrent edit references survive new generations", async () => {
  const legacyPath = paths.sidecarPath(document.videoId, "storyboards");
  const original = JSON.stringify(document);
  await fs.writeFile(legacyPath, original);
  await store.writeStoryboards({ ...document, storyboards: [{ ...idea, id: "sb-second" }], accepted: {} });
  let saved = (await store.readStoryboards(document.videoId))!;
  assert.equal(saved.storyboards.length, 2);
  assert.equal(saved.accepted?.[idea.id], "short-existing.mp4");
  assert.equal(await fs.readFile(legacyPath, "utf8"), original);

  await Promise.all([
    store.recordStoryboardEdit(document.videoId, idea, "short-a.mp4"),
    store.recordStoryboardEdit(document.videoId, idea, "short-b.mp4"),
    store.writeStoryboards({ ...document, storyboards: [{ ...idea, id: "sb-third" }], accepted: {} }),
  ]);
  saved = (await store.readStoryboards(document.videoId))!;
  assert.equal(saved.storyboards.length, 3);
  assert.deepEqual(new Set(saved.editing_projects?.[idea.id]), new Set(["short-existing.mp4", "short-a.mp4", "short-b.mp4"]));

  await store.updateSavedStoryboard(document.videoId, idea.id, (record) => {
    record.storyboards[0].title = "Revised angle";
  });
  await store.recordStoryboardEdit(document.videoId, idea, "short-late.mp4");
  saved = (await store.readStoryboards(document.videoId))!;
  assert.equal(saved.storyboards.find((item) => item.id === idea.id)?.revision, 2);
  assert.equal(saved.accepted?.[idea.id], undefined);
  const revision = JSON.parse(await fs.readFile(join(paths.STORYBOARDS_DIR, document.videoId, "revisions", `${idea.id}-v1.json`), "utf8"));
  assert.equal(revision.storyboards[0].title, "First angle");
  assert.equal(saved.editing_projects?.[idea.id]?.length, 4);

  const restarted = await exec(process.execPath, ["--import", "tsx", "-e",
    `require('./src/lib/storyboard-store').readStoryboards('master-legacy').then(doc => console.log(JSON.stringify(doc.storyboards.map(idea => idea.id).sort())))`,
  ]);
  assert.deepEqual(JSON.parse(restarted.stdout), ["sb-first", "sb-second", "sb-third"]);

  await fs.writeFile(join(paths.STORYBOARDS_DIR, document.videoId, "sb-corrupt.json"), "broken");
  await assert.rejects(() => store.readStoryboards(document.videoId));
  await assert.rejects(() => store.readStoryboards("../escape"));
});

test("project lookup supports old and new folders and rejects escaping paths", async () => {
  for (const [directory, filename] of [
    [paths.DOWNLOADS_DIR, "author_1234.mp4"], [paths.STORYBOARDS_DIR, "master-file.mov"], [paths.EDITING_DIR, "short-file.mp4"],
  ]) {
    await fs.writeFile(join(directory, filename), "fixture");
    assert.equal((await media.resolveProjectFile(filename))?.directory, directory);
  }
  assert.equal((await media.findDownloadFile("1234"))?.filename, "author_1234.mp4");
  assert.equal(await media.resolveProjectFile("../outside.mp4"), null);
  assert.equal(await media.resolveProjectFile("..\\outside.mp4"), null);
  const outside = join(root, "outside.mp4");
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, join(paths.EDITING_DIR, "escape.mp4"));
  assert.equal(await media.resolveProjectFile("escape.mp4"), null);
  await fs.mkdir(join(paths.DOWNLOADS_DIR, "folder.mp4"));
  assert.equal((await media.listProjectFiles()).some((item) => item.filename === "folder.mp4"), false);
  await fs.writeFile(join(paths.DOWNLOADS_DIR, "A clip.mp4"), "fixture");
  const { DELETE } = await import("../src/app/api/downloads/route");
  const removed = await DELETE(new NextRequest("http://localhost/api/downloads", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "A clip.mp4" }),
  }));
  assert.equal(removed.status, 200);
});

test("master -> multiple generations -> independent edits -> render -> fork -> delete", async () => {
  const source = join(paths.LIBRARY_DIR, "interview.mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]);
  const request = (body: unknown, method = "POST") => new NextRequest("http://localhost/api/test", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const masterAPI = await import("../src/app/api/master/route");
  const masterResponse = await masterAPI.POST(request({ clips: ["interview.mp4"], title: "Interview" }));
  assert.equal(masterResponse.status, 200);
  const master = await masterResponse.json();
  assert.equal((await media.findDownloadFile(master.videoId))?.directory, paths.STORYBOARDS_DIR);
  const segments: MasterSegments = {
    videoId: master.videoId, analyzedAt: new Date().toISOString(), model: "test", timing_source: "gemini",
    whisperx: null, words: [], sentences: [], silences: [], full_transcript: "First sentence. Another sentence. Final sentence.", timing_note: null,
    segments: idea.beats.map((beat, index) => ({
      index, start_time: beat.start, end_time: beat.end, start_word: null, end_word: null,
      text: beat.text, topic: "Interview", role: index === 0 ? "hook" : index === 2 ? "cta" : "claim",
      hook_score: 9 - index, standalone: true, on_screen_text_idea: "",
    })),
  };
  await fs.writeFile(paths.sidecarPath(master.videoId, "segments"), JSON.stringify(segments));
  const generationAPI = await import("../src/app/api/master/[videoId]/storyboards/route");
  const params = { params: Promise.resolve({ videoId: master.videoId }) };
  for (let run = 0; run < 2; run++) {
    const response = await generationAPI.POST(request(document.request), params);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal((await response.json()).storyboards.length, run + 1);
  }
  const before = (await store.readStoryboards(master.videoId))!;
  const selected = before.storyboards[0];
  const acceptAPI = await import("../src/app/api/master/[videoId]/storyboards/accept/route");
  const edits: Array<{ filename: string; videoId: string; displayName: string }> = [];
  for (let index = 0; index < 2; index++) {
    const response = await acceptAPI.POST(request({ storyboard_id: selected.id }), params);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    edits.push(await response.json());
  }
  assert.notEqual(edits[0].filename, edits[1].filename);
  assert.equal((await media.findDownloadFile(edits[0].videoId))?.directory, paths.EDITING_DIR);
  const metaPath = join(paths.EDITING_DIR, `${edits[0].filename}.metadata.json`);
  const snapshot = await fs.readFile(metaPath, "utf8");
  const patchResponse = await generationAPI.PATCH(request({ storyboard_id: selected.id, beats: selected.beats.map((beat) => ({ ...beat, on_screen_text: "Revised" })) }, "PATCH"), params);
  assert.equal(patchResponse.status, 200);
  assert.equal(await fs.readFile(metaPath, "utf8"), snapshot);
  assert.equal((await store.readStoryboards(master.videoId))?.editing_projects?.[selected.id]?.length, 2);

  const downloadAPI = await import("../src/app/api/downloads/route");
  const listing = await (await downloadAPI.GET()).json();
  assert.equal(listing.files.find((file: { name: string }) => file.name === master.filename).stage, "storyboarding");
  assert.equal(listing.files.find((file: { name: string }) => file.name === edits[0].filename).stage, "editing");
  const deleteSource = await downloadAPI.DELETE(request({ filename: master.filename }, "DELETE"));
  assert.equal(deleteSource.status, 409);

  const videoAPI = await import("../src/app/api/downloads/[filename]/route");
  const playback = await videoAPI.GET(new NextRequest("http://localhost/video", { headers: { Range: "bytes=0-99" } }), { params: Promise.resolve({ filename: edits[0].filename }) });
  assert.equal(playback.status, 206);
  assert.equal((await playback.arrayBuffer()).byteLength, 100);

  const renderAPI = await import("../src/app/api/analyze/[videoId]/render/route");
  const rendered = await renderAPI.POST(request({ audio: "original", burn_text: false }), { params: Promise.resolve({ videoId: edits[0].videoId }) });
  const render = await rendered.json();
  assert.equal(rendered.status, 200, JSON.stringify(render));
  assert.equal(render.audio, "original");
  assert.ok(render.shots.every((shot: { clip_source: string }) => shot.clip_source === "source"));
  assert.deepEqual(render.warnings, []);
  const forkAPI = await import("../src/app/api/downloads/[filename]/fork/route");
  const forked = await forkAPI.POST(request({}), { params: Promise.resolve({ filename: edits[0].filename }) });
  assert.equal(forked.status, 200);
  assert.equal((await media.resolveProjectFile((await forked.json()).filename))?.directory, paths.EDITING_DIR);

  assert.equal((await downloadAPI.DELETE(request({ filename: edits[0].filename }, "DELETE"))).status, 200);
  assert.ok(await media.resolveProjectFile(master.filename));
  assert.ok(await media.resolveProjectFile(edits[1].filename));
  assert.equal((await store.readStoryboards(master.videoId))?.storyboards.length, 2);
  assert.deepEqual((await store.readStoryboards(master.videoId))?.editing_projects?.[selected.id], [edits[1].filename]);
  await fs.access(source);
});

test("Add Footage reuses timed transcripts, preserves sources, and cuts the selected local clip", async () => {
  const footage = await import("../src/lib/storyboard-footage");
  const library = await import("../src/lib/library-store");
  const request = (body: unknown, method = "POST") => new NextRequest("http://localhost/api/test", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const [name, color] of [["main", "red"], ["extra", "blue"], ["whole", "green"], ["unknown", "white"]]) {
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:size=180x320:rate=15`, "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", join(paths.LIBRARY_DIR, `${name}.mp4`)]);
  }
  const catalog = await library.scanLibrary();
  const whole = catalog.videos.find((clip) => clip.filename === "whole.mp4")!;
  whole.analysis = {
    analyzedAt: new Date().toISOString(), model: "saved-test", location: "interior", product_present: false,
    product_note: "", time_of_day: "unclear", camera_action: "static", category: "interview",
    spoken_text: "A previously analyzed whole clip.", description: "Saved footage", suggested_tags: [],
  };
  await library.saveLibrary(catalog);
  const masterAPI = await import("../src/app/api/master/route");
  const previous = await (await masterAPI.POST(request({ clips: ["main.mp4", "extra.mp4"], title: "Previous interview" }))).json();
  const current = await (await masterAPI.POST(request({ clips: ["main.mp4"], title: "New story" }))).json();
  const transcript: MasterSegments = {
    videoId: previous.videoId, analyzedAt: new Date().toISOString(), model: "saved-test", timing_source: "gemini",
    whisperx: null, words: [], sentences: [], silences: [], timing_note: null,
    full_transcript: "Original introduction. Saved answer one. Saved answer two.",
    segments: [[0, 4, "Original introduction."], [4, 6, "Saved answer one."], [6, 8, "Saved answer two."]].map(([start, end, text], index) => ({
      index, start_time: Number(start), end_time: Number(end), text: String(text), start_word: null, end_word: null,
      topic: "Interview", role: index === 0 ? "hook" : "claim", hook_score: 9, standalone: true, on_screen_text_idea: "",
    })),
  };
  await fs.writeFile(paths.sidecarPath(previous.videoId, "segments"), JSON.stringify(transcript));
  await fs.writeFile(paths.sidecarPath(current.videoId, "segments"), JSON.stringify({ ...transcript, videoId: current.videoId, segments: transcript.segments.slice(0, 1), full_transcript: "Original introduction." }));
  const masterPath = (await media.findDownloadFile(current.videoId))!.path;
  const originalMaster = await fs.readFile(masterPath);
  const originalExtra = await fs.readFile(join(paths.LIBRARY_DIR, "extra.mp4"));
  const candidates = await footage.listStoryboardFootage(current.videoId);
  const extra = candidates.find((item) => item.clip.filename === "extra.mp4")!;
  assert.equal(extra.timing, "saved_segments");
  assert.deepEqual(extra.segments.map((segment) => [segment.start_time, segment.end_time]), [[0, 2], [2, 4]]);
  assert.equal(candidates.find((item) => item.clip.filename === "main.mp4")?.included, true);
  const wholeCandidate = candidates.find((item) => item.clip.filename === "whole.mp4")!;
  assert.equal(wholeCandidate.timing, "whole_clip");
  assert.equal(wholeCandidate.segments.length, 1);
  assert.equal(wholeCandidate.segments[0].start_word, null);
  await assert.rejects(() => footage.includeStoryboardFootage(current.videoId, "unknown.mp4"), /Analyze/);
  await Promise.all([footage.includeStoryboardFootage(current.videoId, "extra.mp4"), footage.includeStoryboardFootage(current.videoId, "extra.mp4")]);
  const attached = await footage.readAttachedFootage(current.videoId);
  assert.equal(attached.length, 1);
  await footage.includeStoryboardFootage(current.videoId, "whole.mp4");
  assert.equal((await footage.readAttachedFootage(current.videoId))[0].offset, attached[0].offset);
  const merged = (await footage.readStoryboardSegments(current.videoId))!;
  assert.equal(merged.segments.length, 4);
  assert.equal(new Set(merged.segments.map((segment) => segment.index)).size, 4);
  assert.equal(merged.segments[1].text, "Saved answer one.");
  assert.equal(merged.segments[1].source?.filename, "extra.mp4");
  assert.equal(merged.segments[1].start_time, attached[0].offset);
  const beat = { ...idea.beats[0], start: merged.segments[1].start_time, end: merged.segments[1].end_time, text: merged.segments[1].text, source: merged.segments[1].source, fix_note: "Keep the natural pause." };
  assert.equal((await footage.resolveStoryboardBeat(current.videoId, beat, masterPath)).start, 0);
  await assert.rejects(() => footage.resolveStoryboardBeat(current.videoId, { ...beat, source: { filename: "../extra.mp4", offset: attached[0].offset } }, masterPath), /not included/);
  await assert.rejects(() => footage.resolveStoryboardBeat(current.videoId, { ...beat, end: beat.end + 100 }, masterPath), /outside/);
  const params = { params: Promise.resolve({ videoId: current.videoId }) };
  const generationAPI = await import("../src/app/api/master/[videoId]/storyboards/route");
  const generatedResponse = await generationAPI.POST(request({ ...document.request, lengths: [12] }), params);
  assert.equal(generatedResponse.status, 200, JSON.stringify(await generatedResponse.clone().json()));
  const generated = (await generatedResponse.json()).storyboards[0];
  assert.ok(generated.beats.some((beat: { source?: { filename: string } }) => beat.source?.filename === "extra.mp4"));
  const patched = await generationAPI.PATCH(request({ storyboard_id: generated.id, beats: [beat] }, "PATCH"), params);
  assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()));
  const acceptAPI = await import("../src/app/api/master/[videoId]/storyboards/accept/route");
  const accepted = await acceptAPI.POST(request({ storyboard_id: generated.id }), params);
  assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
  const edit = await accepted.json();
  const editPath = (await media.findDownloadFile(edit.videoId))!.path;
  const pixels = await exec("ffmpeg", ["-v", "error", "-i", editPath, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
  assert.ok(pixels.stdout[2] > 180 && pixels.stdout[0] < 60, "Accepted edit should contain blue extra footage, not the red master");
  const notes = JSON.parse(await fs.readFile(paths.sidecarPath(edit.videoId, "edit-notes"), "utf8"));
  assert.equal(notes.notes["0"], beat.fix_note);
  assert.deepEqual(await fs.readFile(masterPath), originalMaster);
  assert.deepEqual(await fs.readFile(join(paths.LIBRARY_DIR, "extra.mp4")), originalExtra);
  const restarted = await exec(process.execPath, ["--import", "tsx", "-e", `require('./src/lib/storyboard-footage').readStoryboardSegments('${current.videoId}').then(doc => console.log(doc.segments.length))`]);
  assert.equal(restarted.stdout.trim(), "4");
});
