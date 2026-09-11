"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import { Play, X } from "lucide-react";
import { MIN_SHOT_SECONDS } from "@/lib/shot-retime";
import type { Beat, Sentence, Word } from "@/lib/segments-schema";
import {
  endsSentence,
  rangeToTimes,
  sentenceEndOptions,
  sentenceIndexAt,
  sentenceStartOptions,
  startsSentence,
  wordsToText,
} from "@/lib/word-range";

// Adjust one storyboard beat's length. With WhisperX word timing the range
// is edited by word (click a word, step a word, or jump to a sentence
// boundary); attached footage without word timing gets plain start/end
// seconds. The target length is a goal, so the dialog only reports the new
// duration — it never forces one.

export type BeatTrim = Pick<Beat, "start" | "end" | "start_word" | "end_word" | "text">;

export interface BeatTrimDialogProps {
  open: boolean;
  beat: Beat | null;
  index: number;
  words: Word[];
  sentences: Sentence[];
  /** Length of the beat's source: the master, or the attached clip */
  sourceDuration: number;
  onClose: () => void;
  onApply: (next: BeatTrim) => void;
  onSeek?: (seconds: number) => void;
  busy?: boolean;
  error?: string | null;
}

const fmt = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

const chip =
  "rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent";

export function BeatTrimDialog({
  open,
  beat,
  index,
  words,
  sentences,
  sourceDuration,
  onClose,
  onApply,
  onSeek,
  busy = false,
  error,
}: BeatTrimDialogProps) {
  const [mode, setMode] = useState<"words" | "time">("words");
  const hasWords =
    !!beat && !beat.source && beat.start_word != null && beat.end_word != null && words.length > 0;
  const wordMode = hasWords && mode === "words";
  const offset = beat?.source?.offset ?? 0;

  const [s, setS] = useState(0);
  const [e, setE] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);

  // Fresh draft every time the dialog opens on a beat
  useEffect(() => {
    if (!beat) return;
    setMode("words");
    setS(beat.start_word ?? 0);
    setE(beat.end_word ?? 0);
    setStartSec(Math.max(0, beat.start - offset));
    setEndSec(Math.max(0, beat.end - offset));
  }, [beat, offset, open]);

  const times = useMemo(
    () => (wordMode ? rangeToTimes(words, s, e, sourceDuration) : null),
    [wordMode, words, s, e, sourceDuration]
  );
  const endOpts = useMemo(() => sentenceEndOptions(sentences, s, e), [sentences, s, e]);
  const startOpts = useMemo(() => sentenceStartOptions(sentences, s, e), [sentences, s, e]);

  // The words shown: one sentence of context on each side of the range
  const context = useMemo(() => {
    if (!wordMode) return [] as Word[];
    const si = sentenceIndexAt(sentences, s);
    const ei = sentenceIndexAt(sentences, e);
    const from = si > 0 ? sentences[si - 1].start_word : (sentences[si]?.start_word ?? s);
    const to =
      ei >= 0 && ei + 1 < sentences.length
        ? sentences[ei + 1].end_word
        : (sentences[ei]?.end_word ?? e);
    return words.slice(Math.max(0, from), Math.min(words.length, to + 1));
  }, [wordMode, words, sentences, s, e]);

  if (!beat) return null;

  const originalSeconds = beat.end - beat.start;
  const draftSeconds = wordMode ? times!.end - times!.start : endSec - startSec;
  const delta = draftSeconds - originalSeconds;
  const midStart = wordMode && !startsSentence(sentences, s);
  const midEnd = wordMode && !endsSentence(sentences, e);
  const timeValid = !wordMode && Number.isFinite(startSec) && Number.isFinite(endSec) && endSec - startSec >= MIN_SHOT_SECONDS - 0.000001 && startSec >= 0 && endSec <= sourceDuration + 0.001;

  // Click a word: move whichever edge is nearer to it
  const pick = (i: number) => {
    if (i < s) setS(i);
    else if (i > e) setE(i);
    else if (i - s <= e - i) setS(i);
    else setE(i);
  };

  const apply = () => {
    if (busy || draftSeconds < MIN_SHOT_SECONDS || (!wordMode && !timeValid)) return;
    if (wordMode) {
      onApply({
        start: times!.start,
        end: times!.end,
        start_word: s,
        end_word: e,
        text: wordsToText(words, s, e),
      });
    } else {
      onApply({
        start: Math.round((offset + startSec) * 1000) / 1000,
        end: Math.round((offset + endSec) * 1000) / 1000,
        start_word: null,
        end_word: null,
        text: beat.text,
      });
    }
  };

  const previewStart = wordMode ? times!.start : offset + startSec;

  return (
    <Dialog.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="downloads-layout fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-4 text-foreground">
          <div className="mb-3 flex items-center justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">
              Adjust length · segment {index + 1}
            </Dialog.Title>
            <Dialog.Close aria-label="Close length editor" className="grid size-8 place-items-center rounded-md hover:bg-muted">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-xs text-muted-foreground">
            {wordMode
              ? "Click a word to move the nearest edge to it, or use the sentence shortcuts. Choose complete words or sentences, or switch to exact timing."
              : "Set source start, source end, or duration in seconds. Changing duration moves the end."}
          </Dialog.Description>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono">
              {wordMode ? `${fmt(times!.start)}–${fmt(times!.end)}` : `${fmt(startSec)}–${fmt(endSec)}`}
            </span>
            <span className="font-semibold">{draftSeconds.toFixed(1)}s</span>
            <span className="text-muted-foreground">
              (was {originalSeconds.toFixed(1)}s{delta !== 0 ? `, ${delta > 0 ? "+" : ""}${delta.toFixed(1)}s` : ""})
            </span>
            {midStart && (
              <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-semibold text-yellow-400">
                starts mid-sentence
              </span>
            )}
            {midEnd && (
              <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-semibold text-yellow-400">
                ends mid-sentence
              </span>
            )}
          </div>

          {hasWords && <div className="mt-3 flex gap-2" aria-label="Length editing mode">
            <button className={chip} aria-pressed={wordMode} onClick={() => {
              if (!wordMode) {
                const first = words.findIndex(w => w.end > startSec + offset);
                const last = words.findLastIndex(w => w.start < endSec + offset);
                const start = first < 0 ? words.length - 1 : first;
                setS(start); setE(Math.max(start, last));
              }
              setMode("words");
            }}>Transcript</button>
            <button className={chip} aria-pressed={!wordMode} onClick={() => { if (times && (s !== beat.start_word || e !== beat.end_word)) { setStartSec(times.start - offset); setEndSec(times.end - offset); } setMode("time"); }}>Exact timing</button>
          </div>}
          {wordMode ? (
            <>
              <div
                className="mt-3 max-h-56 overflow-y-auto rounded-md border border-border p-2 text-sm leading-7"
                aria-label="Transcript words around this segment"
              >
                {context.map((w) => {
                  const inRange = w.i >= s && w.i <= e;
                  const edge = w.i === s || w.i === e;
                  return (
                    <button
                      key={w.i}
                      onClick={() => pick(w.i)}
                      title={`word ${w.i} · ${w.start.toFixed(2)}s`}
                      className={`mr-1 rounded px-0.5 transition-colors ${
                        inRange
                          ? `bg-primary/20 text-foreground ${edge ? "ring-1 ring-primary/70" : ""}`
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      {w.word}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Start</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button className={chip} disabled={s <= 0} onClick={() => setS(s - 1)}>−1 word</button>
                    <button className={chip} disabled={s >= e} onClick={() => setS(s + 1)}>+1 word</button>
                    {startOpts.toStart != null && (
                      <button className={chip} onClick={() => setS(startOpts.toStart!)}>◀ Sentence start</button>
                    )}
                    {startOpts.skip != null && (
                      <button className={chip} onClick={() => setS(startOpts.skip!)}>Drop opening fragment</button>
                    )}
                    {startOpts.prev != null && (
                      <button className={chip} onClick={() => setS(startOpts.prev!)}>+ Previous sentence</button>
                    )}
                    {startOpts.next != null && (
                      <button className={chip} onClick={() => setS(startOpts.next!)}>− First sentence</button>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">End</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button className={chip} disabled={e <= s} onClick={() => setE(e - 1)}>−1 word</button>
                    <button className={chip} disabled={e >= words.length - 1} onClick={() => setE(e + 1)}>+1 word</button>
                    {endOpts.finish != null && (
                      <button className={`${chip} border-primary/60`} onClick={() => setE(endOpts.finish!)}>Finish sentence ▶</button>
                    )}
                    {endOpts.drop != null && (
                      <button className={chip} onClick={() => setE(endOpts.drop!)}>Drop closing fragment</button>
                    )}
                    {endOpts.next != null && (
                      <button className={chip} onClick={() => setE(endOpts.next!)}>+ Next sentence</button>
                    )}
                    {endOpts.back != null && (
                      <button className={chip} onClick={() => setE(endOpts.back!)}>− Last sentence</button>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
              <label className="flex flex-col gap-1">
                Source start (s)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={sourceDuration}
                  value={startSec}
                  onChange={(event) => setStartSec(Number(event.target.value))}
                  className="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1">
                Source end (s)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={sourceDuration}
                  value={endSec}
                  onChange={(event) => setEndSec(Number(event.target.value))}
                  className="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1">
                Duration (s)
                <input type="number" step={0.1} min={MIN_SHOT_SECONDS} max={sourceDuration - startSec}
                  value={Math.round((endSec - startSec) * 1000) / 1000}
                  onChange={event => setEndSec(startSec + Number(event.target.value))}
                  className="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono" />
              </label>
              <span className="text-muted-foreground">clip runs {sourceDuration.toFixed(1)}s</span>
            </div>
          )}

          {(!wordMode && !timeValid || draftSeconds < MIN_SHOT_SECONDS) && <p className="mt-3 text-xs text-amber-500">Choose a range within the source, at least {MIN_SHOT_SECONDS}s long.</p>}
          {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {onSeek && (
              <button
                onClick={() => onSeek(previewStart)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-semibold"
              >
                <Play className="size-3" /> Play from start
              </button>
            )}
            <div className="flex-1" />
            <button onClick={onClose} className="rounded-md border border-border px-3 py-2 text-xs font-semibold">
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={busy || draftSeconds < MIN_SHOT_SECONDS || (!wordMode && !timeValid)}
              className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Saving…" : "Apply"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
