"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MusicPicker } from "@/components/form/MusicPicker";
import {
  defaultMusicDuration,
  type MusicLibrary,
  type MusicTrack,
} from "@/lib/music-schema";

const PROMPT_FLOW_DEFAULT_SECONDS = 30;

// Two orderings of the same form. flow=music puts the song first — the
// video's length and pacing follow the track. The standard flow leads
// with the prompt and offers the song as an optional field.
function CreateForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const musicFirst = searchParams.get("flow") === "music";

  const [track, setTrack] = useState<MusicTrack | null>(null);
  const [duration, setDuration] = useState<number>(
    PROMPT_FLOW_DEFAULT_SECONDS
  );
  const [durationTouched, setDurationTouched] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Duration defaults to min(song length, 60s) and follows the song until
  // the user edits it by hand
  useEffect(() => {
    if (durationTouched) return;
    setDuration(
      track ? defaultMusicDuration(track.duration) : PROMPT_FLOW_DEFAULT_SECONDS
    );
  }, [track, durationTouched]);

  const onLibrary = useCallback((library: MusicLibrary) => {
    // Refresh the selected track's details (duration lands after probing)
    setTrack((current) =>
      current
        ? (library.tracks.find((t) => t.filename === current.filename) ?? null)
        : current
    );
  }, []);

  const canSubmit = musicFirst ? track !== null : prompt.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      setStatus("Creating the project…");
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flow: musicFirst ? "music" : "prompt",
          prompt,
          music_filename: track?.filename ?? null,
          duration_seconds: duration,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create the project");
      const { filename, videoId } = data as { filename: string; videoId: string };
      window.dispatchEvent(new Event("downloads-changed"));

      // Plan the shots right away; a failure here just lands the user in
      // the editor with the "Plan shots" button to retry
      setStatus(
        track
          ? "Planning shots to the track with Gemini… (can take a minute)"
          : "Planning shots with Gemini… (can take a minute)"
      );
      try {
        const planRes = await fetch(`/api/analyze/${videoId}`, { method: "POST" });
        if (!planRes.ok) {
          const planData = await planRes.json().catch(() => null);
          console.error("shot plan failed:", planData?.error);
        }
      } catch (planError) {
        console.error("shot plan failed:", planError);
      }
      router.push(`/downloads/${encodeURIComponent(filename)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the project");
      setStatus(null);
      setSubmitting(false);
    }
  };

  const songField = (
    <div className="space-y-2">
      <label className="text-sm font-medium">
        Song{" "}
        {!musicFirst && (
          <span className="text-muted-foreground">(optional)</span>
        )}
      </label>
      <MusicPicker
        value={track?.filename ?? null}
        onChange={setTrack}
        allowNone={!musicFirst}
        onLibrary={onLibrary}
      />
      {track && (
        <p className="text-xs text-muted-foreground">
          Selected: {track.title}
          {track.author ? ` — ${track.author}` : ""}
          {track.duration != null ? ` · ${track.duration.toFixed(1)}s` : ""}
        </p>
      )}
    </div>
  );

  const promptField = (
    <div className="space-y-2">
      <label htmlFor="prompt" className="text-sm font-medium">
        Concept{" "}
        {musicFirst && (
          <span className="text-muted-foreground">(optional)</span>
        )}
      </label>
      <textarea
        id="prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        maxLength={2000}
        placeholder={
          musicFirst
            ? "What should happen over this track? e.g. “POV: the duck rides shotgun on a night drive, reveal at the drop”. Leave empty and Gemini picks a format."
            : "Describe the video you want, e.g. “a 30-second montage of the duck on different dashboards, ending on the Tesla screen frame”"
        }
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
      />
    </div>
  );

  const durationField = (
    <div className="space-y-2">
      <label htmlFor="duration" className="text-sm font-medium">
        Length (seconds)
      </label>
      <input
        id="duration"
        type="number"
        min={3}
        max={180}
        step={1}
        value={duration}
        onChange={(e) => {
          setDurationTouched(true);
          setDuration(Number(e.target.value));
        }}
        className="w-32 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <p className="text-xs text-muted-foreground">
        {track
          ? track.duration != null && duration > track.duration
            ? "Longer than the song — it loops to fill the video."
            : "Defaults to the song length, capped at 60s."
          : "TikTok favors short — 15 to 60 seconds."}
      </p>
    </div>
  );

  return (
    <div className="flex flex-col items-center min-h-screen p-8">
      <div className="w-full max-w-lg space-y-6 py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold">
            {musicFirst ? "Start from a song" : "Custom video from a prompt"}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {musicFirst
              ? "Pick a track first — the shot plan is paced to the music"
              : "Describe the video; Gemini plans shots your clip library can fill"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {musicFirst ? (
            <>
              {songField}
              {durationField}
              {promptField}
            </>
          ) : (
            <>
              {promptField}
              {songField}
              {durationField}
            </>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
              <p className="text-xs text-red-500 break-words">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="submit"
              disabled={!canSubmit || submitting}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Working…" : "Create & plan shots"}
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

export default function CreatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="size-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
        </div>
      }
    >
      <CreateForm />
    </Suspense>
  );
}
