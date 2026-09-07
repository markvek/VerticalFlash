"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { MIN_SHOT_SECONDS, type RetimeEdit } from "@/lib/shot-retime";
import { MIN_BROLL_SECONDS } from "@/lib/broll-resolve";
import type { Word } from "@/lib/segments-schema";

// The editor's timeline: one column per shot, sized by duration, with the
// frame / B-roll / time / text / notes / tags tracks and (once matched) the
// B-roll recommendations track. Boundaries between shots are draggable: on
// a storyboard cutdown a drag changes the shot's footage range (its real
// length); on any other project it moves the split point. B-roll blocks
// sit on their own track and can be moved, trimmed, created from a
// highlighted phrase in the SPOKEN row, or placed from a recommendation.

export interface TimelineShot {
  index: number;
  start_time: number;
  end_time: number;
  screenshot: string;
  on_screen_text: string;
  spoken_text: string;
  description: string;
  tags?: string[];
  source_start?: number;
  source_end?: number;
}

export interface TimelineRec {
  filename: string;
  confidence: "strong" | "moderate" | "weak";
  reason: string;
  trim_start?: number | null;
  trim_end?: number | null;
}

export interface TimelineResize {
  // "source": drag changes the shot's footage range (cutdowns);
  // "split": drag moves the boundary inside a fixed-length video
  mode: "source" | "split";
  // Footage length, for clamping source-mode drags
  footageMax?: number;
  busy: boolean;
  onCommit: (edit: RetimeEdit) => void;
  // Source mode: pull a proposed footage time onto a word boundary and say
  // whether that boundary sits mid-sentence
  snap?: (index: number, edge: "start" | "end", time: number) => { time: number; midSentence: boolean } | null;
}

export interface TimelineBrollBlock {
  id: string;
  start: number;
  end: number;
  valid: boolean;
  reason?: string;
  status: "suggested" | "placed";
  clip: { filename: string; clip_start: number | null } | null;
  phrase: string;
  description: string | null;
}

export interface TimelineBroll {
  blocks: TimelineBrollBlock[];
  selectedId: string | null;
  coverage: { covered: number; total: number };
  busy: boolean;
  thumbSrc: (filename: string) => string;
  onSelect: (id: string | null, rect: DOMRect | null) => void;
  onChangeRange: (id: string, start: number, end: number) => void;
  // Click on empty track space
  onCreateAt: (time: number) => void;
  onRemove: (id: string) => void;
  onAcceptAll?: () => void;
  // Phrase selection in the SPOKEN row (shots with word timing)
  wordsForShot?: (index: number) => Word[];
  onPhrase?: (shotIndex: number, startWord: number, endWord: number) => void;
  // "+" on a recommendation thumbnail: cover the shot with that clip
  onPlaceRec?: (shotIndex: number, rec: TimelineRec) => void;
}

export interface ShotTimelineProps {
  shots: TimelineShot[];
  selectedShot: number;
  playheadTime: number;
  timelineRef: RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  sectionFor: (index: number) => { label: string; className: string } | null;
  onSelectShot: (index: number, seek?: boolean) => void;
  confidenceStyles: Record<TimelineRec["confidence"], string>;
  recs: {
    byShot: Map<number, TimelineRec[]>;
    selectedByShot: Map<number, string | null>;
    keepSourceByShot: Map<number, boolean>;
    gapForShot: (index: number) => boolean;
    thumbSrc: (filename: string) => string;
    sourceBadgeClass: string;
    onGenerate: (index: number) => void;
    onPreview: (index: number, rec: TimelineRec) => void;
  } | null;
  resize?: TimelineResize | null;
  broll?: TimelineBroll | null;
}

interface DragState {
  index: number;
  edge: "start" | "end";
  // The value being dragged: footage seconds (source) or short seconds (split)
  original: number;
  current: number;
  midSentence: boolean;
  startX: number;
}

interface BlockDrag {
  id: string;
  part: "body" | "start" | "end";
  origStart: number;
  origEnd: number;
  start: number;
  end: number;
  startX: number;
  moved: boolean;
}

interface PhraseSel {
  shot: number;
  a: number;
  b: number;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s - Math.floor(s / 60) * 60).toFixed(1).padStart(4, "0")}`;

export function ShotTimeline({
  shots,
  selectedShot,
  playheadTime,
  timelineRef,
  pxPerSec,
  sectionFor,
  onSelectShot,
  confidenceStyles,
  recs,
  resize,
  broll,
}: ShotTimelineProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [blockDrag, setBlockDrag] = useState<BlockDrag | null>(null);
  const blockDragRef = useRef<BlockDrag | null>(null);
  const [phraseSel, setPhraseSel] = useState<PhraseSel | null>(null);
  // Mirror of phraseSel that updates synchronously, so pointer events that
  // arrive before React re-renders still extend the selection
  const phraseRef = useRef<PhraseSel | null>(null);
  const selecting = useRef(false);
  const updatePhrase = (next: PhraseSel | null) => {
    phraseRef.current = next;
    setPhraseSel(next);
  };

  useEffect(() => {
    if (!drag && !blockDrag && !phraseSel) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dragRef.current = null;
        blockDragRef.current = null;
        setDrag(null);
        setBlockDrag(null);
        updatePhrase(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drag, blockDrag, phraseSel]);

  // A phrase selection ends wherever the pointer is released
  useEffect(() => {
    const up = () => {
      selecting.current = false;
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  // Column widths during a drag: the dragged shot grows or shrinks; in
  // split mode its neighbour absorbs the change
  const durationFor = (i: number): number => {
    const s = shots[i];
    let d = s.end_time - s.start_time;
    if (drag) {
      const delta = drag.current - drag.original;
      if (resize?.mode === "source") {
        if (drag.index === i) d += drag.edge === "end" ? delta : -delta;
      } else if (drag.edge === "end") {
        if (drag.index === i) d += delta;
        if (drag.index + 1 === i) d -= delta;
      }
    }
    return Math.max(0.05, d);
  };
  const widthFor = (i: number) => durationFor(i) * pxPerSec;
  const totalWidth = shots.reduce((sum, _s, i) => sum + widthFor(i), 0);
  const totalSeconds = shots.reduce((sum, _s, i) => sum + durationFor(i), 0);
  const leftOf = (i: number) => shots.slice(0, i).reduce((sum, _s, k) => sum + widthFor(k), 0);

  // ---- Shot boundary drags -------------------------------------------

  const baseValue = (index: number, edge: "start" | "end"): number => {
    const s = shots[index];
    if (resize?.mode === "source") return edge === "end" ? (s.source_end ?? s.end_time) : (s.source_start ?? s.start_time);
    return s.end_time;
  };

  const clamp = (index: number, edge: "start" | "end", value: number): number => {
    const s = shots[index];
    if (resize?.mode === "source") {
      const lo = edge === "end" ? (s.source_start ?? 0) + MIN_SHOT_SECONDS : 0;
      const hi = edge === "end" ? (resize.footageMax ?? Infinity) : (s.source_end ?? Infinity) - MIN_SHOT_SECONDS;
      return Math.max(lo, Math.min(value, hi));
    }
    const next = shots[index + 1];
    const lo = s.start_time + MIN_SHOT_SECONDS;
    const hi = (next?.end_time ?? s.end_time) - MIN_SHOT_SECONDS;
    return Math.max(lo, Math.min(value, hi));
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, index: number, edge: "start" | "end") => {
    if (!resize || resize.busy) return;
    event.preventDefault();
    event.stopPropagation();
    // Alt on an interior boundary (source mode) trims the right shot's
    // start instead of the left shot's end
    let target = { index, edge };
    if (resize.mode === "source" && edge === "end" && event.altKey && shots[index + 1]) {
      target = { index: index + 1, edge: "start" };
    }
    const original = baseValue(target.index, target.edge);
    const state: DragState = { ...target, original, current: original, midSentence: false, startX: event.clientX };
    dragRef.current = state;
    setDrag(state);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state) return;
    let value = clamp(state.index, state.edge, state.original + (event.clientX - state.startX) / pxPerSec);
    let midSentence = false;
    if (resize?.mode === "source" && resize.snap) {
      const snapped = resize.snap(state.index, state.edge, value);
      if (snapped) {
        value = clamp(state.index, state.edge, snapped.time);
        midSentence = snapped.midSentence;
      }
    }
    const next = { ...state, current: value, midSentence };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = () => {
    const state = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!state || !resize) return;
    if (Math.abs(state.current - state.original) < 0.02) return;
    const value = Math.round(state.current * 1000) / 1000;
    if (resize.mode === "source") {
      resize.onCommit(state.edge === "end" ? { index: state.index, source_end: value } : { index: state.index, source_start: value });
    } else {
      resize.onCommit({ index: state.index, end_time: value });
    }
  };

  // Handles: every shot's end (split mode skips the last), plus the first
  // shot's start in source mode
  const handles: Array<{ index: number; edge: "start" | "end"; x: number }> = [];
  if (resize) {
    if (resize.mode === "source") handles.push({ index: 0, edge: "start", x: 0 });
    shots.forEach((_s, i) => {
      if (resize.mode === "split" && i === shots.length - 1) return;
      handles.push({ index: i, edge: "end", x: leftOf(i) + widthFor(i) });
    });
  }
  const dragX = drag
    ? drag.edge === "end"
      ? leftOf(drag.index) + widthFor(drag.index)
      : leftOf(drag.index)
    : 0;
  const dragDelta = drag ? drag.current - drag.original : 0;

  // ---- B-roll blocks ---------------------------------------------------

  const shotAt = (t: number) => shots.find((s) => t >= s.start_time && t < s.end_time) ?? shots[shots.length - 1];

  const blockRange = (b: TimelineBrollBlock) =>
    blockDrag && blockDrag.id === b.id ? { start: blockDrag.start, end: blockDrag.end } : { start: b.start, end: b.end };

  const clampBlock = (id: string, start: number, end: number, part: BlockDrag["part"]) => {
    const block = broll?.blocks.find((b) => b.id === id);
    if (!block) return { start, end };
    // Stay inside the shot the block belongs to, and off its neighbours
    const shot = shotAt(block.start);
    const others = (broll?.blocks ?? []).filter((b) => b.id !== id && b.valid && b.status === "placed");
    const prevEnd = Math.max(shot.start_time, ...others.filter((b) => b.end <= block.start + 0.01).map((b) => b.end));
    const nextStart = Math.min(shot.end_time, ...others.filter((b) => b.start >= block.end - 0.01).map((b) => b.start));
    const len = end - start;
    if (part === "body") {
      const s = Math.max(prevEnd, Math.min(start, nextStart - len));
      return { start: s, end: s + len };
    }
    if (part === "start") return { start: Math.max(prevEnd, Math.min(start, end - MIN_BROLL_SECONDS)), end };
    return { start, end: Math.min(nextStart, Math.max(end, start + MIN_BROLL_SECONDS)) };
  };

  const beginBlockDrag = (event: ReactPointerEvent<HTMLDivElement>, b: TimelineBrollBlock, part: BlockDrag["part"]) => {
    if (!broll || broll.busy || !b.valid) return;
    event.preventDefault();
    event.stopPropagation();
    const state: BlockDrag = { id: b.id, part, origStart: b.start, origEnd: b.end, start: b.start, end: b.end, startX: event.clientX, moved: false };
    blockDragRef.current = state;
    setBlockDrag(state);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveBlockDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = blockDragRef.current;
    if (!state) return;
    const delta = (event.clientX - state.startX) / pxPerSec;
    let start = state.origStart;
    let end = state.origEnd;
    if (state.part === "body") {
      start += delta;
      end += delta;
    } else if (state.part === "start") start += delta;
    else end += delta;
    const clamped = clampBlock(state.id, start, end, state.part);
    const next = { ...state, ...clamped, moved: state.moved || Math.abs(delta) > 0.02 };
    blockDragRef.current = next;
    setBlockDrag(next);
  };

  const endBlockDrag = (event: ReactPointerEvent<HTMLDivElement>, b: TimelineBrollBlock) => {
    const state = blockDragRef.current;
    blockDragRef.current = null;
    setBlockDrag(null);
    if (!state || !broll) return;
    if (!state.moved) {
      // A click: open the block's picker
      broll.onSelect(b.id, (event.currentTarget.closest("[data-broll-block]") as HTMLElement | null)?.getBoundingClientRect() ?? null);
      return;
    }
    if (Math.abs(state.start - state.origStart) < 0.02 && Math.abs(state.end - state.origEnd) < 0.02) return;
    broll.onChangeRange(b.id, Math.round(state.start * 1000) / 1000, Math.round(state.end * 1000) / 1000);
  };

  const coveragePct = broll && broll.coverage.total > 0 ? Math.round((broll.coverage.covered / broll.coverage.total) * 100) : 0;
  const suggestedCount = broll?.blocks.filter((b) => b.status === "suggested").length ?? 0;

  // ---- Phrase selection (SPOKEN row) ------------------------------------

  const phraseRange = phraseSel ? { lo: Math.min(phraseSel.a, phraseSel.b), hi: Math.max(phraseSel.a, phraseSel.b) } : null;

  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
      {/* Track labels */}
      <div className="flex flex-col shrink-0 bg-muted/40 border-r border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <div className="h-24 flex items-center px-2">Video</div>
        {broll && (
          <div className="h-16 flex flex-col justify-center px-2 border-t border-border text-violet-500" title="Seconds of the short covered by B-roll">
            <span>B-roll</span>
            <span className="font-mono text-[9px] normal-case tracking-normal text-muted-foreground">
              {broll.coverage.covered.toFixed(1)}s · {coveragePct}%
            </span>
            {suggestedCount > 0 && broll.onAcceptAll && (
              <button
                onClick={broll.onAcceptAll}
                disabled={broll.busy}
                className="mt-0.5 self-start rounded px-1 py-px text-[9px] normal-case tracking-normal bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
              >
                Accept all ({suggestedCount})
              </button>
            )}
          </div>
        )}
        <div className="h-10 flex items-center px-2 border-y border-border">Time</div>
        <div className="h-16 flex items-center px-2 border-b border-border">On-screen</div>
        <div className="h-16 flex items-center px-2 border-b border-border">Spoken</div>
        <div className="h-20 flex items-center px-2">Notes</div>
        <div className="h-14 flex items-center px-2 border-t border-border">Tags</div>
        {recs && (
          <div className="h-20 flex items-center px-2 border-t border-border text-primary">B-roll recs.</div>
        )}
      </div>

      {/* Scrollable tracks */}
      <div ref={timelineRef} className={`relative overflow-x-auto ${drag || blockDrag ? "select-none" : ""}`}>
        <div className="relative" style={{ width: totalWidth }}>
          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
            style={{ left: playheadTime * pxPerSec }}
          />
          {/* What the B-roll covers, marked along the top of the VIDEO track */}
          {broll?.blocks
            .filter((b) => b.valid && b.status === "placed" && b.clip)
            .map((b) => {
              const r = blockRange(b);
              return (
                <div
                  key={`cover-${b.id}`}
                  className="absolute top-0 h-[3px] bg-violet-500 z-10 pointer-events-none"
                  style={{ left: r.start * pxPerSec, width: (r.end - r.start) * pxPerSec }}
                />
              );
            })}

          <div className="flex">
            {shots.map((s) => {
              const words = broll?.wordsForShot?.(s.index) ?? [];
              const selectable = words.length > 0 && !!broll?.onPhrase;
              return (
                <div
                  key={s.index}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectShot(s.index)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onSelectShot(s.index);
                  }}
                  style={{ width: widthFor(s.index) }}
                  className={`flex flex-col shrink-0 text-left border-l first:border-l-0 border-border transition-colors cursor-pointer ${
                    s.index === selectedShot ? "bg-primary/10" : "hover:bg-muted/40"
                  }`}
                >
                  {/* The frame keeps its aspect at track height, pinned
                      left; the rest of the shot's span is a grey slab */}
                  <div className="w-full h-24 bg-muted flex justify-start overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.screenshot}
                      alt={`Shot ${s.index + 1}`}
                      className="h-24 w-auto max-w-full object-contain object-left shrink-0"
                      loading="lazy"
                    />
                  </div>
                  {/* B-roll track spacer: the blocks are drawn once, over
                      all columns, below */}
                  {broll && <div className="h-16 w-full border-t border-border" />}
                  <div
                    className={`h-10 w-full px-1 flex flex-col justify-center border-y ${
                      s.index === selectedShot ? "border-primary/50 bg-primary/15" : "border-border bg-muted/30"
                    }`}
                  >
                    <span className="text-[10px] font-mono text-foreground leading-tight truncate">
                      {s.start_time.toFixed(1)}s
                      {sectionFor(s.index) && (
                        <span
                          className={`ml-1 px-1 py-px rounded-full text-[8px] font-sans font-semibold uppercase ${sectionFor(s.index)!.className}`}
                        >
                          {sectionFor(s.index)!.label}
                        </span>
                      )}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground leading-tight truncate">
                      +{durationFor(s.index).toFixed(1)}s
                    </span>
                  </div>
                  <div className="h-16 w-full px-1 py-1 overflow-hidden border-b border-border">
                    <p className="text-[9px] leading-tight text-foreground line-clamp-4 break-words italic">
                      {s.on_screen_text || <span className="text-muted-foreground">—</span>}
                    </p>
                  </div>
                  <div className="relative h-16 w-full px-1 py-1 overflow-hidden border-b border-border">
                    {selectable ? (
                      <p
                        className="text-[9px] leading-tight text-foreground break-words select-none"
                        title="Drag across words to cover them with B-roll"
                      >
                        {words.map((w) => {
                          const inSel = phraseSel?.shot === s.index && phraseRange && w.i >= phraseRange.lo && w.i <= phraseRange.hi;
                          return (
                            <span
                              key={w.i}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                selecting.current = true;
                                updatePhrase({ shot: s.index, a: w.i, b: w.i });
                              }}
                              onPointerEnter={() => {
                                const current = phraseRef.current;
                                if (selecting.current && current?.shot === s.index) updatePhrase({ ...current, b: w.i });
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className={`rounded px-px cursor-text ${inSel ? "bg-violet-500/40 text-foreground" : "hover:bg-muted"}`}
                            >
                              {w.word}{" "}
                            </span>
                          );
                        })}
                      </p>
                    ) : (
                      <p className="text-[9px] leading-tight text-foreground line-clamp-4 break-words">
                        {s.spoken_text || <span className="text-muted-foreground">—</span>}
                      </p>
                    )}
                    {phraseSel?.shot === s.index && phraseRange && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          broll?.onPhrase?.(s.index, phraseRange.lo, phraseRange.hi);
                          updatePhrase(null);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="absolute right-1 bottom-1 z-20 rounded-md bg-violet-600 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow hover:bg-violet-500"
                      >
                        + B-roll
                      </button>
                    )}
                  </div>
                  <div className="h-20 w-full px-1 py-1 overflow-hidden">
                    <p className="text-[10px] leading-tight text-foreground line-clamp-5 break-words">{s.description}</p>
                  </div>
                  <div className="h-14 w-full px-1 py-1 overflow-hidden border-t border-border">
                    {s.tags?.length ? (
                      <div className="flex flex-wrap gap-0.5">
                        {s.tags.map((tag) => (
                          <span key={tag} className="rounded-full bg-muted px-1.5 py-px text-[8px] leading-tight text-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[9px] text-muted-foreground">—</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* B-roll track: blocks over the spacer row, plus empty-space
              clicks to start a new segment */}
          {broll && (
            <div
              className="absolute left-0 right-0 z-10"
              style={{ top: 96, height: 64 }}
              onClick={(e) => {
                if (e.target !== e.currentTarget || broll.busy) return;
                const rect = e.currentTarget.getBoundingClientRect();
                broll.onCreateAt((e.clientX - rect.left) / pxPerSec);
              }}
              title="Click empty space to start a B-roll segment here"
            >
              {broll.blocks.length === 0 && (
                <p className="pointer-events-none absolute left-2 top-5 text-[10px] text-muted-foreground border border-dashed border-border rounded-md px-2 py-0.5">
                  Drag across words in SPOKEN, click here, or use + on a recommendation
                </p>
              )}
              {broll.blocks.map((b) => {
                const r = blockRange(b);
                const selected = broll.selectedId === b.id;
                const placeholder = !b.clip;
                return (
                  <div
                    key={b.id}
                    data-broll-block={b.id}
                    style={{ left: r.start * pxPerSec, width: Math.max(8, (r.end - r.start) * pxPerSec) }}
                    title={b.valid ? `${b.phrase || b.description || "B-roll"} · ${r.start.toFixed(1)}–${r.end.toFixed(1)}s` : `Not rendered — ${b.reason}`}
                    className={`group absolute top-1.5 h-[52px] rounded-md border overflow-hidden flex items-center gap-1.5 pr-2 ${
                      !b.valid
                        ? "border-red-500/60 bg-red-500/10 opacity-70"
                        : b.status === "suggested"
                          ? "border-dashed border-violet-400/80 bg-violet-500/10"
                          : placeholder
                            ? "border-dashed border-violet-500 bg-violet-500/10"
                            : "border-violet-500 bg-violet-500/20"
                    } ${selected ? "ring-2 ring-violet-500/60" : ""} ${broll.busy ? "cursor-progress" : "cursor-grab"}`}
                    onPointerDown={(e) => beginBlockDrag(e, b, "body")}
                    onPointerMove={moveBlockDrag}
                    onPointerUp={(e) => endBlockDrag(e, b)}
                    onPointerCancel={(e) => endBlockDrag(e, b)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Like the VIDEO track: the frame fills the block's
                        height at its own aspect, pinned left; the rest of
                        the block is the violet slab */}
                    {b.clip ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={broll.thumbSrc(b.clip.filename)}
                        alt=""
                        className="h-full w-auto max-w-[60%] shrink-0 object-contain object-left bg-muted"
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <span className="h-full w-[30px] shrink-0 border-r border-dashed border-violet-500/60" />
                    )}
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold leading-tight truncate">
                        {b.clip ? b.clip.filename : "needs a clip"}
                        {b.status === "suggested" && <span className="ml-1 text-[8px] font-normal uppercase text-violet-400">suggested</span>}
                      </p>
                      <p className="text-[9px] leading-tight text-muted-foreground truncate italic">
                        {b.phrase || b.description || `${r.start.toFixed(1)}–${r.end.toFixed(1)}s`}
                      </p>
                    </div>
                    {/* Trim handles */}
                    <div
                      onPointerDown={(e) => beginBlockDrag(e, b, "start")}
                      onPointerMove={moveBlockDrag}
                      onPointerUp={(e) => endBlockDrag(e, b)}
                      className="absolute inset-y-0 left-0 w-1.5 cursor-col-resize border-l-2 border-violet-500/80"
                    />
                    <div
                      onPointerDown={(e) => beginBlockDrag(e, b, "end")}
                      onPointerMove={moveBlockDrag}
                      onPointerUp={(e) => endBlockDrag(e, b)}
                      className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize border-r-2 border-violet-500/80"
                    />
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        broll.onRemove(b.id);
                      }}
                      title="Remove this B-roll"
                      aria-label="Remove B-roll segment"
                      className="absolute right-1 top-0.5 hidden group-hover:block text-[10px] text-muted-foreground hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              {blockDrag && (
                <div
                  className="absolute -top-6 z-30 pointer-events-none rounded-md border border-border bg-background/95 px-2 py-0.5 text-[10px] font-mono text-foreground shadow"
                  style={{ left: Math.max(48, blockDrag.start * pxPerSec) }}
                >
                  {fmt(blockDrag.start)}–{fmt(blockDrag.end)} · {(blockDrag.end - blockDrag.start).toFixed(1)}s
                </div>
              )}
            </div>
          )}

          {/* Recommended B-roll track (outside the shot columns —
              thumbnails are clickable themselves) */}
          {recs && (
            <div className="flex border-t border-border">
              {shots.map((s) => {
                const all = recs.byShot.get(s.index) || [];
                // Float the confirmed pick to the front so its green ring
                // is visible (manual picks append past the cap)
                const sel = recs.selectedByShot.get(s.index);
                const shotRecs = sel ? [...all.filter((r) => r.filename === sel), ...all.filter((r) => r.filename !== sel)] : all;
                const gap = recs.gapForShot(s.index);
                const keep = recs.keepSourceByShot.get(s.index);
                return (
                  <div
                    key={s.index}
                    style={{ width: widthFor(s.index) }}
                    className={`h-20 shrink-0 border-l first:border-l-0 border-border px-1 py-1 flex items-center gap-1 overflow-hidden ${
                      s.index === selectedShot ? "bg-primary/10" : ""
                    }`}
                  >
                    {gap && (
                      <button
                        onClick={() => recs.onGenerate(s.index)}
                        title="No library clip covers this shot — generate an AI clip"
                        className="shrink-0 px-1 py-0.5 rounded-md border border-yellow-500/60 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-[9px] font-semibold hover:bg-yellow-500/20 transition-colors"
                      >
                        ⚡ generate
                      </button>
                    )}
                    {keep && (
                      <span
                        title="Renders from the source video at this shot's own time"
                        className={`shrink-0 px-1 py-0.5 rounded-md text-[9px] font-semibold ${recs.sourceBadgeClass}`}
                      >
                        No B-Roll
                      </span>
                    )}
                    {shotRecs.length === 0 ? (
                      !gap && !keep && <span className="text-[10px] text-muted-foreground">—</span>
                    ) : (
                      <>
                        {shotRecs.slice(0, 2).map((r) => (
                          <div key={r.filename} className="relative shrink-0">
                            <button
                              onClick={() => recs.onPreview(s.index, r)}
                              title={`${r.filename} (${r.confidence}) — ${r.reason}${
                                r.trim_start != null && r.trim_end != null
                                  ? ` — use ${r.trim_start.toFixed(1)}s → ${r.trim_end.toFixed(1)}s`
                                  : ""
                              }`}
                              className={`relative block rounded overflow-hidden border transition-colors ${
                                sel === r.filename ? "border-green-500 ring-2 ring-green-500/60" : "border-border hover:border-primary"
                              }`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={recs.thumbSrc(r.filename)} alt={r.filename} className="h-16 w-12 object-cover bg-muted" loading="lazy" />
                              <span
                                className={`absolute bottom-0 left-0 right-0 text-[8px] text-center font-semibold ${confidenceStyles[r.confidence]} backdrop-blur-sm`}
                              >
                                {r.confidence}
                              </span>
                            </button>
                            {broll?.onPlaceRec && (
                              <button
                                onClick={() => broll.onPlaceRec!(s.index, r)}
                                disabled={broll.busy}
                                title="Cover this shot with the clip (B-roll track)"
                                aria-label={`Place ${r.filename} as B-roll over shot ${s.index + 1}`}
                                className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-sm bg-violet-600 text-[11px] font-bold leading-none text-white shadow hover:bg-violet-500 disabled:opacity-50"
                              >
                                +
                              </button>
                            )}
                          </div>
                        ))}
                        {shotRecs.length > 2 && (
                          <span className="text-[10px] text-muted-foreground shrink-0">+{shotRecs.length - 2}</span>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Drag handles over the boundaries */}
          {handles.map((h) => (
            <div
              key={`${h.index}-${h.edge}`}
              role="separator"
              aria-label={
                resize?.mode === "source"
                  ? h.edge === "start"
                    ? `Trim the start of shot ${h.index + 1}`
                    : `Trim the end of shot ${h.index + 1}${shots[h.index + 1] ? " (Alt: the start of the next shot)" : ""}`
                  : `Move the boundary between shots ${h.index + 1} and ${h.index + 2}`
              }
              title={
                resize?.mode === "source"
                  ? h.edge === "start"
                    ? "Drag to trim where this shot starts"
                    : shots[h.index + 1]
                      ? "Drag to change where this shot ends · Alt-drag: where the next shot starts"
                      : "Drag to change where this shot ends"
                  : "Drag to move the cut between these shots"
              }
              onPointerDown={(event) => beginDrag(event, h.index, h.edge)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ left: h.x }}
              className={`group absolute top-0 bottom-0 z-20 w-2 -ml-1 ${resize?.busy ? "cursor-progress" : "cursor-col-resize"}`}
            >
              <div
                className={`absolute inset-y-0 left-1/2 -ml-px w-0.5 transition-colors ${
                  drag && drag.index === h.index && drag.edge === h.edge
                    ? "bg-primary"
                    : "bg-transparent group-hover:bg-primary/70"
                }`}
              />
            </div>
          ))}

          {drag && (
            <div
              className="absolute top-1 z-30 pointer-events-none -translate-x-1/2 rounded-md border border-border bg-background/95 px-2 py-1 text-[10px] font-mono text-foreground shadow"
              style={{ left: Math.max(48, dragX) }}
            >
              {resize?.mode === "source" ? "footage " : ""}
              {fmt(drag.current)}
              <span className={dragDelta >= 0 ? " text-green-500" : " text-yellow-500"}>
                {" "}
                {dragDelta >= 0 ? "+" : ""}
                {dragDelta.toFixed(1)}s
              </span>
              <span className="text-muted-foreground"> · shot {drag.index + 1} → {durationFor(drag.index).toFixed(1)}s</span>
              <span className="text-muted-foreground"> · total {totalSeconds.toFixed(1)}s</span>
              {drag.midSentence && (
                <span className="ml-1 rounded-full bg-yellow-500/15 px-1.5 py-px font-sans font-semibold text-yellow-500">
                  mid-sentence
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
