"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  AgentCapabilityDefinition,
  AgentOption,
  AgentSettings,
} from "@/lib/agent-settings-schema";

interface AgentSettingsPayload {
  settings: AgentSettings;
  defaults: AgentSettings;
  capabilities: AgentCapabilityDefinition[];
  agents: AgentOption[];
}

function agentLabel(agent: AgentOption | undefined): string {
  if (!agent) return "Unknown";
  return agent.model ? `${agent.provider} · ${agent.model}` : agent.provider;
}

function hasChanges(a: AgentSettings | null, b: AgentSettings | null): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function AgentSettingsBoard() {
  const [payload, setPayload] = useState<AgentSettingsPayload | null>(null);
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/agents", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load agent settings");
      setPayload(data);
      setDraft(data.settings);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load agent settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const agentsById = useMemo(() => {
    return new Map((payload?.agents ?? []).map((agent) => [agent.id, agent]));
  }, [payload]);

  const dirty = hasChanges(payload?.settings ?? null, draft);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save agent settings");
      setPayload(data);
      setDraft(data.settings);
      setMessage("Preferences saved. These do not change active models.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save agent settings");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not reset agent settings");
      setPayload(data);
      setDraft(data.settings);
      setMessage("Agent settings reset to defaults.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not reset agent settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">Loading agent settings...</p>
      </section>
    );
  }

  if (!payload || !draft) {
    return (
      <section className="rounded-lg border border-border bg-card p-5">
        <p className="text-sm text-destructive">{error ?? "Agent settings unavailable"}</p>
        <Button onClick={load} variant="outline" size="sm" className="mt-4">
          <RotateCcw className="size-4" aria-hidden="true" />
          Retry
        </Button>
      </section>
    );
  }

  return (
    <section aria-labelledby="agent-selector" className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            Planned workflow preferences
          </div>
          <h2 id="agent-selector" className="text-lg font-semibold">Future agent preferences</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            These preferences do not change which model runs today. Use the model selector in each creation flow; saved project models drive supported analysis and editing operations.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={reset} disabled={saving} variant="outline" size="sm">
            <RotateCcw className="size-4" aria-hidden="true" />
            Reset
          </Button>
          <Button onClick={save} disabled={saving || !dirty} size="sm">
            <Save className="size-4" aria-hidden="true" />
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>

      {(error || message) && (
        <div className={`border-b border-border px-5 py-3 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error ?? message}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-semibold">Workflow step</th>
              <th className="px-5 py-3 font-semibold">Agent</th>
              <th className="px-5 py-3 font-semibold">Provider/model</th>
              <th className="px-5 py-3 font-semibold">Benchmark</th>
              <th className="px-5 py-3 font-semibold">Cost</th>
              <th className="px-5 py-3 font-semibold">Latency</th>
            </tr>
          </thead>
          <tbody>
            {payload.capabilities.map((capability) => {
              const selected = agentsById.get(draft[capability.id]);
              const options = payload.agents.filter((agent) =>
                agent.supports.includes(capability.id)
              );
              return (
                <tr key={capability.id} className="border-b border-border last:border-0">
                  <td className="px-5 py-4 align-top">
                    <div className="font-medium text-foreground">{capability.label}</div>
                    <div className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{capability.description}</div>
                    <div className="mt-2 text-xs text-muted-foreground">{capability.group}</div>
                  </td>
                  <td className="px-5 py-4 align-top">
                    <select
                      value={draft[capability.id]}
                      onChange={(event) =>
                        setDraft({ ...draft, [capability.id]: event.target.value })
                      }
                      className="h-9 w-64 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                    >
                      {options.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.label}{agent.status === "planned" ? " (planned)" : ""}
                        </option>
                      ))}
                    </select>
                    {selected?.status === "planned" && (
                      <p className="mt-2 text-xs text-amber-600">Adapter not implemented yet.</p>
                    )}
                  </td>
                  <td className="px-5 py-4 align-top">
                    <div className="font-medium">{agentLabel(selected)}</div>
                    <div className="mt-1 max-w-[220px] text-xs leading-5 text-muted-foreground">{selected?.description ?? "No catalog entry found."}</div>
                  </td>
                  <td className="px-5 py-4 align-top text-muted-foreground">Pending</td>
                  <td className="px-5 py-4 align-top text-muted-foreground">Pending</td>
                  <td className="px-5 py-4 align-top text-muted-foreground">Pending</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
