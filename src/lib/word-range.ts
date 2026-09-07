import type { Sentence, Word } from "./segments-schema";

// Word-index ↔ seconds helpers for the storyboard flow. Pure (no ffmpeg
// import) so the beat-trimming UI can share them with the server.

// How far before the first word / after the last word a cut may sit, so
// the cut lands in the breath around a sentence rather than on a phoneme
export const LEAD_SECONDS = 0.15;
export const TAIL_SECONDS = 0.25;

export function clampWordRange(
  words: Word[],
  startWord: number,
  endWord: number
): { startWord: number; endWord: number } {
  const last = words.length - 1;
  let s = Math.max(0, Math.min(Math.floor(startWord), last));
  let e = Math.max(0, Math.min(Math.floor(endWord), last));
  if (e < s) [s, e] = [e, s];
  return { startWord: s, endWord: e };
}

// Cut times for a word range: lead into the gap before the first word and
// trail into the gap after the last, never crossing a neighbouring word.
export function rangeToTimes(
  words: Word[],
  startWord: number,
  endWord: number,
  videoDuration: number
): { start: number; end: number } {
  if (words.length === 0) {
    throw new Error("rangeToTimes: no words");
  }
  const { startWord: s, endWord: e } = clampWordRange(words, startWord, endWord);
  const first = words[s];
  const last = words[e];
  const prevEnd = s > 0 ? words[s - 1].end : 0;
  const nextStart = e < words.length - 1 ? words[e + 1].start : videoDuration;
  const start = Math.max(prevEnd, first.start - LEAD_SECONDS, 0);
  const end = Math.min(nextStart, last.end + TAIL_SECONDS, videoDuration);
  return {
    start: Math.round(start * 1000) / 1000,
    end: Math.round(Math.max(end, start + 0.1) * 1000) / 1000,
  };
}

export function wordsToText(words: Word[], startWord: number, endWord: number): string {
  const { startWord: s, endWord: e } = clampWordRange(words, startWord, endWord);
  return words
    .slice(s, e + 1)
    .map((w) => w.word)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1");
}

// Index of the sentence a word belongs to. Sentences are in transcript
// order; a word in an alignment gap belongs to the last sentence that
// starts before it. -1 when there are no sentences up to that word.
export function sentenceIndexAt(sentences: Sentence[], word: number): number {
  let found = -1;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.start_word > word) break;
    found = i;
    if (word <= s.end_word) return i;
  }
  return found;
}

export const endsSentence = (sentences: Sentence[], word: number): boolean =>
  sentences.some((s) => s.end_word === word);

export const startsSentence = (sentences: Sentence[], word: number): boolean =>
  sentences.some((s) => s.start_word === word);

// Where a beat's END could move so it closes on a whole sentence:
// - finish: the end of the sentence the last word sits in (null when it
//   already closes one)
// - drop: the end of the previous sentence, when the beat is mid-sentence
//   and at least one whole sentence would remain
// - next: (already closes a sentence) the end of the following sentence
// - back: (already closes a sentence) the end of the previous sentence,
//   when at least one whole sentence would remain
export function sentenceEndOptions(
  sentences: Sentence[],
  startWord: number,
  endWord: number
): { finish: number | null; drop: number | null; next: number | null; back: number | null } {
  const i = sentenceIndexAt(sentences, endWord);
  if (i === -1) return { finish: null, drop: null, next: null, back: null };
  const closes = sentences[i].end_word === endWord;
  const prevEnd = i > 0 ? sentences[i - 1].end_word : null;
  const keepsOne = prevEnd != null && prevEnd >= startWord;
  const nextEnd = i + 1 < sentences.length ? sentences[i + 1].end_word : null;
  return {
    finish: closes ? null : sentences[i].end_word,
    drop: !closes && keepsOne ? prevEnd : null,
    next: closes ? nextEnd : null,
    back: closes && keepsOne ? prevEnd : null,
  };
}

// Where a beat's START could move so it opens on a whole sentence:
// - toStart: the start of the sentence the first word sits in (null when
//   it already opens one)
// - skip: the start of the next sentence, when the beat opens mid-sentence
//   and at least one whole sentence would remain
// - prev: (already opens a sentence) the start of the previous sentence
// - next: (already opens a sentence) the start of the following sentence,
//   when at least one whole sentence would remain
export function sentenceStartOptions(
  sentences: Sentence[],
  startWord: number,
  endWord: number
): { toStart: number | null; skip: number | null; prev: number | null; next: number | null } {
  const i = sentenceIndexAt(sentences, startWord);
  if (i === -1) return { toStart: null, skip: null, prev: null, next: null };
  const opens = sentences[i].start_word === startWord;
  const nextStart = i + 1 < sentences.length ? sentences[i + 1].start_word : null;
  const keepsOne = nextStart != null && sentences[i + 1].end_word <= endWord;
  return {
    toStart: opens ? null : sentences[i].start_word,
    skip: !opens && keepsOne ? nextStart : null,
    prev: opens && i > 0 ? sentences[i - 1].start_word : null,
    next: opens && keepsOne ? nextStart : null,
  };
}

// Times + text for a beat whose word range is the source of truth (the
// master's own transcript in WhisperX mode). null when it has no range.
export function resolveWordBeat(
  beat: { start_word: number | null; end_word: number | null },
  words: Word[],
  videoDuration: number
): { start: number; end: number; text: string } | null {
  if (beat.start_word == null || beat.end_word == null || words.length === 0) return null;
  const { start, end } = rangeToTimes(words, beat.start_word, beat.end_word, videoDuration);
  return { start, end, text: wordsToText(words, beat.start_word, beat.end_word) };
}
