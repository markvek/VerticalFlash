"use client";

import { useRef, useEffect } from "react";
import { playMedia } from "@/lib/media-playback";

interface VideoPreviewOverlayProps {
  videoUrl: string;
  videoId: string;
  playbackRequest: number;
}

export function VideoPreviewOverlay({ videoUrl, videoId, playbackRequest }: VideoPreviewOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    playMedia(video, playbackRequest).catch(() => {});
    return () => video.pause();
  }, [playbackRequest, videoUrl]);

  return <div className="absolute inset-0 z-10" onClick={(event) => event.stopPropagation()}>
    <video ref={videoRef} key={videoId} className="size-full object-cover" controls playsInline src={videoUrl} />
  </div>;
}
