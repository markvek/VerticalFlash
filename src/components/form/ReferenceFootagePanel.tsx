"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryClip } from "@/lib/library-schema";
import { clipDescription, clipTags } from "@/lib/library-metadata";
import { FOOTAGE_DRAG_TYPE, type FootageRange } from "@/lib/footage-drag";

export function ReferenceFootagePanel({ busy, onReplace }: { busy: boolean; onReplace: (range: FootageRange) => Promise<unknown> }) {
  const [clips, setClips] = useState<LibraryClip[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/library"); const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load footage");
    setClips(data.videos);
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  const upload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true); setError(null);
    try {
      const form = new FormData(); Array.from(files).forEach(file => form.append("files", file));
      const res = await fetch("/api/library/upload?analyze=1", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      await load();
      if (data.errors?.length) setError(data.errors.map((e: { error: string }) => e.error).join("; "));
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed"); }
    finally { setUploading(false); if (input.current) input.current.value = ""; }
  };
  return <div className="space-y-3">
    <div className="rounded-lg border border-dashed border-border p-4" onDragOver={e => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void upload(e.dataTransfer.files); } }}>
      <input ref={input} type="file" accept="video/*" multiple className="hidden" onChange={e => void upload(e.target.files)} />
      <button disabled={uploading} onClick={() => input.current?.click()} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{uploading ? "Uploading and analyzing…" : "Upload footage"}</button>
      <p className="mt-2 text-xs text-muted-foreground">Or drop videos here. Drag a library clip to a timeline Replace target, or use it for the selected segment.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <input aria-label="Search reference replacement footage" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search descriptions and tags" className="min-w-0 flex-1 rounded border border-border bg-background p-2 text-xs" />
      <select aria-label="Replacement footage category" value={category} onChange={e => setCategory(e.target.value)} className="rounded border border-border bg-background p-2 text-xs"><option value="">All categories</option>{[...new Set(clips.map(c => c.analysis?.category).filter(Boolean))].map(c => <option key={c}>{c}</option>)}</select>
    </div>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    <div className="space-y-2">{clips.filter(c => (!category || c.analysis?.category === category) && `${c.filename} ${clipDescription(c)} ${clipTags(c).join(" ")}`.toLowerCase().includes(query.toLowerCase())).map(clip => <div key={clip.filename}
      draggable={!busy && !uploading && !!clip.duration} onDragStart={e => { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData(FOOTAGE_DRAG_TYPE, JSON.stringify({ filename: clip.filename, start: 0, end: clip.duration })); }}
      className="flex items-center gap-3 rounded-md border border-border p-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/library/thumbs/${encodeURIComponent(clip.filename)}`} alt="" className="h-14 w-10 rounded object-cover" />
      <div className="min-w-0 flex-1"><p className="truncate text-xs">{clip.filename}</p><p className="line-clamp-2 text-[11px] text-muted-foreground">{clipDescription(clip)}</p></div>
      <button disabled={busy || uploading || !clip.duration} onClick={() => void onReplace({ filename: clip.filename, start: 0, end: clip.duration! })} className="rounded bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">Use clip</button>
    </div>)}</div>
  </div>;
}
