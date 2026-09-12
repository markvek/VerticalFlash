"use client";

import { useEffect, useRef, useState } from "react";
import { GEMINI_OMNI_VIDEO_OUT_PER_SEC } from "@/lib/gemini-pricing";

// Mirrors ShotGenerationsZ in src/lib/generation-schema.ts (kept local so
// the client bundle doesn't pull the schema module's @google/genai import)
export interface GenerationAttempt {
  attempt: number;
  kind: "generate" | "extend";
  prompt: string;
  source_clip: string | null;
  reference_files: string[];
  file: string | null;
  duration: number | null;
  interaction_id: string | null;
  status: "ready" | "failed";
  error: string | null;
  video_seconds: number | null;
  model: string;
  createdAt: string;
}

export interface ShotGeneration {
  shot_index: number;
  prompt: string;
  prompt_source: "gemini" | "user";
  status: "idle" | "generating" | "ready" | "failed";
  startedAt?: string | null;
  accepted_file: string | null;
  attempts: GenerationAttempt[];
}

export interface ShotGenerations {
  videoId: string;
  updatedAt: string;
  promptsGeneratedAt: string | null;
  promptModel: string | null;
  shots: Record<string, ShotGeneration>;
}

export interface GenerationPanelProps {
  videoId: string;
  shotIndex: number;
  shotDuration: number;
  /** True when the render would hit a gap here (no clip / clip too short) */
  gap: boolean;
  generation: ShotGenerations | null;
  /** The shot's confirmed clip, for the Extend action */
  selectedRec: { filename: string; duration: number | null } | null;
  onGeneration: (g: ShotGenerations) => void;
  onAccept: (g: ShotGenerations, recs: unknown) => void;
}

const isGeneratedClip = (f: string) => /^gen_s\d+_a\d+\.mp4$/.test(f);

function costLine(attempt: GenerationAttempt): string | null {
  if (attempt.video_seconds == null) return null;
  const secs = attempt.video_seconds.toFixed(1);
  if (GEMINI_OMNI_VIDEO_OUT_PER_SEC == null) {
    return `${secs}s generated · pricing not configured`;
  }
  return `${secs}s · ~$${(
    attempt.video_seconds * GEMINI_OMNI_VIDEO_OUT_PER_SEC
  ).toFixed(2)}`;
}

// Per-shot AI clip generation: draft/edit the prompt, generate a fresh clip
// (with real product footage as character references) or extend a too-short
// selected clip, preview the attempts, and accept one as the shot's clip.
export function GenerationPanel({
  videoId,
  shotIndex,
  shotDuration,
  gap,
  generation,
  selectedRec,
  onGeneration,
  onAccept,
}: GenerationPanelProps) {
  const entry = generation?.shots[String(shotIndex)] ?? null;
  const [draft, setDraft] = useState(entry?.prompt ?? "");
  const [useReferences, setUseReferences] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState<"generate" | "extend" | "accept" | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const autoDrafted = useRef(false);

  // Sync the textarea when the shot changes or a draft arrives from the server
  const promptKey = `${shotIndex}:${entry?.prompt ?? ""}`;
  const lastPromptKey = useRef(promptKey);
  useEffect(() => {
    if (lastPromptKey.current !== promptKey) {
      lastPromptKey.current = promptKey;
      setDraft(entry?.prompt ?? "");
      setError(null);
    }
  }, [promptKey, entry?.prompt]);

  // First open with no prompts on disk: draft them all in one batch call
  useEffect(() => {
    if (!generation || generation.promptsGeneratedAt || autoDrafted.current) {
      return;
    }
    autoDrafted.current = true;
    setDrafting(true);
    fetch(`/api/analyze/${videoId}/generation/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Prompt drafting failed");
        onGeneration(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Draft failed"))
      .finally(() => setDrafting(false));
  }, [generation, videoId, onGeneration]);

  const savePrompt = async () => {
    const trimmed = draft.trim();
    if (trimmed === (entry?.prompt ?? "")) return;
    try {
      const res = await fetch(`/api/analyze/${videoId}/generation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shot_index: shotIndex, prompt: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      onGeneration(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  const redraft = async () => {
    setDrafting(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}/generation/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shot_index: shotIndex, force: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-draft failed");
      onGeneration(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-draft failed");
    } finally {
      setDrafting(false);
    }
  };

  const runAction = async (
    kind: "generate" | "extend",
    body: Record<string, unknown>
  ) => {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(
        `/api/analyze/${videoId}/generation/${kind}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        const retry = data.retryAfterMs
          ? ` — retry in ${Math.ceil(data.retryAfterMs / 1000)}s`
          : "";
        throw new Error(`${data.error || `${kind} failed`}${retry}`);
      }
      onGeneration(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  const accept = async (attemptNumber: number) => {
    setBusy("accept");
    setError(null);
    try {
      const res = await fetch(
        `/api/analyze/${videoId}/generation/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shot_index: shotIndex, attempt: attemptNumber }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Accept failed");
      onAccept(data.generation, data.recommendations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accept failed");
    } finally {
      setBusy(null);
    }
  };

  const generating = busy != null || entry?.status === "generating";
  // "In use" = this attempt's file is the shot's actual confirmed selection
  // (accepted_file alone can outlive a cleared selection)
  const inUse = (file: string | null) =>
    file != null &&
    file === entry?.accepted_file &&
    selectedRec?.filename === file;
  const canExtend =
    selectedRec != null &&
    !isGeneratedClip(selectedRec.filename) &&
    selectedRec.duration != null &&
    selectedRec.duration < shotDuration - 0.1;
  const attempts = [...(entry?.attempts ?? [])].reverse();

  return (
    <div className="rounded-md border border-violet-500/40 p-2 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-bold text-foreground uppercase tracking-wide">
          ⚡ AI clip for shot #{shotIndex + 1}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {entry?.prompt_source === "user" && (
            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-primary/15 text-primary">
              edited
            </span>
          )}
          <button
            onClick={redraft}
            disabled={drafting || generating}
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {drafting ? "drafting…" : "↺ re-draft prompt"}
          </button>
        </div>
      </div>

      {gap && (
        <p className="text-[10px] text-yellow-700 dark:text-yellow-400">
          No library clip covers this {shotDuration.toFixed(1)}s shot — generate
          one, or extend the selected clip.
        </p>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={savePrompt}
        disabled={drafting || generating}
        rows={4}
        maxLength={4000}
        aria-label={`Generation prompt for shot ${shotIndex + 1}`}
        placeholder={
          drafting
            ? "Drafting a prompt from the shot analysis…"
            : "Describe the clip to generate (a draft appears here after the analysis)"
        }
        className="w-full text-xs rounded-md border border-border bg-transparent p-1.5 outline-none focus:border-primary resize-y disabled:opacity-60"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() =>
            runAction("generate", {
              shot_index: shotIndex,
              use_references: useReferences,
              prompt: draft.trim(),
            })
          }
          disabled={generating || drafting || !draft.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-60"
        >
          {busy === "generate" ? "Generating…" : "⚡ Generate clip"}
        </button>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useReferences}
            disabled={generating}
            onChange={(e) => setUseReferences(e.target.checked)}
            className="accent-current"
          />
          use product reference clips
        </label>
        {canExtend && (
          <button
            onClick={() =>
              runAction("extend", {
                shot_index: shotIndex,
                filename: selectedRec!.filename,
              })
            }
            disabled={generating || drafting}
            title={`Continue ${selectedRec!.filename} (${selectedRec!.duration!.toFixed(1)}s) so it covers the ${shotDuration.toFixed(1)}s shot`}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-violet-500/60 text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 disabled:opacity-60"
          >
            {busy === "extend"
              ? "Extending…"
              : `⇥ Extend ${selectedRec!.filename}`}
          </button>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Generate and Extend call the paid Gemini video model. Set
        GENAI_VIDEO_DRY_RUN=1 in .env.local to test the flow for free.
      </p>

      {(busy === "generate" ||
        busy === "extend" ||
        entry?.status === "generating") && (
        <p className="text-[11px] font-semibold text-violet-600 dark:text-violet-400 animate-pulse">
          Generating with {entry?.attempts.length ? "Omni" : "Gemini Omni"} —
          this can take a few minutes…
        </p>
      )}

      {error && (
        <p className="text-[11px] text-red-500 break-words">⚠ {error}</p>
      )}

      {attempts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {attempts.map((a) => (
            <div
              key={a.attempt}
              className={`flex gap-2 items-start rounded-md border p-2 ${
                inUse(a.file) ? "border-green-500/60" : "border-border"
              }`}
            >
              {a.status === "ready" && a.file ? (
                <div className="rounded overflow-hidden border border-border bg-black aspect-[9/16] w-[90px] shrink-0">
                  <video
                    controls
                    muted
                    preload="metadata"
                    className="w-full h-full object-contain"
                  >
                    <source
                      src={`/api/generated/${videoId}/${encodeURIComponent(a.file)}`}
                      type="video/mp4"
                    />
                  </video>
                </div>
              ) : (
                <div className="h-16 w-12 rounded bg-red-500/10 shrink-0 flex items-center justify-center text-[9px] text-red-500">
                  failed
                </div>
              )}
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <p className="text-xs font-medium text-foreground">
                  Attempt {a.attempt} ·{" "}
                  {a.kind === "extend"
                    ? `extended ${a.source_clip ?? "clip"}`
                    : "generated"}
                  {a.duration != null && (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      · {a.duration.toFixed(1)}s
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-1 flex-wrap">
                  {inUse(a.file) && (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-green-500/15 text-green-600 dark:text-green-400">
                      ✓ in use
                    </span>
                  )}
                  {a.reference_files.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px]">
                      {a.reference_files.length} ref
                      {a.reference_files.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {costLine(a) && (
                    <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] font-mono">
                      {costLine(a)}
                    </span>
                  )}
                </div>
                {a.error && (
                  <p className="text-[10px] text-red-500 leading-snug break-words">
                    {a.error}
                  </p>
                )}
                {a.status === "ready" && a.file && !inUse(a.file) && (
                  <button
                    onClick={() => accept(a.attempt)}
                    disabled={busy != null}
                    className="self-start px-2 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-semibold disabled:opacity-60"
                  >
                    {busy === "accept" ? "Saving…" : "Use this clip"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
