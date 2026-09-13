"use client";
import { trackEditSave } from "@/lib/edit-save-tracker";

import { NativeModelSelector } from "@/components/form/NativeModelSelector";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import { Dialog } from "radix-ui";
import { ChevronDown, ChevronRight, Loader2, Play, Plus, Square, X } from "lucide-react";
import { StoryboardBeatCard } from "./StoryboardBeatCard";
import { useStoryboardReviews } from "./ViralityReviewPanel";
import { beginMediaPlayback, isCurrentMediaPlayback, subscribeMediaPlayback } from "@/lib/media-playback";
import type {
  Beat,
  FootageSource,
  MasterSegments,
  MasterStoryboards,
  Pacing,
  Segment,
  SegmentRole,
  Storyboard,
  StoryboardRequest,
} from "@/lib/segments-schema";
import {
  PACINGS,
  STORYBOARD_DEFAULT_COUNT,
  STORYBOARD_DEFAULT_SECONDS,
  STORYBOARD_MAX_COUNT,
  STORYBOARD_MAX_SECONDS,
  STORYBOARD_MIN_COUNT,
  STORYBOARD_MIN_SECONDS,
} from "@/lib/segments-schema";

// Storyboards tab for master projects: the timed transcript, request controls,
// and one active storyboard idea that can be steered before it is accepted into
// the normal editor flow.

export interface StoryboardPanelProps {
  selectedIdea?: string;
  onIdeaChange?: (id: string) => void;
  adoptedIdea?: string;
  adoptedRevision?: number;
  activeEdit?: string;
  onBeforeAccept?: () => Promise<void>;
  onEditCreated?: (filename: string) => Promise<void>;
  onOpenEdit?: (filename: string) => Promise<void>;
  onReturnToEdit?: () => void;
  videoId: string;
  filename: string;
  onSeek?: (seconds: number, source?: FootageSource, request?: number) => void;
  onStopPreview?: () => void;
  previewMedia?: ReactNode;
  footagePanel?: ReactNode;
  refreshKey?: number;
  onOpenReview?: (storyboardId: string) => void;
}

const ROLE_STYLES: Record<SegmentRole, string> = {
  hook: "bg-amber-500/15 text-amber-300",
  claim: "bg-blue-500/15 text-blue-300",
  demo: "bg-green-500/15 text-green-300",
  proof: "bg-teal-500/15 text-teal-300",
  objection: "bg-purple-500/15 text-purple-300",
  cta: "bg-pink-500/15 text-pink-300",
  filler: "bg-muted text-muted-foreground",
};

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function normalizeBeats(beats: Beat[]): Beat[] {
  return beats.map((beat, i) => ({
    ...beat,
    section: i === 0 ? "hook" : i === beats.length - 1 ? "end" : "main",
    show: i === 0 || i === beats.length - 1 ? "source" : beat.show,
    broll_hint: i === 0 || i === beats.length - 1 ? null : beat.broll_hint,
  }));
}

function withBeats(storyboard: Storyboard, beats: Beat[]): Storyboard {
  const normalized = normalizeBeats(beats);
  const estimated = normalized.reduce(
    (sum, beat) => sum + Math.max(0, beat.end - beat.start),
    0
  );
  return {
    ...storyboard,
    hook_line:
      normalized[0]?.text.trim().split(/\s+/).slice(0, 16).join(" ") ||
      storyboard.hook_line,
    estimated_seconds: Math.round(estimated * 10) / 10,
    beats: normalized,
  };
}

function segmentToBeat(segment: Segment): Beat {
  return {
    source: segment.source,
    thumbnail: segment.thumbnail,
    section: "main",
    start: segment.start_time,
    end: segment.end_time,
    start_word: segment.start_word,
    end_word: segment.end_word,
    text: segment.text,
    on_screen_text: segment.on_screen_text_idea,
    show: "source",
    broll_hint: null,
  };
}

function beatMatchesSegment(beat: Beat, segment: Segment): boolean {
  if (beat.source?.filename !== segment.source?.filename || beat.source?.offset !== segment.source?.offset) return false;
  if (beat.start_word != null && segment.start_word != null) {
    return beat.start_word === segment.start_word && beat.end_word === segment.end_word;
  }
  return (
    Math.abs(beat.start - segment.start_time) < 0.05 &&
    Math.abs(beat.end - segment.end_time) < 0.05
  );
}

export function StoryboardPanel({ selectedIdea, onIdeaChange, adoptedIdea, adoptedRevision, activeEdit, onBeforeAccept, onEditCreated, onOpenEdit, onReturnToEdit, videoId, filename, onOpenReview, onSeek, onStopPreview, previewMedia, footagePanel, refreshKey = 0 }: StoryboardPanelProps) {
  const [model, setModel] = useState("");
  const [segments, setSegments] = useState<MasterSegments | null>(null);
  const [storyboards, setStoryboards] = useState<MasterStoryboards | null>(null);
  const [activeStoryboardId, setActiveStoryboardId] = useState<string | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [fullTranscriptOpen, setFullTranscriptOpen] = useState(true);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [segmentPickerOpen, setSegmentPickerOpen] = useState(false);

  const [count, setCount] = useState(STORYBOARD_DEFAULT_COUNT);
  const [perIdea, setPerIdea] = useState(false);
  const [length, setLength] = useState(STORYBOARD_DEFAULT_SECONDS);
  const [lengths, setLengths] = useState<number[]>(
    Array.from({ length: STORYBOARD_MAX_COUNT }, () => STORYBOARD_DEFAULT_SECONDS)
  );
  const [pacing, setPacing] = useState<Pacing>("standard");
  const [allowBroll, setAllowBroll] = useState(false);
  const [brief, setBrief] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addText, setAddText] = useState(false);
  const [addBroll, setAddBroll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reviews = useStoryboardReviews(videoId, storyboards?.storyboards.map(s => `${s.id}:${s.revision ?? 1}`).join(",") ?? "");

  useEffect(() => { if (selectedIdea) setActiveStoryboardId(selectedIdea); }, [selectedIdea]);
  const ideaChanged = useRef(onIdeaChange); ideaChanged.current = onIdeaChange;
  useEffect(() => { if (activeStoryboardId) ideaChanged.current?.(activeStoryboardId); }, [activeStoryboardId]);
  const acceptingRef = useRef(false);
  const acceptanceRequest = useRef<{ signature: string; key: string } | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptedNow, setAcceptedNow] = useState<
    Record<string, { filename: string; displayName: string }>
  >({});
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewTimers = useRef<number[]>([]);
  const previewRequest = useRef<number | null>(null);
  const draggedBeat = useRef<{ storyboardId: string; index: number } | null>(
    null
  );
  const draggedSegment = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<Segment | null>(null);
  const dragPreviewElement = useRef<HTMLDivElement>(null);

  const clearDrag = useCallback(() => {
    draggedBeat.current = null;
    draggedSegment.current = null;
    setDropIndex(null);
    setDragPreview(null);
  }, []);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") clearDrag(); };
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("blur", clearDrag);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("blur", clearDrag);
      window.removeEventListener("keydown", cancel);
    };
  }, [clearDrag]);

  useEffect(() => { clearDrag(); }, [activeStoryboardId, controlsOpen, saving, accepting, clearDrag]);

  const load = useCallback(async () => {
    if (refreshKey === 0) setLoading(true);
    setError(null);
    try {
      const [segRes, sbRes] = await Promise.all([
        fetch(`/api/master/${videoId}/segments`),
        fetch(`/api/master/${videoId}/storyboards`),
      ]);
      if (!segRes.ok && segRes.status !== 404) throw new Error("Could not load saved transcript segments");
      if (!sbRes.ok && sbRes.status !== 404) throw new Error("Could not load saved storyboard ideas");
      setSegments(segRes.ok ? await segRes.json() : null);
      const sb: MasterStoryboards | null = sbRes.ok ? await sbRes.json() : null;
      setStoryboards(sb);
      setActiveStoryboardId((current) => current ?? sb?.storyboards[0]?.id ?? null);
      setControlsOpen(!sb);
      if (sb) {
        setCount(sb.request.count);
        setPacing(sb.request.pacing);
        setAllowBroll(sb.request.allow_broll);
        setBrief(sb.request.brief);
        if (sb.request.lengths.length === 1) {
          setPerIdea(false);
          setLength(sb.request.lengths[0]);
        } else {
          setPerIdea(true);
          setLengths((prev) => prev.map((v, i) => sb.request.lengths[i] ?? v));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load storyboards");
    } finally {
      setLoading(false);
    }
  }, [videoId, refreshKey]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!storyboards) return;
    if (
      activeStoryboardId &&
      storyboards.storyboards.some((s) => s.id === activeStoryboardId)
    ) {
      return;
    }
    setActiveStoryboardId(storyboards.storyboards[0]?.id ?? null);
  }, [activeStoryboardId, storyboards]);

  const clearPreview = useCallback(() => {
    for (const t of previewTimers.current) window.clearTimeout(t);
    previewTimers.current = [];
    previewRequest.current = null;
    setPreviewing(null);
  }, []);

  const stopPreview = useCallback(() => {
    const request = previewRequest.current;
    clearPreview();
    if (request != null && isCurrentMediaPlayback(request)) beginMediaPlayback();
    onStopPreview?.();
  }, [clearPreview, onStopPreview]);

  useEffect(() => stopPreview, [stopPreview]);
  useEffect(() => subscribeMediaPlayback(() => {
    if (previewRequest.current != null && !isCurrentMediaPlayback(previewRequest.current)) clearPreview();
  }), [clearPreview]);

  const activeStoryboard = useMemo(() => {
    if (!storyboards) return null;
    return (
      storyboards.storyboards.find((sb) => sb.id === activeStoryboardId) ??
      storyboards.storyboards[0] ??
      null
    );
  }, [activeStoryboardId, storyboards]);
  const activeReview = reviews.items.find(i => i.storyboard.id === activeStoryboard?.id && (i.storyboard.revision ?? 1) === (activeStoryboard?.revision ?? 1))?.review;

  const saveStoryboard = async (storyboard: Storyboard): Promise<Storyboard> => {
    setSaving(true);
    setError(null);
    try {
      return await trackEditSave(videoId, async () => {
      const res = await fetch(`/api/master/${videoId}/storyboards`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyboard_id: storyboard.id,
          beats: storyboard.beats,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Save failed (HTTP ${res.status})`);
      if (data.storyboards) setStoryboards(data.storyboards);
      return data.storyboard as Storyboard;
      }, storyboard.id);
    } finally {
      setSaving(false);
    }
  };

  const commitStoryboard = async (next: Storyboard) => {
    const previousStoryboards = storyboards;
    const previousAccepted = acceptedNow;
    setStoryboards((current) =>
      current
        ? {
            ...current,
            accepted: current.accepted
              ? Object.fromEntries(
                  Object.entries(current.accepted).filter(([id]) => id !== next.id)
                )
              : current.accepted,
            storyboards: current.storyboards.map((sb) =>
              sb.id === next.id ? next : sb
            ),
          }
        : current
    );
    setAcceptedNow((current) => {
      const copy = { ...current };
      delete copy[next.id];
      return copy;
    });
    try {
      await saveStoryboard(next);
    } catch (e) {
      setStoryboards(previousStoryboards);
      setAcceptedNow(previousAccepted);
      setError(e instanceof Error ? e.message : "Could not save storyboard edit");
    }
  };

  const reorderBeat = (storyboard: Storyboard, from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const beats = [...storyboard.beats];
    if (from >= beats.length || to >= beats.length) return;
    const [moved] = beats.splice(from, 1);
    beats.splice(to, 0, moved);
    commitStoryboard(withBeats(storyboard, beats));
  };

  const insertSegment = (
    storyboard: Storyboard,
    segment: Segment,
    index = storyboard.beats.length
  ) => {
    const alreadyUsed = storyboard.beats.some((beat) => beatMatchesSegment(beat, segment));
    if (alreadyUsed) {
      setError("That transcript segment is already in this storyboard");
      return;
    }
    const beats = [...storyboard.beats];
    beats.splice(
      Math.max(0, Math.min(index, beats.length)),
      0,
      segmentToBeat(segment)
    );
    setSegmentPickerOpen(false);
    setControlsOpen(false);
    commitStoryboard(withBeats(storyboard, beats));
  };

  const canDrop = (event: DragEvent<HTMLDivElement>, storyboard: Storyboard) => {
    if (saving || accepting) return false;
    if (event.dataTransfer.types.includes("application/x-storyboard-beat")) return draggedBeat.current?.storyboardId === storyboard.id;
    const segment = event.dataTransfer.types.includes("application/x-transcript-segment")
      ? segments?.segments.find((segment) => segment.index === draggedSegment.current) : null;
    return !!segment && !storyboard.beats.some((beat) => beatMatchesSegment(beat, segment));
  };

  const landingIndex = (event: DragEvent<HTMLDivElement>, storyboard: Storyboard) => {
    const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-storyboard-drop-index]");
    if (slot) return Number(slot.dataset.storyboardDropIndex);
    const cards = event.currentTarget.querySelectorAll<HTMLElement>("[data-storyboard-index]");
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) return Number(card.dataset.storyboardIndex);
    }
    return storyboard.beats.length;
  };

  const pasteSlot = (index: number) => dropIndex === index ? <div
    data-storyboard-drop-index={index} data-testid="storyboard-paste-slot" role="status" aria-label={`Insert segment at position ${index + 1}`}
    className="flex min-h-[348px] w-[72px] shrink-0 items-center justify-center self-stretch rounded-lg bg-[#363636] text-xs text-[#a3a3a3]">
    Paste
  </div> : null;

  const preview = (sb: Storyboard) => {
    stopPreview();
    if (!onSeek) return;
    const request = beginMediaPlayback();
    previewRequest.current = request;
    setPreviewing(sb.id);
    let offset = 0;
    sb.beats.forEach((beat, i) => {
      const at = offset;
      const t = window.setTimeout(() => {
        if (!isCurrentMediaPlayback(request)) return;
        onSeek(beat.start, beat.source, request);
        if (i === sb.beats.length - 1) {
          const done = window.setTimeout(
            stopPreview,
            Math.max(0, (beat.end - beat.start) * 1000)
          );
          previewTimers.current.push(done);
        }
      }, at);
      previewTimers.current.push(t);
      offset += Math.max(0, beat.end - beat.start) * 1000;
    });
  };

  const requestBody = (): StoryboardRequest | string => {
    const list = perIdea ? lengths.slice(0, count) : [length];
    for (const v of list) {
      if (!Number.isFinite(v) || v < STORYBOARD_MIN_SECONDS || v > STORYBOARD_MAX_SECONDS) {
        return `Lengths must be between ${STORYBOARD_MIN_SECONDS} and ${STORYBOARD_MAX_SECONDS} seconds`;
      }
    }
    return {
      count,
      lengths: list.map((v) => Math.round(v)),
      pacing,
      allow_broll: allowBroll,
      brief: brief.slice(0, 500),
    };
  };

  const generate = async () => {
    const body = requestBody();
    if (typeof body === "string") {
      setError(body);
      return;
    }
    setGenerating(true);
    setNotice(null);
    setError(null);
    stopPreview();
    try {
      const res = await fetch(`/api/master/${videoId}/storyboards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, model: model || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (HTTP ${res.status})`);
      setStoryboards(data);
      setActiveStoryboardId(data.storyboards?.[0]?.id ?? null);
      setAcceptedNow({});
      setControlsOpen(false);
      if (data.reviewWarnings?.length) setNotice(`Ideas saved. Some reviews need a retry: ${data.reviewWarnings.join("; ")}`);
      window.dispatchEvent(new Event("downloads-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Storyboard generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const accept = async (sb: Storyboard) => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    setAccepting(sb.id);
    setError(null);
    setNotice(null);
    try {
      await onBeforeAccept?.();
      const saved = await saveStoryboard(sb);
      const signature = JSON.stringify([saved.id, saved.revision, addText, addBroll]);
      if (acceptanceRequest.current?.signature !== signature) acceptanceRequest.current = { signature, key: crypto.randomUUID() };
      const res = await fetch(`/api/master/${videoId}/storyboards/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: acceptanceRequest.current.key, storyboard_id: saved.id, revision: saved.revision ?? 1, add_text: addText && !!activeReview?.text.length, add_broll: addBroll && !!activeReview?.broll.length }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (HTTP ${res.status})`);
      setAcceptedNow((prev) => ({
        ...prev,
        [saved.id]: { filename: data.filename, displayName: data.displayName },
      }));
      window.dispatchEvent(new Event("downloads-changed"));
      await onEditCreated?.(data.filename);
      acceptanceRequest.current = null;
      setNotice(data.warnings?.length ? data.warnings.join(" ") : "Editing project created. Your selected additions are ready to edit.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cut the short");
    } finally {
      acceptingRef.current = false;
      setAccepting(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">Loading storyboards…</p>
      </div>
    );
  }

  if (!segments) {
    return (
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">
          {error || "No transcript yet. Analyze the footage first."}
        </p>
      </div>
    );
  }

  const selectedAccepted =
    activeStoryboard && storyboards
      ? acceptedNow[activeStoryboard.id]?.filename ??
        storyboards.accepted?.[activeStoryboard.id] ??
        null
      : null;
  const timingBadge =
    segments.segments.some((segment) => segment.source)
      ? "Timing: saved source segments"
      : segments.timing_source === "whisperx"
      ? "Timing: WhisperX (word-accurate)"
      : "Timing: Gemini (approximate)";

  return (
    <div className={previewMedia ? "grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(220px,320px)_minmax(0,1fr)]" : "flex min-w-0 flex-col gap-4"}>
      {previewMedia}
      {footagePanel}
      <section aria-label="Storyboard ideas" className={`min-w-0 space-y-3 rounded-lg border border-border p-3 ${previewMedia && footagePanel ? "lg:col-span-2" : ""}`}>
        <h2 className="text-xs font-semibold uppercase">Storyboards</h2>
        <div className="flex max-w-full overflow-x-auto" role="tablist" aria-label="Storyboard ideas">
          {(storyboards?.storyboards ?? []).map((storyboard, index) => <button key={storyboard.id} role="tab" aria-selected={activeStoryboard?.id === storyboard.id && !controlsOpen}
            onClick={() => { stopPreview(); setActiveStoryboardId(storyboard.id); setControlsOpen(false); }}
            className={`shrink-0 border px-4 py-2 text-xs font-semibold first:rounded-l-md ${adoptedIdea === storyboard.id ? "border-green-500 ring-1 ring-inset ring-green-500" : "border-border"} ${activeStoryboard?.id === storyboard.id && !controlsOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/40"}`}>
            Idea {index + 1}{adoptedIdea === storyboard.id && <span className="ml-2 text-green-500">In this edit</span>}
          </button>)}
          <button role="tab" aria-selected={controlsOpen || !storyboards} onClick={() => { stopPreview(); setControlsOpen(true); }}
            className={`shrink-0 rounded-r-md border border-border px-4 py-2 text-xs font-semibold ${controlsOpen || !storyboards ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
            {storyboards?.storyboards.length ? "Create More Ideas" : "Create Ideas"}
          </button>
        </div>
      <NativeModelSelector value={model} onChange={setModel} disabled={generating} />

      {(!storyboards || controlsOpen) && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              How many ideas
              <input
                type="number"
                min={STORYBOARD_MIN_COUNT}
                max={STORYBOARD_MAX_COUNT}
                value={count}
                onChange={(e) =>
                  setCount(
                    Math.max(
                      STORYBOARD_MIN_COUNT,
                      Math.min(
                        STORYBOARD_MAX_COUNT,
                        parseInt(e.target.value, 10) || STORYBOARD_MIN_COUNT
                      )
                    )
                  )
                }
                className="px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm"
              />
            </label>
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              Pacing
              <select
                value={pacing}
                onChange={(e) => setPacing(e.target.value as Pacing)}
                className="px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm"
              >
                {PACINGS.map((p) => (
                  <option key={p} value={p}>
                    {p === "fast"
                      ? "Fast (1.5–4 s beats)"
                      : p === "standard"
                        ? "Standard (2.5–7 s beats)"
                        : "Detailed (4–12 s beats)"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs text-muted-foreground flex items-center gap-2">
                Length (seconds)
                <input
                  type="number"
                  min={STORYBOARD_MIN_SECONDS}
                  max={STORYBOARD_MAX_SECONDS}
                  value={length}
                  disabled={perIdea}
                  onChange={(e) => setLength(parseInt(e.target.value, 10) || 0)}
                  className="w-20 px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm disabled:opacity-50"
                />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={perIdea}
                  onChange={(e) => setPerIdea(e.target.checked)}
                />
                Different length per idea
              </label>
            </div>
            {perIdea && (
              <div className="flex items-center gap-2 flex-wrap">
                {Array.from({ length: count }, (_, i) => (
                  <label
                    key={i}
                    className="text-[10px] text-muted-foreground flex items-center gap-1"
                  >
                    #{i + 1}
                    <input
                      type="number"
                      min={STORYBOARD_MIN_SECONDS}
                      max={STORYBOARD_MAX_SECONDS}
                      value={lengths[i]}
                      onChange={(e) =>
                        setLengths((prev) =>
                          prev.map((v, j) =>
                            j === i ? parseInt(e.target.value, 10) || 0 : v
                          )
                        )
                      }
                      className="w-16 px-2 py-1 rounded-md border border-border bg-background text-foreground text-sm"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowBroll}
              onChange={(e) => setAllowBroll(e.target.checked)}
            />
            Allow B-roll from the clip library (main beats may cut away while
            the voice continues)
          </label>
          <label className="text-xs text-muted-foreground flex flex-col gap-1">
            Brief (optional)
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value.slice(0, 500))}
              rows={2}
              placeholder="e.g. lead with the price objection; make one a quick tutorial"
              className="px-2 py-1.5 rounded-md border border-border bg-background text-foreground text-sm"
            />
          </label>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={generate}
              disabled={generating}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {generating
                ? "Creating storyboards and reviewing hooks…"
                : storyboards
                  ? "Generate more storyboards"
                  : "Generate storyboards"}
            </button>
            {storyboards && (
              <span className="text-[10px] text-muted-foreground">
                {storyboards.storyboards.length} idea
                {storyboards.storyboards.length === 1 ? "" : "s"} ·{" "}
                {storyboards.request.lengths.join("/")}s ·{" "}
                {storyboards.request.pacing}
                {storyboards.request.allow_broll ? " · B-roll on" : ""} ·{" "}
                {new Date(storyboards.generatedAt).toLocaleString()}
                {storyboards.usage?.totalTokens
                  ? ` · ${storyboards.usage.totalTokens.toLocaleString()} tokens`
                  : ""}
              </span>
            )}
          </div>
        </div>
      )}


        {!controlsOpen && activeStoryboard && <div className="space-y-3">
          <div className="flex flex-col items-start justify-between gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">{activeStoryboard.title}</h3>
              <p className="mt-1 text-xs font-semibold">&ldquo;{activeStoryboard.hook_line}&rdquo;</p>
              <p className="mt-1 text-xs text-muted-foreground">{activeStoryboard.angle}</p>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground" title="The target is a goal, not a limit — whole sentences win over the exact count">
              target {activeStoryboard.target_seconds}s · estimated {activeStoryboard.estimated_seconds}s
              {activeStoryboard.target_seconds > 0 && (() => {
                const pct = Math.round(((activeStoryboard.estimated_seconds - activeStoryboard.target_seconds) / activeStoryboard.target_seconds) * 100);
                return pct === 0 ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`;
              })()}
              {saving ? " · saving..." : ""}
            </span>
          </div>
          <div className="flex items-stretch gap-2 overflow-x-auto pb-1" aria-label="Storyboard segments"
            onDragOver={(event) => {
              if (!canDrop(event, activeStoryboard)) { event.dataTransfer.dropEffect = "none"; setDropIndex(null); return; }
              event.preventDefault();
              event.dataTransfer.dropEffect = draggedBeat.current ? "move" : "copy";
              setDropIndex(landingIndex(event, activeStoryboard));
              const rect = event.currentTarget.getBoundingClientRect();
              if (event.clientX < rect.left + 32) event.currentTarget.scrollLeft -= 16;
              else if (event.clientX > rect.right - 32) event.currentTarget.scrollLeft += 16;
            }}
            onDragLeave={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              if (event.clientX <= rect.left || event.clientX >= rect.right || event.clientY <= rect.top || event.clientY >= rect.bottom) setDropIndex(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (canDrop(event, activeStoryboard)) {
                const index = landingIndex(event, activeStoryboard);
                const from = draggedBeat.current;
                if (from) {
                  // The slot is a boundary in the original list; removing the
                  // dragged card shifts later insertion boundaries left by one.
                  reorderBeat(activeStoryboard, from.index, index > from.index ? index - 1 : index);
                } else {
                  const segment = segments.segments.find((segment) => segment.index === draggedSegment.current);
                  if (segment) insertSegment(activeStoryboard, segment, index);
                }
              }
              clearDrag();
            }}>
            {activeStoryboard.beats.map((beat, index) => {
              const segment = segments.segments.find((segment) => beatMatchesSegment(beat, segment))
                ?? segments.segments.find((segment) => beat.source?.filename === segment.source?.filename && beat.source?.offset === segment.source?.offset && beat.start < segment.end_time && beat.end > segment.start_time);
              return <Fragment key={`${activeStoryboard.id}-${index}-${beat.start}`}>
                {pasteSlot(index)}
                <div className="w-[224px] shrink-0" data-storyboard-index={index}
                draggable={!saving && !accepting}
                onDragStart={(event) => {
                  if ((event.target as HTMLElement).closest("textarea,input")) { event.preventDefault(); return; }
                  draggedBeat.current = { storyboardId: activeStoryboard.id, index };
                  draggedSegment.current = null;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-storyboard-beat", String(index));
                  const card = event.currentTarget.querySelector("article")!;
                  const rect = card.getBoundingClientRect();
                  event.dataTransfer.setDragImage(card, Math.max(0, event.clientX - rect.left), Math.max(0, event.clientY - rect.top));
                }} onDragEnd={clearDrag}>
                <StoryboardBeatCard beat={beat} segment={segment} index={index} disabled={saving || accepting !== null}
                  onSeek={() => onSeek?.(beat.start, beat.source)}
                  onNote={(note) => commitStoryboard(withBeats(activeStoryboard, activeStoryboard.beats.map((value, i) => i === index ? { ...value, fix_note: note } : value)))}
                  />
                </div>
              </Fragment>;
            })}
            {pasteSlot(activeStoryboard.beats.length)}
            <button disabled={saving || accepting !== null} onClick={() => setSegmentPickerOpen(true)}
              className="flex min-h-[348px] w-36 shrink-0 flex-col items-center justify-center gap-4 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              <Plus className="size-7" /><span>Add a storyboard segment</span>
            </button>
          </div>
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span>{reviews.loading ? "Loading hook review…" : activeReview ? `Hook ${activeReview.assessments.hook.score}/5 · Review ready` : "Review needed for this revision"}</span>
              {onOpenReview ? <button className="underline" onClick={() => onOpenReview(activeStoryboard.id)}>Virality Review</button> : <a className="underline" href={`/editing/${encodeURIComponent(filename)}?view=virality&storyboard=${encodeURIComponent(activeStoryboard.id)}`}>Virality Review</a>}
              {!activeReview && !reviews.loading && <button className="underline disabled:opacity-50" disabled={!!reviews.reviewing || saving || !!accepting} onClick={() => reviews.review(activeStoryboard.id)}>{reviews.reviewing ? "Reviewing…" : "Review storyboard"}</button>}
            </div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={addText && !!activeReview?.text.length} disabled={!activeReview?.text.length || saving || !!accepting} onChange={e => setAddText(e.target.checked)} />Add recommended on-screen text{activeReview ? ` (${activeReview.text.length})` : ""}</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={addBroll && !!activeReview?.broll.length} disabled={!activeReview?.broll.length || saving || !!accepting} onChange={e => setAddBroll(e.target.checked)} />Add recommended B-roll{activeReview ? ` (${activeReview.broll.length})` : ""}</label>
            <p className="text-[11px] text-muted-foreground">Optional additions based on this storyboard review. Text is separate from speech captions. Strong B-roll matches are placed over your original audio; unmatched windows stay as suggestions.</p>
            {reviews.error && <p role="alert" className="text-xs text-red-400">{reviews.error}</p>}
          </div>
          {activeEdit && <p className="text-xs text-muted-foreground">{adoptedIdea === activeStoryboard.id ? `This edit uses ${adoptedRevision ? `revision ${adoptedRevision}` : "its saved storyboard"}. You are viewing revision ${activeStoryboard.revision ?? 1}. Changes to this idea apply only to a new edit.` : "Browsing another idea. Your active timeline stays unchanged."}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {adoptedIdea === activeStoryboard.id && onReturnToEdit && <button className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground" onClick={onReturnToEdit}>Return to edit</button>}
            <button onClick={() => previewing ? stopPreview() : preview(activeStoryboard)} disabled={!onSeek}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50">
              {previewing ? <Square className="size-3" /> : <Play className="size-3" />}{previewing ? "Stop preview" : "Preview"}
            </button>
            <button disabled={accepting !== null || saving} onClick={() => accept(activeStoryboard)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-50 ${adoptedIdea === activeStoryboard.id ? "border border-border" : "bg-primary text-primary-foreground"}`}>
              {accepting && <Loader2 className="size-3 animate-spin" />}{accepting ? "Creating edit..." : activeEdit ? "Create new edit from this idea" : selectedAccepted ? "Create another edit" : "Use storyboard & edit"}
            </button>
            {selectedAccepted && (onOpenEdit ? <button onClick={() => void onOpenEdit(selectedAccepted).catch(e => setError(e.message))} className="text-xs underline">Open existing edit</button> : <a href={`/editing/${encodeURIComponent(selectedAccepted)}`} className="text-xs underline">Open existing edit</a>)}
          </div>
        </div>}
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
      </section>

      <section className="min-w-0 space-y-2 rounded-lg border border-border p-3 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button onClick={() => setTranscriptOpen((value) => !value)} aria-expanded={transcriptOpen} className="flex items-center gap-1 text-xs font-semibold uppercase">
            {transcriptOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}Transcript · {segments.segments.length} segments
          </button>
          <span className="rounded bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">{timingBadge}</span>
        </div>
        {segments.timing_note && <p className="text-[10px] text-amber-300">{segments.timing_note}</p>}
        {transcriptOpen && <div className="max-h-80 space-y-1 overflow-y-auto" aria-label="Transcript segments">
          {segments.segments.map((segment) => <div key={segment.index} className="group flex items-center gap-2 rounded-md hover:bg-muted/40"
            draggable={!saving && !accepting} onDragStart={(event) => {
              draggedSegment.current = segment.index;
              draggedBeat.current = null;
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("application/x-transcript-segment", String(segment.index));
              flushSync(() => setDragPreview(segment));
              if (dragPreviewElement.current) event.dataTransfer.setDragImage(dragPreviewElement.current, 112, 24);
            }} onDragEnd={clearDrag}>
            <button onClick={() => onSeek?.(segment.start_time, segment.source)} className="min-w-0 flex-1 px-2 py-2 text-left">
              <span className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className="font-mono text-muted-foreground">{fmtTime(segment.start_time - (segment.source?.offset ?? 0))}-{fmtTime(segment.end_time - (segment.source?.offset ?? 0))}</span>
                <span className={`rounded px-1.5 py-0.5 font-semibold uppercase ${ROLE_STYLES[segment.role]}`}>{segment.role}</span>
                {segment.hook_score >= 6 && <span className="text-amber-300">{segment.hook_score}/10</span>}
                <span className="text-muted-foreground">{segment.topic}</span>
                {segment.source && <span className="max-w-52 truncate text-emerald-300" title={segment.source.filename}>{segment.source.filename}</span>}
              </span>
              <span className="mt-1 block text-xs leading-relaxed">{segment.text || "No spoken audio"}</span>
            </button>
            {activeStoryboard && <button disabled={saving || accepting !== null || activeStoryboard.beats.some((beat) => beatMatchesSegment(beat, segment))}
              title="Add segment to selected idea" aria-label={`Add transcript segment ${segment.index + 1}`}
              onClick={() => insertSegment(activeStoryboard, segment)} className="mr-2 grid size-7 shrink-0 place-items-center rounded border border-border disabled:opacity-25"><Plus className="size-3" /></button>}
          </div>)}
        </div>}
      </section>
      <section className="min-w-0 rounded-lg border border-border lg:col-span-2">
        <button onClick={() => setFullTranscriptOpen((value) => !value)} aria-expanded={fullTranscriptOpen} className="flex w-full items-center justify-between px-3 py-3 text-xs font-semibold">
          Full transcript{fullTranscriptOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        {fullTranscriptOpen && <p className="max-h-96 overflow-y-auto whitespace-pre-wrap px-3 pb-3 text-xs leading-relaxed text-muted-foreground">{segments.full_transcript}</p>}
      </section>

      {dragPreview && <div ref={dragPreviewElement} aria-hidden="true" inert
        className="downloads-layout pointer-events-none fixed -left-[10000px] top-0 w-[224px] rounded-lg bg-background text-foreground">
        <StoryboardBeatCard beat={segmentToBeat(dragPreview)} segment={dragPreview} index={0} disabled
          onSeek={() => {}} onNote={() => {}} />
      </div>}

      <Dialog.Root open={segmentPickerOpen} onOpenChange={setSegmentPickerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content className="downloads-layout fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-4 text-foreground">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Dialog.Title className="text-sm font-semibold">Add transcript segment</Dialog.Title>
              <Dialog.Close aria-label="Close transcript segment picker" className="grid size-8 place-items-center rounded-md hover:bg-muted"><X className="size-4" /></Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Saved segments from the recording and included footage</Dialog.Description>
            <div className="space-y-1">
              {segments.segments.map((segment) => {
                const selected = activeStoryboard?.beats.some((beat) => beatMatchesSegment(beat, segment));
                return <button key={segment.index} disabled={selected || saving} onClick={() => activeStoryboard && insertSegment(activeStoryboard, segment)} className="w-full rounded-md p-2 text-left hover:bg-muted disabled:opacity-40">
                  <span className="block text-[10px] text-muted-foreground">{segment.source?.filename ? `${segment.source.filename} · ` : ""}{fmtTime(segment.start_time - (segment.source?.offset ?? 0))} · {segment.topic}{selected ? " · Added" : ""}</span>
                  <span className="mt-1 block text-xs">{segment.text || "No spoken audio"}</span>
                </button>;
              })}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
