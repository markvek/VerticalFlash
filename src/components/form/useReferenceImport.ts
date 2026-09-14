"use client";
import { useCallback, useEffect, useState } from "react";
import type { ReferenceImport } from "@/lib/reference-import-schema";

export function useReferenceImport(videoId: string | null) {
  const [job, setJob] = useState<ReferenceImport | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const retryJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/reference-import/${videoId}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not retry preparation");
      setJob(data); setError(null); setRetry(v => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not retry"); }
  }, [videoId]);
  useEffect(() => {
    if (!videoId || !/^\d+$/.test(videoId)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastStatus = "";
    const poll = async () => {
      try {
        const res = await fetch(`/api/reference-import/${videoId}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Could not check preparation progress");
        const current: ReferenceImport | null = await res.json();
        if (cancelled) return;
        setJob(current); setError(null);
        if (current && current.status !== lastStatus) {
          lastStatus = current.status; setRevision(v => v + 1);
          window.dispatchEvent(new Event("downloads-changed"));
        }
        if (current && current.status !== "ready" && current.status !== "failed") timer = setTimeout(poll, 1500);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not check preparation");
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [videoId, retry]);
  return { job, revision, error, retryJob, busy: !!job && !["ready", "failed"].includes(job.status) };
}
