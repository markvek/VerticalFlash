"use client";
import { FOOTAGE_DRAG_TYPE, type FootageRange } from "@/lib/footage-drag";
import { clipDescription, clipTags } from "@/lib/library-metadata";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, Search, Upload } from "lucide-react";
import { FootageThumbnail } from "@/components/ui/FootageThumbnail";
import type { FootageCandidate } from "@/lib/storyboard-footage-schema";

export function StoryboardFootagePanel({ videoId, mode, onIncluded, onTimeline, timelineBusy }: { onTimeline?: (range: FootageRange, action: "insert" | "replace" | "broll") => Promise<boolean>; timelineBusy?: boolean; videoId: string; mode: "add" | "upload"; onIncluded: () => void }) {
  const [footage, setFootage] = useState<FootageCandidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  useEffect(() => { setRangeStart(0); setRangeEnd(null); }, [selected]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/master/${videoId}/footage`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load footage");
      setFootage(body.footage);
      setSelected((value) => value ?? body.footage.find((item: FootageCandidate) => !item.included)?.clip.filename ?? body.footage[0]?.clip.filename ?? null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not load footage"); }
    finally { setLoading(false); }
  }, [videoId]);
  useEffect(() => { load(); }, [load]);

  const include = async (filename: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/master/${videoId}/footage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not include footage");
      await load();
      onIncluded();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not include footage"); }
    finally { setBusy(false); }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setProgress("Uploading and analyzing footage...");
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("files", file);
      const response = await fetch("/api/library/upload?analyze=1", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Upload failed");
      const failures: string[] = (body.errors ?? []).map((item: { error: string }) => item.error);
      for (const clip of body.clips ?? []) {
        const included = await fetch(`/api/master/${videoId}/footage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: clip.filename }) });
        if (!included.ok) { const result = await included.json(); failures.push(`${clip.filename}: ${result.error || "Could not include footage; retry from the library"}`); }
      }
      onIncluded();
      await load();
      const uploaded = body.clips?.[0];
      if (uploaded) { setSelected(uploaded.filename); setDate(null); setSearch(""); }
      if (failures.length) setError(failures.join("; "));
      setProgress(`${body.clips?.length ?? 0} file(s) uploaded`);
    } catch (error) { setError(error instanceof Error ? error.message : "Upload failed"); setProgress(null); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };

  const dayOf = (item: FootageCandidate) => (item.clip.date ?? item.clip.createdAt).slice(0, 10);
  const groups = [...new Set(footage.map(dayOf))].sort().reverse();
  const filtered = footage.filter((item) => (!category || item.clip.analysis?.category === category) && (!date || dayOf(item) === date) && `${item.clip.filename} ${clipDescription(item.clip)} ${clipTags(item.clip).join(" ")} ${item.transcript}`.toLowerCase().includes(search.toLowerCase()));
  const active = footage.find((item) => item.clip.filename === selected);

  return <div className="min-w-0 space-y-4">
    {mode === "upload" && <div onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); if (!busy) void upload(e.dataTransfer.files); } }} className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-3">
      <input ref={input} type="file" multiple accept="video/*" className="hidden" onChange={(event) => upload(event.target.files)} />
      <button disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}Upload and analyze
      </button><span className="text-xs text-muted-foreground">or drop videos here</span>
      {progress && <p role="status" className="text-xs text-muted-foreground">{progress}</p>}
    </div>}
    <label className="flex items-center gap-2 text-xs">Category<select aria-label="Footage category" className="rounded border border-border bg-background p-2" value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{[...new Set(footage.map(item => item.clip.analysis?.category).filter((value): value is string => !!value))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
    <div className="flex items-center gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-3 py-2">
        <Search className="size-4 shrink-0 text-muted-foreground" /><input aria-label="Search uploaded footage" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search footage" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <button onClick={() => { setError(null); load(); }} disabled={loading || busy} aria-label="Refresh footage" title="Refresh footage" className="grid size-9 shrink-0 place-items-center rounded-md border border-border"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></button>
    </div>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {active && onTimeline && <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3 text-xs">
      <label>From (s)<input aria-label="Footage start" type="number" min={0} max={active.duration ?? 0} step={0.1} value={rangeStart} onChange={e => setRangeStart(Number(e.target.value))} className="ml-2 w-20 rounded border border-border bg-background p-1.5" /></label>
      <label>To (s)<input aria-label="Footage end" type="number" min={0} max={active.duration ?? 0} step={0.1} value={rangeEnd ?? active.duration ?? 0} onChange={e => setRangeEnd(Number(e.target.value))} className="ml-2 w-20 rounded border border-border bg-background p-1.5" /></label>
      {(["insert", "replace", "broll"] as const).map(action => <button key={action} disabled={busy || timelineBusy || !active.duration || (rangeEnd ?? active.duration) - rangeStart < 0.5} className="rounded border border-border px-2 py-1.5 disabled:opacity-50" onClick={async () => {
        setBusy(true); setError(null);
        try {
          if (!active.included) { const response = await fetch(`/api/master/${videoId}/footage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: active.clip.filename }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); onIncluded(); await load(); }
          if (!await onTimeline({ filename: active.clip.filename, start: rangeStart, end: rangeEnd ?? active.duration! }, action)) throw new Error("Could not update the timeline. See the timeline error and retry.");
        } catch (e) { setError(e instanceof Error ? e.message : "Could not add footage"); } finally { setBusy(false); }
      }}>{action === "insert" ? "Insert after selected shot" : action === "replace" ? "Replace selected shot" : "Add B-roll at selected shot"}</button>)}
      <p className="w-full text-muted-foreground">Drag a footage card to an insertion point, the Replace target, or the B-roll lane.</p>
    </div>}
    {active && <div className="grid overflow-hidden rounded-lg border border-border md:grid-cols-[minmax(140px,230px)_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-2 bg-black p-4">
        <video key={active.clip.filename} src={`/api/library/clips/${encodeURIComponent(active.clip.filename)}`} poster={`/api/library/thumbs/${encodeURIComponent(active.clip.filename)}`} controls playsInline preload="metadata" className="aspect-[9/16] w-full max-w-56 rounded-md bg-black object-contain" />
        <p className="w-full truncate text-center text-xs text-muted-foreground" title={active.clip.filename}>{active.clip.filename}</p>
      </div>
      <div className="min-w-0 space-y-3 bg-card p-4 text-xs">
        <dl className="space-y-3">
          <div><dt className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Filename</dt><dd className="break-all">{active.clip.filename}</dd></div>
          <div><dt className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Date</dt><dd>{active.clip.date ? new Date(active.clip.date).toLocaleDateString() : "No date set"}</dd></div>
          <div><dt className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Description</dt><dd>{clipDescription(active.clip) || "No description"}</dd></div>
          <div><dt className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Tags</dt><dd className="flex flex-wrap gap-1">{clipTags(active.clip).map((tag) => <span key={tag} className="rounded bg-muted px-2 py-0.5">{tag}</span>)}</dd></div>
          <div><dt className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Source</dt><dd>{active.clip.source || "Not specified"}</dd></div>
          <div><dt className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Duration</dt><dd>{active.duration ? `${active.duration.toFixed(1)}s` : "Unavailable"}</dd></div>
        </dl>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Saved analysis</p>
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap">{active.transcript || (active.timing === "unavailable" ? "Not analyzed" : "Nothing spoken")}</p>
          <p className="text-muted-foreground">{active.timing === "saved_segments" ? `${active.segments.length} saved transcript segments` : active.timing === "whole_clip" ? "Whole-clip transcript; no segment timing" : "Analysis required"}</p>
        </div>
        <button disabled={busy || active.included || active.timing === "unavailable" || !active.duration} onClick={() => include(active.clip.filename)} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 font-semibold text-primary-foreground disabled:opacity-50">
          {busy ? <Loader2 className="size-3 animate-spin" /> : active.included ? <Check className="size-3" /> : <Plus className="size-3" />}{active.included ? "Included in project" : "Include in project"}
        </button>
      </div>
    </div>}
    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Footage dates">
      <button onClick={() => setDate(null)} className={`shrink-0 rounded-md border px-3 py-2 text-xs ${date === null ? "border-primary bg-muted" : "border-border"}`}>All dates</button>
      {groups.map((day) => <button key={day} onClick={() => setDate(day)} aria-pressed={date === day} className={`w-20 shrink-0 rounded-md border px-2 py-2 text-center ${date === day ? "border-primary bg-muted" : "border-border"}`}>
        <span className="block text-[10px] uppercase text-muted-foreground">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short" })}</span>
        <span className="block text-lg font-semibold">{day.slice(8)}</span><span className="block text-[10px] text-muted-foreground">{footage.filter((item) => dayOf(item) === day).length} clips</span>
      </button>)}
    </div>
    {loading && !footage.length ? <p role="status" className="text-sm text-muted-foreground">Loading uploaded footage...</p> : !filtered.length ? <p className="text-sm text-muted-foreground">No footage found</p> : <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Uploaded footage">
      {filtered.map((item) => <button key={item.clip.filename} draggable={!!onTimeline && !busy && !timelineBusy && !!item.duration && item.timing !== "unavailable"} onDragStart={event => {
        const start = selected === item.clip.filename ? rangeStart : 0;
        const end = selected === item.clip.filename ? rangeEnd ?? item.duration : item.duration;
        if (end == null || end - start < 0.5) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(FOOTAGE_DRAG_TYPE, JSON.stringify({ filename: item.clip.filename, start, end }));
      }} onClick={() => setSelected(item.clip.filename)} aria-pressed={selected === item.clip.filename} title={item.clip.filename} className={`w-28 shrink-0 rounded-md border p-2 text-left ${selected === item.clip.filename ? "border-primary bg-muted" : "border-border"}`}>
        <FootageThumbnail src={`/api/library/thumbs/${encodeURIComponent(item.clip.filename)}`} alt={item.clip.filename} className="mx-auto w-14" />
        <span className="mt-2 block truncate text-xs">{item.clip.filename}</span><span className="block text-[10px] text-muted-foreground">{item.included ? "Included" : item.timing === "unavailable" ? "Not analyzed" : `${item.segments.length} segments`}</span>
      </button>)}
    </div>}
  </div>;
}
