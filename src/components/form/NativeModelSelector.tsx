"use client";
import { useEffect, useState } from "react";
import type { ModelOption } from "@/lib/models/schema";
export function NativeModelSelector({
  videoId,
  value,
  onChange,
  disabled = false,
}: {
  videoId?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [defaultModel, setDefaultModel] = useState("Loading default…");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/models${videoId ? `?videoId=${encodeURIComponent(videoId)}` : ""}`)
      .then((r) => r.json())
      .then((data) => {
        setDefaultModel(data.defaultModel);
        setModels(
          data.models.filter((m: ModelOption) => m.provider === "gemini"),
        );
      })
      .catch(() => setError("Could not load model choices"));
  }, [videoId]);
  return (
    <label className="block text-sm space-y-1">
      <span>Model</span>
      <select
        className="block w-full rounded-md border bg-background p-2"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Default: {defaultModel}</option>
        {models.map((m) => (
          <option key={m.id} value={m.model} disabled={!m.available}>
            {m.model}
            {m.available ? "" : ` — ${m.reason}`}
          </option>
        ))}
      </select>
      <span className="block text-xs text-muted-foreground">
        This flow uses Gemini’s video/audio inspection. Compare providers with
        Benchmark on the storyboard page.
      </span>
      {error && <span className="text-destructive">{error}</span>}
    </label>
  );
}
