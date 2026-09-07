"use client";

import { useState } from "react";
import Image from "next/image";

export function FootageThumbnail({ src, alt, className = "w-20" }: { src?: string; alt: string; className?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <div className={`relative aspect-[9/16] shrink-0 overflow-hidden bg-black ${className}`} data-testid="footage-thumbnail">
    {src && failedSource !== src && <Image src={src} alt={alt} fill unoptimized sizes="240px" className="object-contain" onError={() => setFailedSource(src)} />}
  </div>;
}
