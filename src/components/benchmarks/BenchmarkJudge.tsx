"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  HUMAN_SCORE_METRICS,
  benchmarkProviderLabel,
  type BenchmarkRun,
  type HumanScoreMetric,
} from "@/lib/benchmark-schema";

interface BenchmarkJudgeProps {
  runId: string;
}

const METRIC_LABELS: Record<HumanScoreMetric, string> = {
  hook: "Hook",
  pacing: "Pacing",
  clarity: "Clarity",
  polish: "Polish",
  broll_fit: "B-roll fit",
};

type Scores = Record<HumanScoreMetric, number>;

function defaultScores(): Scores {
  return Object.fromEntries(
    HUMAN_SCORE_METRICS.map((metric) => [metric, 7])
  ) as Scores;
}

function scoreSummary(scores: Scores, wouldPost: boolean): string {
  const values = Object.values(scores);
  const average = values.reduce((sum, score) => sum + score, 0) / values.length;
  const normalized = average * 10 + (wouldPost ? 5 : 0);
  return `${Math.round(normalized * 10) / 10}`;
}

export function BenchmarkJudge({ runId }: BenchmarkJudgeProps) {
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [ratings, setRatings] = useState<Record<string, Scores>>({});
  const [wouldPost, setWouldPost] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [winnerVariantId, setWinnerVariantId] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/benchmarks/${encodeURIComponent(runId)}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load benchmark");
      setRun(data.run);
      const ready = data.run.variants.filter(
        (variant: BenchmarkRun["variants"][number]) => variant.status === "ready"
      );
      setRatings((current) => ({
        ...Object.fromEntries(ready.map((variant: BenchmarkRun["variants"][number]) => [variant.id, defaultScores()])),
        ...current,
      }));
      setWouldPost((current) => ({
        ...Object.fromEntries(ready.map((variant: BenchmarkRun["variants"][number]) => [variant.id, false])),
        ...current,
      }));
      setNotes((current) => ({
        ...Object.fromEntries(ready.map((variant: BenchmarkRun["variants"][number]) => [variant.id, ""])),
        ...current,
      }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load benchmark");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  const readyVariants = useMemo(
    () => run?.variants.filter((variant) => variant.status === "ready" && variant.output) ?? [],
    [run]
  );

  const setScore = (variantId: string, metric: HumanScoreMetric, value: number) => {
    setRatings((current) => ({
      ...current,
      [variantId]: {
        ...(current[variantId] ?? defaultScores()),
        [metric]: value,
      },
    }));
  };

  const submit = async () => {
    if (!run || readyVariants.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/benchmarks/${encodeURIComponent(run.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          reviewer,
          winnerVariantId,
          reviews: readyVariants.map((variant) => ({
            variantId: variant.id,
            scores: ratings[variant.id] ?? defaultScores(),
            wouldPost: wouldPost[variant.id] ?? false,
            notes: notes[variant.id] ?? "",
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not submit review");
      setRun(data.run);
      setRevealed(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not submit review");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading review...</div>;
  }

  if (!run) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-destructive">{error ?? "Benchmark not found"}</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/benchmarks"><ArrowLeft className="size-4" aria-hidden="true" />Benchmarks</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-7xl space-y-8 px-5 py-8 text-foreground sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href={`/benchmarks/${encodeURIComponent(run.id)}`}>
              <ArrowLeft className="size-4" aria-hidden="true" />
              Run
            </Link>
          </Button>
          <h1 className="text-3xl font-semibold tracking-tight">Blind review</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {run.title}. Provider names are hidden until reveal.
          </p>
        </div>
        <Button onClick={() => setRevealed((value) => !value)} variant="outline" size="sm">
          <Eye className="size-4" aria-hidden="true" />
          {revealed ? "Hide providers" : "Reveal providers"}
        </Button>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {readyVariants.length === 0 ? (
        <section className="rounded-lg border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">Assign at least one provider output before starting a blind review.</p>
        </section>
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-2">
            {readyVariants.map((variant) => {
              const scores = ratings[variant.id] ?? defaultScores();
              return (
                <article key={variant.id} className="rounded-lg border border-border bg-card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{variant.blindLabel}</div>
                      <h2 className="mt-1 text-lg font-semibold">
                        {revealed ? benchmarkProviderLabel(variant.provider) : variant.blindLabel}
                      </h2>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        checked={winnerVariantId === variant.id}
                        onChange={() => setWinnerVariantId(variant.id)}
                      />
                      Winner
                    </label>
                  </div>

                  <video
                    className="mt-4 aspect-[9/16] max-h-[520px] w-full rounded-md bg-black object-contain"
                    src={`/api/downloads/${encodeURIComponent(variant.output!.filename)}`}
                    controls
                    preload="metadata"
                  />

                  <div className="mt-5 grid gap-3">
                    {HUMAN_SCORE_METRICS.map((metric) => (
                      <label key={metric} className="grid grid-cols-[96px_1fr_28px] items-center gap-3 text-sm">
                        <span className="font-medium">{METRIC_LABELS[metric]}</span>
                        <input
                          type="range"
                          min={1}
                          max={10}
                          value={scores[metric]}
                          onChange={(event) => setScore(variant.id, metric, Number(event.target.value))}
                        />
                        <span className="text-right tabular-nums text-muted-foreground">{scores[metric]}</span>
                      </label>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={wouldPost[variant.id] ?? false}
                        onChange={(event) =>
                          setWouldPost((current) => ({ ...current, [variant.id]: event.target.checked }))
                        }
                      />
                      Would post
                    </label>
                    <div className="text-sm text-muted-foreground">Score {scoreSummary(scores, wouldPost[variant.id] ?? false)}</div>
                  </div>

                  <label className="mt-4 block space-y-2 text-sm">
                    <span className="font-medium">Notes</span>
                    <textarea
                      value={notes[variant.id] ?? ""}
                      onChange={(event) =>
                        setNotes((current) => ({ ...current, [variant.id]: event.target.value }))
                      }
                      rows={3}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 outline-none focus:border-primary"
                    />
                  </label>
                </article>
              );
            })}
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block space-y-2 text-sm">
                <span className="font-medium">Reviewer</span>
                <input
                  value={reviewer}
                  onChange={(event) => setReviewer(event.target.value)}
                  placeholder="Reviewer"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 outline-none focus:border-primary"
                />
              </label>
              <Button onClick={submit} disabled={submitting} size="lg">
                <Send className="size-4" aria-hidden="true" />
                {submitting ? "Submitting..." : "Submit review"}
              </Button>
            </div>
          </section>

          {revealed && (
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="font-semibold">Provider reveal</h2>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {readyVariants.map((variant) => (
                  <div key={variant.id} className="rounded-md border border-border p-3 text-sm">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{variant.blindLabel}</div>
                    <div className="mt-1 font-semibold">{benchmarkProviderLabel(variant.provider)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Human {variant.humanScore == null ? "Pending" : variant.humanScore.toFixed(1)}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
