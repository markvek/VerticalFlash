import { MIN_SHOT_SECONDS } from "./shot-retime";
import { resolveBrollSegment, wordsForShot } from "./broll-resolve";
import type { Word } from "./segments-schema";
import type { BrollSegment } from "./broll-schema";

export type TimelineOperation =
  | { type: "trim"; index: number; start: number; end: number }
  | { type: "move"; index: number; to: number }
  | { type: "remove"; index: number }
  | { type: "broll"; index: number; filename: string; start: number; end: number; offset?: number }
  | { type: "insert" | "replace"; index: number; filename: string; start: number; end: number };
export interface ClipRange { source_start: number; source_end: number; start_time: number; end_time: number }
export interface SourceBounds { min: number; max: number }

// order maps each new position to its old position. Every indexed sidecar
// uses this same mapping, including sparse settings and B-roll anchors.
export function editTimeline<T extends ClipRange>(shots: T[], op: TimelineOperation, bounds: SourceBounds[], inserted?: T) {
  if (op.type !== "insert" && !shots[op.index]) throw new Error("Clip no longer exists");
  const order = shots.map((_, i) => i);
  const next = shots.map(s => ({ ...s }));
  if (op.type === "broll") throw new Error("B-roll does not change main-track ranges");
  if (op.type === "insert" || op.type === "replace") {
    if (!Number.isInteger(op.index) || op.index < 0 || op.index > shots.length || !inserted || !Number.isFinite(inserted.source_start) || !Number.isFinite(inserted.source_end) || inserted.source_end - inserted.source_start < MIN_SHOT_SECONDS - 0.000001) throw new Error("Invalid footage insertion");
    order.splice(op.index, op.type === "replace" ? 1 : 0, -1);
  } else if (op.type === "trim") {
    const limit = bounds[op.index];
    if (!limit || !Number.isFinite(op.start) || !Number.isFinite(op.end) || op.start < limit.min || op.end > limit.max + 0.001 || op.end - op.start < MIN_SHOT_SECONDS - 0.000001) {
      throw new Error(`Choose a source range of at least ${MIN_SHOT_SECONDS}s within the available footage`);
    }
    next[op.index].source_start = op.start;
    next[op.index].source_end = op.end;
  } else if (op.type === "move") {
    if (!Number.isInteger(op.to) || !shots[op.to]) throw new Error("Invalid clip position");
    order.splice(op.to, 0, order.splice(op.index, 1)[0]);
  } else {
    if (shots.length === 1) throw new Error("Keep at least one clip");
    order.splice(op.index, 1);
  }
  let cursor = 0;
  const round = (t: number) => Math.round(t * 1000) / 1000;
  const result = order.map((oldIndex, index) => {
    const s = oldIndex === -1 ? inserted! : next[oldIndex];
    const start_time = round(cursor);
    cursor += s.source_end - s.source_start;
    return { ...s, index, start_time, end_time: round(cursor) };
  });
  return { shots: result, order };
}

export function remapRecord<T>(record: Record<string, T>, order: number[]): Record<string, T> {
  return Object.fromEntries(order.flatMap((old, index) => record[String(old)] === undefined ? [] : [[String(index), record[String(old)]]]));
}
export function remapIndexed<T extends { shot_index: number }>(rows: T[], order: number[]): T[] {
  return order.flatMap((old, index) => rows.filter(s => s.shot_index === old).map(s => ({ ...s, shot_index: index })));
}
export function remapBroll(segments: BrollSegment[], order: number[], before: ClipRange[], after: ClipRange[], words: Word[] = []): BrollSegment[] {
  return segments.flatMap(segment => {
    if (segment.anchor.kind === "span") {
      const anchor = segment.anchor;
      if (anchor.invalidReason) return [segment];
      const startIndex = order.indexOf(anchor.shot_index);
      const endIndex = order.indexOf(anchor.end_shot_index);
      const reason = startIndex < 0 || endIndex < 0 ? "An endpoint shot was removed; adjust this B-roll range" : startIndex > endIndex ? "Endpoint shots were reordered; adjust this B-roll range" : undefined;
      if (reason) return [{ ...segment, anchor: { ...anchor, invalidReason: reason } }];
      const startShift = before[anchor.shot_index].source_start - after[startIndex].source_start;
      const endShift = before[anchor.end_shot_index].source_start - after[endIndex].source_start;
      const offset = anchor.offset + startShift;
      return [{ ...segment, clip: segment.clip && offset < 0 ? { ...segment.clip, clip_start: (segment.clip.clip_start ?? 0) - offset } : segment.clip,
        anchor: { ...anchor, shot_index: startIndex, end_shot_index: endIndex, offset: Math.max(0, offset), end_offset: Math.max(0, anchor.end_offset + endShift) } }];
    }
    const old = segment.anchor.shot_index;
    const index = order.indexOf(old);
    if (index < 0) return [];
    let anchor = { ...segment.anchor, shot_index: index };
    let clip = segment.clip;
    let phrase = segment.phrase;
    if (anchor.kind === "offset") {
      const offset = anchor.offset + before[old].source_start - after[index].source_start;
      const end = Math.min(after[index].end_time - after[index].start_time, offset + anchor.duration);
      const start = Math.max(0, offset);
      if (end - start < 0.5) return [];
      if (clip && offset < 0) clip = { ...clip, clip_start: (clip.clip_start ?? 0) - offset };
      anchor = { ...anchor, offset: start, duration: end - start };
    }
    if (anchor.kind === "words" && words.length) {
      const previous = resolveBrollSegment(segment, [{ ...before[old], index: old }], words);
      const range = resolveBrollSegment({ id: segment.id, anchor }, [{ ...after[index], index }], words);
      if (!range.valid) return [];
      if (clip && previous.valid) {
        const skipped = (after[index].source_start + range.start - after[index].start_time)
          - (before[old].source_start + previous.start - before[old].start_time);
        clip = { ...clip, clip_start: Math.max(0, (clip.clip_start ?? 0) + skipped) };
      }
      const startWord = anchor.start_word, endWord = anchor.end_word;
      phrase = wordsForShot(words, { ...after[index], index }).filter(w => w.i >= startWord && w.i <= endWord).map(w => w.word).join(" ");
    }
    return [{ ...segment, anchor, clip, phrase }];
  });
}
