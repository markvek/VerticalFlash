"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { BenchmarkRun } from "@/lib/benchmark-schema";

export function StoryboardBenchmarkResults({
  initial,
}: {
  initial: BenchmarkRun;
}) {
  const [run, setRun] = useState(initial);
  const [blind, setBlind] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const active = !["complete", "failed"].includes(run.execution!.status);
  useEffect(() => {
    if (!active) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch(`/api/benchmarks/${run.id}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(data.error || "Could not refresh benchmark");
        if (!canceled) {
          setRun(data.run);
          setError(null);
        }
      } catch (e) {
        if (!canceled)
          setError(e instanceof Error ? e.message : "Refresh failed");
      }
      if (!canceled) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [active, run.id]);
  const retry = async () => {
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/benchmarks/${run.id}/retry`, {
        method: "POST",
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setRun(data.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setWorking(false);
    }
  };
  const fork = async (filename: string) => {
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/downloads/${encodeURIComponent(filename)}/fork`,
        { method: "POST" },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      window.location.href = `/editing/${encodeURIComponent(data.filename)}`;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create editing copy",
      );
      setWorking(false);
    }
  };
  const completed = run.variants.filter((v) => v.status === "ready").length;
  const aiReview = run.aiReviews.at(-1) ?? null;
  const aiByVariant = new Map(
    (aiReview?.reviews ?? []).map((r) => [r.variantId, r]),
  );
  return (
    <main className="mx-auto max-w-7xl p-6 space-y-6">
      <Link href="/benchmarks" className="text-sm text-muted-foreground">
        ← Benchmarks
      </Link>
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{run.title}</h1>
          <p className="text-sm text-muted-foreground">
            {completed}/4 versions ready · {run.execution!.status}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm">
            <input
              type="checkbox"
              checked={blind}
              onChange={(e) => setBlind(e.target.checked)}
            />{" "}
            Blind labels
          </label>
          {!active && completed > 0 && (
            <Link
              className="rounded bg-primary px-3 py-2 text-primary-foreground text-sm"
              href={`/benchmarks/${run.id}/judge`}
            >
              Score results
            </Link>
          )}
        </div>
      </header>
      <section className="rounded-lg border p-4 space-y-2 text-sm">
        <p className="font-medium">Same setup for every model</p>
        <p>
          {run.execution!.input.request.brief ||
            "Choose the strongest story from the footage."}
        </p>
        <p className="text-muted-foreground">
          {run.execution!.input.request.lengths[0]} seconds ·{" "}
          {run.execution!.input.request.pacing} pacing ·{" "}
          {run.execution!.input.clips.length} core clips ·{" "}
          {run.execution!.input.request.allow_broll
            ? `${run.execution!.input.brollClips.length} B-roll clips`
            : "B-roll off"}
        </p>
        <p className="text-xs text-muted-foreground">
          Shared transcript preparation
          {run.execution!.preparationModel
            ? `: ${run.execution!.preparationModel}`
            : " runs once"}
          . Models independently choose their storyboard and B-roll. Sampled
          B-roll frames guide moment selection.
        </p>
      </section>
      {(error || run.execution!.error) && (
        <p role="alert" className="text-destructive">
          {error || run.execution!.error}
        </p>
      )}
      {!active && completed < 4 && !run.humanReviews.length && (
        <button
          disabled={working}
          className="rounded border px-3 py-2 text-sm"
          onClick={retry}
        >
          {working ? "Resuming…" : "Retry unfinished versions"}
        </button>
      )}
      <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {run.variants.map((v) => (
          <article
            key={v.id}
            className="min-w-0 rounded-xl border p-4 space-y-3"
          >
            <h2 className="font-semibold">{v.blindLabel}</h2>
            {!blind && (
              <p className="text-xs text-muted-foreground">
                {v.provider} · {v.model}
              </p>
            )}
            <p className="text-sm capitalize">
              {v.artifact?.stage || v.status}
            </p>
            {aiByVariant.has(v.id) && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
                <p className="flex items-center justify-between font-medium">
                  <span>
                    AI virality
                    {aiReview?.winnerVariantId === v.id && (
                      <span className="ml-1 rounded bg-primary px-1 text-primary-foreground">
                        top pick
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    {Math.round(aiByVariant.get(v.id)!.virality)}/100
                  </span>
                </p>
                <p className="mt-1 text-muted-foreground">
                  {aiByVariant.get(v.id)!.rationale}
                </p>
              </div>
            )}
            {v.status === "ready" && (
              <video
                controls
                preload="metadata"
                className="aspect-[9/16] w-full rounded bg-black"
                src={`/api/benchmarks/${run.id}/preview/${v.id}`}
              />
            )}
            {v.error && (
              <p role="alert" className="text-sm text-destructive">
                {blind
                  ? "This version failed. Reveal model labels to see the error, or retry unfinished versions."
                  : v.error}
              </p>
            )}
            {v.artifact?.storyboard && (
              <>
                <h3 className="text-sm font-medium">
                  {v.artifact.storyboard.title}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {v.artifact.storyboard.angle}
                </p>
                <ol className="space-y-3">
                  {v.artifact.storyboard.beats.map((b, i) => {
                    const d = v.artifact?.broll?.find((d) => d.beat === i);
                    return (
                      <li key={i} className="border-t pt-2 text-xs space-y-1">
                        <p className="font-medium capitalize">
                          {b.section} · {b.start.toFixed(1)}–{b.end.toFixed(1)}s
                          source
                        </p>
                        <p>{b.text}</p>
                        {d && (
                          <div className="rounded bg-muted p-2">
                            <p>
                              {d.filename
                                ? `B-roll: ${d.filename} · ${d.clipStart?.toFixed(1)}s`
                                : "Source footage — no suitable B-roll"}
                            </p>
                            <p className="mt-1 text-muted-foreground">
                              {d.reason}
                            </p>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
            {v.status === "ready" && v.output && (
              <button
                disabled={working}
                onClick={() => fork(v.output!.filename)}
                className="w-full rounded border py-2 text-sm"
              >
                Edit a copy
              </button>
            )}
            {!blind && v.artifact?.elapsedMs != null && (
              <p className="text-xs text-muted-foreground">
                {Math.round(v.artifact.elapsedMs / 1000)}s processing ·{" "}
                {v.artifact.usage
                  ?.reduce(
                    (n, u) => n + (u.promptTokens ?? 0) + (u.outputTokens ?? 0),
                    0,
                  )
                  .toLocaleString()}{" "}
                tokens
              </p>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
