"use client";

import { useState } from "react";
import type {
  Variation,
  VariationKind,
  Variations,
} from "@/lib/variations-schema";
import { formatCount } from "@/lib/utils";

const KIND_ORDER: VariationKind[] = ["hook", "pacing", "shot_swap", "caption"];

const KIND_LABELS: Record<VariationKind, { label: string; className: string }> =
  {
    hook: {
      label: "hook",
      className: "bg-primary/15 text-primary",
    },
    pacing: {
      label: "pacing",
      className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
    },
    shot_swap: {
      label: "shot swap",
      className: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    },
    caption: {
      label: "caption",
      className: "bg-green-500/15 text-green-600 dark:text-green-400",
    },
  };

// Fix notes go through /edit-notes, which caps a note at 500 characters
const MAX_NOTE = 2000;

// Applying a second suggestion to the same shot appends rather than
// clobbering the first; if the pair won't fit, the newest note wins
function mergeNote(existing: string, addition: string): string {
  if (!existing) return addition;
  if (existing.includes(addition)) return existing;
  const merged = `${existing}; ${addition}`;
  return merged.length > MAX_NOTE ? addition : merged;
}

interface Props {
  videoId: string;
  variations: Variations;
  editNotes: Record<string, string>;
  // True once clip matches exist — a render needs them
  canRender: boolean;
  rendering: boolean;
  onVariations: (v: Variations) => void;
  onEditNotes: (notes: Record<string, string>) => void;
  onRender: () => void;
}

export function VariationsPanel({
  videoId,
  variations,
  editNotes,
  canRender,
  rendering,
  onVariations,
  onEditNotes,
  onRender,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);

  const source = variations.source;
  const actionable = (v: Variation) =>
    v.fix_note != null && v.fix_note.length > 0 && v.shot_index != null;

  const setStatus = async (
    id: string,
    status: Variation["status"]
  ): Promise<boolean> => {
    const res = await fetch(`/api/analyze/${videoId}/variations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Updating the suggestion failed");
    onVariations(data);
    return true;
  };

  // Apply = write the ready-made fix note for the shot, then mark applied.
  // Advisory suggestions (no note) just flip status so the list stays honest.
  const apply = async (v: Variation) => {
    if (busyId) return;
    setBusyId(v.id);
    setError(null);
    try {
      if (actionable(v)) {
        const key = String(v.shot_index);
        const note = mergeNote(editNotes[key] || "", v.fix_note!);
        const res = await fetch(`/api/analyze/${videoId}/edit-notes`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shot_index: v.shot_index, note }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Saving the fix note failed");
        onEditNotes(data.notes || {});
      }
      await setStatus(v.id, "applied");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setBusyId(null);
    }
  };

  const move = async (v: Variation, status: Variation["status"]) => {
    if (busyId) return;
    setBusyId(v.id);
    setError(null);
    try {
      await setStatus(v.id, status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}/variations`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Regenerating failed");
      onVariations(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regenerating failed");
    } finally {
      setRegenerating(false);
    }
  };

  const copy = (id: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId((k) => (k === id ? null : k)), 1500);
      })
      .catch(() => alert("Copying failed"));
  };

  const active = variations.suggestions.filter((s) => s.status !== "dismissed");
  const dismissed = variations.suggestions.filter(
    (s) => s.status === "dismissed"
  );
  const appliedNotes = variations.suggestions.filter(
    (s) => s.status === "applied" && actionable(s)
  ).length;

  const stat = (label: string, value: string) => (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );

  const renderCard = (v: Variation) => {
    const kind = KIND_LABELS[v.kind];
    const busy = busyId === v.id;
    return (
      <div
        key={v.id}
        className={`rounded-md border p-2.5 flex flex-col gap-1.5 ${
          v.status === "applied"
            ? "border-green-500/50 bg-green-500/5"
            : v.status === "dismissed"
              ? "border-border opacity-60"
              : "border-border"
        }`}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${kind.className}`}
          >
            {kind.label}
          </span>
          {v.shot_index != null && (
            <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] font-mono">
              shot #{v.shot_index + 1}
            </span>
          )}
          {v.status === "applied" && (
            <span className="px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 text-[9px] font-semibold uppercase">
              ✓ applied
            </span>
          )}
          {!actionable(v) && v.status !== "applied" && (
            <span
              className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] uppercase"
              title="The renderer can't execute this one — it's advice for you to act on"
            >
              advisory
            </span>
          )}
        </div>
        <p className="text-sm font-medium text-foreground">{v.title}</p>
        <p className="text-[11px] text-muted-foreground leading-snug">
          {v.rationale}
        </p>
        {v.fix_note && (
          <p className="text-[10px] font-mono text-primary/90 leading-snug rounded bg-primary/5 px-1.5 py-1">
            ✎ {v.fix_note}
          </p>
        )}
        {v.text && (
          <p className="text-xs text-foreground/90 whitespace-pre-wrap border-l-2 border-primary/50 pl-2">
            {v.text}
          </p>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {v.status === "proposed" && (
            <button
              onClick={() => apply(v)}
              disabled={busy}
              className="px-2 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90 disabled:opacity-60"
              title={
                actionable(v)
                  ? "Write this as the shot's fix note"
                  : "Mark as done — nothing for the renderer to do"
              }
            >
              {busy ? "Applying…" : actionable(v) ? "Apply" : "Mark applied"}
            </button>
          )}
          {v.text && (
            <button
              onClick={() => copy(v.id, v.text!)}
              className="px-2 py-1 rounded-md border border-border text-[10px] font-semibold text-foreground hover:bg-muted/40"
            >
              {copiedId === v.id
                ? "✓ Copied"
                : v.kind === "caption"
                  ? "Copy caption"
                  : "Copy text"}
            </button>
          )}
          {v.status === "proposed" ? (
            <button
              onClick={() => move(v, "dismissed")}
              disabled={busy}
              className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              Dismiss
            </button>
          ) : (
            <button
              onClick={() => move(v, "proposed")}
              disabled={busy}
              className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              title={
                v.status === "applied"
                  ? "Marks it proposed again — the fix note stays until you clear it in the render tab"
                  : "Bring it back"
              }
            >
              {v.status === "applied" ? "Undo" : "Restore"}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-bold text-foreground uppercase tracking-wide">
          Alternate version · suggestions from the stats
        </p>
        <p className="text-[10px] text-muted-foreground">
          {variations.model} ·{" "}
          {new Date(variations.generatedAt).toLocaleString()}
        </p>
      </div>

      <div className="rounded-md border border-border p-2.5 flex flex-col gap-1.5">
        <p className="text-[11px] text-foreground truncate">
          {source.shareUrl ? (
            <a
              href={source.shareUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary"
            >
              {source.title || "(untitled post)"}
            </a>
          ) : (
            source.title || "(untitled post)"
          )}
        </p>
        <div className="flex items-center gap-4 flex-wrap">
          {stat("views", formatCount(source.viewCount))}
          {stat("likes", formatCount(source.likeCount))}
          {stat("comments", formatCount(source.commentCount))}
          {stat("shares", formatCount(source.shareCount))}
          {stat(
            "completion",
            source.completionRate != null
              ? `${source.completionRate.toFixed(1)}%`
              : "—"
          )}
          {source.benchmark && source.benchmark.medianViews > 0 &&
            stat(
              "vs account median",
              `${(source.viewCount / source.benchmark.medianViews).toFixed(1)}× views`
            )}
        </div>
        {source.completionRate == null && (
          <p className="text-[10px] text-muted-foreground">
            No completion rate yet — run &ldquo;Sync TikHub&rdquo; on the
            analytics page and regenerate for pacing advice grounded in
            watch time.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={regenerate}
          disabled={regenerating}
          className="px-3 py-1.5 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-xs"
        >
          {regenerating ? "Thinking…" : "Regenerate suggestions"}
        </button>
        {canRender && appliedNotes > 0 && (
          <button
            onClick={onRender}
            disabled={rendering}
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
          >
            {rendering
              ? "Rendering…"
              : `Render with ${appliedNotes} applied fix${appliedNotes === 1 ? "" : "es"}`}
          </button>
        )}
        {!canRender && appliedNotes > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Match library clips first, then render to see the fixes applied.
          </p>
        )}
        <p className="text-[10px] text-muted-foreground">
          &ldquo;Apply&rdquo; writes the shot&apos;s fix note; advisory items
          are for you to act on (copy the text, edit the shot&apos;s overlay).
          Regenerating replaces every suggestion.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2">
          <p className="text-[11px] text-red-500 break-words">{error}</p>
        </div>
      )}

      {KIND_ORDER.map((kind) => {
        const items = active.filter((s) => s.kind === kind);
        if (items.length === 0) return null;
        return (
          <div key={kind} className="flex flex-col gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {KIND_LABELS[kind].label}
            </p>
            {items.map(renderCard)}
          </div>
        );
      })}

      {active.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Every suggestion is dismissed — regenerate for a fresh set.
        </p>
      )}

      {dismissed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className="self-start text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showDismissed ? "Hide" : "Show"} {dismissed.length} dismissed
          </button>
          {showDismissed && dismissed.map(renderCard)}
        </div>
      )}
    </div>
  );
}
