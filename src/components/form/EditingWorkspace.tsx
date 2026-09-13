"use client";
import { flushEditSaves } from "@/lib/edit-save-tracker";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { StoryboardPanel } from "./StoryboardPanel";
import { ViralityReviewPanel } from "./ViralityReviewPanel";
import type { DownloadEntry } from "@/lib/download-types";
import type { FootageSource } from "@/lib/segments-schema";
import type { MasterJobStatus } from "@/lib/master-job-schema";
import { extractVideoId } from "@/lib/video-id";
import { beginMediaPlayback, isCurrentMediaPlayback, playMedia } from "@/lib/media-playback";

import { useSearchParams } from "next/navigation";
import { EditingEditor } from "./EditingEditor";

export type EditingView = "video" | "shots" | "storyboards" | "upload" | "virality" | "clips" | "variations" | "render" | "captions";
export interface EditingWorkspaceControls {
  sourceId: string; onFootageIncluded: () => void;
  activeEdit: string | null; view: EditingView; setView: (view: EditingView) => void;
  showSource: boolean; preview: ReactNode; header: ReactNode; panel: ReactNode;
  registerFlush: (flush: () => Promise<void>) => () => void;
}
export function EditingWorkspace({ filename: requestedFilename }: { filename: string }) {
  const search = useSearchParams();
  const [files, setFiles] = useState<DownloadEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const res = await fetch("/api/downloads");
    if (!res.ok) throw new Error("Could not load editing projects");
    const data = await res.json(); setFiles(data.files); return data.files as DownloadEntry[];
  }, []);
  useEffect(() => {
    const load = () => { void reload().catch(e => setLoadError(e.message)); };
    load(); window.addEventListener("downloads-changed", load);
    return () => window.removeEventListener("downloads-changed", load);
  }, [reload]);
  const requested = files?.find(f => f.name === requestedFilename);
  const filename = requested?.project?.kind === "cutdown" ? requested.project.masterFilename : requestedFilename;
  // A background master job can exist before its media appears in the listing.
  if (!files) return <p role={loadError ? "alert" : "status"} className="p-4 text-sm">{loadError ?? "Loading editing workspace..."}</p>;
  if (requested?.project?.kind !== "master" && requested?.project?.kind !== "cutdown" && !filename.startsWith("master-")) return <EditingEditor key={filename} filenameOverride={filename} />;
  return <SourceEditingWorkspace key={filename} filename={filename} files={files} reload={reload} initialEdit={requested?.project?.kind === "cutdown" ? requested.videoId : null} search={search.toString()} />;
}
function SourceEditingWorkspace({ filename, files, reload, initialEdit, search }: { filename: string; files: DownloadEntry[]; reload: () => Promise<DownloadEntry[]>; initialEdit: string | null; search: string }) {
  const [project, setProject] = useState<DownloadEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<FootageSource | undefined>();
  const [mediaError, setMediaError] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [job, setJob] = useState<MasterJobStatus | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const processing = job?.status === "preparing" || job?.status === "analyzing";
  const video = useRef<HTMLVideoElement>(null);
  const pendingTime = useRef<{ time: number; request: number } | null>(null);
  const stopPreview = useCallback(() => { pendingTime.current = null; video.current?.pause(); }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let loadedStatus: string | undefined;
    const controller = new AbortController();
    setProject(null);
    setJob(null);
    setError(null);
    const poll = async () => {
      try {
        const videoId = extractVideoId(filename);
        let current: MasterJobStatus | null = null;
        if (videoId?.startsWith("master-")) {
          const response = await fetch(`/api/master/${videoId}/status`, { cache: "no-store", signal: controller.signal });
          if (!response.ok && response.status !== 404) throw new Error("Could not check storyboard progress");
          if (response.ok) current = await response.json();
        }
        if (cancelled) return;
        setJob(current);
        setError(null);
        const status = current?.status ?? "existing";
        if (status !== "preparing" && status !== loadedStatus) {
          const response = await fetch("/api/downloads", { signal: controller.signal });
          if (!response.ok) throw new Error("Could not load storyboard project");
          const data = await response.json();
          const file = data.files.find((file: DownloadEntry) => file.name === filename);
          if (file?.project?.kind !== "master" && status !== "failed") throw new Error("Storyboard project not found");
          if (cancelled) return;
          setProject(file ?? null);
          loadedStatus = status;
          setRevision((value) => value + 1);
          window.dispatchEvent(new Event("downloads-changed"));
        }
        if (current?.status === "preparing" || current?.status === "analyzing") timer = setTimeout(poll, 1500);
      } catch (error) {
        if (cancelled) return;
        setError(error instanceof Error ? error.message : "Could not load storyboard project");
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [filename, pollRevision]);

  const seek = (seconds: number, footage?: FootageSource, request = beginMediaPlayback()) => {
    if (!isCurrentMediaPlayback(request)) return;
    const time = Math.max(0, seconds - (footage?.offset ?? 0));
    const target = footage ? `/api/library/clips/${encodeURIComponent(footage.filename)}` : `/api/downloads/${encodeURIComponent(filename)}`;
    const same = video.current?.getAttribute("src") === target;
    pendingTime.current = { time, request };
    setMediaError(false);
    setSource(footage);
    if (same && video.current?.readyState) {
      video.current.currentTime = time;
      pendingTime.current = null;
      playMedia(video.current, request).catch(() => {});
    }
  };
  const preview = <div className="min-w-0 self-start">
    <div className="relative mx-auto aspect-[9/16] w-full max-w-80 overflow-hidden rounded-lg bg-black">
      <video ref={video} key={source?.filename ?? filename} src={source ? `/api/library/clips/${encodeURIComponent(source.filename)}` : `/api/downloads/${encodeURIComponent(filename)}`}
        poster={source ? `/api/library/thumbs/${encodeURIComponent(source.filename)}` : `/api/download-thumb/${encodeURIComponent(filename)}`}
        controls playsInline preload="metadata" onError={() => setMediaError(true)} onLoadedMetadata={() => {
          const pending = pendingTime.current;
          pendingTime.current = null;
          if (pending && video.current && isCurrentMediaPlayback(pending.request)) {
            video.current.currentTime = pending.time;
            playMedia(video.current, pending.request).catch(() => {});
          }
        }} className="h-full w-full object-contain" />
      {mediaError && <p role="alert" className="absolute inset-x-2 top-3 rounded bg-black/80 p-2 text-xs text-red-300">Footage could not be loaded</p>}
    </div>
    {source && <p className="mt-2 truncate text-xs text-muted-foreground" title={source.filename}>{source.filename}</p>}
  </div>;


  const sourceId = extractVideoId(filename)!;
  const children = files.filter(f => f.project?.kind === "cutdown" && f.project.masterId === sourceId);
  const [selection, setSelection] = useState<{ edit: string | null; idea: string | null; view: EditingView } | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [reviewContext, setReviewContext] = useState<"idea" | "edit">("edit");
  const flush = useRef<() => Promise<void>>(async () => {});
  const registerFlush = useCallback((fn: () => Promise<void>) => { flush.current = fn; return () => { if (flush.current === fn) flush.current = async () => {}; }; }, []);
  const currentSelection = useRef(selection); currentSelection.current = selection;
  useEffect(() => {
    let cancelled = false;
    let saved: { edit?: string; idea?: string; view?: EditingView } = {};
    try { saved = JSON.parse(localStorage.getItem(`editing-workspace:${sourceId}`) ?? "{}"); } catch {}
    const query = new URLSearchParams(search);
    const edit = query.has("edit") ? query.get("edit") : initialEdit ?? saved.edit ?? null;
    const views = ["video", "storyboards", "upload", "virality", "clips", "variations", "render", "captions"];
    const legacyView = query.get("view") ?? query.get("tab") ?? saved.view;
    const requestedView = legacyView === "shots" ? "storyboards" : legacyView;
    const view = views.includes(requestedView ?? "") ? requestedView as EditingView : edit ? "video" : "storyboards";
    const next = { edit, idea: query.get("idea") ?? saved.idea ?? null, view };
    const previous = currentSelection.current;
    if (previous?.edit && previous.edit !== edit) {
      void (async () => {
        try { await flushEditSaves(sourceId); await flush.current(); if (!cancelled) setSelection(next); }
        catch (e) {
          if (cancelled) return;
          setSwitchError(e instanceof Error ? e.message : "Could not save this edit");
          const url = new URL(window.location.href);
          for (const key of ["edit", "idea", "view"] as const) { if (previous[key]) url.searchParams.set(key, previous[key]!); else url.searchParams.delete(key); }
          window.history.replaceState(null, "", url.toString());
        }
      })();
    } else setSelection(next);
    return () => { cancelled = true; };
  }, [sourceId, search, initialEdit]);
  const update = (change: Partial<NonNullable<typeof selection>>) => {
    const next = { edit: null, idea: null, view: "storyboards" as EditingView, ...selection, ...change };
    setSelection(next);
    try { localStorage.setItem(`editing-workspace:${sourceId}`, JSON.stringify(next)); } catch {}
    const url = new URL(window.location.href);
    url.pathname = `/editing/${encodeURIComponent(filename)}`;
    for (const key of ["edit", "idea", "view"] as const) { const value = next[key]; if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    if (url.toString() !== window.location.href) window.history.pushState(null, "", url.toString());
  };
  useEffect(() => {
    if (!selection || window.location.pathname === `/editing/${encodeURIComponent(filename)}`) return;
    const url = new URL(window.location.href); url.pathname = `/editing/${encodeURIComponent(filename)}`;
    if (selection.edit) url.searchParams.set("edit", selection.edit);
    if (selection.idea) url.searchParams.set("idea", selection.idea);
    url.searchParams.set("view", selection.view);
    window.history.replaceState(null, "", url.toString());
  }, [filename, selection]);
  const selectedEdit = children.find(f => f.videoId === selection?.edit || f.name === selection?.edit);
  const activeMeta = selectedEdit?.project?.kind === "cutdown" ? selectedEdit.project : null;
  const switchEdit = async (name: string) => {
    setSwitching(true); setSwitchError(null);
    try {
      await flushEditSaves(sourceId);
      await flush.current();
      const currentFiles = await reload();
      const edit = currentFiles.find(f => f.name === name || f.videoId === name);
      if (!edit || edit.project?.kind !== "cutdown" || edit.project.masterId !== sourceId) throw new Error("This edit is not available in this project.");
      stopPreview(); update({ edit: edit.videoId, view: "video" });
    } catch (e) { setSwitchError(e instanceof Error ? e.message : "Could not open edit"); throw e; }
    finally { setSwitching(false); }
  };
  const view = selection?.view ?? "storyboards";
  const showSource = !selectedEdit || ["storyboards", "upload", "virality"].includes(view);
  const header = <div className="flex flex-wrap items-center gap-2">
    <h1 className="min-w-0 truncate text-sm font-semibold">{project?.displayName ?? job?.title ?? filename}</h1>
    <label className="ml-auto flex items-center gap-2 text-xs">Edit
      <select aria-label="Active edit" disabled={switching} className="max-w-64 rounded border border-border bg-background p-1.5" value={selectedEdit?.name ?? ""} onChange={e => void switchEdit(e.target.value).catch(() => {})}>
        <option value="" disabled>Choose a storyboard first</option>
        {children.map(f => <option key={f.name} value={f.name}>{f.displayName}</option>)}
      </select>
    </label>
    {selectedEdit && <button disabled={switching} className="rounded border border-border px-2 py-1.5 text-xs disabled:opacity-50" onClick={async () => {
      setSwitching(true); setSwitchError(null);
      try { await flush.current(); const response = await fetch(`/api/downloads/${encodeURIComponent(selectedEdit.name)}/fork`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not duplicate edit"); await switchEdit(data.filename); }
      catch (e) { setSwitchError(e instanceof Error ? e.message : "Could not duplicate edit"); } finally { setSwitching(false); }
    }}>Duplicate current edit</button>}
    {switchError && <p role="alert" className="w-full text-xs text-red-400">{switchError}</p>}
  </div>;
  const panel = <>
    {processing && <p role="status" className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />{job.status === "preparing" ? "Preparing footage..." : "Transcribing and segmenting footage..."}</p>}
    {job?.status === "failed" && <div className="mb-4 space-y-2">
      <p role="alert" className="text-sm text-red-400">{job.error}</p>
      <button disabled={retrying} onClick={async () => {
        setRetrying(true);
        setError(null);
        try {
          const response = await fetch(`/api/master/${job.videoId}/status`, { method: "POST" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not retry processing");
          setJob(data);
          setPollRevision((value) => value + 1);
        } catch (error) { setError(error instanceof Error ? error.message : "Could not retry processing"); }
        finally { setRetrying(false); }
      }} className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"><RotateCcw aria-hidden="true" className="size-4" />{retrying ? "Retrying..." : "Retry processing"}</button>
    </div>}
    {project?.videoId && !project.analysis && !processing && job?.status !== "failed" && <button disabled={analyzing} onClick={async () => {
      setAnalyzing(true);
      setError(null);
      try {
        const response = await fetch(`/api/analyze/${project.videoId}`, { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Analysis failed");
        setProject({ ...project, analysis: { analyzedAt: data.analyzedAt, shotCount: data.shots.length } });
        setRevision((value) => value + 1);
        window.dispatchEvent(new Event("downloads-changed"));
      } catch (error) { setError(error instanceof Error ? error.message : "Analysis failed"); }
      finally { setAnalyzing(false); }
    }} className="mb-4 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{analyzing ? "Analyzing footage..." : "Analyze footage"}</button>}
    {error && <p role="alert" className="mb-4 text-sm text-red-400">{error}</p>}

    {selection?.edit && !selectedEdit && <p role="alert" className="text-xs text-red-400">The selected edit is unavailable. Choose an existing edit or use a storyboard to create one.</p>}
    {!processing && project?.analysis && view === "storyboards" && <StoryboardPanel videoId={sourceId} filename={filename} refreshKey={revision}
      selectedIdea={selection?.idea ?? undefined} onIdeaChange={idea => update({ idea })} adoptedIdea={activeMeta?.storyboardId} adoptedRevision={activeMeta?.storyboardRevision}
      activeEdit={selectedEdit?.name} onBeforeAccept={() => flush.current()} onEditCreated={switchEdit} onOpenEdit={switchEdit}
      onReturnToEdit={() => { stopPreview(); update({ view: "video" }); }}
      onSeek={seek} onStopPreview={stopPreview} onOpenReview={idea => { stopPreview(); setReviewContext("idea"); update({ idea, view: "virality" }); }} />}
    {view === "virality" && project?.analysis && <>
      {selectedEdit && <label className="text-xs">Review context <select className="ml-2 rounded border border-border bg-background p-2" value={reviewContext} onChange={e => setReviewContext(e.target.value as "idea" | "edit")}><option value="edit">Storyboard used in this edit</option><option value="idea">Browsed storyboard idea</option></select></label>}
      <p className="text-xs text-muted-foreground">{selectedEdit && reviewContext === "edit" ? "Saved review of the adopted storyboard. Timeline and framing changes after adoption are not assessed by this review." : "Reviewing the browsed storyboard revision. This review does not assess subsequent timeline changes."}</p>
      <ViralityReviewPanel key={reviewContext} videoId={selectedEdit && reviewContext === "edit" ? selectedEdit.videoId! : sourceId} storyboardId={selectedEdit && reviewContext === "edit" ? activeMeta?.storyboardId : selection?.idea ?? activeMeta?.storyboardId} onSeek={seek} />
    </>}
  </>;
  if (!selection) return <p className="p-4 text-sm">Restoring editing workspace...</p>;
  return <EditingEditor key={selectedEdit?.name ?? filename} filenameOverride={selectedEdit?.name ?? filename} workspace={{ sourceId, onFootageIncluded: () => setRevision(v => v + 1), activeEdit: selectedEdit?.name ?? null, view, setView: view => { stopPreview(); update({ view }); }, showSource, preview, header, panel, registerFlush }} />;
}
