"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, ClipboardCheck, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  BenchmarkProvider,
  BenchmarkRun,
  BenchmarkStage,
} from "@/lib/benchmark-schema";
import type { DownloadEntry } from "@/lib/download-types";

interface Option<T extends string> {
  id: T;
  label: string;
  modelLabel?: string;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

export function BenchmarkDashboard() {
  const router = useRouter();
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [providerOptions, setProviderOptions] = useState<Option<BenchmarkProvider>[]>([]);
  const [stageOptions, setStageOptions] = useState<Option<BenchmarkStage>[]>([]);
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<BenchmarkProvider[]>([]);
  const [selectedStages, setSelectedStages] = useState<BenchmarkStage[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [benchmarksResponse, downloadsResponse] = await Promise.all([
        fetch("/api/benchmarks", { cache: "no-store" }),
        fetch("/api/downloads", { cache: "no-store" }),
      ]);
      const benchmarksData = await benchmarksResponse.json();
      const downloadsData = await downloadsResponse.json();
      if (!benchmarksResponse.ok) {
        throw new Error(benchmarksData.error || "Could not load benchmarks");
      }
      if (!downloadsResponse.ok) {
        throw new Error(downloadsData.error || "Could not load projects");
      }
      setRuns(benchmarksData.runs ?? []);
      setProviderOptions(benchmarksData.providerOptions ?? []);
      setStageOptions(benchmarksData.stageOptions ?? []);
      setDownloads(downloadsData.files ?? []);
      setSelectedProviders((current) => current.length ? current : (benchmarksData.providerOptions ?? []).map((option: Option<BenchmarkProvider>) => option.id));
      setSelectedStages((current) => current.length ? current : (benchmarksData.stageOptions ?? []).map((option: Option<BenchmarkStage>) => option.id));
      setSelectedFile((current) => current || downloadsData.files?.[0]?.name || "");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load benchmarks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectedDownload = useMemo(
    () => downloads.find((file) => file.name === selectedFile) ?? null,
    [downloads, selectedFile]
  );

  const toggleProvider = (provider: BenchmarkProvider) => {
    setSelectedProviders((current) =>
      current.includes(provider)
        ? current.filter((entry) => entry !== provider)
        : [...current, provider]
    );
  };

  const toggleStage = (stage: BenchmarkStage) => {
    setSelectedStages((current) =>
      current.includes(stage)
        ? current.filter((entry) => entry !== stage)
        : [...current, stage]
    );
  };

  const createRun = async () => {
    if (!selectedDownload) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          providers: selectedProviders,
          stages: selectedStages,
          source: {
            filename: selectedDownload.name,
            videoId: selectedDownload.videoId,
            displayName: selectedDownload.displayName,
            durationSeconds: durationFor(selectedDownload),
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create benchmark");
      router.push(`/benchmarks/${encodeURIComponent(data.run.id)}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create benchmark");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl space-y-8 px-5 py-8 text-foreground sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BarChart3 className="size-4" aria-hidden="true" />
            Benchmark Lab
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">AI editing benchmarks</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Lock a source project, compare provider outputs, and collect blind human ratings before revealing the model names.
          </p>
        </div>
        <Button onClick={load} variant="outline" size="sm">Refresh</Button>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section aria-labelledby="new-benchmark" className="rounded-lg border border-border bg-card">
        <div className="border-b border-border p-5">
          <h2 id="new-benchmark" className="text-lg font-semibold">New benchmark run</h2>
        </div>
        <div className="grid gap-5 p-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <label className="block space-y-2 text-sm">
              <span className="font-medium">Source project</span>
              <select
                value={selectedFile}
                onChange={(event) => setSelectedFile(event.target.value)}
                className="h-10 w-full rounded-md border border-border bg-background px-3 outline-none focus:border-primary"
                disabled={loading || downloads.length === 0}
              >
                {downloads.map((file) => (
                  <option key={file.name} value={file.name}>
                    {file.displayName} · {file.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              <span className="font-medium">Run title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={selectedDownload ? `${selectedDownload.displayName} benchmark` : "Benchmark title"}
                className="h-10 w-full rounded-md border border-border bg-background px-3 outline-none focus:border-primary"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {providerOptions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => toggleProvider(provider.id)}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${selectedProviders.includes(provider.id) ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"}`}
                >
                  <span className="block font-medium">{provider.label}</span>
                  <span className="text-xs">{provider.modelLabel}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {stageOptions.map((stage) => (
                <label key={stage.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedStages.includes(stage.id)}
                    onChange={() => toggleStage(stage.id)}
                  />
                  {stage.label}
                </label>
              ))}
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">
              <div className="font-medium text-foreground">Fairness lock</div>
              <div>Same source, same stage list, same provider slots, anonymous labels, and shared renderer requirement.</div>
            </div>
            <Button
              onClick={createRun}
              disabled={creating || !selectedDownload || selectedProviders.length === 0 || selectedStages.length === 0}
              size="lg"
              className="w-full"
            >
              <Plus className="size-4" aria-hidden="true" />
              {creating ? "Creating..." : "Create benchmark"}
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="benchmark-runs" className="rounded-lg border border-border bg-card">
        <div className="border-b border-border p-5">
          <h2 id="benchmark-runs" className="text-lg font-semibold">Runs</h2>
        </div>
        {loading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading benchmarks...</p>
        ) : runs.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No benchmark runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-semibold">Run</th>
                  <th className="px-5 py-3 font-semibold">Source</th>
                  <th className="px-5 py-3 font-semibold">Providers</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Updated</th>
                  <th className="px-5 py-3 font-semibold">Open</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-4 font-medium">{run.title}</td>
                    <td className="px-5 py-4 text-muted-foreground">{run.source.displayName}</td>
                    <td className="px-5 py-4 text-muted-foreground">{run.providers.length}</td>
                    <td className="px-5 py-4">
                      <span className="rounded-full border border-border px-2 py-1 text-xs capitalize text-muted-foreground">{run.status}</span>
                    </td>
                    <td className="px-5 py-4 text-muted-foreground">{formatDate(run.updatedAt)}</td>
                    <td className="px-5 py-4">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/benchmarks/${encodeURIComponent(run.id)}`}>
                          <ClipboardCheck className="size-4" aria-hidden="true" />
                          Manage
                        </Link>
                      </Button>
                      {run.variants.some((variant) => variant.status === "ready") && (
                        <Button asChild variant="ghost" size="sm" className="ml-2">
                          <Link href={`/benchmarks/${encodeURIComponent(run.id)}/judge`}>
                            <Play className="size-4" aria-hidden="true" />
                            Judge
                          </Link>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
