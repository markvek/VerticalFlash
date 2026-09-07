import type { BrollAnchor, BrollSegment } from "./broll-schema";
import type { Word } from "./segments-schema";
import { rangeToTimes, wordsToText } from "./word-range";

// Turning voice-anchored B-roll segments into seconds on the short's
// timeline, and back. Pure so the client can preview drags and the server
// can validate and render from the same rules.

export const MIN_BROLL_SECONDS = 0.5;

export interface ResolveShot {
  index: number;
  start_time: number;
  end_time: number;
  source_start?: number;
  source_end?: number;
}

export interface ResolvedBroll {
  id: string;
  start: number;
  end: number;
  valid: boolean;
  reason?: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function resolveBrollSegment(
  segment: Pick<BrollSegment, "id" | "anchor">,
  shots: ResolveShot[],
  words: Word[] | null
): ResolvedBroll {
  const { anchor } = segment;
  const shot = shots.find((s) => s.index === anchor.shot_index);
  if (!shot) return { id: segment.id, start: 0, end: 0, valid: false, reason: "its shot no longer exists" };
  if (anchor.kind === "offset") {
    const start = shot.start_time + anchor.offset;
    const end = Math.min(shot.end_time, start + anchor.duration);
    if (end - start < MIN_BROLL_SECONDS) {
      return { id: segment.id, start: round(start), end: round(end), valid: false, reason: "it falls outside its shot" };
    }
    return { id: segment.id, start: round(start), end: round(end), valid: true };
  }
  if (shot.source_start == null || shot.source_end == null || !words?.length) {
    return { id: segment.id, start: 0, end: 0, valid: false, reason: "its shot has no word timing" };
  }
  const { start: ms, end: me } = rangeToTimes(words, anchor.start_word, anchor.end_word, Number.MAX_SAFE_INTEGER);
  const cs = Math.max(ms, shot.source_start);
  const ce = Math.min(me, shot.source_end);
  if (ce - cs < MIN_BROLL_SECONDS) {
    const outside = me <= shot.source_start || ms >= shot.source_end;
    return {
      id: segment.id,
      start: 0,
      end: 0,
      valid: false,
      reason: outside ? "its words were trimmed out of the shot" : `it is shorter than ${MIN_BROLL_SECONDS}s`,
    };
  }
  return {
    id: segment.id,
    start: round(shot.start_time + (cs - shot.source_start)),
    end: round(shot.start_time + (ce - shot.source_start)),
    valid: true,
  };
}

export function resolveBrollTrack(
  track: { segments: Array<Pick<BrollSegment, "id" | "anchor">> },
  shots: ResolveShot[],
  words: Word[] | null
): ResolvedBroll[] {
  return track.segments
    .map((s) => resolveBrollSegment(s, shots, words))
    .sort((a, b) => a.start - b.start);
}

// Pairs of valid segments that overlap on the timeline
export function brollOverlaps(resolved: ResolvedBroll[]): Array<[ResolvedBroll, ResolvedBroll]> {
  const valid = resolved.filter((r) => r.valid).sort((a, b) => a.start - b.start);
  const out: Array<[ResolvedBroll, ResolvedBroll]> = [];
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].start < valid[i - 1].end - 0.01) out.push([valid[i - 1], valid[i]]);
  }
  return out;
}

// Seconds of the short covered by valid segments (no double counting)
export function brollCoverage(resolved: ResolvedBroll[]): number {
  let covered = 0;
  let cursor = -Infinity;
  for (const r of resolved.filter((r) => r.valid).sort((a, b) => a.start - b.start)) {
    const start = Math.max(r.start, cursor);
    if (r.end > start) covered += r.end - start;
    cursor = Math.max(cursor, r.end);
  }
  return round(covered);
}

// Words of the master transcript that fall inside a shot's footage range
export function wordsForShot(words: Word[], shot: ResolveShot): Word[] {
  if (shot.source_start == null || shot.source_end == null) return [];
  return words.filter((w) => w.start >= shot.source_start! - 0.05 && w.end <= shot.source_end! + 0.05);
}

// An anchor for a short-timeline range inside a shot: by words when the
// shot has word timing and the range holds at least one word, else by
// offset. Used when a block is created at a time or dragged.
export function anchorForRange(
  shot: ResolveShot,
  start: number,
  end: number,
  words: Word[] | null
): BrollAnchor {
  const s = Math.max(shot.start_time, start);
  const e = Math.min(shot.end_time, end);
  if (words?.length && shot.source_start != null && shot.source_end != null) {
    const ms = shot.source_start + (s - shot.start_time);
    const me = shot.source_start + (e - shot.start_time);
    const inShot = wordsForShot(words, shot);
    // A word belongs to the range when a meaningful part of it (0.15s, or
    // half of a very short word) is inside; the cut itself then leads and
    // trails into the gaps like every other word cut
    const inside = (w: Word) => {
      const overlap = Math.min(w.end, me) - Math.max(w.start, ms);
      return overlap >= Math.min(0.15, (w.end - w.start) / 2);
    };
    const first = inShot.find(inside);
    const last = [...inShot].reverse().find(inside);
    if (first && last && last.i >= first.i) {
      return { kind: "words", shot_index: shot.index, start_word: first.i, end_word: last.i };
    }
  }
  return {
    kind: "offset",
    shot_index: shot.index,
    offset: round(Math.max(0, s - shot.start_time)),
    duration: round(Math.max(MIN_BROLL_SECONDS, e - s)),
  };
}

export function phraseForAnchor(anchor: BrollAnchor, words: Word[] | null): string {
  if (anchor.kind !== "words" || !words?.length) return "";
  return wordsToText(words, anchor.start_word, anchor.end_word);
}

// A segment covering a whole shot (the "place over this shot" action)
export function anchorForShot(shot: ResolveShot, words: Word[] | null): BrollAnchor {
  return anchorForRange(shot, shot.start_time, shot.end_time, words);
}
