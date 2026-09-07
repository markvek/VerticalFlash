"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { MIN_SHOT_SECONDS, type RetimeEdit } from "@/lib/shot-retime";

// The editor's timeline: one column per shot, sized by duration, with the
// frame / time / text / notes / tags tracks and (once matched) the B-roll
// recommendations track. Boundaries between shots are draggable: on a
// storyboard cutdown a drag changes the shot's footage range (its real
// length); on any other project it moves the split point.

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
}: ShotTimelineProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!drag) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dragRef.current = null;
        setDrag(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drag]);

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
  const leftOf = (i: number) => shots.slice(0, i).reduce((sum, _s, k) => sum + widthFor(k), 0);

  // Where a handle's value starts from
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

  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
      {/* Track labels */}
      <div className="flex flex-col shrink-0 bg-muted/40 border-r border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <div className="h-24 flex items-center px-2">Video</div>
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
      <div ref={timelineRef} className={`relative overflow-x-auto ${drag ? "select-none" : ""}`}>
        <div className="relative" style={{ width: totalWidth }}>
          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
            style={{ left: playheadTime * pxPerSec }}
          />
          <div className="flex">
            {shots.map((s) => (
              <button
                key={s.index}
                onClick={() => onSelectShot(s.index)}
                style={{ width: widthFor(s.index) }}
                className={`flex flex-col shrink-0 text-left border-l first:border-l-0 border-border transition-colors ${
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
                <div className="h-16 w-full px-1 py-1 overflow-hidden border-b border-border">
                  <p className="text-[9px] leading-tight text-foreground line-clamp-4 break-words">
                    {s.spoken_text || <span className="text-muted-foreground">—</span>}
                  </p>
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
              </button>
            ))}
          </div>

          {/* Recommended B-roll track (outside the shot buttons —
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
                          <button
                            key={r.filename}
                            onClick={() => recs.onPreview(s.index, r)}
                            title={`${r.filename} (${r.confidence}) — ${r.reason}${
                              r.trim_start != null && r.trim_end != null
                                ? ` — use ${r.trim_start.toFixed(1)}s → ${r.trim_end.toFixed(1)}s`
                                : ""
                            }`}
                            className={`relative shrink-0 rounded overflow-hidden border transition-colors ${
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
