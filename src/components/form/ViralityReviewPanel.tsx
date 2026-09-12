"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { REVIEW_CRITERIA, type ViralityReview } from "@/lib/virality-schema";
import type { FootageSource, Storyboard } from "@/lib/segments-schema";
import { beginMediaPlayback, playMedia } from "@/lib/media-playback";

interface ReviewItem { storyboard: Storyboard; review: ViralityReview | null }
export function useStoryboardReviews(videoId: string, refreshKey = "") {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [snapshot, setSnapshot] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/analyze/${videoId}/virality`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load reviews");
      if (request === generation.current) { setItems(data.items); setSnapshot(data.snapshot); }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : "Could not load reviews"); }
    finally { if (request === generation.current) setLoading(false); }
  }, [videoId]);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useEffect(() => { void load(); return invalidate; }, [load, refreshKey, invalidate]);
  const review = async (id: string) => {
    setReviewing(id);
    setError(null);
    try {
      const response = await fetch(`/api/analyze/${videoId}/virality`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storyboard_id: id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Review failed");
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : "Review failed"); }
    finally { setReviewing(null); }
  };
  return { items, snapshot, loading, reviewing, error, review };
}

export function ViralityReviewPanel({ videoId, storyboardId, onSeek }: { videoId: string; storyboardId?: string; onSeek?: (time: number, source?: FootageSource) => void }) {
  const { items, snapshot, loading, reviewing, error, review } = useStoryboardReviews(videoId);
  const [selected, setSelected] = useState(storyboardId ?? "");
  const [sourcePreview, setSourcePreview] = useState<{ filename: string; time: number; request: number } | null>(null);
  const sourceVideo = useRef<HTMLVideoElement>(null);
  const seekSource = (time: number, source?: FootageSource) => {
    if (!source) { setSourcePreview(null); onSeek?.(time); return; }
    const request = beginMediaPlayback();
    const localTime = Math.max(0, time - source.offset);
    if (sourcePreview?.filename === source.filename && sourceVideo.current) {
      sourceVideo.current.currentTime = localTime;
      void playMedia(sourceVideo.current, request).catch(() => {});
    }
    setSourcePreview({ filename: source.filename, time: localTime, request });
  };
  const item = items.find(i => i.storyboard.id === selected) ?? items[0];
  const assessment = item?.review;
  return <section aria-label="Virality Review" className="space-y-4 rounded-lg border border-border p-4">
    <div><h2 className="text-base font-semibold">Virality Review</h2>
      <p className="mt-1 text-xs text-muted-foreground">Hook, audience relevance, clarity, payoff, and shareability. AI creative assessment, not a prediction of views.</p></div>
    {loading && <p role="status" className="text-xs text-muted-foreground">Loading reviews…</p>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {sourcePreview && <div className="space-y-2"><p className="text-xs">Source footage: {sourcePreview.filename}</p><video ref={sourceVideo} key={sourcePreview.filename} controls playsInline className="max-h-72 max-w-full rounded bg-black" src={`/api/library/clips/${encodeURIComponent(sourcePreview.filename)}`} onLoadedMetadata={event => { event.currentTarget.currentTime = sourcePreview.time; void playMedia(event.currentTarget, sourcePreview.request).catch(() => {}); }} /><button className="text-xs underline" onClick={() => setSourcePreview(null)}>Close source preview</button></div>}
    {!loading && !item && <p className="text-sm text-muted-foreground">Create a storyboard from imported clips to get an automatic review.</p>}
    {item && <>
      {items.length > 1 && <label className="block text-xs">Storyboard
        <select aria-label="Storyboard to review" value={item.storyboard.id} onChange={e => setSelected(e.target.value)} className="ml-2 max-w-full rounded border border-border bg-background p-2">
          {items.map(i => <option key={i.storyboard.id} value={i.storyboard.id}>{i.storyboard.title}</option>)}
        </select></label>}
      <p className="text-xs text-muted-foreground">{item.storyboard.title} · Storyboard revision {item.storyboard.revision ?? 1}{snapshot ? " · Saved at transition to editing" : ""}</p>
      {snapshot && <p className="text-xs text-muted-foreground">This review describes the original storyboard. Later timeline edits and rendered audio, visuals, and captions have not been assessed.</p>}
      {!snapshot && !assessment && <div className="space-y-2"><p className="text-xs text-muted-foreground">This revision has no review yet. New ideas are reviewed automatically; edited or older ideas can be reviewed here.</p>
        <button disabled={!!reviewing} onClick={() => review(item.storyboard.id)} className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{reviewing && <Loader2 className="size-3 animate-spin" />}{reviewing ? "Reviewing storyboard…" : "Review storyboard"}</button></div>}
      {snapshot && !assessment && <p className="text-xs text-muted-foreground">No review was saved with this editing project.</p>}
      {assessment && <>
        <p className="text-sm">{assessment.summary}</p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">{REVIEW_CRITERIA.map(key => <div key={key} className="rounded border border-border p-3"><p className="text-xs font-semibold capitalize">{key === "audience" ? "Audience relevance" : key} · {assessment.assessments[key].score}/5</p><p className="mt-2 text-xs text-muted-foreground">{assessment.assessments[key].reason}</p></div>)}</div>
        <div className="space-y-2"><h3 className="text-sm font-semibold">Prioritized improvements</h3>
          {!assessment.improvements.length && <p className="text-xs text-muted-foreground">No specific improvements identified.</p>}
          {assessment.improvements.map((entry, i) => <div key={i} className="rounded border border-border p-3"><p className="text-xs font-semibold">{i + 1}. {entry.title} · Beat {entry.beat_index + 1}</p><p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
            {!snapshot && onSeek && <button className="mt-2 text-xs underline" onClick={() => { const beat = item.storyboard.beats[entry.beat_index]; if (beat) seekSource(beat.start, beat.source); }}>Play source beat</button>}</div>)}
        </div>
        <div className="space-y-2"><h3 className="text-sm font-semibold">Alternative hooks from your footage</h3>
          {!assessment.hooks.length && <p className="text-xs text-muted-foreground">No stronger standalone alternatives identified in the available footage.</p>}
          {assessment.hooks.map((hook, i) => <div key={i} className="rounded border border-border p-3"><p className="text-sm">“{hook.text}”</p><p className="mt-1 text-xs text-muted-foreground">{hook.reason}</p>
            {!snapshot && onSeek && <button className="mt-2 text-xs underline" onClick={() => seekSource(hook.start, hook.source)}>Play source at {(hook.start - (hook.source?.offset ?? 0)).toFixed(1)}s</button>}</div>)}
        </div>
        <div className="space-y-2"><h3 className="text-sm font-semibold">Recommended additions for editing</h3>
          {!assessment.text.length && !assessment.broll.length && <p className="text-xs text-muted-foreground">No text or B-roll additions recommended.</p>}
          {assessment.text.map((entry, i) => <p key={`text-${i}`} className="text-xs"><strong>Text · Beat {entry.beat_index + 1} · +{entry.offset.toFixed(1)}s:</strong> “{entry.text}” <span className="text-muted-foreground">— {entry.reason}</span></p>)}
          {assessment.broll.map((entry, i) => <p key={`broll-${i}`} className="text-xs"><strong>B-roll · Beat {entry.beat_index + 1} · +{entry.offset.toFixed(1)}s:</strong> {entry.description} <span className="text-muted-foreground">— {entry.reason}</span></p>)}
          <p className="text-xs text-muted-foreground">Choose which additions to include when you create an editing project. Text stays editable; B-roll is placed only when a strong library match is available.</p>
        </div>
      </>}
    </>}
  </section>;
}
