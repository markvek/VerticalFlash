"use client";

import { useEffect, useState } from "react";
import type { LibraryClip, ClipLibrary } from "@/lib/library-schema";

interface ClipLibraryModalProps {
  open: boolean;
  onClose: () => void;
  // Duration of the shot the clip will fill; too-short clips get flagged
  shotDuration: number | null;
  selectedFilename: string | null;
  onSelect: (filename: string) => void;
  // Multi-select (pinning) mode: the create form pins several clips at
  // once. onSelect then toggles membership in selectedFilenames instead of
  // replacing a single choice.
  multiSelect?: boolean;
  selectedFilenames?: string[];
}

// Full-library clip picker for the clip matching tab — mirrors the
// /library page layout: a preview player plus the date-grouped clip strip.
export function ClipLibraryModal({
  open,
  onClose,
  shotDuration,
  selectedFilename,
  onSelect,
  multiSelect = false,
  selectedFilenames = [],
}: ClipLibraryModalProps) {
  const [library, setLibrary] = useState<ClipLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || library) return;
    fetch("/api/library")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: ClipLibrary) => setLibrary(data))
      .catch(() => setError("Failed to load the clip library"));
  }, [open, library]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggleDateGroup = (key: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Group by (local) shoot date, chronological, undated last — same
  // grouping the /library page uses
  const dateGroups = (() => {
    const map = new Map<
      string,
      { key: string; sortTime: number; items: LibraryClip[] }
    >();
    library?.videos.forEach((video) => {
      const d = video.date ? new Date(video.date) : null;
      const key = d ? d.toLocaleDateString() : "No date";
      const sortTime = d ? new Date(d.toLocaleDateString()).getTime() : Infinity;
      if (!map.has(key)) map.set(key, { key, sortTime, items: [] });
      map.get(key)!.items.push(video);
    });
    return [...map.values()].sort((a, b) => a.sortTime - b.sortTime);
  })();

  const previewVideo = library?.videos.find(
    (v) => v.filename === previewFilename
  );
  const tooShort = (v: LibraryClip) =>
    v.duration != null && shotDuration != null && v.duration < shotDuration;
  const isChosen = (filename: string) =>
    multiSelect
      ? selectedFilenames.includes(filename)
      : filename === selectedFilename;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-4xl flex-col gap-3 rounded-lg border border-border bg-card p-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            All Clips
            {library && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {library.videos.length} in library
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Close ✕
          </button>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}
        {!library && !error && (
          <p className="text-xs text-muted-foreground">Loading library…</p>
        )}

        {/* Preview player for the highlighted clip */}
        {previewVideo && (
          <div className="flex gap-3 items-start">
            <div className="h-72 w-44 shrink-0 overflow-hidden rounded-lg bg-black">
              <video
                key={previewVideo.filename}
                src={`/api/library/clips/${encodeURIComponent(previewVideo.filename)}`}
                controls
                autoPlay
                muted
                className="w-full h-full object-contain"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <p className="break-all font-mono text-xs text-muted-foreground">
                {previewVideo.filename}
                {previewVideo.duration != null &&
                  ` · ${previewVideo.duration.toFixed(1)}s`}
              </p>
              {tooShort(previewVideo) && (
                <p className="text-xs text-red-500">
                  Shorter than this shot ({shotDuration?.toFixed(1)}s) — it
                  will need a freeze or loop to fill the slot
                </p>
              )}
              {previewVideo.description && (
                <p className="text-xs text-muted-foreground line-clamp-3">
                  {previewVideo.description}
                </p>
              )}
              <button
                onClick={() => onSelect(previewVideo.filename)}
                className={`w-fit rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  isChosen(previewVideo.filename)
                    ? "border border-green-500/50 bg-green-500/15 text-green-600 dark:text-green-400"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {multiSelect
                  ? isChosen(previewVideo.filename)
                    ? "✓ Pinned — click to unpin"
                    : "Pin this clip"
                  : isChosen(previewVideo.filename)
                    ? "✓ Selected"
                    : "Select for this shot"}
              </button>
            </div>
          </div>
        )}

        {/* Carousel strip — grouped by shoot date, collapsible per group */}
        {library && (
          <div className="flex items-stretch gap-2 overflow-x-auto rounded-lg border border-border bg-muted/20 p-2 pb-2">
            {dateGroups.map((group) => {
              const expanded = expandedDates.has(group.key);
              const [month, day, year] =
                group.key === "No date"
                  ? ["—", "?", ""]
                  : [
                      new Date(group.sortTime).toLocaleDateString(undefined, {
                        month: "short",
                      }),
                      new Date(group.sortTime).getDate().toString(),
                      new Date(group.sortTime).getFullYear().toString(),
                    ];
              return (
                <div key={group.key} className="flex shrink-0 items-stretch gap-2">
                  <button
                    onClick={() => toggleDateGroup(group.key)}
                    className={`flex w-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border p-2 transition-colors ${
                      expanded
                        ? "border-primary/60 bg-primary/10"
                        : "border-border bg-muted/40 hover:border-primary/60"
                    }`}
                  >
                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                      {month}
                    </span>
                    <span className="text-2xl font-bold leading-none text-foreground">
                      {day}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {year}
                    </span>
                    <span className="mt-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {group.items.length} clips
                    </span>
                    <span className="mt-0.5 text-[10px] text-muted-foreground">
                      {expanded ? "◀ collapse" : "expand ▶"}
                    </span>
                  </button>

                  {expanded &&
                    group.items.map((video) => (
                      <button
                        key={video.filename}
                        onClick={() => setPreviewFilename(video.filename)}
                        title={
                          tooShort(video)
                            ? `${video.filename} — shorter than this shot`
                            : video.filename
                        }
                        className={`flex w-28 shrink-0 flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors ${
                          isChosen(video.filename)
                            ? "border-green-500 ring-2 ring-green-500/60"
                            : tooShort(video)
                              ? "border-red-500/60 hover:border-red-500"
                              : video.filename === previewFilename
                                ? "border-primary bg-primary/10"
                                : "border-border hover:border-primary/60 hover:bg-muted/40"
                        }`}
                      >
                        <video
                          src={`/api/library/clips/${encodeURIComponent(video.filename)}`}
                          className="h-40 w-full rounded-md bg-muted object-cover"
                        />
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {video.filename}
                        </p>
                        <div className="flex flex-wrap items-center gap-0.5">
                          {video.duration != null && (
                            <span
                              className={`text-[8px] ${
                                tooShort(video)
                                  ? "font-semibold text-red-500"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {video.duration.toFixed(1)}s
                            </span>
                          )}
                          {(video.tags || []).slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-muted px-1 py-0 text-[8px] text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
