import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sentence, Word } from "../src/lib/segments-schema";
import {
  endsSentence,
  rangeToTimes,
  resolveWordBeat,
  sentenceEndOptions,
  sentenceIndexAt,
  sentenceStartOptions,
  startsSentence,
  wordsToText,
} from "../src/lib/word-range";

// Two sentences, half a second per word with a 0.1s gap between words:
// "One two three." (0-2) and "Four five six seven." (3-6)
const words: Word[] = ["One", "two", "three.", "Four", "five", "six", "seven."].map((word, i) => ({
  i,
  word,
  start: i * 0.6,
  end: i * 0.6 + 0.5,
  score: 0.9,
  interpolated: false,
}));
const sentences: Sentence[] = [
  { start: 0, end: 1.7, text: "One two three.", start_word: 0, end_word: 2 },
  { start: 1.8, end: 4.1, text: "Four five six seven.", start_word: 3, end_word: 6 },
];
const duration = 10;

test("rangeToTimes leads into the gap before the first word and trails after the last", () => {
  const { start, end } = rangeToTimes(words, 1, 2, duration);
  // Lead is capped by the previous word's end (0.5), tail by the next word's start (1.8)
  assert.equal(start, 0.5);
  assert.equal(end, 1.8);
  // The last word of the file trails into silence, not past the file
  assert.equal(rangeToTimes(words, 6, 6, 3.7).end, 3.7);
});

test("sentence lookups", () => {
  assert.equal(sentenceIndexAt(sentences, 0), 0);
  assert.equal(sentenceIndexAt(sentences, 4), 1);
  assert.equal(sentenceIndexAt(sentences, 99), 1);
  assert.equal(endsSentence(sentences, 2), true);
  assert.equal(endsSentence(sentences, 4), false);
  assert.equal(startsSentence(sentences, 3), true);
});

test("end options: finish or drop a closing fragment, step whole sentences", () => {
  // Beat "One two three. Four five" ends mid-sentence
  assert.deepEqual(sentenceEndOptions(sentences, 0, 4), {
    finish: 6,
    drop: 2,
    next: null,
    back: null,
  });
  // A beat that is only a fragment can finish but has nothing to drop back to
  assert.deepEqual(sentenceEndOptions(sentences, 3, 4), {
    finish: 6,
    drop: null,
    next: null,
    back: null,
  });
  // A beat closing on sentence one can grow by a sentence, not shrink below one
  assert.deepEqual(sentenceEndOptions(sentences, 0, 2), {
    finish: null,
    drop: null,
    next: 6,
    back: null,
  });
  assert.deepEqual(sentenceEndOptions(sentences, 0, 6), {
    finish: null,
    drop: null,
    next: null,
    back: 2,
  });
});

test("start options: open on a sentence, drop an opening fragment", () => {
  assert.deepEqual(sentenceStartOptions(sentences, 1, 6), {
    toStart: 0,
    skip: 3,
    prev: null,
    next: null,
  });
  assert.deepEqual(sentenceStartOptions(sentences, 3, 6), {
    toStart: null,
    skip: null,
    prev: 0,
    next: null,
  });
  assert.deepEqual(sentenceStartOptions(sentences, 0, 6), {
    toStart: null,
    skip: null,
    prev: null,
    next: 3,
  });
});

test("resolveWordBeat rebuilds times and text from the word range", () => {
  assert.deepEqual(resolveWordBeat({ start_word: 3, end_word: 6 }, words, duration), {
    start: 1.7,
    end: 4.35,
    text: "Four five six seven.",
  });
  assert.equal(wordsToText(words, 0, 2), "One two three.");
  assert.equal(resolveWordBeat({ start_word: null, end_word: 2 }, words, duration), null);
});
