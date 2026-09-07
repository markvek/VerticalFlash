"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { beginMediaPlayback, installMediaPlaybackGuard } from "@/lib/media-playback";

export function MediaPlaybackGuard() {
  const pathname = usePathname();
  useEffect(() => installMediaPlaybackGuard(), []);
  useEffect(() => { beginMediaPlayback(); }, [pathname]);
  return null;
}
