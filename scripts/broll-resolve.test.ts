import assert from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "../src/lib/segments-schema";
import {
  anchorForRange,
  brollCoverage,
  brollOverlaps,
  phraseForAnchor,
  resolveBrollSegment,
  resolveBrollTrack,
  wordsForShot,
} from "../src/lib/broll-resolve";

// Master words at 10.0s onward, 0.5s each with 0.1s gaps
const words: Word[] = ["One", "two", "three.", "Four", "five", "six", "seven."].map((word, i) => ({
  i,
  word,
  start: 10 + i * 0.6,
  end: 10 + i * 0.6 + 0.5,
  score: 0.9,
  interpolated: false,
}));
// Shot 0 covers master 10.0–14.2 and sits at 0–4.2 on the short; shot 1 has no word timing
const shots = [
  { index: 0, start_time: 0, end_time: 4.2, source_start: 10, source_end: 14.2 },
  { index: 1, start_time: 4.2, end_time: 9, source_start: 30, source_end: 34.8 },
];

test("a words anchor resolves through the shot's footage range", () => {
  const r = resolveBrollSegment({ id: "a", anchor: { kind: "words", shot_index: 0, start_word: 1, end_word: 2 } }, shots, words);
  // Word 1 starts at 10.6 (lead capped by word 0's end at 10.5) → 0.5s on the short;
  // word 2 ends 11.7, tail capped by word 3's start 11.8 → 1.8s
  assert.deepEqual(r, { id: "a", start: 0.5, end: 1.8, valid: true });
});

test("words trimmed out of the shot invalidate the segment", () => {
  const trimmed = [{ ...shots[0], source_end: 10.9, end_time: 0.9 }, shots[1]];
  const r = resolveBrollSegment({ id: "a", anchor: { kind: "words", shot_index: 0, start_word: 4, end_word: 6 } }, trimmed, words);
  assert.equal(r.valid, false);
  assert.match(r.reason ?? "", /trimmed/);
});

test("an offset anchor is clamped to its shot", () => {
  const r = resolveBrollSegment({ id: "b", anchor: { kind: "offset", shot_index: 1, offset: 3, duration: 5 } }, shots, null);
  assert.deepEqual(r, { id: "b", start: 7.2, end: 9, valid: true });
  const gone = resolveBrollSegment({ id: "c", anchor: { kind: "offset", shot_index: 1, offset: 4.6, duration: 2 } }, shots, null);
  assert.equal(gone.valid, false);
});

test("overlaps and coverage", () => {
  const track = {
    segments: [
      { id: "a", anchor: { kind: "words" as const, shot_index: 0, start_word: 0, end_word: 2 } },
      { id: "b", anchor: { kind: "words" as const, shot_index: 0, start_word: 2, end_word: 4 } },
      { id: "c", anchor: { kind: "offset" as const, shot_index: 1, offset: 0, duration: 1 } },
    ],
  };
  const resolved = resolveBrollTrack(track, shots, words);
  assert.deepEqual(resolved.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(brollOverlaps(resolved).length, 1);
  // a: 0–1.8, b: 1.2–3.0 (overlap counted once), c: 4.2–5.2
  assert.equal(brollCoverage(resolved), 4);
});

test("anchorForRange prefers words and falls back to an offset", () => {
  assert.deepEqual(anchorForRange(shots[0], 0.5, 1.9, words), { kind: "words", shot_index: 0, start_word: 1, end_word: 2 });
  assert.deepEqual(anchorForRange(shots[1], 5, 7, words), { kind: "offset", shot_index: 1, offset: 0.8, duration: 2 });
  assert.equal(wordsForShot(words, shots[0]).length, 7);
  assert.equal(phraseForAnchor({ kind: "words", shot_index: 0, start_word: 0, end_word: 2 }, words), "One two three.");
});
