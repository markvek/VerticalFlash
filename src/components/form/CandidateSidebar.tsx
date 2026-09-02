"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScanHistory } from "@/app/context/scan-history";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/utils";
import type { ScanSeeds } from "@/lib/scan-storage";

export function CandidateSidebar() {
  const { currentScan, createScan, updateSelectedCandidates } =
    useScanHistory();
  const router = useRouter();
  const [isSearching, setIsSearching] = useState(false);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(
    new Set(currentScan?.selectedCandidates || [])
  );

  if (!currentScan || !currentScan.results.discovered) {
    return (
      <div className="w-56 border-l border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          Next Search
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          No candidates available. Run a scan first.
        </p>
      </div>
    );
  }

  const { candidateTags } = currentScan.results.discovered;
  const seedsPreview = [
    currentScan.seeds.hashtags.slice(0, 2).join(", "),
    currentScan.seeds.keywords.slice(0, 1).join(", "),
  ]
    .filter(Boolean)
    .join(" + ");

  const handleToggleCandidate = (name: string) => {
    const newSet = new Set(selectedSet);
    if (newSet.has(name)) {
      newSet.delete(name);
    } else {
      newSet.add(name);
    }
    setSelectedSet(newSet);
    updateSelectedCandidates(currentScan.id, Array.from(newSet));
  };

  const handleSearch = async () => {
    if (selectedSet.size === 0) {
      alert("Please select at least one candidate");
      return;
    }

    setIsSearching(true);
    try {
      const selectedTags = Array.from(selectedSet);
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hashtags: selectedTags.join(", "),
          keywords: "",
          competitors: "",
          tiktokUrl: currentScan.seeds.tiktokUrl,
          minViews: currentScan.seeds.minViews,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to run scan");
      }

      const results = await response.json();

      // Create new scan with current scan as parent
      const newSeeds: ScanSeeds = {
        hashtags: selectedTags,
        keywords: [],
        competitors: [],
        tiktokUrl: currentScan.seeds.tiktokUrl,
        minViews: currentScan.seeds.minViews,
      };

      const newScan = createScan(newSeeds, results, currentScan.id);
      router.push(`/results?scan=${newScan.id}`);
    } catch (error) {
      alert(
        `Scan failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="w-56 border-l border-border bg-card">
      <div className="space-y-4 p-4 max-h-screen overflow-y-auto">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Next Search
          </h2>
          {seedsPreview && (
            <p className="mt-2 text-xs text-muted-foreground">
              <span className="font-medium">Building on:</span>
              <br />
              {seedsPreview}
            </p>
          )}
        </div>

        {candidateTags.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No candidates available to explore further.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Candidates ({selectedSet.size} selected)
            </p>

            <div className="space-y-2">
              {candidateTags.map((tag) => {
                const isSelected = selectedSet.has(tag.name);
                const isAiRecommended = !tag.zone; // AI-recommended tags have no zone
                const zoneLabel = tag.zone
                  ? tag.zone === "too-big"
                    ? "too big"
                    : "too small"
                  : null;

                return (
                  <label
                    key={tag.name}
                    className={`flex items-start gap-2 cursor-pointer p-2 rounded-lg transition-colors ${
                      isSelected
                        ? "bg-orange-500/10 border border-orange-500/20"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleToggleCandidate(tag.name)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate text-foreground">
                          #{tag.name}
                        </span>
                        {isAiRecommended && (
                          <span className="inline-flex px-1.5 py-0.5 text-xs rounded bg-blue-500/20 text-blue-600 dark:text-blue-400 flex-shrink-0">
                            AI
                          </span>
                        )}
                        {isSelected && (
                          <span className="inline-flex px-1.5 py-0.5 text-xs rounded bg-orange-500/20 text-orange-600 dark:text-orange-400 flex-shrink-0">
                            Selected
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {tag.viewCount !== undefined
                          ? `${formatCount(tag.viewCount)} views`
                          : `×${tag.occurrences}`}{" "}
                        {zoneLabel && `· ${zoneLabel}`}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <Button
          onClick={handleSearch}
          disabled={
            selectedSet.size === 0 || isSearching || candidateTags.length === 0
          }
          className="w-full mt-4"
        >
          {isSearching ? "Searching..." : "Search These"}
        </Button>
      </div>
    </div>
  );
}
