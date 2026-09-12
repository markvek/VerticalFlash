import { test } from "node:test";
import assert from "node:assert/strict";
import { intersects, pointerTime, previewTime, textIntersects } from "../src/lib/playhead";

test("cuts belong to exactly one shot, including the final preview frame", () => {
  const shots = [{ start_time: 0, end_time: 2 }, { start_time: 2, end_time: 4 }];
  for (const [requested, expected] of [[0, 0], [1.99, 0], [2, 1], [4, 1], [500, 1], [-1, 0]]) {
    const time = previewTime(requested, 4);
    assert.deepEqual(shots.flatMap((s, i) => intersects(time, s.start_time, s.end_time) ? [i] : []), [expected]);
  }
  assert.equal(previewTime(1, 0), 0);
  assert.ok(previewTime(.01, .01) < .01);
});

test("text eligibility follows the block range and visibility, not speech gaps", () => {
  const shot = { start_time: 2, end_time: 6 };
  const entry = { include: true, text: "Hello", startOffset: 1, endOffset: 3, matchSpeech: true,
    words: [{ text: "Hello", start: 3, end: 3.2 }, { text: "again", start: 4.8, end: 5 }] };
  assert.equal(textIntersects(2.99, shot, entry, true), false);
  assert.equal(textIntersects(3, shot, entry, true), true);
  assert.equal(textIntersects(4, shot, entry, true), true);
  assert.equal(textIntersects(5, shot, entry, true), false);
  assert.equal(textIntersects(4, shot, entry, false), false);
  assert.equal(textIntersects(4, shot, { ...entry, include: false }, true), false);
  assert.equal(textIntersects(4, shot, { ...entry, endOffset: .5 }, true), false);
});

test("B-roll remains eligible across a main-video cut but expires at its end", () => {
  assert.deepEqual([1, 1.5, 2, 3, 3.5].map(t => intersects(t, 1.5, 3.5)), [false, true, true, true, false]);
});

test("dragging preserves the grab offset and accounts for timeline scroll", () => {
  assert.equal(pointerTime(305, 100, 80, 56, 5, 20), 5);
  assert.equal(pointerTime(361, 100, 80, 56, 5, 20), 6);
  assert.equal(pointerTime(305, 100, 136, 56, 5, 20), 6);
  assert.equal(pointerTime(-100, 100, 0, 56, 5, 20), 0);
  assert.equal(pointerTime(9999, 100, 0, 56, 5, 20), 20);
});
