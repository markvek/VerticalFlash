"use client";
import { useCallback, useRef, useState } from "react";
import { StoryboardPanel } from "./StoryboardPanel";
import type { FootageSource } from "@/lib/segments-schema";
import { beginMediaPlayback, isCurrentMediaPlayback, playMedia } from "@/lib/media-playback";

// The legacy shared editor needs a source player that can switch to attached
// footage independently of its edited timeline player.
export function StoryboardPreviewPanel({ videoId, filename }: { videoId: string; filename: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<FootageSource>();
  const [error, setError] = useState(false);
  const pending = useRef<{ time: number; request: number } | null>(null);
  const url = source ? `/api/library/clips/${encodeURIComponent(source.filename)}` : `/api/downloads/${encodeURIComponent(filename)}`;
  const stop = useCallback(() => { pending.current = null; video.current?.pause(); }, []);
  const seek = (time: number, footage?: FootageSource, request = beginMediaPlayback()) => {
    const target = footage ? `/api/library/clips/${encodeURIComponent(footage.filename)}` : `/api/downloads/${encodeURIComponent(filename)}`;
    const local = time - (footage?.offset ?? 0);
    setError(false); setSource(footage); pending.current = { time: local, request };
    if (video.current?.getAttribute("src") === target && video.current.readyState) {
      video.current.currentTime = local; pending.current = null;
      void playMedia(video.current, request).catch(() => {});
    }
  };
  return <StoryboardPanel videoId={videoId} filename={filename} onSeek={seek} onStopPreview={stop} previewVideoRef={video}
    previewMedia={<div><video ref={video} key={url} src={url} controls playsInline preload="metadata" className="mx-auto max-h-96 max-w-full rounded bg-black" onError={() => setError(true)} onLoadedMetadata={() => {
      const next = pending.current; pending.current = null;
      if (next && video.current && isCurrentMediaPlayback(next.request)) { video.current.currentTime = next.time; void playMedia(video.current, next.request).catch(() => {}); }
    }} />{error && <p role="alert">Footage could not be loaded.</p>}</div>} />;
}
