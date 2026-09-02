"use client";

import { useState } from "react";
import type { ScanResult } from "@/lib/tikhub";
import { cn, formatCount } from "@/lib/utils";
import { HashtagCard } from "./HashtagCard";
import { VideoGrid } from "./VideoGrid";
import { CompetitorRow } from "./CompetitorRow";

interface ScanResultsProps {
  data: ScanResult;
}

export function ScanResults({ data }: ScanResultsProps) {
  const [selectedHashtag, setSelectedHashtag] = useState<string | null>(
    data.hashtags[0]?.name || null
  );
  const [selectedDiscovered, setSelectedDiscovered] = useState<string | null>(
    data.discovered?.expandedTags[0]?.name || null
  );

  const selectedHashtagData = data.hashtags.find(
    (h) => h.name === selectedHashtag
  );
  const selectedDiscoveredData = data.discovered?.expandedTags.find(
    (t) => t.name === selectedDiscovered
  );

  const hasHashtags = data.hashtags.length > 0;
  const hasKeywords = data.keywords.length > 0;
  const hasCompetitors = data.competitors.length > 0;
  const hasData = hasHashtags || hasKeywords || hasCompetitors;

  if (!hasData) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">
          No results found. Try adding hashtags, keywords, or competitor
          accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {hasHashtags && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Hashtags
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {data.hashtags.map((hashtag) => (
              <HashtagCard
                key={hashtag.name}
                name={hashtag.name}
                videoCount={hashtag.videoCount}
                viewCount={hashtag.viewCount}
                isSelected={hashtag.name === selectedHashtag}
                onClick={() => setSelectedHashtag(hashtag.name)}
              />
            ))}
          </div>
        </section>
      )}

      {selectedHashtagData && selectedHashtagData.topVideos.length > 0 && (
        <section>
          <VideoGrid
            title={`Top Videos for ${selectedHashtagData.name}`}
            videos={selectedHashtagData.topVideos}
          />
        </section>
      )}

      {hasKeywords &&
        data.keywords.map((keyword) => (
          <section key={keyword.term}>
            <VideoGrid
              title={`Results for "${keyword.term}"`}
              videos={keyword.videos}
            />
          </section>
        ))}

      {hasCompetitors && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Competitors
          </h2>
          <div className="space-y-3">
            {data.competitors.map((competitor) => (
              <CompetitorRow key={competitor.handle} competitor={competitor} />
            ))}
          </div>
        </section>
      )}

      {data.discovered && data.discovered.expandedTags.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Discovered Hashtags
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {data.discovered.expandedTags.map((tag) => (
              <HashtagCard
                key={tag.name}
                name={`#${tag.name}`}
                viewCount={tag.viewCount}
                subtitle={`found in ${tag.occurrences} niche video${tag.occurrences === 1 ? "" : "s"}`}
                isSelected={tag.name === selectedDiscovered}
                onClick={() => setSelectedDiscovered(tag.name)}
              />
            ))}
          </div>
        </section>
      )}

      {selectedDiscoveredData && selectedDiscoveredData.topVideos.length > 0 && (
        <section>
          <VideoGrid
            title={`Top Videos for #${selectedDiscoveredData.name}`}
            videos={selectedDiscoveredData.topVideos}
          />
        </section>
      )}

      {data.discovered && data.discovered.trendingVideos.length > 0 && (
        <section>
          <VideoGrid
            title="Trending in Your Niche"
            videos={data.discovered.trendingVideos}
          />
        </section>
      )}

      {data.discovered && data.discovered.candidateTags.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Next-Hop Candidates
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.discovered.candidateTags.map((tag) => (
              <span
                key={tag.name}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-sm text-foreground",
                  tag.zone && tag.zone !== "in" && "opacity-50"
                )}
              >
                #{tag.name}
                <span className="text-xs text-muted-foreground">
                  {tag.viewCount !== undefined
                    ? `${formatCount(tag.viewCount)} views${tag.zone === "too-big" ? " · too big" : tag.zone === "too-small" ? " · too small" : ""}`
                    : `×${tag.occurrences}`}
                </span>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
