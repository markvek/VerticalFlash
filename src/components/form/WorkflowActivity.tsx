"use client";
import { useEffect, useState } from "react";
import type { WorkflowActivity as Activity, activitySummary } from "@/lib/workflow-activity";

export function WorkflowActivity({ videoId }: { videoId?: string }) {
  const [data, setData] = useState<{ records: Activity[]; summary: ReturnType<typeof activitySummary> }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/workflow-activity${videoId ? `?videoId=${encodeURIComponent(videoId)}` : ""}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (active) { setData(result); setError(undefined); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Activity unavailable"); }
    };
    void poll(); const timer = setInterval(poll, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [videoId]);
  const running = data?.records.filter(r => r.status === "running") ?? [];
  return <details className="my-3 rounded border border-border p-3 text-xs">
    <summary className="cursor-pointer font-semibold">{videoId ? "Project activity" : "Local workflow measurements"}{running.length ? ` · ${running.map(r => r.stage).join(", ")} running` : ""}</summary>
    {error && <p role="alert" className="mt-2 text-red-400">{error}</p>}
    <p className="mt-2 text-muted-foreground">Progress and attempts stay available when you leave this page. Reload completed results; retry failed actions from their original controls. Retries can incur model charges.</p>
    {data && <><p className="my-2 text-muted-foreground">{data.summary.previews} projects previewed · {data.summary.exportsWithIssues} previews with issues · {data.summary.corrections} metadata corrections · {data.summary.acceptedSuggestions} storyboards accepted{data.summary.meanTimeToPreviewMs != null ? ` · average first recorded action to preview: ${(data.summary.meanTimeToPreviewMs / 60000).toFixed(1)} min` : ""}. Recorded locally from this update onward.</p>
      {Object.entries(data.summary.failures).length > 0 && <p className="my-2">Failures by action: {Object.entries(data.summary.failures).map(([stage, count]) => `${stage}: ${count}`).join(" · ")}</p>}
      <ul className="max-h-64 space-y-2 overflow-auto">{data.records.map(r => <li key={r.id}><span className="font-medium">{r.stage}</span> · {r.status} · attempt {r.attempt} · {new Date(r.startedAt).toLocaleString()}{r.error && <span className="block text-red-400">{r.error}</span>}{r.issues > 0 && <span className="block text-amber-400">{r.issues} export issues require review.</span>}</li>)}</ul>
    </>}
  </details>;
}
