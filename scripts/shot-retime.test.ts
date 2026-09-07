import assert from "node:assert/strict";
import { test } from "node:test";
import {
  footageToShortTime,
  MIN_SHOT_SECONDS,
  retimeBeats,
  retimeShots,
  shortToFootageTime,
} from "../src/lib/shot-retime";

const beats = [
  { source_start: 10, source_end: 16, start: 0, end: 6 },
  { source_start: 50, source_end: 53, start: 6, end: 9 },
  { source_start: 80, source_end: 90, start: 9, end: 19 },
];
const bounds = () => ({ min: 0, max: 100 });

test("retimeBeats changes one beat's footage range and re-lays the short", () => {
  const next = retimeBeats(beats, [{ index: 1, source_end: 55 }], bounds);
  assert.deepEqual(next[1], { source_start: 50, source_end: 55, start: 6, end: 11 });
  assert.deepEqual(next[2], { source_start: 80, source_end: 90, start: 11, end: 21 });
  // Untouched input
  assert.equal(beats[1].source_end, 53);
});

test("retimeBeats clamps to the footage and keeps a minimum length", () => {
  const next = retimeBeats(beats, [{ index: 2, source_end: 120 }], bounds);
  assert.equal(next[2].source_end, 100);
  const tiny = retimeBeats(beats, [{ index: 0, source_start: 15.9 }], bounds);
  assert.equal(tiny[0].source_start, 16 - MIN_SHOT_SECONDS);
  const trimmedStart = retimeBeats(beats, [{ index: 1, source_start: 51 }], bounds);
  assert.deepEqual(trimmedStart[1], { source_start: 51, source_end: 53, start: 6, end: 8 });
  assert.throws(() => retimeBeats(beats, [{ index: 5, source_end: 1 }], bounds), /No shot 6/);
});

test("retimeShots moves a split point and its neighbour together", () => {
  const shots = [
    { start_time: 0, end_time: 4 },
    { start_time: 4, end_time: 9 },
    { start_time: 9, end_time: 12 },
  ];
  const next = retimeShots(shots, [{ index: 0, end_time: 5.5 }]);
  assert.deepEqual(next[0], { start_time: 0, end_time: 5.5 });
  assert.deepEqual(next[1], { start_time: 5.5, end_time: 9 });
  // Cannot swallow the neighbour
  const clamped = retimeShots(shots, [{ index: 1, end_time: 30 }]);
  assert.equal(clamped[1].end_time, 12 - MIN_SHOT_SECONDS);
  assert.equal(clamped[2].start_time, 12 - MIN_SHOT_SECONDS);
  // The first shot's start is not a boundary
  assert.throws(() => retimeShots(shots, [{ index: 0, start_time: 1 }]), /no neighbour/);
});

test("time mapping between the short and its footage", () => {
  assert.deepEqual(footageToShortTime(beats, 52), { index: 1, time: 8 });
  assert.equal(footageToShortTime(beats, 30), null);
  assert.equal(shortToFootageTime(beats, 10), 81);
  assert.equal(shortToFootageTime(beats, 99), 90);
});
