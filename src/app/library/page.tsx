"use client";

import { useEffect, useRef, useState } from "react";
import type { LibraryClip, ClipLibrary } from "@/lib/library-schema";
import { useBrand } from "@/app/context/brand";

export default function LibraryPage() {
  const brand = useBrand();
  const [library, setLibrary] = useState<ClipLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingFilename, setEditingFilename] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<LibraryClip>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [selectedVideoIndex, setSelectedVideoIndex] = useState(0);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const carouselRef = useRef<HTMLDivElement>(null);

  const toggleDateGroup = (key: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  useEffect(() => {
    loadLibrary();
  }, []);

  const loadLibrary = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/library");
      if (!res.ok) throw new Error("Failed to load library");
      const data = await res.json();
      setLibrary(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectVideo = (index: number) => {
    setSelectedVideoIndex(index);
    setEditingFilename(null);
    setEditForm({});
  };

  const handleEdit = (video: LibraryClip) => {
    setEditingFilename(video.filename);
    setEditForm({
      date: video.date,
      tags: video.tags || [],
      description: video.description,
      source: video.source,
    });
  };

  const handleSave = async () => {
    if (!editingFilename) return;

    const payload = {
      filename: editingFilename,
      ...editForm,
    };

    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("Failed to save metadata");

      await loadLibrary();
      setEditingFilename(null);
      setEditForm({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleAnalyzeWithGemini = async (filename: string) => {
    try {
      setAnalyzing(true);
      setError(null);
      const res = await fetch("/api/library/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Analysis failed (HTTP ${res.status})`);
      }

      // Results auto-save server-side — refresh so date/tags/analysis appear
      await loadLibrary();
      setEditingFilename(null);
      setEditForm({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gemini analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading)
    return (
      <div className="downloads-layout flex items-center justify-center min-h-screen">
        <p className="text-foreground">Loading clip library...</p>
      </div>
    );

  const selectedVideo = library?.videos[selectedVideoIndex];
  const videoUrl = selectedVideo
    ? `/api/library/clips/${encodeURIComponent(selectedVideo.filename)}`
    : null;

  // Group carousel videos by (local) shoot date, chronological, undated last
  const dateGroups = (() => {
    const map = new Map<
      string,
      { key: string; sortTime: number; items: { video: LibraryClip; index: number }[] }
    >();
    library?.videos.forEach((video, index) => {
      const d = video.date ? new Date(video.date) : null;
      const key = d ? d.toLocaleDateString() : "No date";
      const sortTime = d ? new Date(d.toLocaleDateString()).getTime() : Infinity;
      if (!map.has(key)) map.set(key, { key, sortTime, items: [] });
      map.get(key)!.items.push({ video, index });
    });
    return [...map.values()].sort((a, b) => a.sortTime - b.sortTime);
  })();

  return (
    <div className="downloads-layout flex flex-col items-center min-h-screen p-4 bg-background text-foreground">
      <div className="flex flex-col gap-6 w-full max-w-6xl">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            {brand.name} clip library
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            {library?.videos.length || 0} videos in library
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <p className="text-sm text-red-500">{error}</p>
          </div>
        )}

        {library && library.videos.length === 0 ? (
          <div className="rounded-lg border border-border p-8 text-center">
            <p className="text-muted-foreground">
              No videos found in the {brand.libraryDir}/ folder
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Add .mp4, .mov, .avi, or .mkv files to the {brand.libraryDir}/ folder
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Carousel */}
            <div className="flex rounded-lg border border-border overflow-hidden">
              {/* Left: Video Preview */}
              <div className="flex flex-col gap-2 bg-black p-4 max-w-sm">
                {selectedVideo && videoUrl ? (
                  <>
                    <div className="rounded-lg overflow-hidden border border-border bg-black aspect-[9/16] flex items-center justify-center">
                      <video
                        src={videoUrl}
                        controls
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground text-center">
                      {selectedVideo.filename}
                    </p>
                  </>
                ) : (
                  <div className="rounded-lg border border-border bg-muted aspect-[9/16] flex items-center justify-center">
                    <p className="text-muted-foreground">No video selected</p>
                  </div>
                )}
              </div>

              {/* Right: Metadata */}
              <div className="flex-1 flex flex-col bg-muted/40 border-l border-border overflow-y-auto">
                {!editingFilename ? (
                  selectedVideo && (
                    <div className="flex flex-col gap-4 p-4">
                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Filename
                        </p>
                        <p className="text-sm text-foreground mt-1">
                          {selectedVideo.filename}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Date
                        </p>
                        <p className="text-sm text-foreground mt-1">
                          {selectedVideo.date
                            ? new Date(selectedVideo.date).toLocaleDateString()
                            : "No date set"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Description
                        </p>
                        <p className="text-sm text-foreground mt-1">
                          {selectedVideo.description || "No description"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Tags
                        </p>
                        {selectedVideo.tags && selectedVideo.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {selectedVideo.tags.map((tag) => (
                              <span
                                key={tag}
                                className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground mt-1">No tags</p>
                        )}
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Source
                        </p>
                        <p className="text-sm text-foreground mt-1">
                          {selectedVideo.source || "Not specified"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Duration
                        </p>
                        <p className="text-sm text-foreground mt-1">
                          {selectedVideo.duration
                            ? `${selectedVideo.duration}s`
                            : "Not available"}
                        </p>
                      </div>

                      <div className="border-t border-border pt-3">
                        <p className="text-xs font-semibold uppercase text-muted-foreground">
                          Gemini Analysis
                        </p>
                        {selectedVideo.analysis ? (
                          <div className="flex flex-col gap-2 mt-2">
                            <div className="flex flex-wrap gap-1.5">
                              <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-semibold">
                                {selectedVideo.analysis.location}
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">
                                {selectedVideo.analysis.time_of_day.replaceAll("_", " ")}
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">
                                {selectedVideo.analysis.camera_action}
                              </span>
                              <span className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs">
                                {selectedVideo.analysis.category.replaceAll("_", " ")}
                              </span>
                            </div>
                            <p className="text-sm text-foreground">
                              {selectedVideo.analysis.product_present ? ` in frame` : `No  in frame`}
                              {selectedVideo.analysis.product_note && (
                                <span className="text-muted-foreground">
                                  {" "}— {selectedVideo.analysis.product_note}
                                </span>
                              )}
                            </p>
                            <div>
                              <p className="text-xs font-semibold uppercase text-muted-foreground">
                                Spoken
                              </p>
                              <p className="text-sm text-foreground mt-0.5 max-h-24 overflow-y-auto">
                                {selectedVideo.analysis.spoken_text || (
                                  <span className="text-muted-foreground">
                                    Nothing spoken
                                  </span>
                                )}
                              </p>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {selectedVideo.analysis.model} ·{" "}
                              {new Date(selectedVideo.analysis.analyzedAt).toLocaleString()}
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground mt-1">
                            Not analyzed yet
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col gap-2 mt-auto">
                        <button
                          onClick={() => handleEdit(selectedVideo)}
                          className="w-full px-3 py-2 bg-secondary text-secondary-foreground rounded text-sm hover:bg-secondary/80"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleAnalyzeWithGemini(selectedVideo.filename)}
                          disabled={analyzing}
                          className="w-full px-3 py-2 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-60"
                        >
                          {analyzing
                            ? "Analyzing… (can take a minute)"
                            : selectedVideo.analysis
                              ? "Re-analyze with Gemini"
                              : "Analyze with Gemini"}
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-3 p-4">
                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        Filename
                      </label>
                      <p className="text-sm text-foreground mt-1">
                        {editingFilename}
                      </p>
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        Date
                      </label>
                      <input
                        type="date"
                        value={
                          editForm.date
                            ? new Date(editForm.date)
                                .toISOString()
                                .split("T")[0]
                            : ""
                        }
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            date: e.target.value
                              ? new Date(e.target.value).toISOString()
                              : undefined,
                          })
                        }
                        className="w-full px-2 py-1 rounded border border-border bg-muted text-foreground text-sm"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        Description
                      </label>
                      <textarea
                        value={editForm.description || ""}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            description: e.target.value,
                          })
                        }
                        className="w-full px-2 py-1 rounded border border-border bg-muted text-foreground text-sm"
                        rows={3}
                        placeholder="Video description..."
                      />
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        Tags
                      </label>
                      <input
                        type="text"
                        placeholder="Type tag and press comma (or space)..."
                        onKeyDown={(e) => {
                          if ((e.key === "," || e.key === " " || e.key === "Enter") && e.currentTarget.value.trim()) {
                            e.preventDefault();
                            const newTag = e.currentTarget.value.trim();
                            if (!editForm.tags?.includes(newTag)) {
                              setEditForm({
                                ...editForm,
                                tags: [...(editForm.tags || []), newTag],
                              });
                            }
                            e.currentTarget.value = "";
                          }
                        }}
                        className="w-full px-2 py-1 rounded border border-border bg-muted text-foreground text-sm"
                      />
                      {editForm.tags && editForm.tags.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {editForm.tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/20 text-primary text-xs font-medium"
                            >
                              {tag}
                              <button
                                type="button"
                                onClick={() =>
                                  setEditForm({
                                    ...editForm,
                                    tags: editForm.tags?.filter((t) => t !== tag) || [],
                                  })
                                }
                                className="ml-1 hover:opacity-70 font-bold"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        Source
                      </label>
                      <input
                        type="text"
                        value={editForm.source || ""}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            source: e.target.value,
                          })
                        }
                        className="w-full px-2 py-1 rounded border border-border bg-muted text-foreground text-sm"
                        placeholder="e.g., iPhone Camera, GoPro..."
                      />
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        Duration (seconds)
                      </label>
                      <input
                        type="number"
                        value={editForm.duration || ""}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            duration: e.target.value
                              ? parseInt(e.target.value)
                              : undefined,
                          })
                        }
                        className="w-full px-2 py-1 rounded border border-border bg-muted text-foreground text-sm"
                        placeholder="45"
                      />
                    </div>

                    <div className="flex flex-col gap-2 mt-2">
                      <button
                        onClick={handleSave}
                        className="w-full px-3 py-1 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingFilename(null)}
                        className="w-full px-3 py-1 bg-muted text-muted-foreground rounded text-sm hover:bg-muted/80"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Carousel Strip — grouped by shoot date, collapsible per group */}
            <div
              ref={carouselRef}
              className="flex gap-2 overflow-x-auto pb-2 rounded-lg border border-border p-2 bg-muted/20 items-stretch"
            >
              {dateGroups.map((group) => {
                const expanded = expandedDates.has(group.key);
                const [month, day, year] =
                  group.key === "No date"
                    ? ["—", "?", ""]
                    : [
                        new Date(group.sortTime).toLocaleDateString(undefined, {
                          month: "short",
                        }),
                        new Date(group.sortTime).getDate().toString(),
                        new Date(group.sortTime).getFullYear().toString(),
                      ];
                return (
                  <div key={group.key} className="flex gap-2 shrink-0 items-stretch">
                    <button
                      onClick={() => toggleDateGroup(group.key)}
                      className={`flex flex-col items-center justify-center w-20 shrink-0 rounded-lg border p-2 gap-0.5 transition-colors ${
                        expanded
                          ? "border-primary/60 bg-primary/10"
                          : "border-border bg-muted/40 hover:border-primary/60"
                      }`}
                    >
                      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                        {month}
                      </span>
                      <span className="text-2xl font-bold text-foreground leading-none">
                        {day}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {year}
                      </span>
                      <span className="mt-1 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]">
                        {group.items.length} clips
                      </span>
                      <span className="text-[10px] text-muted-foreground mt-0.5">
                        {expanded ? "◀ collapse" : "expand ▶"}
                      </span>
                    </button>

                    {expanded &&
                      group.items.map(({ video, index }) => (
                        <button
                          key={video.filename}
                          onClick={() => handleSelectVideo(index)}
                          className={`flex flex-col gap-1 w-28 shrink-0 rounded-lg border p-1.5 text-left transition-colors ${
                            index === selectedVideoIndex
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/60 hover:bg-muted/40"
                          }`}
                        >
                          <video
                            src={`/api/library/clips/${encodeURIComponent(video.filename)}`}
                            className="w-full h-40 object-cover rounded-md bg-muted"
                          />
                          <p className="text-[10px] font-mono text-muted-foreground truncate">
                            {video.filename}
                          </p>
                          {video.tags && video.tags.length > 0 && (
                            <div className="flex flex-wrap gap-0.5">
                              {video.tags.slice(0, 2).map((tag) => (
                                <span
                                  key={tag}
                                  className="px-1 py-0 rounded text-[8px] bg-muted text-muted-foreground"
                                >
                                  {tag}
                                </span>
                              ))}
                              {video.tags.length > 2 && (
                                <span className="text-[8px] text-muted-foreground">
                                  +{video.tags.length - 2}
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
