import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
let root: string;
let api: typeof import("../src/app/api/analyze/[videoId]/text-overlays/route");
const context = { params: Promise.resolve({ videoId: "text-api" }) };
const url = "http://localhost/api/analyze/text-api/text-overlays";
const patch = async (body: unknown) => api.PATCH(new NextRequest(url, { method: "PATCH", body: JSON.stringify(body) }), context);
before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "vf-text-api-")); process.env.DATA_DIR = root;
  const paths = await import("../src/lib/paths"); await paths.ensureDataDirs();
  api = await import("../src/app/api/analyze/[videoId]/text-overlays/route");
});
after(() => fs.rm(root, { recursive: true, force: true }));
test("concurrent text saves retain both shots and partial settings preserve drafts", async () => {
  const results = await Promise.all([patch({ shot_index: 0, text: "Custom", include: true }), patch({ shot_index: 1, text: "Second", include: true, style: { fontSize: 90 } })]);
  assert(results.every(r => r.status === 200));
  const word = { text: "Spoken", start: 1, end: 2 };
  let result = await (await patch({ shot_index: 0, matchSpeech: true, words: [word] })).json();
  assert.equal(result.shots[0].text, "Custom"); assert.equal(result.shots[1].text, "Second");
  result = await (await patch({ shot_index: 0, matchSpeech: false })).json();
  assert.deepEqual(result.shots[0].words, [word]); assert.equal(result.shots[0].text, "Custom");
  const reloaded = await (await api.GET(new NextRequest(url), context)).json();
  assert.deepEqual(reloaded, result);
});
test("reject invalid text styles, inverted times, and invalid word timing without losing saved values", async () => {
  assert.equal((await patch({ shot_index: 0, style: { fontSize: 900 } })).status, 400);
  assert.equal((await patch({ shot_index: 0, endOffset: 1, startOffset: 2 })).status, 400);
  assert.equal((await patch({ shot_index: 0, words: [{ text: "Invalid", start: 2, end: 1 }] })).status, 400);
  assert.equal((await patch({ shot_index: -1, text: "Wrong", include: true })).status, 400);
  const saved = await (await api.GET(new NextRequest(url), context)).json();assert.equal(saved.shots[0].text, "Custom");
});
