import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import type { GoogleGenAI } from "@google/genai";
import type { MasterStoryboards, MasterSegments } from "../src/lib/segments-schema";
import type { ViralityOutput } from "../src/lib/virality-schema";

let root: string;
let paths: typeof import("../src/lib/paths");
let service: typeof import("../src/lib/storyboard-virality");
let store: typeof import("../src/lib/storyboard-store");
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "verticalflash-virality-"));
  process.env.DATA_DIR = root;
  paths = await import("../src/lib/paths");
  service = await import("../src/lib/storyboard-virality");
  store = await import("../src/lib/storyboard-store");
  await paths.ensureDataDirs();
});
after(() => fs.rm(root, { recursive: true, force: true }));

const storyboard = {
  id: "sb-review", revision: 1, title: "A useful result", angle: "Result then explanation", hook_line: "Here is the result.", target_seconds: 6, estimated_seconds: 6,
  beats: [0, 2, 4].map((start, i) => ({ section: (["hook", "main", "end"] as const)[i], start, end: start + 2, start_word: null, end_word: null, text: ["Here is the result.", "This is how it works.", "Try it yourself."][i], on_screen_text: "Old default text", show: i === 1 ? "broll" as const : "source" as const, broll_hint: null })),
};
const doc: MasterStoryboards = { videoId: "master-review", generatedAt: "2026-09-11T00:00:00Z", model: "test", timing_source: "gemini", request: { count: 1, lengths: [6], pacing: "standard", allow_broll: false, brief: "Help beginners understand the result" }, storyboards: [storyboard] };
const segments: MasterSegments = { videoId: doc.videoId, analyzedAt: doc.generatedAt, model: "test", timing_source: "gemini", whisperx: null, words: [], sentences: [], silences: [], full_transcript: storyboard.beats.map(b => b.text).join(" "), timing_note: null,
  segments: storyboard.beats.map((b, index) => ({ index, start_time: b.start, end_time: b.end, start_word: null, end_word: null, text: b.text, topic: "Result", role: index === 0 ? "hook" : "claim", hook_score: 7, standalone: true, on_screen_text_idea: "" })),
};
const output: ViralityOutput = {
  summary: "Clear result; reinforce it with a short title.",
  assessments: { hook: { score: 4, reason: "Opens on the result." }, audience: { score: 3, reason: "Beginners can follow it." }, clarity: { score: 4, reason: "Simple sequence." }, payoff: { score: 3, reason: "The result is explained." }, shareability: { score: 3, reason: "Useful to a beginner." } },
  improvements: [{ beat_index: 0, title: "Name the result", reason: "A short title makes the promise specific." }],
  alternative_hooks: [{ segment_index: 1, reason: "An explanation-led alternative." }],
  text: [{ beat_index: 0, offset: 0.25, duration: 1.5, text: "See the result", reason: "Clarify the opening." }],
  broll: [{ beat_index: 1, offset: 0, duration: 1.5, description: "Close-up of the result", reason: "Support the explanation." }],
};
const aiReturning = (value: unknown, onCall = () => {}) => ({ models: { generateContent: async () => { onCall(); return { text: JSON.stringify(value) }; } } }) as unknown as GoogleGenAI;

test("review validates timing and references; zero suggestions are valid", () => {
  assert.deepEqual(service.validateViralityOutput(output, storyboard, segments), output);
  assert.doesNotThrow(() => service.validateViralityOutput({ ...output, improvements: [], alternative_hooks: [], text: [], broll: [] }, storyboard, segments));
  assert.throws(() => service.validateViralityOutput({ ...output, improvements: [{ ...output.improvements[0], beat_index: 20 }] }, storyboard, segments), /unknown/);
  assert.throws(() => service.validateViralityOutput({ ...output, text: [{ ...output.text[0], duration: 5 }] }, storyboard, segments), /timing/);
  assert.throws(() => service.validateViralityOutput({ ...output, alternative_hooks: [{ segment_index: 99, reason: "Invented" }] }, storyboard, segments), /source speech/);
  assert.throws(() => service.validateViralityOutput({ ...output, text: [output.text[0], output.text[0]] }, storyboard, segments), /one text/);
  assert.throws(() => service.validateViralityOutput({ ...output, assessments: {} }, storyboard, segments));
});

test("reviews cache by revision and brief, deduplicate concurrent calls, and preserve source hook words", async () => {
  await store.writeStoryboards(doc);
  let calls = 0;
  const ai = aiReturning(output, () => calls++);
  const [a, b] = await Promise.all([service.reviewStoryboard(doc, storyboard, segments, ai), service.reviewStoryboard(doc, storyboard, segments, ai)]);
  assert.equal(calls, 1);
  assert.equal(a.id, b.id);
  assert.equal(a.hooks[0].text, segments.segments[1].text);
  assert.equal((await service.readViralityReview(doc.videoId, storyboard, doc.request.brief))?.id, a.id);
  assert.equal(await service.readViralityReview(doc.videoId, { ...storyboard, revision: 2 }, doc.request.brief), null);
  assert.equal(await service.readViralityReview(doc.videoId, storyboard, "A different audience"), null);
  await store.writeStoryboards({ ...doc, generatedAt: "2026-09-12T00:00:00Z", request: { ...doc.request, brief: "New brief" }, storyboards: [{ ...storyboard, id: "sb-other" }] });
  assert.equal((await store.readSavedStoryboard(doc.videoId, storyboard.id))?.request.brief, doc.request.brief);
  assert.equal((await store.readSavedStoryboard(doc.videoId, "sb-other"))?.request.brief, "New brief");
  let failedCalls = 0;
  await assert.rejects(service.reviewStoryboard(doc, { ...storyboard, id: "invalid-review" }, segments, aiReturning({}, () => failedCalls++)), /failed validation/);
  assert.equal(failedCalls, 2);
  assert.equal(await service.readViralityReview(doc.videoId, { ...storyboard, id: "invalid-review" }, doc.request.brief), null);
});

test("Start Edit honors both checkboxes, saves the review, rejects stale input, and renders original audio", async () => {
  const exec = promisify(execFile);
  const videoPath = join(paths.STORYBOARDS_DIR, `${doc.videoId}.mp4`);
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=180x320:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", videoPath]);
  await fs.writeFile(`${videoPath}.metadata.json`, JSON.stringify({ kind: "master", title: "Review test", createdAt: doc.generatedAt, sourceClips: [] }));
  await fs.writeFile(paths.sidecarPath(doc.videoId, "segments"), JSON.stringify(segments));
  const request = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const params = { params: Promise.resolve({ videoId: doc.videoId }) };
  const api = await import("../src/app/api/master/[videoId]/storyboards/accept/route");
  const reviews = await import("../src/app/api/analyze/[videoId]/virality/route");
  const before = JSON.stringify(await store.readSavedStoryboard(doc.videoId, storyboard.id));
  const stale = await api.POST(request({ storyboard_id: storyboard.id, revision: 99, add_text: true }), params);
  assert.equal(stale.status, 409);
  assert.equal(JSON.stringify(await store.readSavedStoryboard(doc.videoId, storyboard.id)), before);
  const noReview = await api.POST(request({ storyboard_id: "sb-other", add_broll: true }), params);
  assert.equal(noReview.status, 409);
  assert.equal((await api.POST(request({ storyboard_id: storyboard.id, add_text: "yes" }), params)).status, 400);

  for (const enabled of [false, true]) {
    const requestId = crypto.randomUUID();
    const body = { request_id: requestId, storyboard_id: storyboard.id, revision: 1, add_text: enabled, add_broll: enabled };
    const response = await api.POST(request(body), params);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const replay = await api.POST(request(body), params);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).filename, result.filename, "A retried acceptance must reuse its edit");
    assert.equal((await api.POST(request({ ...body, add_text: !enabled }), params)).status, 409);
    const fork = await import("../src/app/api/downloads/[filename]/fork/route");
    const duplicated = await fork.POST(request({}), { params: Promise.resolve({ filename: result.filename }) });
    assert.equal(duplicated.status, 200, JSON.stringify(await duplicated.clone().json()));
    const copy = await duplicated.json();
    const copied = JSON.parse(await fs.readFile(join(paths.EDITING_DIR, `${copy.filename}.metadata.json`), "utf8"));
    assert.equal(copied.masterId, doc.videoId);
    assert.equal(copied.storyboardId, storyboard.id);
    const overlays = JSON.parse(await fs.readFile(paths.sidecarPath(result.videoId, "text-overlays"), "utf8"));
    const broll = JSON.parse(await fs.readFile(paths.sidecarPath(result.videoId, "broll"), "utf8"));
    const recommendations = JSON.parse(await fs.readFile(paths.sidecarPath(result.videoId, "recommendations"), "utf8"));
    assert.equal(overlays.shots["0"].include, enabled);
    assert.equal(overlays.shots["0"].text, enabled ? "See the result" : "");
    assert.equal(overlays.shots["1"].include, false);
    assert.ok(recommendations.shots.every((s: { keep_source: boolean }) => s.keep_source));
    assert.equal(broll.segments.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(overlays.shots["0"].startOffset, 0.25);
      assert.equal(overlays.shots["0"].endOffset, 1.75);
      assert.equal(broll.segments[0].status, "suggested");
      assert.equal(broll.segments[0].clip, null);
      assert.match(result.warnings.join(" "), /No analyzed B-roll/);
    }
    const reviewResponse = await reviews.GET(new NextRequest("http://localhost/api/test"), { params: Promise.resolve({ videoId: result.videoId }) });
    const saved = await reviewResponse.json();
    assert.equal(saved.snapshot, true);
    assert.equal(saved.items[0].review.revision, 1);
    if (enabled) {
      const renderer = await import("../src/app/api/analyze/[videoId]/render/route");
      const renderResponse = await renderer.POST(request({ audio: "original", burn_text: true }), { params: Promise.resolve({ videoId: result.videoId }) });
      const render = await renderResponse.json();
      assert.equal(renderResponse.status, 200, JSON.stringify(render));
      assert.equal(render.audio, "original");
      assert.ok(render.shots.every((shot: { clip_source: string }) => shot.clip_source === "source"));
    }
  }
  assert.equal((await store.readSavedStoryboard(doc.videoId, storyboard.id))?.storyboards[0].revision, 1);
});

test("auto placement skips weak, missing, and short clips and keeps the exact reviewed window", async () => {
  const { handoffText, handoffBrollTargets, placeHandoffMatches } = await import("../src/lib/storyboard-handoff");
  const { analysisFromCutdown } = await import("../src/lib/cutdown-build");
  const review = (await service.readViralityReview(doc.videoId, storyboard, doc.request.brief))!;
  const analysis = analysisFromCutdown("short-fixture", { kind: "cutdown", masterId: doc.videoId, masterFilename: `${doc.videoId}.mp4`, storyboardId: storyboard.id, title: storyboard.title, hookLine: storyboard.hook_line, targetDuration: 6, timingSource: "gemini", createdAt: doc.generatedAt, beats: storyboard.beats.map(b => ({ ...b, source_start: b.start, source_end: b.end })) }, 6);
  const handoff = { options: { add_text: false, add_broll: true }, review };
  const targets = handoffBrollTargets(analysis, handoff);
  const make = (filename: string, confidence: "strong" | "weak", clip_start = 0) => ({ filename, confidence, clip_start, duration: 5, reason: "Shows the result", moment_note: null });
  await placeHandoffMatches(targets, new Map([[targets[0].id, [make("weak.mp4", "weak"), make("missing.mp4", "strong"), make("short.mp4", "strong", 1), make("good.mp4", "strong", 2)]]]), async filename => ({ "weak.mp4": 10, "short.mp4": 2, "good.mp4": 5 })[filename] ?? null);
  assert.equal(targets[0].status, "placed");
  assert.equal(targets[0].clip?.filename, "good.mp4");
  assert.equal(targets[0].clip?.clip_start, 2);
  assert.deepEqual(targets[0].anchor, { kind: "offset", shot_index: 1, offset: 0, duration: 1.5 });
  assert.ok(Object.values(handoffText(analysis, handoff).shots).every(s => !s.include));
  const shortAnalysis = { ...analysis, shots: analysis.shots.map(s => ({ ...s, end_time: s.start_time + 0.5 })) };
  assert.deepEqual(handoffBrollTargets(shortAnalysis, handoff), []);
  const text = handoffText(shortAnalysis, { options: { add_text: true, add_broll: false }, review });
  assert.equal(text.shots["0"].endOffset, 0.5);
});
