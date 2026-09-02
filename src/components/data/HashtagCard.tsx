import { cn, formatCount } from "@/lib/utils";

interface HashtagCardProps {
  name: string;
  videoCount?: number;
  viewCount?: number;
  subtitle?: string;
  isSelected?: boolean;
  onClick?: () => void;
}

export function HashtagCard({
  name,
  videoCount,
  viewCount,
  subtitle,
  isSelected,
  onClick,
}: HashtagCardProps) {
  const isTrending = viewCount && viewCount > 100_000_000;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start rounded-lg border border-border bg-card p-4 text-left transition-all hover:bg-muted/50",
        isSelected && "border-primary bg-primary/5",
        onClick && "cursor-pointer"
      )}
    >
      <span className="text-lg font-semibold text-foreground">{name}</span>
      {subtitle ? (
        <span className="mt-1 text-sm text-muted-foreground">{subtitle}</span>
      ) : (
        videoCount !== undefined && (
          <span className="mt-1 text-sm text-muted-foreground">
            {formatCount(videoCount)} videos
          </span>
        )
      )}
      {viewCount && (
        <span className="text-xs text-muted-foreground">
          {formatCount(viewCount)} views
        </span>
      )}
      {isTrending && (
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary">
          <svg
            className="size-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
            />
          </svg>
          Trending
        </span>
      )}
    </button>
  );
}
