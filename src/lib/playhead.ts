import type { ShotOverlay } from "./text-overlays-schema";

export interface TimelineRange { start_time: number; end_time: number }

// The editor currently has no project frame-rate metadata. Use 30 fps for
// keyboard steps and for the final renderable frame, never the empty end.
export const PLAYHEAD_STEP = 1 / 30;
export function previewTime(time: number, duration: number): number {
  return Math.max(0, Math.min(time, Math.max(0, duration - Math.min(PLAYHEAD_STEP, duration / 2))));
}
export function intersects(time: number, start: number, end: number): boolean {
  return time >= start && time < end;
}
export function textIntersects(time: number, shot: TimelineRange, entry: ShotOverlay, enabled: boolean): boolean {
  const duration = shot.end_time - shot.start_time;
  return enabled && entry.include && intersects(time,
    shot.start_time + Math.min(duration, entry.startOffset ?? 0),
    shot.start_time + Math.min(duration, entry.endOffset ?? duration));
}
export function pointerTime(clientX: number, left: number, scrollLeft: number, pxPerSec: number, grabOffset: number, duration: number): number {
  return Math.max(0, Math.min(duration, (clientX - left + scrollLeft - grabOffset) / pxPerSec));
}
