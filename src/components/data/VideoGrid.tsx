import type { Video } from "@/lib/tikhub";
import { VideoCard } from "./VideoCard";

interface VideoGridProps {
  videos: Video[];
  title?: string;
}

export function VideoGrid({ videos, title }: VideoGridProps) {
  if (videos.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {title && (
        <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {videos.map((video) => (
          <VideoCard key={video.id} video={video} />
        ))}
      </div>
    </div>
  );
}
