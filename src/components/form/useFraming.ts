"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FramingDocumentZ, type FramingDocument, type PreviewSource } from "@/lib/framing-schema";

export function useFraming(videoId: string | null, sourceVersion: string) {
  const [document, setDocument] = useState<FramingDocument | null>(null);
  const [sources, setSources] = useState<Record<string, PreviewSource[]>>({});
  const [status, setStatus] = useState("Loading framing");
  const [error, setError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const current = useRef<FramingDocument | null>(null);
  const saved = useRef<FramingDocument | null>(null);
  const history = useRef<{ past: FramingDocument[]; future: FramingDocument[] }>({ past: [], future: [] });
  const transaction = useRef<FramingDocument | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epoch = useRef(0);
  const content = (d: FramingDocument | null) => JSON.stringify(d && { shots: d.shots, broll: d.broll });

  useEffect(() => {
    current.current = null; saved.current = null; pending.current = null;
    history.current = { past: [], future: [] };
    transaction.current = null;
    setDocument(null); setSources({}); setStatus("Loading framing"); setError(null);
    const generation = ++epoch.current;
    return () => { epoch.current = generation + 1; if (timer.current) clearTimeout(timer.current); };
  }, [videoId]);

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    fetch(`/api/analyze/${videoId}/framing`).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Cannot load framing");
      if (cancelled) return;
      setSources(data.sources);
      if (!current.current) {
        const loaded = FramingDocumentZ.parse(data.document);
        current.current = saved.current = loaded;
        setDocument(loaded); setStatus("Saved");
      }
    }).catch(e => { if (!cancelled) { setError(e.message); setStatus("Load failed"); } });
    return () => { cancelled = true; };
  }, [videoId, sourceVersion]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) { await pending.current; }
    if (!current.current || !saved.current) throw new Error("Framing has not loaded");
    if (content(current.current) === content(saved.current)) return;
    const generation = epoch.current;
    const save = async () => {
      while (generation === epoch.current && !transaction.current && current.current && saved.current && content(current.current) !== content(saved.current)) {
        const snapshot = { ...current.current, revision: saved.current.revision };
        setStatus("Saving");
        const res = await fetch(`/api/analyze/${snapshot.videoId}/framing`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Cannot save framing");
        if (generation !== epoch.current) return;
        const stored = FramingDocumentZ.parse(data);
        saved.current = stored;
        current.current = { ...current.current!, revision: stored.revision, updatedAt: stored.updatedAt };
        setDocument(current.current);
      }
      if (generation === epoch.current) { setStatus(content(current.current) === content(saved.current) ? "Saved" : "Unsaved"); setError(null); }
    };
    const task = save(); pending.current = task;
    try { await task; }
    catch (e) {
      if (generation === epoch.current) { setStatus("Not saved"); setError(e instanceof Error ? e.message : "Cannot save framing"); }
      throw e;
    } finally { if (pending.current === task) pending.current = null; }
  }, []);

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => {}); }, 450);
  };
  const begin = () => {
    if (!transaction.current) transaction.current = current.current;
    if (timer.current) clearTimeout(timer.current);
  };
  const commit = () => {
    if (transaction.current && content(transaction.current) !== content(current.current)) {
      history.current.past.push(transaction.current);
      history.current.past = history.current.past.slice(-100);
      history.current.future = [];
      setHistoryVersion(v => v + 1);
    }
    transaction.current = null;
    schedule();
  };
  const update = (change: (d: FramingDocument) => FramingDocument, continuous = false) => {
    if (!current.current) return;
    begin();
    current.current = change(current.current);
    setDocument(current.current); setStatus("Unsaved");
    if (!continuous) commit();
  };
  const travel = (direction: "past" | "future") => {
    if (!current.current) return;
    commit();
    const next = history.current[direction].pop();
    if (!next) return;
    history.current[direction === "past" ? "future" : "past"].push(current.current);
    current.current = { ...next, revision: current.current.revision, updatedAt: current.current.updatedAt };
    setDocument(current.current); setStatus("Unsaved"); setHistoryVersion(v => v + 1); schedule();
  };
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (content(current.current) !== content(saved.current)) { e.preventDefault(); }
    };
    window.addEventListener("beforeunload", beforeUnload);
    const navigate = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || content(current.current) === content(saved.current)) return;
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.origin !== location.origin || link.href === location.href) return;
      e.preventDefault(); e.stopPropagation();
      transaction.current = null;
      void flush().then(() => location.assign(link.href)).catch(() => {});
    };
    window.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("click", navigate, true); };
  }, [flush]);
  void historyVersion;
  const replace = (next: FramingDocument | null) => {
    if (timer.current) clearTimeout(timer.current);
    current.current = saved.current = next;
    transaction.current = null;
    history.current = { past: [], future: [] };
    setDocument(next); setStatus(next ? "Saved" : "Loading framing"); setError(null);
    setHistoryVersion(v => v + 1);
  };
  return { document, sources, status, error, update, begin, commit, flush, replace,
    undo: () => travel("past"), redo: () => travel("future"),
    canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 };
}
