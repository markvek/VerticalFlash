"use client";

import { NativeModelSelector } from "@/components/form/NativeModelSelector";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LibraryUpload } from "@/components/form/LibraryUpload";
import { useRouter } from "next/navigation";
import type { ClipLibrary, LibraryClip } from "@/lib/library-schema";
import { useBrand } from "@/app/context/brand";

// Start page for the storyboard flow: upload or pick library clips, order
// them, name the master, and open its workspace while footage is processed.

type TimingEngine = "whisperx" | "gemini";

interface WhisperXStatus {
  available: boolean;
  binary: string | null;
  version: string | null;
  reason: string | null;
  default: TimingEngine;
  model: string;
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

export default function StoryboardPage() {
  const router = useRouter();
  const brand = useBrand();

  const [model, setModel] = useState("");
  const [library, setLibrary] = useState<ClipLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);

  const [uploadsBusy, setUploadsBusy] = useState(false);

  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);

  const [whisperx, setWhisperx] = useState<WhisperXStatus | null>(null);
  const [timingEngine, setTimingEngine] = useState<TimingEngine | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    try {
      setLibraryLoading(true);
      const res = await fetch("/api/library");
      if (!res.ok) throw new Error("Failed to load the clip library");
      const data: ClipLibrary = await res.json();
      setLibrary(data);
      setLibraryError(null);
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : "Failed to load the clip library");
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

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

  // Title follows the first selected clip until the user edits it
  useEffect(() => {
    if (titleTouched) return;
    setTitle(selected.length > 0 ? stripExtension(selected[0]) : "");
  }, [selected, titleTouched]);

  const totalDuration = selected.reduce(
    (sum, name) => sum + (clipsByName.get(name)?.duration ?? 0),
    0
  );
  const hasUnknownDuration = selected.some(
    (name) => clipsByName.get(name)?.duration == null
  );

  const addClip = (filename: string) => {
    setSelected((current) =>
      current.includes(filename) ? current : [...current, filename]
    );
  };

  const removeClip = (index: number) => {
    setSelected((current) => current.filter((_, i) => i !== index));
  };

  const moveClip = (index: number, delta: -1 | 1) => {
    setSelected((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const canSubmit =
    selected.length > 0 && title.trim().length > 0 && !submitting && !uploadsBusy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      setStatus("Opening storyboard...");
      const res = await fetch("/api/master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          clips: selected,
          title: title.trim(),
          timing_engine: timingEngine,
          background: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not build the master");
      const { filename } = data as {
        filename: string;
        videoId: string;
        displayName: string;
      };
      window.dispatchEvent(new Event("downloads-changed"));

      router.push(`/storyboards/${encodeURIComponent(filename)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the master");
      setStatus(null);
      setSubmitting(false);
    }
  };

  const whisperxDisabled = whisperx !== null && !whisperx.available;

  return (
    <div className="flex flex-col items-center min-h-screen p-8">
      <div className="w-full max-w-3xl space-y-8 py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold">
            Storyboard shorts from your own footage
          </h1>
          <p className="mt-2 text-muted-foreground">
            Upload a recording, {brand.name} transcribes it and proposes
            hook → main → end storyboards you can cut into shorts
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-8">
          <LibraryUpload onBusy={setUploadsBusy} onAdded={async clips => { clips.forEach(c => addClip(c.filename)); await loadLibrary(); }} />

          <NativeModelSelector value={model} onChange={setModel} disabled={submitting} />

          {/* Library picker */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">2. Pick clips from the library</h2>
              <button
                type="button"
                onClick={loadLibrary}
                disabled={libraryLoading}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                {libraryLoading ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {libraryError && (
              <p className="text-xs text-red-500">{libraryError}</p>
            )}

            {library && library.videos.length === 0 && !libraryLoading && (
              <p className="text-xs text-muted-foreground rounded-lg border border-border p-4 text-center">
                No clips yet — upload above or drop files into{" "}
                <span className="font-mono">{brand.libraryDir}/</span>.
              </p>
            )}

            {library && library.videos.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2 max-h-80 overflow-y-auto pr-0.5">
                {library.videos.map((clip) => {
                  const isSelected = selected.includes(clip.filename);
                  return (
                    <button
                      key={clip.filename}
                      type="button"
                      onClick={() => addClip(clip.filename)}
                      disabled={isSelected}
                      title={isSelected ? "Already selected" : "Add to the master"}
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
                        <span className="block truncate text-sm text-foreground">
                          {clip.filename}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {formatSeconds(clip.duration)}
                          {clip.source ? ` · ${clip.source}` : ""}
                          {isSelected ? " · selected" : ""}
                        </span>
                        {clip.description && (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {clip.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Selected clips */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Selected clips (in order)</h2>
              <span className="text-xs text-muted-foreground">
                {selected.length === 0
                  ? "Nothing selected"
                  : `${selected.length} clip${selected.length === 1 ? "" : "s"} · ${formatSeconds(
                      totalDuration
                    )}${hasUnknownDuration ? "+" : ""} total`}
              </span>
            </div>
            {selected.length === 0 ? (
              <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border p-4 text-center">
                Click clips above to add them. One clip becomes the master;
                several are joined in this order.
              </p>
            ) : (
              <ol className="space-y-1.5">
                {selected.map((name, index) => {
                  const clip = clipsByName.get(name);
                  return (
                    <li
                      key={name}
                      className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
                    >
                      <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/library/thumbs/${encodeURIComponent(name)}`}
                        alt=""
                        className="size-9 shrink-0 rounded object-cover bg-muted"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">
                          {name}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {formatSeconds(clip?.duration)}
                        </span>
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveClip(index, -1)}
                          disabled={index === 0}
                          title="Move up"
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveClip(index, 1)}
                          disabled={index === selected.length - 1}
                          title="Move down"
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => removeClip(index)}
                          title="Remove"
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* Title */}
          <section className="space-y-2">
            <label htmlFor="master-title" className="text-sm font-semibold">
              3. Source project name
            </label>
            <input
              id="master-title"
              type="text"
              value={title}
              maxLength={120}
              onChange={(e) => {
                setTitleTouched(true);
                setTitle(e.target.value);
              }}
              placeholder="e.g. Founder story take 2"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Defaults to the first clip&apos;s name. Shorts cut from this
              master are named after their hook line.
            </p>
          </section>

          {/* Timing engine */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">4. Timing engine</h2>
            <div className="space-y-1.5">
              <label
                className={`flex items-start gap-2 text-sm ${
                  whisperxDisabled ? "opacity-60 cursor-not-allowed" : ""
                }`}
              >
                <input
                  type="radio"
                  name="timing"
                  value="whisperx"
                  checked={timingEngine === "whisperx"}
                  disabled={whisperxDisabled}
                  onChange={() => setTimingEngine("whisperx")}
                  className="mt-1"
                />
                <span>
                  WhisperX (word-accurate)
                  {whisperx?.available && whisperx.version && (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · v{whisperx.version} · {whisperx.model}
                    </span>
                  )}
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="timing"
                  value="gemini"
                  checked={timingEngine === "gemini"}
                  onChange={() => setTimingEngine("gemini")}
                  className="mt-1"
                />
                <span>Gemini (approximate, no install)</span>
              </label>
            </div>
            {whisperxDisabled && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <p className="text-amber-700 dark:text-amber-400 break-words">
                  WhisperX not detected{whisperx?.reason ? `: ${whisperx.reason}` : "."}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Install: <span className="font-mono">uv tool install whisperx</span>
                </p>
              </div>
            )}
            {!whisperx && (
              <p className="text-xs text-muted-foreground">Checking for WhisperX…</p>
            )}
          </section>

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
              <p className="text-xs text-red-500 break-words">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Opening..." : "Prepare footage and transcript"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back
            </button>
            {status && (
              <p className="text-xs text-muted-foreground animate-pulse">
                {status}
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
