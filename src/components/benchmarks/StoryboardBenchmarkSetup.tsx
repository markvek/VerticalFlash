"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LibraryClip } from "@/lib/library-schema";
import {
  BENCHMARK_MODEL_PROVIDERS,
  defaultBenchmarkModelIds,
  type ModelOption,
} from "@/lib/models/schema";

function formatSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "?:??";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function StoryboardBenchmarkSetup({
  clips,
  library,
  title,
  timingEngine,
  busy,
  defaultExpanded = false,
}: {
  clips: string[];
  library: LibraryClip[];
  title: string;
  timingEngine: "gemini" | "whisperx" | null;
  busy: boolean;
  defaultExpanded?: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [compareProviders, setCompareProviders] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [configuration, setConfiguration] = useState<string[]>([]);
  const [preparationAvailable, setPreparationAvailable] = useState(false);
  const [brief, setBrief] = useState("");
  const [duration, setDuration] = useState(22);
  const [pacing, setPacing] = useState("standard");
  const [broll, setBroll] = useState(false);
  const [pool, setPool] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => {
    fetch("/api/models")
      .then((r) => {
        if (!r.ok) throw new Error("Could not load models");
        return r.json();
      })
      .then((data) => {
        setModels(data.models);
        setSelected(defaultBenchmarkModelIds(data.models));
        setPreparationAvailable(data.preparationAvailable);
        setConfiguration(
          data.providers
            .filter(
              (p: { keyConfigured: boolean; modelsConfigured: boolean }) =>
                !p.keyConfigured || !p.modelsConfigured,
            )
            .map(
              (p: {
                provider: string;
                keyVariable: string;
                modelsVariable: string;
                keyConfigured: boolean;
                modelsConfigured: boolean;
              }) =>
                `${p.provider}: ${[!p.keyConfigured && p.keyVariable, !p.modelsConfigured && p.modelsVariable].filter(Boolean).join(" + ")}`,
            ),
        );
      })
      .catch((e) => setError(e.message));
  }, []);
  const eligible = library.filter((c) => !clips.includes(c.filename));
  const effectivePool = pool.filter((name) => !clips.includes(name));
  const start = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const payload = {
      comparisonMode: compareProviders ? "providers" : "models",
      clips,
      title: title.trim(),
      timingEngine,
      request: {
        count: 1,
        lengths: [duration],
        pacing,
        allow_broll: broll,
        brief,
      },
      brollClips: broll ? effectivePool : [],
      models: selected.map((id) => {
        const m = models.find((m) => m.id === id)!;
        return { provider: m.provider, model: m.model };
      }),
    };
    const serialized = JSON.stringify(payload);
    if (attempt.current?.payload !== serialized)
      attempt.current = { payload: serialized, id: crypto.randomUUID() };
    try {
      const res = await fetch("/api/benchmarks/storyboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestId: attempt.current.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start benchmark");
      router.push(`/benchmarks/${data.run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start benchmark");
      setSubmitting(false);
    }
  };
  return (
    <section className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Compare four models</h2>
          <p className="text-sm text-muted-foreground">
            One setup. Four storyboards, with automatic B-roll if you choose.
          </p>
        </div>
        <button
          type="button"
          className="rounded-md border px-3 py-2 text-sm"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide options" : "Benchmark"}
        </button>
      </div>
      {expanded && (
        <div className="space-y-4">
          <label className="block text-sm">
            Shared prompt
            <textarea
              className="mt-1 w-full rounded-md border bg-background p-2"
              maxLength={500}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="What should these shorts communicate?"
            />
          </label>
          <div className="flex gap-4">
            <label className="text-sm">
              Length (seconds)
              <input
                className="block w-28 rounded border bg-background p-2"
                type="number"
                min={5}
                max={180}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </label>
            <label className="text-sm">
              Pacing
              <select
                className="block rounded border bg-background p-2"
                value={pacing}
                onChange={(e) => setPacing(e.target.value)}
              >
                <option value="fast">Fast</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Models ({selected.length}/4)
            </legend>
            <label className="block text-sm">
              Comparison
              <select
                className="mt-1 block w-full rounded-md border bg-background p-2"
                value={compareProviders ? "providers" : "models"}
                disabled={submitting}
                onChange={(event) => {
                  const providers = event.target.value === "providers";
                  setCompareProviders(providers);
                  setSelected(defaultBenchmarkModelIds(models, providers));
                }}
              >
                <option value="providers">
                  Gemini vs OpenAI vs Claude vs xAI/Grok
                </option>
                <option value="models">Choose any four models</option>
              </select>
            </label>
            {compareProviders ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {BENCHMARK_MODEL_PROVIDERS.map((provider) => {
                  const options = models.filter(
                    (model) => model.provider === provider.id,
                  );
                  const chosen = options.find((model) =>
                    selected.includes(model.id),
                  );
                  const ready = options.some((model) => model.available);
                  const reason = ready
                    ? null
                    : options[0]?.reason ||
                      configuration.find((line) =>
                        line.startsWith(`${provider.id}:`),
                      ) ||
                      "Loading provider configuration…";
                  return (
                    <div
                      key={provider.id}
                      className="rounded-lg border bg-background p-3 space-y-2"
                    >
                      <label className="block text-sm font-medium">
                        {provider.label}
                        <select
                          aria-label={`${provider.label} model`}
                          className="mt-1 block w-full rounded-md border bg-background p-2 text-sm font-normal"
                          value={chosen?.id ?? ""}
                          disabled={submitting || !ready}
                          onChange={(event) =>
                            setSelected((current) => [
                              ...current.filter(
                                (id) =>
                                  !options.some((model) => model.id === id),
                              ),
                              ...(event.target.value
                                ? [event.target.value]
                                : []),
                            ])
                          }
                        >
                          <option value="">
                            {ready ? "Choose a model" : "Setup required"}
                          </option>
                          {options.map((model) => (
                            <option
                              key={model.id}
                              value={model.id}
                              disabled={!model.available}
                            >
                              {model.model}
                            </option>
                          ))}
                        </select>
                      </label>
                      {reason && (
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          {reason}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2">
                {models.map((m) => (
                  <label
                    key={m.id}
                    className={`flex gap-2 text-sm ${!m.available ? "opacity-50" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(m.id)}
                      disabled={
                        !m.available ||
                        submitting ||
                        (!selected.includes(m.id) && selected.length === 4)
                      }
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked
                            ? [...s, m.id]
                            : s.filter((id) => id !== m.id),
                        )
                      }
                    />
                    {m.label}
                    {m.reason && <span> — {m.reason}</span>}
                  </label>
                ))}
              </div>
            )}
            {compareProviders && selected.length < 4 && (
              <p className="text-sm text-muted-foreground">
                Connect all four providers to run this comparison. Each provider
                creates its own storyboard and B-roll choices.
              </p>
            )}
            {configuration.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary>Provider setup</summary>
                <p className="mt-2">
                  Add these environment settings and restart the app. Model
                  lists accept comma-separated IDs.
                </p>
                {configuration.map((c) => (
                  <p key={c} className="mt-1 font-mono">
                    {c}
                  </p>
                ))}
              </details>
            )}
            {!preparationAvailable && (
              <p className="text-xs text-destructive">
                Configure GEMINI_API_KEY for the shared transcript preparation.
              </p>
            )}
          </fieldset>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={broll}
              onChange={(e) => {
                setBroll(e.target.checked);
                if (e.target.checked && !pool.length)
                  setPool(eligible.slice(0, 20).map((c) => c.filename));
              }}
            />
            Automatically add B-roll
          </label>
          {broll && (
            <fieldset className="max-h-48 overflow-auto rounded border p-3 space-y-2">
              <legend className="text-xs">
                Eligible B-roll pool — shared by all models (up to 20)
              </legend>
              {eligible.map((c) => {
                const isSelected = effectivePool.includes(c.filename);
                const isDisabled = !isSelected && effectivePool.length >= 20;
                return (
                  <button
                    key={c.filename}
                    type="button"
                    disabled={isDisabled}
                    title={
                      isSelected
                        ? "Remove from the B-roll pool"
                        : "Add to the B-roll pool"
                    }
                    aria-pressed={isSelected}
                    onClick={() =>
                      setPool((p) =>
                        isSelected
                          ? p.filter((n) => n !== c.filename)
                          : [...p, c.filename],
                      )
                    }
                    className={`flex w-full items-center gap-3 rounded-lg border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/60 hover:bg-muted/40"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/library/thumbs/${encodeURIComponent(c.filename)}`}
                      alt=""
                      loading="lazy"
                      className="size-14 shrink-0 rounded object-cover bg-muted"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {c.filename}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {formatSeconds(c.duration)}
                        {c.source ? ` · ${c.source}` : ""}
                        {(!c.analysis || !c.duration) &&
                          " · will be analyzed once"}
                      </span>
                    </span>
                  </button>
                );
              })}
              {!eligible.length && (
                <p className="text-sm">
                  Add library clips besides the core footage to use B-roll.
                </p>
              )}
            </fieldset>
          )}
          <p className="text-xs text-muted-foreground">
            Each model creates one storyboard and chooses its own B-roll clips
            and moments from the same pool. Shared transcript preparation runs
            once. Starting a benchmark uses the configured providers’ APIs.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={start}
            disabled={
              busy ||
              submitting ||
              !clips.length ||
              !title.trim() ||
              selected.length !== 4 ||
              !preparationAvailable ||
              (broll && !effectivePool.length) ||
              duration < 5 ||
              duration > 180
            }
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
          >
            {submitting
              ? "Starting benchmark…"
              : "Benchmark — create four versions"}
          </button>
        </div>
      )}
    </section>
  );
}
