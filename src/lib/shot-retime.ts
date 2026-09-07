// Re-timing shots from the editor's timeline drags. Pure module (no fs or
// ffmpeg) so the rules are unit-testable and shared with the client preview.
//
// Two models:
// - Split-point projects (downloads, briefs): the source video is fixed, so
//   a boundary only moves where one shot ends and the next begins. Total
//   length never changes.
// - Storyboard cutdowns: each shot is its own range of the master (or an
//   attached clip), glued together. A drag changes that range, and the
//   short's timeline is rebuilt cumulatively from the new durations.

export const MIN_SHOT_SECONDS = 0.3;

export interface RetimeEdit {
  index: number;
  // Split-point model (short seconds)
  start_time?: number;
  end_time?: number;
  // Cutdown model (footage seconds, in the storyboard's virtual timeline)
  source_start?: number;
  source_end?: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// Cutdown: apply footage-range edits to the beats, then lay the short's
// timeline back out end to end. `bounds` gives the legal footage range for
// a beat (the master's length, or the attached clip's window).
export function retimeBeats<
  T extends { source_start: number; source_end: number; start: number; end: number },
>(
  beats: T[],
  edits: RetimeEdit[],
  bounds: (index: number) => { min: number; max: number }
): T[] {
  const next = beats.map((b) => ({ ...b }));
  for (const edit of edits) {
    const beat = next[edit.index];
    if (!beat) throw new Error(`No shot ${edit.index + 1}`);
    const { min, max } = bounds(edit.index);
    if (edit.source_start != null) {
      beat.source_start = Math.max(min, Math.min(edit.source_start, beat.source_end - MIN_SHOT_SECONDS));
    }
    if (edit.source_end != null) {
      beat.source_end = Math.min(max, Math.max(edit.source_end, beat.source_start + MIN_SHOT_SECONDS));
    }
    if (beat.source_end - beat.source_start < MIN_SHOT_SECONDS - 1e-6) {
      throw new Error(`Shot ${edit.index + 1} would be shorter than ${MIN_SHOT_SECONDS}s`);
    }
    beat.source_start = round(beat.source_start);
    beat.source_end = round(beat.source_end);
  }
  let cursor = 0;
  for (const beat of next) {
    beat.start = round(cursor);
    cursor += beat.source_end - beat.source_start;
    beat.end = round(cursor);
  }
  return next;
}

// Split-point: move boundaries inside a fixed-length video. Moving shot
// i's end also moves shot i+1's start (and vice versa); the first start and
// last end stay put. Each shot keeps at least MIN_SHOT_SECONDS.
export function retimeShots<T extends { start_time: number; end_time: number }>(
  shots: T[],
  edits: RetimeEdit[]
): T[] {
  const next = shots.map((s) => ({ ...s }));
  const moveBoundary = (leftIndex: number, time: number) => {
    const left = next[leftIndex];
    const right = next[leftIndex + 1];
    if (!left || !right) {
      throw new Error(`Shot ${leftIndex + 1} has no neighbour to share that boundary with`);
    }
    const lo = left.start_time + MIN_SHOT_SECONDS;
    const hi = right.end_time - MIN_SHOT_SECONDS;
    if (hi < lo) throw new Error(`Shots ${leftIndex + 1} and ${leftIndex + 2} are too short to move`);
    const t = round(Math.max(lo, Math.min(time, hi)));
    left.end_time = t;
    right.start_time = t;
  };
  for (const edit of edits) {
    if (!next[edit.index]) throw new Error(`No shot ${edit.index + 1}`);
    if (edit.end_time != null) moveBoundary(edit.index, edit.end_time);
    if (edit.start_time != null) moveBoundary(edit.index - 1, edit.start_time);
  }
  return next;
}

// The short-timeline seconds a footage time lands on (cutdown preview that
// plays the footage directly); null when it is outside every beat
export function footageToShortTime(
  beats: Array<{ source_start: number; source_end: number; start: number }>,
  footageTime: number
): { index: number; time: number } | null {
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    if (footageTime >= b.source_start - 0.05 && footageTime < b.source_end) {
      return { index: i, time: b.start + Math.max(0, footageTime - b.source_start) };
    }
  }
  return null;
}

export function shortToFootageTime(
  beats: Array<{ source_start: number; source_end: number; start: number; end: number }>,
  shortTime: number
): number {
  for (const b of beats) {
    if (shortTime >= b.start && shortTime < b.end) return b.source_start + (shortTime - b.start);
  }
  const last = beats[beats.length - 1];
  return last ? last.source_end : 0;
}
