"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicLibrary, MusicTrack } from "@/lib/music-schema";
import { beginMediaPlayback, playMedia } from "@/lib/media-playback";

interface MusicPickerProps {
  // Selected track filename (null = none)
  value: string | null;
  onChange: (track: MusicTrack | null) => void;
  // Show a "No song" row that selects null
  allowNone?: boolean;
  // Tighter layout for the render controls
  compact?: boolean;
  // Called after the library loads or changes, so a parent can look up the
  // selected track's details (duration for the default video length)
  onLibrary?: (library: MusicLibrary) => void;
}

function formatSeconds(s: number | null): string {
  if (s == null) return "?";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// The music library picker: every track in music/, with a preview player,
// an "add from TikTok link" box, and per-track delete. Shared by the
// /create form and the render tab's audio picker.
export function MusicPicker({
  value,
  onChange,
  allowNone = false,
  compact = false,
  onLibrary,
}: MusicPickerProps) {
  const [library, setLibrary] = useState<MusicLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackRequest = useRef<number | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || playbackRequest.current == null) return;
    playMedia(audio, playbackRequest.current).catch(() => {});
    return () => audio.pause();
  }, [previewing]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/music");
      if (!res.ok) throw new Error();
      const data: MusicLibrary = await res.json();
      setLibrary(data);
      onLibrary?.(data);
    } catch {
      setError("Failed to load the music library");
    }
  }, [onLibrary]);

  useEffect(() => {
    load();
  }, [load]);

  const addFromUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add that track");
      setUrl("");
      await load();
      onChange(data.track as MusicTrack);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Could not add that track");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (track: MusicTrack) => {
    if (!confirm(`Remove "${track.title}" from the music library?`)) return;
    const res = await fetch("/api/music", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: track.filename }),
    });
    if (!res.ok) {
      alert("Failed to remove the track");
      return;
    }
    if (value === track.filename) onChange(null);
    if (previewing === track.filename) setPreviewing(null);
    await load();
  };

  const togglePreview = (track: MusicTrack) => {
    if (previewing === track.filename && audioRef.current?.paused) {
      playMedia(audioRef.current).catch(() => {});
      return;
    }
    playbackRequest.current = beginMediaPlayback();
    setPreviewing((current) => (current === track.filename ? null : track.filename));
  };

  const rowClass = (selected: boolean) =>
    `flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
      selected
        ? "border-primary bg-primary/10"
        : "border-border hover:border-primary/60 hover:bg-muted/40"
    }`;

  return (
    <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-2"}`}>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {!library && !error && (
        <p className="text-xs text-muted-foreground">Loading music library…</p>
      )}

      {library && (
        <div
          className={`flex flex-col gap-1 ${
            compact ? "max-h-48" : "max-h-72"
          } overflow-y-auto pr-0.5`}
        >
          {allowNone && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className={rowClass(value === null)}
            >
              <span className="size-9 shrink-0 rounded bg-muted flex items-center justify-center text-muted-foreground text-xs">
                —
              </span>
              <span className="text-sm text-foreground">No song</span>
            </button>
          )}
          {library.tracks.length === 0 && (
            <p className="text-xs text-muted-foreground px-1 py-2">
              No tracks yet — paste a TikTok post or sound link below, or drop
              audio files into the <span className="font-mono">music/</span>{" "}
              folder.
            </p>
          )}
          {library.tracks.map((track) => {
            const selected = value === track.filename;
            return (
              <div key={track.filename} className={rowClass(selected)}>
                <button
                  type="button"
                  onClick={() => togglePreview(track)}
                  title={previewing === track.filename && previewPlaying ? "Stop preview" : "Preview"}
                  className="relative size-9 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center text-muted-foreground"
                >
                  {track.cover ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={`/api/music/${encodeURIComponent(track.filename)}?cover=1`}
                      alt=""
                      className="size-9 object-cover"
                    />
                  ) : (
                    <span className="text-sm">🎵</span>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-xs">
                    {previewing === track.filename && previewPlaying ? "■" : "▶"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onChange(track)}
                  className="flex-1 min-w-0 text-left"
                >
                  <span className="block truncate text-sm text-foreground">
                    {track.title}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {track.author ? `${track.author} · ` : ""}
                    {formatSeconds(track.duration)}
                    {track.acquisition === "video_mix" ? " · video mix" : ""}
                    {track.acquisition === "local" ? " · local file" : ""}
                    {selected ? " · selected" : ""}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => remove(track)}
                  title="Remove from library"
                  className="shrink-0 text-muted-foreground hover:text-destructive text-xs px-1"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {previewing && (
        <audio
          ref={audioRef}
          key={previewing}
          src={`/api/music/${encodeURIComponent(previewing)}`}
          controls
          onPlay={() => setPreviewPlaying(true)}
          onPause={() => setPreviewPlaying(false)}
          onEnded={() => setPreviewing(null)}
          className="w-full h-8"
        />
      )}

      <div className="flex flex-col gap-1">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFromUrl();
              }
            }}
            placeholder="Add from a TikTok post or sound link…"
            disabled={adding}
            className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          <button
            type="button"
            onClick={addFromUrl}
            disabled={adding || !url.trim()}
            className="shrink-0 rounded-md bg-secondary text-secondary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-secondary/80 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
        {adding && (
          <p className="text-[10px] text-muted-foreground animate-pulse">
            Fetching the sound from TikTok — falls back to extracting the
            post&apos;s audio when the sound has no download URL.
          </p>
        )}
        {addError && <p className="text-xs text-red-500">{addError}</p>}
      </div>
    </div>
  );
}
