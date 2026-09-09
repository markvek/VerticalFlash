"use client";

import { useEffect, useRef } from "react";
import { Crop, X } from "lucide-react";
import type { BrollCandidate } from "@/lib/broll-schema";

// The picker for one B-roll segment, anchored under its block on the
// timeline: the phrase it covers, the current clip with a looping preview,
// the matcher's candidates, and the actions (library, re-pick moment,
// accept, remove).

export interface PopoverSegment {
  id: string;
  start: number;
  end: number;
  valid: boolean;
  reason?: string;
  status: "suggested" | "placed";
  clip: { filename: string; clip_start: number | null } | null;
  phrase: string;
  description: string | null;
  candidates: BrollCandidate[];
}

export interface BrollSegmentPopoverProps {
  onFrame?: () => void;
  segment: PopoverSegment;
  anchorRect: { left: number; right: number; top: number; bottom: number } | null;
  thumbSrc: (filename: string) => string;
  clipSrc: (filename: string) => string;
  // Which action is running ("match", "moment", "save"), if any
  busy: string | null;
  onClose: () => void;
  onUseCandidate: (candidate: BrollCandidate) => void;
  onOpenLibrary: () => void;
  onMatch: () => void;
  onRepickMoment: () => void;
  onAccept: () => void;
  onRemove: () => void;
}

const CONFIDENCE: Record<BrollCandidate["confidence"], string> = {
  strong: "bg-green-500/15 text-green-600 dark:text-green-400",
  moderate: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  weak: "bg-muted text-muted-foreground",
};

const WIDTH = 400;

export function BrollSegmentPopover({
  onFrame,
  segment,
  anchorRect,
  thumbSrc,
  clipSrc,
  busy,
  onClose,
  onUseCandidate,
  onOpenLibrary,
  onMatch,
  onRepickMoment,
  onAccept,
  onRemove,
}: BrollSegmentPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const duration = segment.end - segment.start;
  const width = Math.min(WIDTH, window.innerWidth - 16);
  const left = anchorRect
    ? Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8))
    : (window.innerWidth - width) / 2;
  const top = anchorRect ? Math.min(anchorRect.bottom + 8, window.innerHeight - 420) : 120;
  const clipStart = segment.clip?.clip_start ?? 0;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`B-roll segment ${segment.phrase || segment.id}`}
      style={{ left, top: Math.max(8, top), width, maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }}
      className="downloads-layout fixed z-50 rounded-lg border border-violet-500/50 bg-background p-3 text-foreground shadow-xl flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-500">
            {segment.status === "suggested" ? "Suggested B-roll" : segment.clip ? "B-roll" : "Needs a clip"}
            <span className="ml-2 font-mono normal-case text-muted-foreground">
              {segment.start.toFixed(1)}–{segment.end.toFixed(1)}s · {duration.toFixed(1)}s
            </span>
          </p>
          {segment.phrase ? (
            <p className="text-xs italic text-foreground/90 leading-snug mt-0.5">“{segment.phrase}”</p>
          ) : (
            <p className="text-xs text-muted-foreground mt-0.5">No speech under this segment</p>
          )}
          {segment.description && (
            <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{segment.description}</p>
          )}
          {!segment.valid && (
            <p className="text-[10px] text-red-500 mt-0.5">Not rendered — {segment.reason}</p>
          )}
        </div>
        <button onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>

      {segment.clip && (
        <div className="flex gap-2 items-start rounded-md border border-border p-2">
          <div className="w-[72px] shrink-0 rounded overflow-hidden bg-black aspect-[9/16]">
            <video
              key={`${segment.clip.filename}-${clipStart}`}
              muted
              autoPlay
              playsInline
              className="w-full h-full object-cover"
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = clipStart;
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.currentTime >= clipStart + duration) {
                  v.currentTime = clipStart;
                  v.play().catch(() => {});
                }
              }}
            >
              <source src={clipSrc(segment.clip.filename)} />
            </video>
          </div>
          <div className="min-w-0 flex flex-col gap-1">
            <p className="text-xs font-medium truncate">{segment.clip.filename}</p>
            <p className="text-[10px] font-mono text-muted-foreground">
              from {clipStart.toFixed(1)}s in the clip
            </p>
            <div className="flex flex-wrap gap-1.5 mt-0.5">
              {onFrame && <button onClick={onFrame} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"><Crop size={14} />Frame &amp; Layers</button>}
              <button
                onClick={onRepickMoment}
                disabled={busy != null}
                className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold hover:bg-muted disabled:opacity-50"
              >
                {busy === "moment" ? "Picking…" : "Re-pick moment"}
              </button>
              <button
                onClick={onOpenLibrary}
                disabled={busy != null}
                className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold hover:bg-muted disabled:opacity-50"
              >
                Replace from library…
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Candidates{segment.candidates.length ? ` (${segment.candidates.length})` : ""}
          </p>
          <button
            onClick={onMatch}
            disabled={busy != null}
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {busy === "match" ? "Matching…" : segment.candidates.length ? "↺ Re-match" : "Match library clips"}
          </button>
        </div>
        {segment.candidates.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            No candidates yet — match the library, or pick a clip yourself.
          </p>
        ) : (
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {segment.candidates.map((c) => {
              const current = segment.clip?.filename === c.filename;
              return (
                <button
                  key={c.filename}
                  onClick={() => onUseCandidate(c)}
                  disabled={busy != null}
                  className={`flex gap-2 items-start rounded-md border p-1.5 text-left transition-colors hover:border-violet-500/60 disabled:opacity-50 ${
                    current ? "border-violet-500" : "border-border"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbSrc(c.filename)} alt={c.filename} className="h-12 w-9 object-cover rounded bg-muted shrink-0" loading="lazy" />
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <p className="text-[11px] font-medium truncate">
                      {c.filename}
                      {c.duration != null && <span className="text-muted-foreground font-normal"> · {c.duration.toFixed(1)}s</span>}
                    </p>
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${CONFIDENCE[c.confidence]}`}>{c.confidence}</span>
                      {c.clip_start != null && (
                        <span className="px-1.5 py-0.5 rounded-full bg-primary/15 text-primary text-[9px] font-mono">✂ {c.clip_start.toFixed(1)}s</span>
                      )}
                      {current && <span className="text-[9px] text-violet-500 font-semibold">in use</span>}
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-snug">{c.reason}</p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border">
        {!segment.clip && (
          <button
            onClick={onOpenLibrary}
            disabled={busy != null}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          >
            Pick from library…
          </button>
        )}
        {segment.status === "suggested" && (
          <button
            onClick={onAccept}
            disabled={busy != null || !segment.clip}
            title={segment.clip ? undefined : "Pick a clip first"}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            Accept
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={onRemove}
          disabled={busy != null}
          className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-500/10 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
