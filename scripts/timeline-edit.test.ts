import assert from "node:assert/strict";
import { test } from "node:test";
import { editTimeline, remapRecord, remapIndexed, remapBroll } from "../src/lib/timeline-edit";
import type { BrollSegment } from "../src/lib/broll-schema";
const shots = [10, 30, 50].map((source_start, i) => ({ source_start, source_end: source_start + 4, start_time: i * 4, end_time: i * 4 + 4, title: `Clip ${i}` }));
const bounds = shots.map(() => ({ min: 0, max: 60 }));

test("exact ranges can move both edges past the old end and ripple later clips", () => {
  const { shots: next } = editTimeline(shots, { type: "trim", index: 0, start: 20, end: 26 }, bounds);
  assert.deepEqual(next.map(s => [s.start_time, s.end_time]), [[0, 6], [6, 10], [10, 14]]);
  assert.equal(next[0].source_start, 20);
  assert.equal(shots[0].source_start, 10);
  assert.throws(() => editTimeline(shots, { type: "trim", index: 0, start: -1, end: 4 }, bounds));
  assert.throws(() => editTimeline(shots, { type: "trim", index: 0, start: 2, end: 2.1 }, bounds));
  assert.throws(() => editTimeline(shots, { type: "trim", index: 2, start: 55, end: 61 }, bounds));
  assert.throws(() => editTimeline(shots, { type: "trim", index: 0, start: NaN, end: 4 }, bounds));
});
test("moving and removing carry sparse settings along with the original clip", () => {
  const { shots: next, order } = editTimeline(shots, { type: "move", index: 2, to: 0 }, bounds);
  assert.deepEqual(next.map(s => s.title), ["Clip 2", "Clip 0", "Clip 1"]);
  assert.deepEqual(remapRecord({ "0": "note A", "2": "note C" }, order), { "0": "note C", "1": "note A" });
  assert.deepEqual(remapIndexed([{ shot_index: 2, file: "generated-C.mp4" }], order), [{ shot_index: 0, file: "generated-C.mp4" }]);
  const removed = editTimeline(shots, { type: "remove", index: 1 }, bounds);
  assert.equal(removed.shots[1].start_time, 4);
  assert.deepEqual(remapRecord({ "1": "deleted" }, removed.order), {});
  assert.throws(() => editTimeline([shots[0]], { type: "remove", index: 0 }, bounds));
  assert.throws(() => editTimeline(shots, { type: "move", index: 0, to: 3 }, bounds));
});
test("offset B-roll follows the source footage when trimming the beginning", () => {
  const segment: BrollSegment = { id: "b", anchor: { kind: "offset", shot_index: 0, offset: 1, duration: 2 }, clip: { filename: "b.mp4", clip_start: 3, source: "library" }, status: "placed", phrase: "", description: null, candidates: [], createdAt: "" };
  const trimmed = editTimeline(shots, { type: "trim", index: 0, start: 12, end: 14 }, bounds);
  const next = remapBroll([segment], trimmed.order, shots, trimmed.shots);
  assert.deepEqual(next[0].anchor, { kind: "offset", shot_index: 0, offset: 0, duration: 1 });
  assert.equal(next[0].clip?.clip_start, 4);
  const removed = editTimeline(shots, { type: "remove", index: 0 }, bounds);
  assert.deepEqual(remapBroll([segment], removed.order, shots, removed.shots), []);
});

test("word B-roll advances its footage and refreshes its phrase when opening words are trimmed", () => {
  const before = [{ source_start: 0, source_end: 3, start_time: 0, end_time: 3 }];
  const after = [{ source_start: 1, source_end: 3, start_time: 0, end_time: 2 }];
  const words = ["First", "second", "third"].map((word, i) => ({ i, word, start: i + 0.1, end: i + 0.8, score: 1, interpolated: false }));
  const segment: BrollSegment = { id: "w", anchor: { kind: "words", shot_index: 0, start_word: 0, end_word: 2 }, clip: { filename: "b.mp4", clip_start: 2, source: "library" }, status: "placed", phrase: "First second third", description: null, candidates: [], createdAt: "" };
  const next = remapBroll([segment], [0], before, after, words);
  assert.equal(next[0].phrase, "second third");
  assert(next[0].clip!.clip_start! > 2.8);
  const extended = remapBroll(next, [0], after, before, words);
  assert(Math.abs(extended[0].clip!.clip_start! - 2) < 0.00001);
  assert.equal(extended[0].phrase, "First second third");
});
