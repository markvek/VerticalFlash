"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, Film, LoaderCircle, RotateCcw, Upload } from "lucide-react";
import { StoryboardPanel } from "./StoryboardPanel";
import { StoryboardFootagePanel } from "./StoryboardFootagePanel";
import type { DownloadEntry } from "@/lib/download-types";
import type { FootageSource } from "@/lib/segments-schema";
import type { MasterJobStatus } from "@/lib/master-job-schema";
import { extractVideoId } from "@/lib/video-id";
import { beginMediaPlayback, isCurrentMediaPlayback, playMedia } from "@/lib/media-playback";

export function StoryboardWorkspace({ filename }: { filename: string }) {
  const [project, setProject] = useState<DownloadEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"storyboarding" | "upload" | "add">("storyboarding");
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

  return <div className="downloads-layout min-h-screen bg-background p-4 text-foreground md:p-5">
    <header className="mb-5">
      <h1 className="text-xl font-semibold">Storyboard</h1>
      <p className="mt-2 truncate text-xs text-muted-foreground" title={project?.displayName ?? job?.title ?? filename}>{project?.displayName ?? job?.title ?? filename}</p>
      <div role="tablist" aria-label="Storyboard workspace" className="mt-3 grid grid-cols-3 overflow-hidden rounded-lg border border-border text-[11px] font-semibold sm:inline-flex sm:text-xs">
        {([{ id: "storyboarding", label: "Storyboarding", Icon: Clapperboard }, { id: "upload", label: "Upload Footage", Icon: Upload }, { id: "add", label: "Add Footage", Icon: Film }] as const).map(({ id, label, Icon }) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`flex min-w-0 flex-col items-center justify-center gap-1 border-r border-border px-1 py-2.5 last:border-0 sm:flex-row sm:gap-1.5 sm:px-3 ${tab === id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}><Icon className="size-3.5 shrink-0" />{label}</button>)}
      </div>
    </header>
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
    {!project?.videoId ? !job && !error && <p role="status" className="text-sm text-muted-foreground">Loading storyboard...</p> : processing ? preview : <StoryboardPanel
      key={project.videoId} videoId={project.videoId} filename={filename} previewMedia={preview} refreshKey={revision} onSeek={seek} onStopPreview={stopPreview}
      footagePanel={tab !== "storyboarding" ? <StoryboardFootagePanel videoId={project.videoId} mode={tab} onIncluded={() => { setRevision((value) => value + 1); window.dispatchEvent(new Event("downloads-changed")); }} /> : undefined}
    />}
  </div>;
}
