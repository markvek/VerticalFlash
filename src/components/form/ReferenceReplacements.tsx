"use client";
import { useEffect, useState } from "react";
import type { ShotRecommendations } from "@/lib/recommendation-schema";
import { GenerationPanel, type ShotGenerations } from "./GenerationPanel";

type Candidate = { filename: string; start: number | null; end: number | null };
export function ReferenceReplacements({ videoId, index, duration, description, recs, busy, error, generation, onGeneration, onAccept, onChoose, onKeep, onPreview, onLibrary, onUpload, onMatch, onHistory, thumbSrc }: {
  videoId: string; index: number; duration: number; description: string; recs: ShotRecommendations;
  busy: boolean; error: string | null; generation: ShotGenerations | null;
  onGeneration: (g: ShotGenerations) => void; onAccept: (g: ShotGenerations, recs: unknown) => void;
  onChoose: (filename: string) => Promise<unknown>; onKeep: () => void; onPreview: (clip: Candidate) => void;
  onLibrary: () => void; onUpload: () => void; onMatch: () => void; onHistory: (action: "undo" | "redo") => void;
  thumbSrc: (filename: string) => string;
}) {
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/analyze/${videoId}/replacements/history`).then(r => r.ok ? r.json() : null).then(data => { if (!cancelled && data) setHistory(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [videoId, recs]);
  const shot = recs.shots.find(s => s.shot_index === index);
  const selected = shot?.recommendations.find(r => r.filename === shot.selected_filename);
  const candidates = [...(selected ? [selected] : []), ...(shot?.recommendations.filter(r => r.filename !== selected?.filename) ?? [])].slice(0, 4);
  return <div className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-semibold">Replacements for segment {index + 1} · {duration.toFixed(1)}s</p>
      <span className="text-[10px] text-muted-foreground">{recs.clipsConsidered} clips considered · Library first</span>
    </div>
    <p className="text-xs text-muted-foreground">{description}</p>
    {shot?.needs_replacement && <p role="status" className="text-xs text-amber-600 dark:text-amber-400">Needs replacement — showing the reference until you choose a clip or Keep original.</p>}
    <div className="flex flex-wrap gap-2 text-xs">
      <button disabled={busy} onClick={onKeep} className="rounded border border-border px-2 py-1.5 disabled:opacity-50">{shot?.keep_source && !shot.needs_replacement ? "✓ Keeping original" : "Keep original"}</button>
      <button disabled={busy} onClick={onLibrary} className="rounded border border-border px-2 py-1.5 disabled:opacity-50">All clips</button>
      <button onClick={onUpload} className="rounded border border-border px-2 py-1.5">Upload footage</button>
      <button disabled={busy} onClick={onMatch} className="rounded border border-border px-2 py-1.5 disabled:opacity-50">{busy ? "Working…" : "Refresh matches"}</button>
      <button disabled={busy || !history.canUndo} onClick={() => onHistory("undo")} className="rounded border border-border px-2 py-1.5 disabled:opacity-50">Undo replacement</button>
      <button disabled={busy || !history.canRedo} onClick={() => onHistory("redo")} className="rounded border border-border px-2 py-1.5 disabled:opacity-50">Redo replacement</button>
    </div>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    {!candidates.length && <p className="text-xs text-muted-foreground">No suitable library matches yet. Choose from All clips, upload footage, or generate an alternative.</p>}
    <div className="space-y-2">{candidates.map(clip => {
      const active = !shot?.keep_source && clip.filename === shot?.selected_filename;
      const short = clip.duration != null && clip.duration < duration - 0.001;
      return <div key={clip.filename} className={`flex items-start gap-3 rounded-md border p-2 ${active ? shot?.choice_origin === "automatic" ? "border-primary" : "border-green-500/60" : "border-border"}`}>
        <button onClick={() => onPreview({ filename: clip.filename, start: clip.trim_start, end: clip.trim_end })} title={`Preview ${clip.filename}`} className="shrink-0 overflow-hidden rounded border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumbSrc(clip.filename)} alt={clip.filename} className="h-16 w-12 object-cover" />
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-xs font-medium" title={clip.filename}>{clip.filename}</p>
          <div className="flex flex-wrap gap-1 text-[10px]">
            {active && <span className="rounded bg-primary/10 px-1.5 py-0.5">{shot?.choice_origin === "automatic" ? "Suggested" : "✓ Selected"}</span>}
            <span className="rounded bg-muted px-1.5 py-0.5">{clip.confidence} match</span>
            {clip.trim_start != null && clip.trim_end != null && <span className="rounded bg-muted px-1.5 py-0.5">{clip.trim_start.toFixed(1)}s → {clip.trim_end.toFixed(1)}s</span>}
            {short && <span className="text-amber-500">Too short · needs {duration.toFixed(1)}s</span>}
          </div>
          <p className="text-[11px] text-muted-foreground">{clip.reason}</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => onPreview({ filename: clip.filename, start: clip.trim_start, end: clip.trim_end })} className="text-xs underline">Preview</button>
            <button disabled={busy || short} onClick={() => void onChoose(clip.filename)} className="rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">{active && shot?.choice_origin !== "automatic" ? "Selected" : "Use clip"}</button>
          </div>
        </div>
      </div>;
    })}</div>
    <details className="rounded-md border border-border p-2">
      <summary className="cursor-pointer text-xs font-semibold">Generate alternative with Gemini Omni</summary>
      <fieldset disabled={busy} className="mt-3 disabled:opacity-50"><GenerationPanel videoId={videoId} shotIndex={index} shotDuration={duration}
        generation={generation} selectedRec={selected ? { filename: selected.filename, duration: selected.duration } : null}
        gap={!!shot?.needs_replacement} onGeneration={onGeneration} onAccept={onAccept} /></fieldset>
    </details>
  </div>;
}
