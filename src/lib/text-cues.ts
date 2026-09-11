import { DEFAULT_TEXT_STYLE, type ShotOverlay, type TextOverlays, type TextStyle, type TextWord } from "./text-overlays-schema";

export interface TextShot { index: number; start_time: number; end_time: number; source_start?: number; source_end?: number; on_screen_text: string }
export interface TextCue { start: number; end: number; text: string; style: TextStyle }
export function overlayForShot(overlays: TextOverlays | null, shot: TextShot): ShotOverlay {
  return overlays?.shots[String(shot.index)] ?? { text: shot.on_screen_text.trim(), include: !!shot.on_screen_text.trim() };
}
export function wordsForOverlay(shot: TextShot, entry: ShotOverlay, fallback: TextWord[] = []): TextWord[] {
  const start = shot.source_start ?? shot.start_time;
  const end = start + shot.end_time - shot.start_time;
  return (entry.words ?? fallback).filter(w => w.end > start && w.start < end);
}
export function resolveTextCues(shot: TextShot, entry: ShotOverlay, defaults = DEFAULT_TEXT_STYLE, fallback: TextWord[] = []): TextCue[] {
  if (!entry.include) return [];
  const duration = shot.end_time - shot.start_time;
  const start = shot.start_time + Math.min(duration, entry.startOffset ?? 0);
  const end = shot.start_time + Math.min(duration, entry.endOffset ?? duration);
  const style = { ...defaults, ...entry.style };
  if (end <= start) return [];
  if (!entry.matchSpeech) return entry.text.trim() ? [{ start, end, text: entry.text.trim(), style }] : [];
  const sourceStart = shot.source_start ?? shot.start_time;
  const words = wordsForOverlay(shot, entry, fallback).map(w => ({ ...w,
    start: Math.max(start, shot.start_time + w.start - sourceStart),
    end: Math.min(end, shot.start_time + w.end - sourceStart),
  })).filter(w => w.end > w.start);
  const cues: TextCue[] = [];
  let phrase: TextWord[] = [];
  const flush = () => {
    if (phrase.length) cues.push({ start: phrase[0].start, end: phrase[phrase.length - 1].end, text: phrase.map(w => w.text).join(" "), style });
    phrase = [];
  };
  for (const word of words) {
    if (phrase.length && (word.start - phrase[phrase.length - 1].end > 0.45 || phrase.length >= 5 || word.end - phrase[0].start > 2.5)) flush();
    phrase.push(word);
    if (/[.!?]$/.test(word.text)) flush();
  }
  flush();
  return cues;
}
