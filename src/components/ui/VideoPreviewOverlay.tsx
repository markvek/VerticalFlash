"use client";

import { useRef, useEffect, useState } from "react";

interface VideoPreviewOverlayProps {
  videoUrl: string;
  videoId: string;
  hasAudioPermission: boolean;
}

// Fills its positioned parent (the card's thumbnail container), playing
// the video over the thumbnail. Until the first frame arrives the video
// is transparent, so the thumbnail stays visible underneath.
export function VideoPreviewOverlay({
  videoUrl,
  videoId,
  hasAudioPermission,
}: VideoPreviewOverlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMuted, setIsMuted] = useState(!hasAudioPermission);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = isMuted;

    // Attempt to play, handling autoplay policy
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Autoplay with audio failed, fallback to muted
        if (!isMuted) {
          setIsMuted(true);
          video.muted = true;
          video.play().catch(() => {
            setHasError(true);
          });
        } else {
          setHasError(true);
        }
      });
    }
  }, [isMuted]);

  // On failure, render nothing so the thumbnail underneath stays visible
  if (hasError) return null;

  return (
    <div className="absolute inset-0 z-10">
      <video
        ref={videoRef}
        key={videoId}
        className="size-full object-cover"
        loop
        playsInline
        src={videoUrl}
      />

      {/* Muted indicator badge */}
      {isMuted && (
        <div className="absolute top-2 left-2 flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-xs text-white">
          <svg className="size-3" fill="currentColor" viewBox="0 0 20 20">
            <path d="M8.717 5.408a1 1 0 10-1.414 1.414.5.5 0 00.707.707A1 1 0 008.717 5.408zM4.929 4.929a1 1 0 10-1.414 1.414.5.5 0 00.707.707 1 1 0 001.414-1.414zm9.9 9.9a1 1 0 10-1.414-1.414.5.5 0 00-.707.707 1 1 0 001.414 1.414zM15.07 15.071a1 1 0 10-1.414-1.414.5.5 0 00-.707.707 1 1 0 001.414 1.414zM10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a.999.999 0 10-1.414-1.414L10 8.586l-2.293-2.293a1 1 0 00-1.414 1.414L8.586 10l-2.293 2.293a1 1 0 001.414 1.414L10 11.414l2.293 2.293a1 1 0 001.414-1.414L11.414 10l2.293-2.293z" />
          </svg>
          Muted
        </div>
      )}
    </div>
  );
}
