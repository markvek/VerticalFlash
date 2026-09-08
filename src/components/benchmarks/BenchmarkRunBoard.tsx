"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ClipboardCheck, Eye, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  benchmarkProviderLabel,
  benchmarkStageLabel,
  type BenchmarkRun,
} from "@/lib/benchmark-schema";
import type { DownloadEntry } from "@/lib/download-types";
import { projectHref } from "@/lib/project-navigation";

interface BenchmarkRunBoardProps {
  runId: string;
}

function durationFor(file: DownloadEntry): number | null {
  if (file.render?.durationSeconds != null) return file.render.durationSeconds;
  if (file.meta?.duration) return file.meta.duration;
  if (file.project?.kind === "music" || file.project?.kind === "prompt") {
    return file.project.targetDuration;
  }
  if (file.project?.kind === "cutdown") return file.project.targetDuration;
  return null;
}

function scoreText(value: number | null): string {
  return value == null ? "Pending" : `${value.toFixed(1)}`;
}

export function BenchmarkRunBoard({ runId }: BenchmarkRunBoardProps) {
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [draftOutputs, setDraftOutputs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [runResponse, downloadsResponse] = await Promise.all([
        fetch(`/api/benchmarks/${encodeURIComponent(runId)}`, { cache: "no-store" }),
        fetch("/api/downloads", { cache: "no-store" }),
      ]);
      const runData = await runResponse.json();
      const downloadsData = await downloadsResponse.json();
      if (!runResponse.ok) throw new Error(runData.error || "Could not load benchmark");
      if (!downloadsResponse.ok) throw new Error(downloadsData.error || "Could not load projects");
      setRun(runData.run);
      setDownloads(downloadsData.files ?? []);
      setDraftOutputs(
        Object.fromEntries(
          runData.run.variants.map((variant: BenchmarkRun["variants"][number]) => [
            variant.id,
            variant.output?.filename ?? "",
          ])
        )
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load benchmark");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  const downloadsByName = useMemo(
    () => new Map(downloads.map((file) => [file.name, file])),
    [downloads]
  );
  const readyCount = run?.variants.filter((variant) => variant.status === "ready").length ?? 0;

  const assignOutput = async (variantId: string) => {
    if (!run) return;
    const filename = draftOutputs[variantId] ?? "";
    const file = filename ? downloadsByName.get(filename) : null;
    setSaving(variantId);
    setError(null);
    try {
      const response = await fetch(`/api/benchmarks/${encodeURIComponent(run.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "assign_output",
          variantId,
          output: file
            ? {
                filename: file.name,
                videoId: file.videoId,
                displayName: file.displayName,
              }
            : null,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save output");
      setRun(data.run);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save output");
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading benchmark...</div>;
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
    <div className="mx-auto min-h-screen w-full max-w-6xl space-y-8 px-5 py-8 text-foreground sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/benchmarks"><ArrowLeft className="size-4" aria-hidden="true" />Benchmarks</Link>
          </Button>
          <h1 className="text-3xl font-semibold tracking-tight">{run.title}</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Source fixture: {run.source.displayName}. Stages: {run.stages.map(benchmarkStageLabel).join(", ")}.
          </p>
        </div>
        {readyCount === 0 ? (
          <Button disabled size="lg">
            <ClipboardCheck className="size-4" aria-hidden="true" />
            Blind judge
          </Button>
        ) : (
          <Button asChild size="lg">
            <Link href={`/benchmarks/${encodeURIComponent(run.id)}/judge`}>
              <ClipboardCheck className="size-4" aria-hidden="true" />
              Blind judge
            </Link>
          </Button>
        )}
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <article className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-semibold">Locked input</h2>
          <video
            className="mt-4 aspect-[9/16] w-full rounded-md bg-black"
            src={`/api/downloads/${encodeURIComponent(run.source.filename)}`}
            controls
            preload="metadata"
          />
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">File</dt>
              <dd className="truncate text-right">{run.source.filename}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{run.source.durationSeconds == null ? "Unknown" : `${Math.round(run.source.durationSeconds)}s`}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Reviews</dt>
              <dd>{run.humanReviews.length}</dd>
            </div>
          </dl>
        </article>

        <section aria-label="Provider outputs" className="grid gap-4 md:grid-cols-2">
          {run.variants.map((variant) => {
            const selected = draftOutputs[variant.id] ?? "";
            const assigned = selected ? downloadsByName.get(selected) : null;
            return (
              <article key={variant.id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{variant.blindLabel}</div>
                    <h2 className="mt-1 text-lg font-semibold">{benchmarkProviderLabel(variant.provider)}</h2>
                  </div>
                  <span className="rounded-full border border-border px-2 py-1 text-xs capitalize text-muted-foreground">{variant.status}</span>
                </div>

                <label className="mt-4 block space-y-2 text-sm">
                  <span className="font-medium">Output project</span>
                  <select
                    value={selected}
                    onChange={(event) =>
                      setDraftOutputs((current) => ({ ...current, [variant.id]: event.target.value }))
                    }
                    className="h-10 w-full rounded-md border border-border bg-background px-3 outline-none focus:border-primary"
                  >
                    <option value="">Waiting for provider output</option>
                    {downloads.map((file) => (
                      <option key={file.name} value={file.name}>
                        {file.displayName} · {file.name}
                      </option>
                    ))}
                  </select>
                </label>

                {assigned && (
                  <div className="mt-4 space-y-3">
                    <video
                      className="aspect-[9/16] max-h-[360px] w-full rounded-md bg-black object-contain"
                      src={`/api/downloads/${encodeURIComponent(assigned.name)}`}
                      controls
                      preload="metadata"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button asChild variant="outline" size="sm">
                        <Link href={projectHref(assigned)}><Eye className="size-4" aria-hidden="true" />Open project</Link>
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {durationFor(assigned) == null ? "Duration unknown" : `${Math.round(durationFor(assigned)!)}s`}
                      </span>
                    </div>
                  </div>
                )}

                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-md border border-border p-2">
                    <div className="text-muted-foreground">Technical</div>
                    <div className="mt-1 font-semibold">{scoreText(variant.technicalScore)}</div>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <div className="text-muted-foreground">AI judge</div>
                    <div className="mt-1 font-semibold">{scoreText(variant.aiJudgeScore)}</div>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <div className="text-muted-foreground">Human</div>
                    <div className="mt-1 font-semibold">{scoreText(variant.humanScore)}</div>
                  </div>
                </div>

                <Button
                  onClick={() => assignOutput(variant.id)}
                  disabled={saving === variant.id}
                  className="mt-4 w-full"
                  variant="outline"
                >
                  <Save className="size-4" aria-hidden="true" />
                  {saving === variant.id ? "Saving..." : "Save output"}
                </Button>
              </article>
            );
          })}
        </section>
      </section>
    </div>
  );
}
