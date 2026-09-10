"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, ClipboardCheck, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StoryboardBenchmarkSetup } from "@/components/benchmarks/StoryboardBenchmarkSetup";
import { LibraryUpload } from "@/components/form/LibraryUpload";
import type { BenchmarkRun } from "@/lib/benchmark-schema";
import type { ClipLibrary, LibraryClip } from "@/lib/library-schema";

type TimingEngine = "whisperx" | "gemini";

interface WhisperXStatus {
  available: boolean;
  reason: string | null;
  default: TimingEngine;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "?:??";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function BenchmarkDashboard() {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [library, setLibrary] = useState<ClipLibrary | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [timingEngine, setTimingEngine] = useState<TimingEngine | null>(null);
  const [whisperx, setWhisperx] = useState<WhisperXStatus | null>(null);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/benchmarks", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load benchmarks");
      setRuns(data.runs ?? []);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load benchmarks");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load the clip library");
      setLibrary(await response.json());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load the clip library");
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRuns();
    loadLibrary();
  }, [loadRuns, loadLibrary]);

  useEffect(() => {
    fetch("/api/whisperx")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: WhisperXStatus | null) => {
        if (!data) return;
        setWhisperx(data);
        setTimingEngine((current) => current ?? data.default);
      })
      .catch(() => {});
  }, []);

  const clipsByName = useMemo(() => {
    const map = new Map<string, LibraryClip>();
    library?.videos.forEach((v) => map.set(v.filename, v));
    return map;
  }, [library]);

  // Title follows the first selected clip until the user edits it.
  useEffect(() => {
    if (titleTouched) return;
    setTitle(selected.length > 0 ? stripExtension(selected[0]) : "");
  }, [selected, titleTouched]);

  const totalDuration = selected.reduce(
    (sum, name) => sum + (clipsByName.get(name)?.duration ?? 0),
    0
  );
  const hasUnknownDuration = selected.some((name) => clipsByName.get(name)?.duration == null);

  const addClip = (filename: string) =>
    setSelected((current) => (current.includes(filename) ? current : [...current, filename]));
  const removeClip = (index: number) =>
    setSelected((current) => current.filter((_, i) => i !== index));
  const moveClip = (index: number, delta: -1 | 1) =>
    setSelected((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const whisperxDisabled = whisperx !== null && !whisperx.available;

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl space-y-8 px-5 py-8 text-foreground sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BarChart3 className="size-4" aria-hidden="true" />
            Benchmark Lab
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">AI editing benchmarks</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Pick footage, run four models on the same brief, and compare their storyboards with
            an AI virality judge and blind human ratings.
          </p>
        </div>
        <Button onClick={loadRuns} variant="outline" size="sm">Refresh</Button>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section aria-labelledby="new-benchmark" className="space-y-6 rounded-lg border border-border bg-card p-5">
        <h2 id="new-benchmark" className="text-lg font-semibold">New benchmark run</h2>

        <LibraryUpload
          onBusy={setUploadsBusy}
          onAdded={async (clips) => {
            clips.forEach((c) => addClip(c.filename));
            await loadLibrary();
          }}
        />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Pick clips from the library</h3>
            <button
              type="button"
              onClick={loadLibrary}
              disabled={libraryLoading}
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              {libraryLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {library && library.videos.length === 0 && !libraryLoading && (
            <p className="rounded-lg border border-border p-4 text-center text-xs text-muted-foreground">
              No clips yet — upload above to get started.
            </p>
          )}
          {library && library.videos.length > 0 && (
            <div className="grid max-h-80 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-2">
              {library.videos.map((clip) => {
                const isSelected = selected.includes(clip.filename);
                return (
                  <button
                    key={clip.filename}
                    type="button"
                    onClick={() => addClip(clip.filename)}
                    disabled={isSelected}
                    title={isSelected ? "Already selected" : "Add to the benchmark"}
                    className={`flex items-center gap-3 rounded-lg border px-2 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10 cursor-default"
                        : "border-border hover:border-primary/60 hover:bg-muted/40"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/library/thumbs/${encodeURIComponent(clip.filename)}`}
                      alt=""
                      loading="lazy"
                      className="size-14 shrink-0 rounded object-cover bg-muted"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{clip.filename}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {formatSeconds(clip.duration)}
                        {clip.source ? ` · ${clip.source}` : ""}
                        {isSelected ? " · selected" : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Selected core clips (in order)</h3>
            <span className="text-xs text-muted-foreground">
              {selected.length === 0
                ? "Nothing selected"
                : `${selected.length} clip${selected.length === 1 ? "" : "s"} · ${formatSeconds(totalDuration)}${hasUnknownDuration ? "+" : ""} total`}
            </span>
          </div>
          {selected.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              Click clips above to add them. Every model gets the same core footage.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {selected.map((name, index) => {
                const clip = clipsByName.get(name);
                return (
                  <li key={name} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
                    <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{index + 1}</span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/library/thumbs/${encodeURIComponent(name)}`}
                      alt=""
                      className="size-9 shrink-0 rounded object-cover bg-muted"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{name}</span>
                      <span className="block text-[11px] text-muted-foreground">{formatSeconds(clip?.duration)}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" onClick={() => moveClip(index, -1)} disabled={index === 0} title="Move up" className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40">↑</button>
                      <button type="button" onClick={() => moveClip(index, 1)} disabled={index === selected.length - 1} title="Move down" className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40">↓</button>
                      <button type="button" onClick={() => removeClip(index)} title="Remove" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive">✕</button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <label className="block space-y-2 text-sm">
          <span className="font-medium">Run title</span>
          <input
            value={title}
            maxLength={100}
            onChange={(event) => {
              setTitleTouched(true);
              setTitle(event.target.value);
            }}
            placeholder="e.g. Founder story benchmark"
            className="h-10 w-full rounded-md border border-border bg-background px-3 outline-none focus:border-primary"
          />
        </label>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Timing engine</legend>
          <label className={`flex items-center gap-2 text-sm ${whisperxDisabled ? "opacity-60" : ""}`}>
            <input
              type="radio"
              name="timing"
              checked={timingEngine === "whisperx"}
              disabled={whisperxDisabled}
              onChange={() => setTimingEngine("whisperx")}
            />
            WhisperX (word-accurate)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="timing"
              checked={timingEngine === "gemini"}
              onChange={() => setTimingEngine("gemini")}
            />
            Gemini (approximate, no install)
          </label>
          {whisperxDisabled && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              WhisperX not detected{whisperx?.reason ? `: ${whisperx.reason}` : "."}
            </p>
          )}
        </fieldset>

        <StoryboardBenchmarkSetup
          clips={selected}
          library={library?.videos ?? []}
          title={title}
          timingEngine={timingEngine}
          busy={uploadsBusy}
          defaultExpanded
        />
      </section>

      <section aria-labelledby="benchmark-runs" className="rounded-lg border border-border bg-card">
        <div className="border-b border-border p-5">
          <h2 id="benchmark-runs" className="text-lg font-semibold">Runs</h2>
        </div>
        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading benchmarks...</p>
        ) : runs.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No benchmark runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-semibold">Run</th>
                  <th className="px-5 py-3 font-semibold">Source</th>
                  <th className="px-5 py-3 font-semibold">Providers</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Updated</th>
                  <th className="px-5 py-3 font-semibold">Open</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-4 font-medium">{run.title}</td>
                    <td className="px-5 py-4 text-muted-foreground">{run.source.displayName}</td>
                    <td className="px-5 py-4 text-muted-foreground">{run.providers.length}</td>
                    <td className="px-5 py-4">
                      <span className="rounded-full border border-border px-2 py-1 text-xs capitalize text-muted-foreground">{run.status}</span>
                    </td>
                    <td className="px-5 py-4 text-muted-foreground">{formatDate(run.updatedAt)}</td>
                    <td className="px-5 py-4">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/benchmarks/${encodeURIComponent(run.id)}`}>
                          <ClipboardCheck className="size-4" aria-hidden="true" />
                          Manage
                        </Link>
                      </Button>
                      {run.variants.some((variant) => variant.status === "ready") && (
                        <Button asChild variant="ghost" size="sm" className="ml-2">
                          <Link href={`/benchmarks/${encodeURIComponent(run.id)}/judge`}>
                            <Play className="size-4" aria-hidden="true" />
                            Judge
                          </Link>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
