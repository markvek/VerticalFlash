import type { CompetitorData } from "@/lib/tikhub";
import { formatCount } from "@/lib/utils";

interface CompetitorRowProps {
  competitor: CompetitorData;
}

export function CompetitorRow({ competitor }: CompetitorRowProps) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4 transition-all hover:bg-muted/50">
      <div className="relative size-12 shrink-0 overflow-hidden rounded-full bg-muted">
        {competitor.avatar ? (
          <img
            src={competitor.avatar}
            alt={competitor.nickname}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <svg className="size-6" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                clipRule="evenodd"
              />
            </svg>
          </div>
        )}
        {competitor.verified && (
          <div className="absolute -bottom-0.5 -right-0.5 rounded-full bg-primary p-0.5">
            <svg
              className="size-2.5 text-primary-foreground"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">
            @{competitor.handle}
          </span>
          {competitor.nickname && competitor.nickname !== competitor.handle && (
            <span className="truncate text-sm text-muted-foreground">
              {competitor.nickname}
            </span>
          )}
        </div>
        {competitor.bio && (
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
            {competitor.bio}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-6 text-sm">
        <div className="flex flex-col items-center">
          <span className="font-semibold text-foreground">
            {formatCount(competitor.followers)}
          </span>
          <span className="text-xs text-muted-foreground">followers</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="font-semibold text-foreground">
            {formatCount(competitor.likes)}
          </span>
          <span className="text-xs text-muted-foreground">likes</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="font-semibold text-foreground">
            {competitor.videoCount}
          </span>
          <span className="text-xs text-muted-foreground">videos</span>
        </div>
      </div>
    </div>
  );
}
