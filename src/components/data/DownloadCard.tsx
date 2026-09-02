"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn, formatCount, formatRelativeTime } from "@/lib/utils";
import type { DownloadEntry } from "@/lib/download-types";

export interface DownloadCardProps {
  file: DownloadEntry;
  // View count of the published TikTok post matched to this download's
  // Remake render (null = no high-performing match) — highlights the card
  matchedViews?: number | null;
  playing: boolean;
  onPlay: () => void;
  onOpen: () => void;
  onFork: () => void;
  forking: boolean;
  onDelete: () => void;
  onRename: (name: string) => Promise<void>;
}

export function DownloadCard({
  file,
  matchedViews = null,
  playing,
  onPlay,
  onOpen,
  onFork,
  forking,
  onDelete,
  onRename,
}: DownloadCardProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(file.displayName);
  const [thumbFailed, setThumbFailed] = useState(false);

  const hasRender = file.render !== null;
  const thumbSrc = `/api/download-thumb/${encodeURIComponent(file.name)}?source=${
    hasRender ? "render" : "original"
  }&v=${encodeURIComponent(file.render?.renderedAt ?? String(file.modified))}`;
  const videoSrc =
    hasRender && file.videoId
      ? `/api/renders/${file.videoId}`
      : `/api/downloads/${encodeURIComponent(file.name)}`;

  const saveName = async () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== file.displayName) {
      await onRename(trimmed);
    } else {
      setNameDraft(file.displayName);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row gap-6 p-4 rounded-xl border bg-card",
        matchedViews !== null
          ? "border-amber-500/60 ring-1 ring-amber-500/30"
          : "border-border"
      )}
    >
      {/* Vertical 9:16 media — the remake render when one exists */}
      <div className="relative h-[480px] aspect-[9/16] shrink-0 rounded-lg overflow-hidden bg-black mx-auto sm:mx-0">
        {playing ? (
          <video
            src={videoSrc}
            controls
            autoPlay
            playsInline
            className="w-full h-full object-contain"
          />
        ) : (
          <button
            onClick={onPlay}
            className="group relative w-full h-full"
            aria-label={`Play ${file.displayName}`}
          >
            {thumbFailed ? (
              <div className="w-full h-full flex items-center justify-center bg-muted text-muted-foreground text-xs">
                No preview
              </div>
            ) : (
              <img
                src={thumbSrc}
                alt={file.displayName}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setThumbFailed(true)}
              />
            )}
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="size-14 rounded-full bg-black/50 group-hover:bg-black/70 transition-colors flex items-center justify-center">
                <svg
                  className="size-7 text-white translate-x-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.34-5.89a1.5 1.5 0 000-2.54L6.3 2.84z" />
                </svg>
              </span>
            </span>
            <span className="absolute top-2 left-2 flex gap-1.5">
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide",
                  hasRender
                    ? "bg-primary/80 text-primary-foreground"
                    : "bg-black/60 text-white/80"
                )}
              >
                {hasRender
                  ? "Remake"
                  : file.project?.kind === "music"
                    ? "Song"
                    : file.project
                      ? "Idea"
                      : "Original"}
              </span>
              {file.version > 1 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-black/60 text-white">
                  v{file.version}
                </span>
              )}
            </span>
          </button>
        )}
      </div>

      {/* Details + actions */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <div>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              maxLength={100}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") {
                  setNameDraft(file.displayName);
                  setEditingName(false);
                }
              }}
              className="w-full text-lg font-semibold bg-transparent border-b border-primary text-foreground focus:outline-none"
            />
          ) : (
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2 min-w-0">
              <span className="truncate">{file.displayName}</span>
              <button
                onClick={() => {
                  setNameDraft(file.displayName);
                  setEditingName(true);
                }}
                className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                title="Rename"
                aria-label="Rename"
              >
                <svg
                  className="size-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
              </button>
            </h2>
          )}
          <p className="text-xs text-muted-foreground truncate mt-1">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB ·{" "}
            {new Date(file.modified).toLocaleString()} · Edited{" "}
            {formatRelativeTime(file.lastEditedAt ?? file.modified)}
          </p>
        </div>

        {file.meta && (
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-foreground font-medium">
                @{file.meta.authorHandle}
              </span>
              <span>{formatCount(file.meta.playCount)} plays</span>
              <span>{formatCount(file.meta.likeCount)} likes</span>
              <span>{formatCount(file.meta.commentCount)} comments</span>
              <span>{formatCount(file.meta.shareCount)} shares</span>
            </p>
            {file.meta.caption && (
              <p className="line-clamp-2">{file.meta.caption}</p>
            )}
          </div>
        )}

        {file.project && (
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {file.project.music && (
                <span className="text-foreground font-medium">
                  🎵 {file.project.music.title}
                  {file.project.music.author
                    ? ` — ${file.project.music.author}`
                    : ""}
                </span>
              )}
              <span>{file.project.targetDuration}s target</span>
            </p>
            {file.project.prompt && (
              <p className="line-clamp-2">{file.project.prompt}</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {matchedViews !== null && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-semibold">
              ★ Proven · {formatCount(matchedViews)} views on TikTok
            </span>
          )}
          {file.analysis ? (
            <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-semibold">
              Analyzed · {file.analysis.shotCount} shots
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-semibold">
              Not analyzed
            </span>
          )}
          {file.render && (
            <span className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 text-xs font-semibold">
              Rendered
              {file.render.renderedAt &&
                ` ${new Date(file.render.renderedAt).toLocaleDateString()}`}
              {file.render.durationSeconds !== null &&
                ` · ${file.render.durationSeconds.toFixed(1)}s`}
            </span>
          )}
          {file.generatedClips > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-600 dark:text-purple-400 text-xs font-semibold">
              {file.generatedClips} generated clip
              {file.generatedClips !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          <Button size="sm" onClick={onOpen}>
            Open
          </Button>
          {hasRender && (
            <Button
              size="sm"
              variant="outline"
              onClick={onFork}
              disabled={forking}
            >
              {forking ? "Forking…" : `Fork to v${file.version + 1}`}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
