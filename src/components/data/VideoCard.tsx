"use client";

import { useState, useRef, useEffect } from "react";
import type { Video } from "@/lib/tikhub";
import { formatCount } from "@/lib/utils";
import { Popover } from "@/components/ui/popover";
import { VideoPreviewOverlay } from "@/components/ui/VideoPreviewOverlay";
import { useVideoAutoplayPermission } from "@/hooks/useVideoAutoplayPermission";

type DownloadStage =
  | "idle"
  | "downloading"
  | "analyzing"
  | "tagging"
  | "done"
  | "error";

const STAGE_LABELS: Record<Exclude<DownloadStage, "idle" | "done" | "error">, string> = {
  downloading: "Downloading…",
  analyzing: "Analyzing with Gemini…",
  tagging: "Tagging shots…",
};

export function VideoCard({ video }: { video: Video }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [stage, setStage] = useState<DownloadStage>("idle");
  const [stageError, setStageError] = useState<string | null>(null);
  const [savedFilename, setSavedFilename] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAudioPermission = useVideoAutoplayPermission();

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const tiktokUrl =
    video.authorHandle && video.id
      ? `https://www.tiktok.com/@${video.authorHandle}/video/${video.id}`
      : null;

  const handleMouseEnter = () => {
    if (!video.id) return;

    // Delay before showing so sweeping the cursor across the grid doesn't
    // fire a preview fetch (and a TikHub API call) per card crossed
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setShowPreview(true), 400);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setShowPreview(false);
  };

  const handleDownload = async () => {
    if (stage !== "idle" && stage !== "done" && stage !== "error") return;
    setPopoverOpen(false);
    setStage("downloading");
    setStageError(null);

    // TikTok CDN blocks cross-origin fetch, so the server resolves a
    // downloadable URL by video ID, saves a copy into downloads/, and
    // streams the mp4 back
    const filename = `${video.authorHandle}_${video.id}.mp4`;
    const proxyUrl = `/api/proxy-video?videoId=${encodeURIComponent(video.id)}&filename=${encodeURIComponent(filename)}`;

    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Download failed (HTTP ${res.status})`);
      }
      const saved = res.headers.get("X-Saved-Filename") || filename;
      setSavedFilename(saved);

      // Still hand the file to the browser's own download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = saved;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      window.dispatchEvent(new Event("downloads-changed"));

      // Round 1: shot split (skip when an analysis already exists)
      let analysis = await fetch(`/api/analyze/${video.id}`).then((r) =>
        r.ok ? r.json() : null
      );
      if (!analysis) {
        setStage("analyzing");
        const analyzeRes = await fetch(`/api/analyze/${video.id}`, {
          method: "POST",
        });
        analysis = await analyzeRes.json();
        if (!analyzeRes.ok) {
          throw new Error(analysis?.error || "Analysis failed");
        }
      }

      // Round 2: shot tags
      if (!analysis.taggedAt) {
        setStage("tagging");
        const tagRes = await fetch(`/api/analyze/${video.id}/tags`, {
          method: "POST",
        });
        if (!tagRes.ok) {
          const data = await tagRes.json().catch(() => null);
          throw new Error(data?.error || "Shot tagging failed");
        }
      }

      setStage("done");
    } catch (error) {
      setStageError(
        error instanceof Error ? error.message : "Download failed"
      );
      setStage("error");
    }
  };

  const card = (
    <div
      onClick={() => setPopoverOpen(!popoverOpen)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group flex h-full cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card transition-all hover:border-primary/50"
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-muted">
        {showPreview && video.id && (
          <VideoPreviewOverlay
            videoUrl={`/api/preview-video?videoId=${encodeURIComponent(video.id)}`}
            videoId={video.id}
            hasAudioPermission={hasAudioPermission}
          />
        )}
        {video.thumbnail ? (
          <img
            src={video.thumbnail}
            alt={video.caption || "Video thumbnail"}
            className="size-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <svg
              className="size-8 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <p className="line-clamp-2 text-sm text-foreground">
          {video.caption || "No caption"}
        </p>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <svg className="size-3" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
              <path
                fillRule="evenodd"
                d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
                clipRule="evenodd"
              />
            </svg>
            {formatCount(video.playCount)}
          </span>
          <span className="flex items-center gap-1">
            <svg className="size-3" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"
                clipRule="evenodd"
              />
            </svg>
            {formatCount(video.likeCount)}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          @{video.authorHandle}
        </div>
        {stage !== "idle" && (
          <div
            className="mt-1 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            {stage === "error" ? (
              <span className="text-red-500 break-words">{stageError}</span>
            ) : stage === "done" ? (
              savedFilename ? (
                <a
                  href={`/downloads/${encodeURIComponent(savedFilename)}`}
                  className="text-primary hover:underline"
                >
                  Ready — open in editor
                </a>
              ) : (
                <span className="text-primary">Ready</span>
              )
            ) : (
              <span className="text-muted-foreground animate-pulse">
                {STAGE_LABELS[stage]}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const popoverContent = (
    <div className="flex flex-col gap-2 p-2">
      {tiktokUrl && (
        <a
          href={tiktokUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted/50 rounded transition-colors"
          onClick={() => setPopoverOpen(false)}
        >
          <span>Watch</span>
          <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
            />
          </svg>
        </a>
      )}
      {video.id && (
        <button
          onClick={handleDownload}
          className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted/50 rounded transition-colors"
        >
          <span>Download</span>
          <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </button>
      )}
    </div>
  );

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={setPopoverOpen}
      trigger={card}
      content={popoverContent}
    />
  );
}
