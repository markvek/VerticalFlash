"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface UploadItem {
  id: string;
  file: File;
  progress: number; // 0-100 (bytes sent)
  status: "queued" | "uploading" | "processing" | "done" | "error";
  message?: string;
  savedAs?: string;
}

interface UploadResponse {
  clips: LibraryClip[];
  errors: Array<{ name: string; error: string }>;
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

// One file per request so the progress bar is per file (XHR is the only
// way to observe upload progress from the browser)
function uploadFile(
  file: File,
  analyze: boolean,
  onProgress: (fraction: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = analyze ? "/api/library/upload?analyze=1" : "/api/library/upload";
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON body (proxy error page etc.)
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data as UploadResponse);
      } else {
        const message =
          (data as { error?: string } | null)?.error ||
          `Upload failed (HTTP ${xhr.status})`;
        reject(new Error(message));
      }
    };
    const form = new FormData();
    form.append("files", file, file.name);
    xhr.send(form);
  });
}

export default function StoryboardPage() {
  const router = useRouter();
  const brand = useBrand();

  const [library, setLibrary] = useState<ClipLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [analyzeUploads, setAnalyzeUploads] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);

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

  const updateUpload = (id: string, patch: Partial<UploadItem>) => {
    setUploads((current) =>
      current.map((u) => (u.id === id ? { ...u, ...patch } : u))
    );
  };

  const startUploads = async (files: File[]) => {
    if (files.length === 0) return;
    const items: UploadItem[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      progress: 0,
      status: "queued",
    }));
    setUploads((current) => [...current, ...items]);

    if (uploadingRef.current) return; // the running loop picks new items up
    uploadingRef.current = true;
    try {
      // Drain the queue sequentially (items added mid-run are included)
      let pending = items;
      while (pending.length > 0) {
        for (const item of pending) {
          updateUpload(item.id, { status: "uploading", progress: 0 });
          try {
            const result = await uploadFile(item.file, analyzeUploads, (fraction) => {
              updateUpload(item.id, {
                progress: Math.round(fraction * 100),
                status: fraction >= 1 ? "processing" : "uploading",
              });
            });
            const clip = result.clips[0];
            const failure = result.errors.find(
              (e) => e.name === item.file.name || e.name === clip?.filename
            );
            if (clip) {
              updateUpload(item.id, {
                status: "done",
                progress: 100,
                savedAs: clip.filename,
                message: failure?.error,
              });
              addClip(clip.filename);
            } else {
              updateUpload(item.id, {
                status: "error",
                message: failure?.error ?? "Upload failed",
              });
            }
          } catch (e) {
            updateUpload(item.id, {
              status: "error",
              message: e instanceof Error ? e.message : "Upload failed",
            });
          }
        }
        await loadLibrary();
        pending = [];
        setUploads((current) => {
          pending = current.filter((u) => u.status === "queued");
          return current;
        });
        // Let the state read above settle before looping
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      uploadingRef.current = false;
    }
  };

  const onFilesChosen = (list: FileList | null) => {
    if (!list) return;
    startUploads(Array.from(list));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      /\.(mp4|mov|avi|mkv)$/i.test(f.name)
    );
    if (files.length === 0) {
      setError("Drop video files (.mp4, .mov, .avi, .mkv)");
      return;
    }
    setError(null);
    startUploads(files);
  };

  const uploadsBusy = uploads.some(
    (u) => u.status === "queued" || u.status === "uploading" || u.status === "processing"
  );
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
          {/* Upload */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">1. Upload footage</h2>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
                dragging
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/60 hover:bg-muted/40"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="video/*"
                onChange={(e) => onFilesChosen(e.target.files)}
                className="hidden"
              />
              <p className="text-sm text-foreground">
                Drop video files here, or click to choose
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                .mp4, .mov, .avi, .mkv · up to 500 MB each · saved into your{" "}
                <span className="font-mono">{brand.libraryDir}/</span> folder
              </p>
            </div>

            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={analyzeUploads}
                onChange={(e) => setAnalyzeUploads(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Also analyze uploads with Gemini for B-roll reuse (costs tokens)
              </span>
            </label>

            {uploads.length > 0 && (
              <ul className="space-y-1.5">
                {uploads.map((u) => (
                  <li
                    key={u.id}
                    className="rounded-lg border border-border px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-foreground">
                        {u.file.name}
                        {u.savedAs && u.savedAs !== u.file.name
                          ? ` → ${u.savedAs}`
                          : ""}
                      </span>
                      <span
                        className={`shrink-0 ${
                          u.status === "error"
                            ? "text-red-500"
                            : u.status === "done"
                              ? "text-green-600"
                              : "text-muted-foreground"
                        }`}
                      >
                        {u.status === "queued" && "Queued"}
                        {u.status === "uploading" && `Uploading ${u.progress}%`}
                        {u.status === "processing" &&
                          (analyzeUploads ? "Probing + analyzing…" : "Probing…")}
                        {u.status === "done" && "Added"}
                        {u.status === "error" && "Failed"}
                      </span>
                    </div>
                    {(u.status === "uploading" || u.status === "processing") && (
                      <div className="mt-1.5 h-1 rounded bg-muted overflow-hidden">
                        <div
                          className={`h-full bg-primary ${
                            u.status === "processing" ? "animate-pulse" : ""
                          }`}
                          style={{ width: `${u.progress}%` }}
                        />
                      </div>
                    )}
                    {u.message && (
                      <p
                        className={`mt-1 break-words ${
                          u.status === "error" ? "text-red-500" : "text-amber-600"
                        }`}
                      >
                        {u.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-muted-foreground">
              Large files: drop them into the{" "}
              <span className="font-mono">{brand.libraryDir}/</span> folder
              instead, then click Refresh.
            </p>
          </section>

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
              3. Master title
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
              {submitting ? "Opening..." : "Build master and analyze"}
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
