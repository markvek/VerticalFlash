"use client";

import { playMedia } from "@/lib/media-playback";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  GEMINI_PRICE_IN_PER_M,
  GEMINI_PRICE_OUT_PER_M,
} from "@/lib/gemini-pricing";
import { ShotTextEditor } from "@/components/form/ShotTextEditor";
import { ClipLibraryModal } from "@/components/form/ClipLibraryModal";
import {
  GenerationPanel,
  type ShotGenerations as ShotGenerationsData,
} from "@/components/form/GenerationPanel";
import { extractVideoId } from "@/lib/video-id";
import { MusicPicker } from "@/components/form/MusicPicker";
import { StoryboardPanel } from "@/components/form/StoryboardPanel";
import { ShotTimeline, type TimelineBroll, type TimelineResize } from "@/components/data/ShotTimeline";
import { BrollSegmentPopover } from "@/components/form/BrollSegmentPopover";
import type { BrollAnchor, BrollSegment, BrollTrack } from "@/lib/broll-schema";
import {
  anchorForRange,
  anchorForShot,
  brollCoverage,
  MIN_BROLL_SECONDS,
  phraseForAnchor,
  resolveBrollTrack,
  wordsForShot,
} from "@/lib/broll-resolve";
import type { DownloadEntryProject } from "@/lib/download-types";
import {
  footageToShortTime,
  shortToFootageTime,
  type RetimeEdit,
} from "@/lib/shot-retime";
import {
  endsSentence,
  LEAD_SECONDS,
  startsSentence,
  TAIL_SECONDS,
} from "@/lib/word-range";
import type { Sentence, Word } from "@/lib/segments-schema";

type AudioMode = "music" | "original" | "none";

interface AnalysisShot {
  index: number;
  start_time: number;
  end_time: number;
  description: string;
  on_screen_text: string;
  spoken_text: string;
  camera_style: string;
  tags?: string[];
  screenshot: string;
  // Cutdowns: where the shot lives in the footage (master or an attached
  // clip named by source_clip); the render cuts from there
  source_start?: number;
  source_end?: number;
  source_clip?: string;
}

interface Recommendation {
  filename: string;
  duration: number | null;
  confidence: "strong" | "moderate" | "weak";
  reason: string;
  source: "gemini" | "tags" | "manual" | "generated";
  tag_overlap: string[];
  score: number;
  trim_start?: number | null;
  trim_end?: number | null;
  moment_note?: string | null;
}

interface ClipPreview {
  filename: string;
  start: number | null;
  end: number | null;
}

interface ShotRecommendations {
  videoId: string;
  generatedAt: string;
  model: string;
  clipsConsidered: number;
  shots: Array<{
    shot_index: number;
    recommendations: Recommendation[];
    selected_filename?: string | null;
    // true = render from the source video at the shot's own time (no
    // library clip); set by storyboard cutdowns and the per-shot toggle
    keep_source?: boolean | null;
  }>;
}

const CONFIDENCE_STYLES: Record<Recommendation["confidence"], string> = {
  strong: "bg-green-500/15 text-green-600 dark:text-green-400",
  moderate: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  weak: "bg-muted text-muted-foreground",
};

interface RenderShot {
  shot_index: number;
  start_time: number;
  end_time: number;
  duration: number;
  clip: string | null;
  clip_source:
    | "selected"
    | "top_recommendation"
    | "generated"
    | "source"
    | "none";
  trim_start: number | null;
  trim_end: number | null;
  moment_note: string | null;
  time_of_day?: string | null;
  fill?: "freeze" | "loop" | "slow_mo" | "black" | null;
  edit_note?: string | null;
  edit_applied?: string | null;
  padded_seconds: number;
  skipped: Array<{ filename: string; reason: string }>;
  on_screen_text: string;
  spoken_text: string;
  // Absent on renders made before text burning existed
  burned_text?: string | null;
}

const FILL_LABELS: Record<string, string> = {
  freeze: "frozen",
  loop: "looped",
  slow_mo: "slowed",
  black: "black gap",
};

interface RenderManifest {
  videoId: string;
  renderedAt: string;
  sourceVideo: string;
  output: string;
  durationSeconds: number;
  recommendationsGeneratedAt: string;
  clipsConsidered: number;
  // Absent on manifests rendered before time-of-day matching existed
  time_mode?: "uniform" | "follow_original" | "none";
  time_target?: "day" | "night" | null;
  // Absent on manifests rendered before the audio option existed;
  // "music" (with `music`) on renders that carry a library track
  audio?: AudioMode;
  music?: {
    filename: string;
    title: string;
    author: string;
    looped: boolean;
  } | null;
  // Absent on manifests rendered before text burning existed
  text_burn?: {
    engine: string;
    preset: string;
    position: string;
    shots_burned: number;
  } | null;
  warnings: string[];
  shots: RenderShot[];
  // Absent on renders made before the B-roll track existed
  broll?: Array<{ id: string; filename: string; start: number; end: number; clip_start: number; phrase: string }>;
}

interface TextOverlaysData {
  videoId: string;
  updatedAt: string;
  // engine "png" is accepted but not built yet — the renderer burns with
  // ASS subtitles until the PNG overlay engine lands
  style: {
    engine: "ass" | "png";
    preset: "tiktok_box" | "outline" | "caption_bar";
    position: "top" | "center" | "bottom";
  };
  shots: Record<string, { text: string; include: boolean }>;
}

const DEFAULT_TEXT_STYLE: TextOverlaysData["style"] = {
  engine: "ass",
  preset: "tiktok_box",
  position: "top",
};

interface CaptionHashtag {
  tag: string;
  reason: string;
  source: "original" | "gemini";
  viewCount: number | null;
  videoCount: number | null;
  zone: "in" | "too-small" | "too-big" | "unknown";
}

interface CaptionsData {
  videoId: string;
  generatedAt: string;
  model: string;
  captions: Array<{ text: string; angle: string }>;
  hashtags: CaptionHashtag[];
  tikhubChecked: boolean;
  // The concept the creator typed when these were generated, if any
  concept?: string | null;
}

const ZONE_BADGES: Record<
  CaptionHashtag["zone"],
  { label: string; className: string }
> = {
  in: {
    label: "sweet spot",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
  },
  "too-small": {
    label: "niche",
    className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  },
  "too-big": {
    label: "crowded",
    className: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  unknown: {
    label: "unverified",
    className: "bg-muted text-muted-foreground",
  },
};

function formatViews(n: number | null): string | null {
  if (n == null) return null;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const CLIP_SOURCE_BADGES: Record<
  RenderShot["clip_source"],
  { label: string; className: string }
> = {
  selected: {
    label: "✓ selected",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
  },
  top_recommendation: {
    label: "top match",
    className: "bg-primary/15 text-primary",
  },
  generated: {
    label: "⚡ AI generated",
    className: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  source: {
    label: "original footage",
    className: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  },
  none: {
    label: "gap",
    className: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
};

interface Analysis {
  videoId: string;
  analyzedAt: string;
  model: string;
  summary: string;
  hook_description: string;
  format: string;
  tags: string[];
  music: {
    title: string;
    author: string;
    usage: string;
    usage_note: string;
  };
  full_transcript: string;
  shots: AnalysisShot[];
  usage?: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  taggedAt?: string;
  tagModel?: string;
  // Set by timeline edits; a render older than this is stale
  shotsEditedAt?: string;
}

// Timeline scale: pixels per second of video
const PX_PER_SEC = 56;

// Storyboard section of a cutdown's beat (beats map 1:1 to shots in order)
const SECTION_BADGES: Record<
  "hook" | "main" | "end",
  { label: string; className: string }
> = {
  hook: { label: "Hook", className: "bg-primary/15 text-primary" },
  main: { label: "Main", className: "bg-muted text-muted-foreground" },
  end: {
    label: "End",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
  },
};

// The brief-based project kinds (started from /create with a prompt + song)
const isBriefProject = (
  p: DownloadEntryProject | null
): p is Extract<DownloadEntryProject, { kind: "music" | "prompt" }> =>
  p?.kind === "music" || p?.kind === "prompt";

const timingLabel = (engine: "whisperx" | "gemini" | null | undefined) =>
  engine === "whisperx"
    ? "timing: WhisperX"
    : engine === "gemini"
      ? "timing: Gemini (approximate)"
      : "timing: default";

// Generated clips live in generated/<videoId>/, not the clip library
// (same regex as isGeneratedClip in src/lib/generation-schema.ts, local so
// the client bundle doesn't pull that module's @google/genai import)
const isGeneratedClip = (f: string) => /^gen_s\d+_a\d+\.mp4$/.test(f);

function formatCost(usage?: Analysis["usage"]): string | null {
  if (!usage || usage.promptTokens === undefined) return null;
  const cost =
    ((usage.promptTokens ?? 0) * GEMINI_PRICE_IN_PER_M +
      (usage.outputTokens ?? 0) * GEMINI_PRICE_OUT_PER_M) /
    1_000_000;
  if (cost < 0.005) return "$0.00 (effectively free)";
  return `$${cost.toFixed(2)}`;
}

// "0:04.2"-style clock for the shot cards
function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function VideoViewerContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const filename = decodeURIComponent(params.filename as string);
  const videoId = extractVideoId(filename);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [playbackError, setPlaybackError] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [selectedShot, setSelectedShot] = useState(0);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [recs, setRecs] = useState<ShotRecommendations | null>(null);
  const [generation, setGeneration] = useState<ShotGenerationsData | null>(
    null
  );
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [tagging, setTagging] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [previewClip, setPreviewClip] = useState<ClipPreview | null>(null);
  const [allClipsOpen, setAllClipsOpen] = useState(false);
  const [trimmingShot, setTrimmingShot] = useState<number | null>(null);
  const [panelTab, setPanelTab] = useState<
    "video" | "clips" | "storyboards" | "render" | "captions"
  >("video");
  // Master projects open their saved storyboards once analysis has loaded.
  const tabParamApplied = useRef(false);
  const [loopShot, setLoopShot] = useState(false);
  const [render, setRender] = useState<RenderManifest | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  // Soundtrack choice for the next render: defaults to the project's song
  // (created projects) or the original audio, then follows the last render
  const [audioMode, setAudioMode] = useState<AudioMode>("original");
  const [musicFilename, setMusicFilename] = useState<string | null>(null);
  const audioInitialized = useRef(false);
  const [project, setProject] = useState<DownloadEntryProject | null>(null);
  const [burnText, setBurnText] = useState(true);
  const [textOverlays, setTextOverlays] = useState<TextOverlaysData | null>(
    null
  );
  const [textSaving, setTextSaving] = useState(false);
  const [captions, setCaptions] = useState<CaptionsData | null>(null);
  const [captionsLoading, setCaptionsLoading] = useState(false);
  const [captionsError, setCaptionsError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Free-text direction for the caption writer (sent with the request)
  const [captionConcept, setCaptionConcept] = useState("");
  const [scriptOpen, setScriptOpen] = useState(false);
  const [editNotes, setEditNotes] = useState<Record<string, string>>({});
  const [noteShot, setNoteShot] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [tiktokStatus, setTiktokStatus] = useState<{
    connected: boolean;
    displayName?: string | null;
  } | null>(null);
  const [tiktokUploading, setTiktokUploading] = useState(false);
  const [tiktokResult, setTiktokResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Timeline re-timing in flight
  const [retiming, setRetiming] = useState(false);
  // A cutdown's master transcript, for snapping drags to words
  const [masterSegs, setMasterSegs] = useState<{ words: Word[]; sentences: Sentence[] } | null>(null);
  const [masterDuration, setMasterDuration] = useState<number | null>(null);
  // The B-roll track: voice-anchored segments over the speaker
  const [brollTrack, setBrollTrack] = useState<BrollTrack | null>(null);
  const [brollSelected, setBrollSelected] = useState<string | null>(null);
  const [brollRect, setBrollRect] = useState<DOMRect | null>(null);
  // Which B-roll step is running ("save", "suggest", "match", "moment")
  const [brollBusy, setBrollBusy] = useState<string | null>(null);
  // The segment the clip library modal is picking for (null = shot mode)
  const [brollLibraryFor, setBrollLibraryFor] = useState<string | null>(null);

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    fetch(`/api/analyze/${videoId}/broll`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.track) setBrollTrack(data.track);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // A cutdown whose shots all live in the master plays the master directly
  // and hops between the shots' footage ranges, so a length change on the
  // timeline previews without re-cutting anything
  const masterBacked =
    project?.kind === "cutdown" &&
    !!analysis &&
    analysis.shots.length > 0 &&
    analysis.shots.every((s) => s.source_start != null && s.source_end != null && !s.source_clip);
  const beatMap = masterBacked
    ? analysis!.shots.map((s) => ({
        source_start: s.source_start!,
        source_end: s.source_end!,
        start: s.start_time,
        end: s.end_time,
      }))
    : [];
  // The player's own time for a shot's start
  const playerTimeFor = (index: number): number => {
    const s = analysis?.shots[index];
    if (!s) return 0;
    return masterBacked ? s.source_start! : s.start_time;
  };

  useEffect(() => {
    // Use the API route to serve the video file (the master for a
    // master-backed cutdown)
    setVideoUrl(
      masterBacked && project?.kind === "cutdown"
        ? `/api/downloads/${encodeURIComponent(project.masterFilename)}`
        : `/api/downloads/${encodeURIComponent(filename)}`
    );
    setPlaybackError(false);
  }, [filename, masterBacked, project]);

  // The master's word timing, for word snapping on the timeline
  useEffect(() => {
    if (project?.kind !== "cutdown") return;
    let cancelled = false;
    fetch(`/api/master/${project.masterId}/segments`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setMasterSegs({ words: data.words ?? [], sentences: data.sentences ?? [] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project]);

  // TikTok connection state (single account; also surfaces the OAuth
  // redirect result via ?tiktok_connected / ?tiktok_error)
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tiktok/auth/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setTiktokStatus(data);
      })
      .catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.get("tiktok_error")) {
      setTiktokResult({
        ok: false,
        message: `TikTok connect failed (${params.get("tiktok_error")})`,
      });
    } else if (params.get("tiktok_connected")) {
      setPanelTab("render");
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTiktokConnect = () => {
    const returnTo = window.location.pathname;
    window.location.href = `/api/tiktok/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  };

  const handleTiktokDisconnect = async () => {
    await fetch("/api/tiktok/auth/status", { method: "DELETE" }).catch(
      () => {}
    );
    setTiktokStatus({ connected: false });
    setTiktokResult(null);
  };

  const handleTiktokUpload = async () => {
    if (!videoId || tiktokUploading) return;
    setTiktokUploading(true);
    setTiktokResult(null);
    try {
      const res = await fetch("/api/tiktok/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "not_connected") {
          setTiktokStatus({ connected: false });
          throw new Error("Connect your TikTok account first");
        }
        throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
      }
      setTiktokResult({
        ok: true,
        message:
          "Sent to your TikTok inbox — open the TikTok app, find it in your notifications/drafts, add the caption and post.",
      });
    } catch (error) {
      setTiktokResult({
        ok: false,
        message: error instanceof Error ? error.message : "Upload failed",
      });
    } finally {
      setTiktokUploading(false);
    }
  };

  // Display name ("Download N" or a user-given name) from the downloads list
  useEffect(() => {
    let cancelled = false;
    fetch("/api/downloads")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const file = (data.files || []).find(
          (f: { name: string }) => f.name === filename
        );
        if (file?.displayName) setDisplayName(file.displayName);
        const proj: DownloadEntryProject | null = file?.project ?? null;
        setProject(proj);
        // A song project defaults to its song unless a render already
        // chose otherwise; masters and cutdowns keep "original" (the
        // speaker's voice is the point)
        if (
          isBriefProject(proj) &&
          proj.music &&
          !audioInitialized.current
        ) {
          setAudioMode("music");
          setMusicFilename(proj.music.filename);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filename]);

  const saveName = async () => {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === displayName) return;
    setDisplayName(trimmed);
    try {
      const res = await fetch("/api/downloads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, displayName: trimmed }),
      });
      if (!res.ok) throw new Error("rename failed");
      // Let the sidebar pick up the new name
      window.dispatchEvent(new Event("downloads-changed"));
    } catch {
      alert("Failed to save the name");
    }
  };

  // Load a previously saved analysis + clip recommendations, if any
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    fetch(`/api/analyze/${videoId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setAnalysis(data);
          setSelectedShot(0);
        }
      })
      .catch(() => {});
    fetch(`/api/analyze/${videoId}/recommendations`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setRecs(data);
      })
      .catch(() => {});
    fetch(`/api/analyze/${videoId}/generation`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setGeneration(data);
      })
      .catch(() => {});
    fetch(`/api/analyze/${videoId}/render`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setRender(data);
          // The last render's soundtrack is the starting point
          const manifest = data as RenderManifest;
          if (manifest.audio) {
            audioInitialized.current = true;
            setAudioMode(manifest.audio);
            if (manifest.music?.filename) {
              setMusicFilename(manifest.music.filename);
            }
          }
        }
      })
      .catch(() => {});
    fetch(`/api/analyze/${videoId}/edit-notes`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setEditNotes(data.notes || {});
      })
      .catch(() => {});
    fetch(`/api/analyze/${videoId}/text-overlays`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setTextOverlays(data);
      })
      .catch(() => {});
    fetch(`/api/analyze/${videoId}/captions`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setCaptions(data);
          if (data.concept) setCaptionConcept(data.concept);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  // Keep the selected shot's column centered in the timeline (scroll only
  // the strip itself — scrollIntoView would also drag the page's scroll)
  useEffect(() => {
    const strip = timelineRef.current;
    const s = analysis?.shots[selectedShot];
    if (strip && s) {
      const center = ((s.start_time + s.end_time) / 2) * PX_PER_SEC;
      strip.scrollTo({
        left: center - strip.clientWidth / 2,
        behavior: "smooth",
      });
    }
  }, [selectedShot, analysis]);

  // Both legacy Downloads links and Storyboarding links open the saved ideas.
  useEffect(() => {
    if (tabParamApplied.current) return;
    if (!analysis || project?.kind !== "master") return;
    tabParamApplied.current = true;
    setPanelTab("storyboards");
  }, [analysis, project, searchParams]);

  // Space toggles play/pause anywhere on the page (except while an
  // interactive element is focused — buttons/inputs keep native behavior)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest(
          "button, input, textarea, select, a, video, [contenteditable]"
        )
      ) {
        return;
      }
      e.preventDefault();
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) playMedia(video).catch(() => {});
      else video.pause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // In the clips tab, auto-open the selected shot's top recommendation
  useEffect(() => {
    if (panelTab !== "clips") return;
    const first = recs?.shots.find((s) => s.shot_index === selectedShot)
      ?.recommendations[0];
    setPreviewClip(
      first
        ? {
            filename: first.filename,
            start: first.trim_start ?? null,
            end: first.trim_end ?? null,
          }
        : null
    );
  }, [panelTab, selectedShot, recs]);

  const handleAnalyze = async () => {
    if (!videoId || analyzing) return;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Analysis failed (HTTP ${res.status})`);
      }
      setAnalysis(data);
      setSelectedShot(0);
    } catch (error) {
      setAnalysisError(
        error instanceof Error ? error.message : "Analysis failed"
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleGenerateTags = async () => {
    if (!videoId || tagging) return;
    setTagging(true);
    setTagError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}/tags`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Tagging failed (HTTP ${res.status})`);
      }
      setAnalysis(data);
    } catch (error) {
      setTagError(error instanceof Error ? error.message : "Tagging failed");
    } finally {
      setTagging(false);
    }
  };

  const handleMatch = async () => {
    if (!videoId || matching) return;
    setMatching(true);
    setMatchError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}/recommendations`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Matching failed (HTTP ${res.status})`);
      }
      setRecs(data);
    } catch (error) {
      setMatchError(
        error instanceof Error ? error.message : "Matching failed"
      );
    } finally {
      setMatching(false);
    }
  };

  // Save (or clear, when empty) the fix note for one shot
  const saveNote = async (shotIndex: number): Promise<boolean> => {
    if (!videoId || noteSaving) return false;
    setNoteSaving(true);
    try {
      const res = await fetch(`/api/analyze/${videoId}/edit-notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shot_index: shotIndex, note: noteDraft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Saving the note failed");
      setEditNotes(data.notes || {});
      setNoteShot(null);
      return true;
    } catch (error) {
      alert(error instanceof Error ? error.message : "Saving the note failed");
      return false;
    } finally {
      setNoteSaving(false);
    }
  };

  // One-click path: save the note, then rebuild the video with it applied
  const saveNoteAndRender = async (shotIndex: number) => {
    if (rendering) return;
    const saved = await saveNote(shotIndex);
    if (saved) await handleRender();
  };

  // Save a per-shot text override/toggle ({shot_index, text, include} or
  // {shot_index, reset}) or a burn-style change ({style}) for the render's
  // text burn stage
  const patchTextOverlays = async (body: object) => {
    if (!videoId || textSaving) return;
    setTextSaving(true);
    try {
      const res = await fetch(`/api/analyze/${videoId}/text-overlays`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Saving the text failed");
      setTextOverlays(data);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Saving the text failed");
    } finally {
      setTextSaving(false);
    }
  };

  const handleGenerateCaptions = async () => {
    if (!videoId || captionsLoading) return;
    setCaptionsLoading(true);
    setCaptionsError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}/captions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: captionConcept.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Captions failed (HTTP ${res.status})`);
      }
      setCaptions(data);
    } catch (error) {
      setCaptionsError(
        error instanceof Error ? error.message : "Caption generation failed"
      );
    } finally {
      setCaptionsLoading(false);
    }
  };

  // Copy with a brief "✓ copied" acknowledgment on the clicked button
  const copyText = (key: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      })
      .catch(() => alert("Copying failed"));
  };

  const handleRender = async () => {
    if (!videoId || rendering) return;
    setRendering(true);
    setRenderError(null);
    try {
      const res = await fetch(`/api/analyze/${videoId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: audioMode,
          music_filename: audioMode === "music" ? musicFilename : null,
          include_original_audio: audioMode === "original",
          burn_text: burnText,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Render failed (HTTP ${res.status})`);
      }
      setRender(data);
      setPanelTab("render");
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "Render failed");
    } finally {
      setRendering(false);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) playMedia(video).catch(() => {});
    else video.pause();
  };

  const selectShot = (index: number, seek = true) => {
    if (!analysis) return;
    const clamped = Math.max(0, Math.min(index, analysis.shots.length - 1));
    // Clicking the shot that's already selected toggles play/pause
    // instead of re-seeking to its start
    if (seek && clamped === selectedShot) {
      togglePlay();
      return;
    }
    setSelectedShot(clamped);
    if (seek) {
      setPlayheadTime(analysis.shots[clamped].start_time);
      const video = videoRef.current;
      if (video) {
        video.currentTime = playerTimeFor(clamped);
        playMedia(video).catch(() => {});
      }
    }
  };

  // Follow playback: move the playhead and highlight the shot under it
  const handleTimeUpdate = () => {
    if (!analysis) return;
    const video = videoRef.current;
    if (!video) return;
    const t = video.currentTime;

    // Master-backed cutdown: the player runs on the master, so hop between
    // the shots' footage ranges and map its time onto the short's timeline
    if (masterBacked) {
      const beat = beatMap[selectedShot];
      if (!beat) return;
      if (t >= beat.source_end - 0.02) {
        if (loopShot) {
          video.currentTime = beat.source_start;
          setPlayheadTime(beat.start);
          return;
        }
        const next = beatMap[selectedShot + 1];
        if (next) {
          setSelectedShot(selectedShot + 1);
          video.currentTime = next.source_start;
          setPlayheadTime(next.start);
        } else {
          video.pause();
          setPlayheadTime(beat.end);
        }
        return;
      }
      if (t < beat.source_start - 0.05) {
        // Scrubbed with the native controls: follow whichever shot the
        // master time falls in, else stay put
        const mapped = footageToShortTime(beatMap, t);
        if (mapped) {
          setSelectedShot(mapped.index);
          setPlayheadTime(mapped.time);
        }
        return;
      }
      setPlayheadTime(beat.start + (t - beat.source_start));
      return;
    }

    // Loop mode: cycle the selected shot instead of playing through
    if (loopShot) {
      const s = analysis.shots[selectedShot];
      if (s && (t >= s.end_time || t < s.start_time - 0.05)) {
        video.currentTime = s.start_time;
        setPlayheadTime(s.start_time);
        return;
      }
      setPlayheadTime(t);
      return;
    }

    setPlayheadTime(t);
    const idx = analysis.shots.findIndex(
      (s) => t >= s.start_time && t < s.end_time
    );
    if (idx !== -1 && idx !== selectedShot) setSelectedShot(idx);
  };

  // Timeline drag: persist the new shot times (the server re-lays the
  // cutdown's timeline and refreshes the affected frames)
  const patchShotTimes = async (edit: RetimeEdit) => {
    if (!videoId || retiming) return;
    setRetiming(true);
    try {
      const res = await fetch(`/api/analyze/${videoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots: [edit] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-timing the shot failed");
      setAnalysis(data);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Re-timing the shot failed");
    } finally {
      setRetiming(false);
    }
  };

  // Pull a dragged footage time onto the nearest word boundary (the same
  // lead/tail the storyboard cut uses) and flag mid-sentence landings
  const snapToWords = (
    _index: number,
    edge: "start" | "end",
    t: number
  ): { time: number; midSentence: boolean } | null => {
    if (!masterSegs?.words.length) return null;
    const { words, sentences } = masterSegs;
    if (edge === "end") {
      let w = -1;
      for (let i = 0; i < words.length; i++) {
        if (words[i].end <= t + 0.3) w = i;
        else break;
      }
      if (w < 0) return null;
      const next = words[w + 1];
      const time = Math.min(words[w].end + TAIL_SECONDS, next ? next.start : Infinity);
      if (Math.abs(time - t) > 0.4) return null;
      return { time, midSentence: !endsSentence(sentences, words[w].i) };
    }
    const w = words.findIndex((x) => x.start >= t - 0.3);
    if (w < 0) return null;
    const prev = words[w - 1];
    const time = Math.max(words[w].start - LEAD_SECONDS, prev ? prev.end : 0);
    if (Math.abs(time - t) > 0.4) return null;
    return { time, midSentence: !startsSentence(sentences, words[w].i) };
  };

  // Looping changes playback behavior without starting another player.
  const toggleLoopShot = () => {
    const next = !loopShot;
    setLoopShot(next);
    if (!next) return;
    const s = analysis?.shots[selectedShot];
    const video = videoRef.current;
    if (video && s) {
      video.currentTime = playerTimeFor(selectedShot);
      setPlayheadTime(s.start_time);
    }
    const preview = previewVideoRef.current;
    if (preview) {
      preview.currentTime = previewClip?.start ?? 0;
    }
  };

  // Persist (or clear) the confirmed clip choice for the current shot
  const patchSelection = async (
    filename: string | null
  ): Promise<ShotRecommendations | null> => {
    if (!videoId) return null;
    try {
      const res = await fetch(`/api/analyze/${videoId}/recommendations`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shot_index: selectedShot, filename }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Selection failed");
      setRecs(data);
      return data;
    } catch (error) {
      alert(error instanceof Error ? error.message : "Selection failed");
      return null;
    }
  };

  // Flip the current shot between its original footage and a library clip
  const patchKeepSource = async (keepSource: boolean) => {
    if (!videoId) return;
    try {
      const res = await fetch(`/api/analyze/${videoId}/recommendations`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shot_index: selectedShot,
          keep_source: keepSource,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Saving the toggle failed");
      setRecs(data);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Saving the toggle failed"
      );
    }
  };

  // Seek the main player to a time (storyboard beats, shot cards)
  const seekTo = (seconds: number, _source?: unknown, request?: number) => {
    const video = videoRef.current;
    if (!video) return;
    if (masterBacked) {
      const idx = beatMap.findIndex((b) => seconds >= b.start && seconds < b.end);
      if (idx !== -1) setSelectedShot(idx);
      video.currentTime = shortToFootageTime(beatMap, seconds);
    } else {
      video.currentTime = seconds;
    }
    setPlayheadTime(seconds);
    playMedia(video, request).catch(() => {});
  };

  // Confirm (or clear) the previewed clip as this shot's replacement
  const selectClip = async () => {
    if (!previewClip || !recs) return;
    const current = recs.shots.find(
      (s) => s.shot_index === selectedShot
    )?.selected_filename;
    await patchSelection(
      current === previewClip.filename ? null : previewClip.filename
    );
  };

  // A pick from the All Clips modal: select it, then have Gemini choose
  // which segment of the clip should fill the shot
  const selectFromLibrary = async (filename: string) => {
    const shotIdx = selectedShot;
    const updated = await patchSelection(filename);
    if (!updated) return;
    setAllClipsOpen(false);

    const rec = updated.shots
      .find((s) => s.shot_index === shotIdx)
      ?.recommendations.find((r) => r.filename === filename);
    setPreviewClip({
      filename,
      start: rec?.trim_start ?? null,
      end: rec?.trim_end ?? null,
    });

    // Existing recommendations already carry a trim window; only manual
    // picks arrive without one
    if (!videoId || rec?.trim_start != null) return;
    setTrimmingShot(shotIdx);
    try {
      const res = await fetch(`/api/analyze/${videoId}/recommendations/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shot_index: shotIdx, filename }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Trim failed");
      setRecs(data);
      const trimmed = (data as ShotRecommendations).shots
        .find((s) => s.shot_index === shotIdx)
        ?.recommendations.find((r) => r.filename === filename);
      if (trimmed?.trim_start != null) {
        setPreviewClip((prev) =>
          prev?.filename === filename
            ? {
                filename,
                start: trimmed.trim_start ?? null,
                end: trimmed.trim_end ?? null,
              }
            : prev
        );
      }
    } catch (error) {
      // The pick stands; it just renders without a suggested moment
      console.error("moment pick failed:", error);
    } finally {
      setTrimmingShot(null);
    }
  };

  const handleDownload = async () => {
    try {
      const response = await fetch(`/api/downloads/${encodeURIComponent(filename)}`);
      if (!response.ok) throw new Error("Download failed");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      alert(`Download failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const cost = formatCost(analysis?.usage);
  const shot = analysis?.shots[selectedShot];
  const recsByShot = new Map(
    (recs?.shots || []).map((s) => [s.shot_index, s.recommendations])
  );
  const selectedByShot = new Map(
    (recs?.shots || []).map((s) => [s.shot_index, s.selected_filename ?? null])
  );
  const keepSourceByShot = new Map(
    (recs?.shots || []).map((s) => [s.shot_index, s.keep_source === true])
  );
  const selectedRecs = recsByShot.get(selectedShot) || [];
  const selectedClipFilename =
    recs?.shots.find((s) => s.shot_index === selectedShot)
      ?.selected_filename ?? null;
  const selectedKeepSource = keepSourceByShot.get(selectedShot) === true;
  // Cutdown beats map 1:1 to shots, so a shot's section is its beat's
  const sectionForShot = (index: number) =>
    project?.kind === "cutdown" ? (project.beats[index]?.section ?? null) : null;

  // Media URLs branch on where the clip lives (library vs generated)
  const thumbSrc = (clipFilename: string) =>
    isGeneratedClip(clipFilename)
      ? `/api/generated/${videoId}/${encodeURIComponent(clipFilename)}?thumb=1`
      : `/api/library/thumbs/${encodeURIComponent(clipFilename)}`;
  const clipSrc = (clipFilename: string) =>
    isGeneratedClip(clipFilename)
      ? `/api/generated/${videoId}/${encodeURIComponent(clipFilename)}`
      : `/api/library/clips/${encodeURIComponent(clipFilename)}`;

  // A shot where the render would hit a gap: nothing recommended at all, or
  // the chosen/best clip can't cover the shot (same 0.1s tolerance as the
  // renderer's eligibility rule) — these get the ⚡ generate suggestion
  const gapForShot = (index: number): boolean => {
    const s = analysis?.shots[index];
    if (!s || !recs) return false;
    // Original footage always covers its own shot
    if (keepSourceByShot.get(index)) return false;
    const duration = s.end_time - s.start_time;
    const shotRecs = recsByShot.get(index) || [];
    const sel = selectedByShot.get(index);
    const chosen = sel
      ? (shotRecs.find((r) => r.filename === sel) ?? null)
      : (shotRecs[0] ?? null);
    if (!chosen) return true;
    return chosen.duration != null && chosen.duration < duration - 0.1;
  };

  const textStyle = textOverlays?.style ?? DEFAULT_TEXT_STYLE;

  // Shot frames are regenerated in place by timeline edits; bust the cache
  const shotThumb = (s: AnalysisShot) =>
    analysis?.shotsEditedAt ? `${s.screenshot}?v=${encodeURIComponent(analysis.shotsEditedAt)}` : s.screenshot;

  // Draggable shot boundaries: footage ranges for cutdowns, split points
  // for everything else
  const timelineResize: TimelineResize | null =
    videoId && analysis
      ? {
          mode: project?.kind === "cutdown" ? "source" : "split",
          footageMax: masterBacked && masterDuration ? masterDuration : undefined,
          busy: retiming,
          onCommit: patchShotTimes,
          snap: masterBacked && masterSegs?.words.length ? snapToWords : undefined,
        }
      : null;
  // ---- B-roll track: resolve anchors to seconds, and the edit handlers ---
  const masterWords = masterSegs?.words ?? null;
  // Attached-footage shots have no master words: resolve them by offset
  const brollShots = (analysis?.shots ?? []).map((s) =>
    s.source_clip ? { ...s, source_start: undefined, source_end: undefined } : s
  );
  const brollResolved = brollTrack && analysis ? resolveBrollTrack(brollTrack, brollShots, masterWords) : [];
  const brollBlocks = (brollTrack?.segments ?? []).map((s) => {
    const r = brollResolved.find((x) => x.id === s.id);
    return {
      id: s.id,
      start: r?.start ?? 0,
      end: r?.end ?? 0,
      valid: r?.valid ?? false,
      reason: r?.reason,
      status: s.status,
      clip: s.clip,
      phrase: s.phrase,
      description: s.description,
    };
  });
  const shortLength = analysis?.shots.length ? analysis.shots[analysis.shots.length - 1].end_time : 0;
  const brollShotAt = (t: number) =>
    brollShots.find((s) => t >= s.start_time && t < s.end_time) ?? brollShots[brollShots.length - 1];

  const saveBroll = async (segments: BrollSegment[]) => {
    if (!videoId) return false;
    setBrollBusy("save");
    try {
      const res = await fetch(`/api/analyze/${videoId}/broll`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Saving the B-roll track failed");
      setBrollTrack(data.track);
      return true;
    } catch (error) {
      alert(error instanceof Error ? error.message : "Saving the B-roll track failed");
      return false;
    } finally {
      setBrollBusy(null);
    }
  };
  const newBrollSegment = (anchor: BrollAnchor, extras: Partial<BrollSegment> = {}): BrollSegment => ({
    id: Math.random().toString(36).slice(2, 10),
    anchor,
    clip: null,
    status: "placed",
    phrase: phraseForAnchor(anchor, masterWords),
    description: null,
    candidates: [],
    createdAt: new Date().toISOString(),
    ...extras,
  });
  const addBrollSegment = async (segment: BrollSegment) => {
    const ok = await saveBroll([...(brollTrack?.segments ?? []), segment]);
    if (ok) {
      setBrollSelected(segment.id);
      setBrollRect(null);
    }
  };
  const brollUpdate = (id: string, patch: (s: BrollSegment) => BrollSegment) =>
    saveBroll((brollTrack?.segments ?? []).map((s) => (s.id === id ? patch(s) : s)));
  const brollCreateFromWords = (shotIndex: number, startWord: number, endWord: number) => {
    addBrollSegment(newBrollSegment({ kind: "words", shot_index: shotIndex, start_word: startWord, end_word: endWord }));
  };
  const brollCreateAt = (t: number) => {
    const shot = brollShotAt(t);
    if (!shot) return;
    const end = Math.min(shot.end_time, t + 3);
    const start = Math.max(shot.start_time, Math.min(t, end - MIN_BROLL_SECONDS));
    if (end - start < MIN_BROLL_SECONDS) return;
    addBrollSegment(newBrollSegment(anchorForRange(shot, start, end, masterWords)));
  };
  const brollChangeRange = (id: string, start: number, end: number) => {
    const seg = brollTrack?.segments.find((s) => s.id === id);
    const shot = seg && brollShots.find((s) => s.index === seg.anchor.shot_index);
    if (!seg || !shot) return;
    const anchor = anchorForRange(shot, start, end, masterWords);
    brollUpdate(id, (s) => ({ ...s, anchor, phrase: phraseForAnchor(anchor, masterWords) }));
  };
  const brollRemove = (id: string) => {
    if (brollSelected === id) setBrollSelected(null);
    saveBroll((brollTrack?.segments ?? []).filter((s) => s.id !== id));
  };
  const brollSetClip = (id: string, filename: string, clipStart: number | null) =>
    brollUpdate(id, (s) => ({
      ...s,
      clip: { filename, clip_start: clipStart, source: isGeneratedClip(filename) ? "generated" : "library" },
    }));
  const brollPlaceRec = (shotIndex: number, rec: { filename: string; trim_start?: number | null }) => {
    const shot = brollShots.find((s) => s.index === shotIndex);
    if (!shot) return;
    addBrollSegment(
      newBrollSegment(anchorForShot(shot, masterWords), {
        clip: {
          filename: rec.filename,
          clip_start: rec.trim_start ?? null,
          source: isGeneratedClip(rec.filename) ? "generated" : "library",
        },
      })
    );
  };
  const runBroll = async (action: "suggest" | "match" | "moment", segmentIds?: string[]) => {
    if (!videoId || brollBusy) return;
    setBrollBusy(action);
    try {
      const res = await fetch(`/api/analyze/${videoId}/broll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, segment_ids: segmentIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `B-roll ${action} failed`);
      setBrollTrack(data.track);
    } catch (error) {
      alert(error instanceof Error ? error.message : `B-roll ${action} failed`);
    } finally {
      setBrollBusy(null);
    }
  };
  const timelineBroll: TimelineBroll | null =
    videoId && analysis
      ? {
          blocks: brollBlocks,
          selectedId: brollSelected,
          coverage: {
            covered: brollCoverage(
              brollResolved.filter((r) => {
                const seg = brollTrack?.segments.find((s) => s.id === r.id);
                return seg?.status === "placed" && !!seg.clip;
              })
            ),
            total: shortLength,
          },
          busy: brollBusy != null,
          thumbSrc,
          onSelect: (id, rect) => {
            setBrollSelected(id);
            setBrollRect(rect);
          },
          onChangeRange: brollChangeRange,
          onCreateAt: brollCreateAt,
          onRemove: brollRemove,
          onAcceptAll: () =>
            saveBroll(
              (brollTrack?.segments ?? []).map((s) => (s.status === "suggested" && s.clip ? { ...s, status: "placed" } : s))
            ),
          wordsForShot:
            masterBacked && masterWords
              ? (i) => {
                  const shot = brollShots.find((s) => s.index === i);
                  return shot ? wordsForShot(masterWords, shot) : [];
                }
              : undefined,
          onPhrase: masterBacked && masterWords ? brollCreateFromWords : undefined,
          onPlaceRec: brollPlaceRec,
        }
      : null;

  const renderStale =
    !!render &&
    ((!!analysis?.shotsEditedAt &&
      new Date(render.renderedAt).getTime() < new Date(analysis.shotsEditedAt).getTime()) ||
      (!!brollTrack &&
        brollTrack.segments.length > 0 &&
        new Date(render.renderedAt).getTime() < new Date(brollTrack.updatedAt).getTime()));

  // What a render would use per shot: your pick, the top match, or nothing
  const renderBreakdown = recs
    ? recs.shots.reduce(
        (acc, s) => {
          if (s.keep_source) acc.source += 1;
          else if (s.selected_filename) acc.selected += 1;
          else if (s.recommendations.length > 0) acc.fallback += 1;
          else acc.none += 1;
          return acc;
        },
        { source: 0, selected: 0, fallback: 0, none: 0 }
      )
    : null;

  // Soundtrack picker (None / Original / Song) — in the render controls and
  // again in the render tab so a re-render can switch audio from there
  const audioControls = (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide text-[10px]">
          Audio
        </span>
        {(
          [
            ["none", "None"],
            ["original", isBriefProject(project) ? "Placeholder track" : "Original"],
            ["music", "Song"],
          ] as Array<[AudioMode, string]>
        ).map(([mode, label]) => (
          <label
            key={mode}
            className="flex items-center gap-1 cursor-pointer select-none"
          >
            <input
              type="radio"
              name="audio-mode"
              checked={audioMode === mode}
              onChange={() => setAudioMode(mode)}
              className="accent-current"
            />
            {label}
          </label>
        ))}
      </div>
      {audioMode === "music" && (
        <div className="rounded-md border border-border p-2">
          <MusicPicker
            compact
            value={musicFilename}
            onChange={(track) => setMusicFilename(track?.filename ?? null)}
          />
          {!musicFilename && (
            <p className="mt-1 text-[10px] text-yellow-700 dark:text-yellow-400">
              Pick a song — without one the render falls back to the original
              audio.
            </p>
          )}
          <p className="mt-1 text-[10px] text-muted-foreground">
            Songs shorter than the video loop to fill it.
          </p>
        </div>
      )}
    </div>
  );

  // Per-shot fix note: the inline editor (Save & re-render / Save only) or
  // the "✎ Add fix note" chip that opens it. `flagged` tints the chip when
  // the shot needs attention (a render gap, no clip, a skipped clip)
  const noteEditor = (shotIndex: number, flagged: boolean) =>
    noteShot === shotIndex ? (
      <div className="flex flex-col gap-1 mt-0.5">
        <textarea
          autoFocus
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder='How should this shot be fixed? e.g. "loop the clip to fill the shot", "use IMG_0072 and start at 3s", "reuse the clip from shot 3". Save empty to clear.'
          className="w-full text-xs rounded-md border border-border bg-transparent p-1.5 outline-none focus:border-primary resize-y"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => saveNoteAndRender(shotIndex)}
            disabled={noteSaving || rendering}
            className="px-2 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-semibold disabled:opacity-60"
          >
            {rendering
              ? "Rendering…"
              : noteSaving
                ? "Saving…"
                : "Save & re-render"}
          </button>
          <button
            onClick={() => saveNote(shotIndex)}
            disabled={noteSaving || rendering}
            className="px-2 py-1 rounded-md border border-border text-[10px] font-semibold text-foreground hover:bg-muted/40 disabled:opacity-60"
          >
            Save only
          </button>
          <button
            onClick={() => setNoteShot(null)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <button
        onClick={() => {
          setNoteShot(shotIndex);
          setNoteDraft(editNotes[String(shotIndex)] || "");
        }}
        className={`self-start text-left text-[10px] mt-0.5 rounded-md px-1.5 py-0.5 border transition-colors ${
          editNotes[String(shotIndex)]
            ? "border-primary/40 text-primary hover:bg-primary/10"
            : flagged
              ? "border-yellow-500/50 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-500/10"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
        }`}
      >
        ✎ {editNotes[String(shotIndex)] || "Add fix note"}
      </button>
    );

  // Title + filename: above the tabs once an analysis exists, standalone
  // (with the Gemini action) before one
  const titleBlock = (
      <div>
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") setEditingName(false);
            }}
            maxLength={100}
            className="text-lg font-bold text-foreground bg-transparent border-b border-primary/50 outline-none w-full"
          />
        ) : (
          <button
            onClick={() => {
              setNameDraft(displayName);
              setEditingName(true);
            }}
            className="group flex items-center gap-2 text-left max-w-full"
            title="Click to rename"
          >
            <h1 className="text-lg font-bold text-foreground truncate">
              Editing - {displayName || "Download"}
            </h1>
            <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              ✎ rename
            </span>
          </button>
        )}
        <p className="text-xs text-muted-foreground mt-1 truncate">
          {filename}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {project?.kind === "music"
            ? `Song project · ${project.music?.title ?? ""}${project.music?.author ? ` — ${project.music.author}` : ""} · ${project.targetDuration}s • Tap to play/pause`
            : project?.kind === "prompt"
              ? `Idea project · ${project.targetDuration}s • Tap to play/pause`
              : project?.kind === "master"
                ? `Master · ${project.sourceClips.length} source clip${project.sourceClips.length === 1 ? "" : "s"} · ${timingLabel(project.timingEngine)} • Tap to play/pause`
                : project?.kind === "cutdown"
                  ? `Short from master · ${project.targetDuration}s · ${project.beats.length} beat${project.beats.length === 1 ? "" : "s"} · ${timingLabel(project.timingSource)} • Tap to play/pause`
                  : "Downloaded video • Tap to play/pause"}
          {project?.kind === "cutdown" && (
            <>
              {" · "}
              <a
                href={`/downloads/${encodeURIComponent(project.masterFilename)}`}
                className="underline hover:text-foreground"
              >
                Open master
              </a>
            </>
          )}
        </p>
        {isBriefProject(project) && project.prompt && (
          <p className="text-xs text-foreground/80 mt-1 line-clamp-3">
            {project.prompt}
          </p>
        )}
        {project?.kind === "cutdown" && project.hookLine && (
          <p className="text-xs text-foreground/80 mt-1 line-clamp-3">
            {project.hookLine}
          </p>
        )}
      </div>
  );

  // The Gemini pipeline (analyze → match B-roll → tag → render) and the
  // render settings — the Render Details tab, or standalone before analysis
  const actionButtonClass =
    "w-full px-4 py-2 text-base bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
  const geminiActions = (
    <div className="flex flex-col gap-3">
      {videoId && (
        <button
          onClick={handleAnalyze}
          disabled={analyzing}
          className={actionButtonClass}
        >
          {project?.kind === "master"
            ? analyzing
              ? "Analyzing master… (transcribe + segment, can take a few minutes)"
              : analysis
                ? "Re-analyze master"
                : "Analyze master (transcribe + segment)"
            : project?.kind === "cutdown"
              ? analyzing
                ? "Rebuilding shots from storyboard…"
                : "Rebuild shots from storyboard"
              : analyzing
                ? project
                  ? "Planning shots with Gemini… (can take a minute)"
                  : "Analyzing with Gemini… (can take a minute)"
                : analysis
                  ? project
                    ? "Re-plan shots with Gemini"
                    : "Re-process video with Gemini"
                  : project
                    ? "Plan shots with Gemini"
                    : "Process video with Gemini"}
        </button>
      )}

      {videoId && analysis && (
        <button
          onClick={handleMatch}
          disabled={matching}
          className={actionButtonClass}
        >
          {matching
            ? "Matching recommended B-roll clips…"
            : recs
              ? "Re-match recommended B-roll clips"
              : "Match recommended B-roll clips"}
        </button>
      )}

      {videoId && analysis && (
        <button
          onClick={handleGenerateTags}
          disabled={tagging}
          className={actionButtonClass}
        >
          {tagging
            ? "Tagging shots…"
            : analysis.taggedAt
              ? "Re-generate shot tags"
              : "Generate shot tags"}
        </button>
      )}

      {videoId && analysis && (
        <div className="flex flex-col gap-3">
          <button
            onClick={handleRender}
            disabled={rendering || !recs}
            title={
              recs ? undefined : "Match recommended B-roll clips first"
            }
            className={actionButtonClass}
          >
            {rendering
              ? "Rendering video… (~1 min)"
              : render
                ? "Re-render video"
                : "Render video"}
          </button>
          {audioControls}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={burnText}
              onChange={(e) => setBurnText(e.target.checked)}
              className="accent-current"
            />
            Burn the on-screen text onto the video
          </label>
          {burnText && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <select
                  value={textStyle.preset}
                  onChange={(e) =>
                    patchTextOverlays({ style: { preset: e.target.value } })
                  }
                  disabled={textSaving}
                  aria-label="Text style preset"
                  className="text-xs rounded-lg border border-border bg-transparent px-1.5 py-1 outline-none focus:border-primary disabled:opacity-60"
                >
                  <option value="tiktok_box">TikTok box</option>
                  <option value="outline">Bold outline</option>
                  <option value="caption_bar">Caption bar</option>
                  <option value="tiktok_pill" disabled>
                    TikTok pill (PNG overlay — planned)
                  </option>
                </select>
                <select
                  value={textStyle.position}
                  onChange={(e) =>
                    patchTextOverlays({ style: { position: e.target.value } })
                  }
                  disabled={textSaving}
                  aria-label="Text position"
                  className="text-xs rounded-lg border border-border bg-transparent px-1.5 py-1 outline-none focus:border-primary disabled:opacity-60"
                >
                  <option value="top">Upper third</option>
                  <option value="center">Center</option>
                  <option value="bottom">Lower third</option>
                </select>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Edit each shot&apos;s text in the B-Roll Clips tab · burned as
                ASS subtitles
              </p>
            </div>
          )}
          {renderBreakdown && (
            <p className="text-[10px] text-muted-foreground">
              {renderBreakdown.selected} shot
              {renderBreakdown.selected === 1 ? "" : "s"} use your selected
              clip · {renderBreakdown.fallback} fall back to the top match
              {renderBreakdown.source > 0 &&
                ` · ${renderBreakdown.source} use original footage`}
              {renderBreakdown.none > 0 &&
                ` · ${renderBreakdown.none} have no match`}
            </p>
          )}
        </div>
      )}

      {renderError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          <p className="text-sm font-medium text-red-500">Render failed</p>
          <p className="mt-1 text-xs text-red-500/90 break-words">
            {renderError}
          </p>
        </div>
      )}

      {tagError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          <p className="text-sm font-medium text-red-500">
            Shot tagging failed
          </p>
          <p className="mt-1 text-xs text-red-500/90 break-words">
            {tagError}
          </p>
        </div>
      )}

      {matchError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          <p className="text-sm font-medium text-red-500">
            Clip matching failed
          </p>
          <p className="mt-1 text-xs text-red-500/90 break-words">
            {matchError}
          </p>
        </div>
      )}

      {analysisError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
          <p className="text-sm font-medium text-red-500">Analysis failed</p>
          <p className="mt-1 text-xs text-red-500/90 break-words">
            {analysisError}
          </p>
        </div>
      )}
    </div>
  );

  // Video Editing / B-Roll Clips / (Storyboards) / Render Details / Captions
  const tabClass = (tab: typeof panelTab, first = false) =>
    `px-4 py-2 transition-colors ${first ? "" : "border-l border-border "}${
      panelTab === tab
        ? "bg-primary/15 text-primary"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
    }`;
  const tabBar = (
    <div className="flex rounded-lg border border-border overflow-hidden self-start text-xs font-semibold">
      <button onClick={() => setPanelTab("video")} className={tabClass("video", true)}>
        Video Editing
      </button>
      <button onClick={() => setPanelTab("clips")} className={tabClass("clips")}>
        B-Roll Clips
      </button>
      {project?.kind === "master" && (
        <button
          onClick={() => setPanelTab("storyboards")}
          className={tabClass("storyboards")}
        >
          Storyboards
        </button>
      )}
      <button onClick={() => setPanelTab("render")} className={tabClass("render")}>
        Render Details
      </button>
      <button
        onClick={() => setPanelTab("captions")}
        className={tabClass("captions")}
      >
        Captions
      </button>
    </div>
  );

  // The Gemini analysis summary (format, hook, tags, music, cost)
  const analysisCard = analysis && (
    <div className="rounded-lg border border-border p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-semibold uppercase tracking-wide">
          {analysis.format}
        </span>
        <span className="text-xs text-muted-foreground">
          analyzed {new Date(analysis.analyzedAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm text-foreground">{analysis.summary}</p>
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Hook
        </p>
        <p className="text-sm text-foreground mt-0.5">
          {analysis.hook_description}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {analysis.tags.map((tag) => (
          <span
            key={tag}
            className="px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        🎵{" "}
        {analysis.music.title
          ? `${analysis.music.title} — ${analysis.music.author} · `
          : ""}
        {analysis.music.usage.replaceAll("_", " ")}
        {analysis.music.usage_note && ` · ${analysis.music.usage_note}`}
      </p>
      <p className="text-xs text-muted-foreground">
        {analysis.model}
        {analysis.usage?.totalTokens
          ? ` · ${analysis.usage.totalTokens.toLocaleString()} tokens`
          : ""}
        {cost ? ` · est. ${cost}` : ""}
      </p>
    </div>
  );


  return (
    <div className="downloads-layout flex flex-col items-center min-h-screen p-4 bg-background text-foreground">
      <div
        className={`flex flex-col gap-6 w-full ${analysis ? "" : "max-w-sm"}`}
      >
        {/* Title + tab strip span the player and the panel */}
        {analysis && (
          <div className="flex flex-col gap-3 -mb-2">
            {titleBlock}
            {tabBar}
          </div>
        )}

        {/* Ribbon 1: video player + the active tab's panel */}
        <div className={analysis ? "grid gap-4 md:grid-cols-[minmax(0,320px)_1fr]" : "flex flex-col gap-4"}>
          <div className="flex flex-col gap-4">
            <div className="rounded-lg overflow-hidden border border-border bg-black aspect-[9/16] flex items-center justify-center">
              {playbackError ? (
                <div className="p-6 text-center">
                  <p className="text-sm font-medium text-white">
                    This file isn&apos;t a playable video
                  </p>
                  <p className="mt-2 text-xs text-white/70">
                    It may be a failed download saved as .mp4. Delete it from the
                    sidebar and re-download the clip.
                  </p>
                </div>
              ) : (
                videoUrl && (
                  <video
                    ref={videoRef}
                    key={videoUrl}
                    width="100%"
                    height="100%"
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full h-full object-contain"
                    onError={() => setPlaybackError(true)}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={(e) => {
                      if (masterBacked) {
                        setMasterDuration(e.currentTarget.duration);
                        e.currentTarget.currentTime = playerTimeFor(selectedShot);
                      }
                    }}
                  >
                    <source src={videoUrl} type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                )
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 min-w-0">
            {!analysis && (
              <>
                {titleBlock}
                {geminiActions}
              </>
            )}

            {analysis && (
              <div className="flex flex-col gap-3 min-w-0">
                {/* Video Editing: one card per shot — time, section, what
                    happens, the fix note, and the text on/under the shot */}
                {panelTab === "video" && (
                  <div className="flex gap-3 overflow-x-auto pb-2 items-stretch">
                    {analysis.shots.map((s) => {
                      const section = sectionForShot(s.index);
                      const spoken = s.spoken_text.trim();
                      const onScreen = s.on_screen_text.trim();
                      return (
                        <div
                          key={s.index}
                          className={`flex flex-col gap-1.5 shrink-0 w-[250px] rounded-lg border p-2.5 transition-colors ${
                            s.index === selectedShot
                              ? "border-primary/50 bg-primary/5"
                              : "border-border"
                          }`}
                        >
                          <button
                            onClick={() => selectShot(s.index)}
                            title={
                              s.index === selectedShot
                                ? "Play / pause"
                                : `Play shot ${s.index + 1}`
                            }
                            className="self-center rounded overflow-hidden bg-black border border-border hover:border-primary transition-colors"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={shotThumb(s)}
                              alt={`Shot ${s.index + 1}`}
                              className="h-32 w-[81px] object-cover"
                              loading="lazy"
                            />
                          </button>
                          <div className="flex items-center gap-2 flex-wrap pt-1">
                            <span className="text-[10px] font-mono text-muted-foreground">
                              {fmtClock(s.start_time)}–{fmtClock(s.end_time)}
                            </span>
                            {section ? (
                              <span
                                className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${SECTION_BADGES[section].className}`}
                              >
                                {SECTION_BADGES[section].label}
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] uppercase">
                                {s.camera_style.replaceAll("_", " ")}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">
                            {s.description}
                          </p>
                          {noteEditor(s.index, gapForShot(s.index))}
                          {spoken ? (
                            <p className="text-xs text-foreground/90 leading-snug">
                              {spoken}
                            </p>
                          ) : onScreen ? (
                            <p className="text-xs text-foreground/90 leading-snug italic border-l-2 border-primary/50 pl-2">
                              {onScreen}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              No spoken or on-screen text
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {panelTab === "clips" &&
                  (!recs ? (
                    <div className="rounded-lg border border-border p-4 flex flex-col gap-3 items-start">
                      <p className="text-sm text-muted-foreground">
                        No B-roll matches yet — match this video&apos;s shots
                        against the analyzed clip library to get recommended
                        B-roll, text, and visual treatments per shot.
                      </p>
                      <button
                        onClick={handleMatch}
                        disabled={matching}
                        className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm"
                      >
                        {matching
                          ? "Matching recommended B-roll clips…"
                          : "Match recommended B-roll clips"}
                      </button>
                      {matchError && (
                        <p className="text-xs text-red-500 break-words">
                          {matchError}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                          Optional B-roll for segment #{selectedShot + 1}
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => patchKeepSource(!selectedKeepSource)}
                            title={
                              selectedKeepSource
                                ? "Using the original footage for this shot — click to allow B-roll again"
                                : "Keep the original footage for this shot (no B-roll)"
                            }
                            className={`px-2 py-0.5 rounded-md border text-[10px] font-semibold transition-colors ${
                              selectedKeepSource
                                ? "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-400"
                                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
                            }`}
                          >
                            {selectedKeepSource ? "✓ No B-Roll" : "No B-Roll"}
                          </button>
                          <button
                            onClick={() => runBroll("suggest")}
                            disabled={brollBusy != null}
                            title="Gemini picks phrases worth covering with B-roll and matches clips for them — review them on the timeline"
                            className="px-2 py-0.5 rounded-md border border-violet-500/60 text-[10px] font-semibold text-violet-500 hover:bg-violet-500/10 disabled:opacity-50"
                          >
                            {brollBusy === "suggest" ? "Suggesting…" : "✦ Suggest B-roll moments"}
                          </button>
                          {!previewClip && (
                            <button
                              onClick={() => setAllClipsOpen(true)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              All Clips
                            </button>
                          )}
                          <p className="text-[10px] text-muted-foreground">
                            {recs.clipsConsidered} clips considered ·{" "}
                            {new Date(recs.generatedAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Select a shot in the timeline below to see its matches.
                      </p>
                      {selectedKeepSource && (
                        <p className="text-[10px] text-sky-700 dark:text-sky-400">
                          Renders from the source video at this shot&apos;s own
                          time; B-roll clips are ignored.
                        </p>
                      )}
                      {analysis?.shots[selectedShot] && (
                        <ShotTextEditor
                          key={selectedShot}
                          shotNumber={selectedShot + 1}
                          detectedText={
                            analysis.shots[selectedShot].on_screen_text
                          }
                          entry={
                            textOverlays?.shots[String(selectedShot)] ?? null
                          }
                          saving={textSaving}
                          onSave={(text, include) =>
                            patchTextOverlays({
                              shot_index: selectedShot,
                              text,
                              include,
                            })
                          }
                          onReset={() =>
                            patchTextOverlays({
                              shot_index: selectedShot,
                              reset: true,
                            })
                          }
                        />
                      )}
                      <div
                        className={`flex gap-3 items-start ${
                          selectedKeepSource ? "opacity-50" : ""
                        }`}
                      >
                      {previewClip && (
                        <div className="flex flex-col gap-1 shrink-0 w-[220px]">
                          <div className="rounded-lg overflow-hidden border border-border bg-black aspect-[9/16] max-w-[240px]">
                            <video
                              ref={previewVideoRef}
                              key={`${previewClip.filename}-${previewClip.start ?? "full"}`}
                              controls
                              playsInline
                              preload="metadata"
                              muted
                              className="w-full h-full object-contain"
                              onLoadedMetadata={(e) => {
                                if (previewClip.start != null) {
                                  e.currentTarget.currentTime =
                                    previewClip.start;
                                }
                              }}
                              onTimeUpdate={(e) => {
                                const v = e.currentTarget;
                                if (previewClip.end == null) return;
                                // Loop mode: cycle the suggested window
                                if (loopShot) {
                                  if (v.currentTime >= previewClip.end) {
                                    v.currentTime = previewClip.start ?? 0;
                                  }
                                  return;
                                }
                                // Otherwise stop at the out-point (scrubbing
                                // well past it frees normal playback)
                                if (
                                  !v.paused &&
                                  v.currentTime >= previewClip.end &&
                                  v.currentTime < previewClip.end + 0.5
                                ) {
                                  v.pause();
                                }
                              }}
                            >
                              <source src={clipSrc(previewClip.filename)} />
                            </video>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={toggleLoopShot}
                              title={
                                loopShot
                                  ? "Stop looping the shot"
                                  : "Loop the playing shot or clip"
                              }
                              className={`p-2 rounded-lg border transition-colors ${
                                loopShot
                                  ? "bg-primary/15 text-primary border-primary/50"
                                  : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
                              }`}
                            >
                              <svg
                                className="size-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M17 2l4 4-4 4" />
                                <path d="M3 11v-1a4 4 0 014-4h14" />
                                <path d="M7 22l-4-4 4-4" />
                                <path d="M21 13v1a4 4 0 01-4 4H3" />
                              </svg>
                            </button>
                            <button
                              onClick={selectClip}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                                selectedClipFilename === previewClip.filename
                                  ? "bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/50"
                                  : "bg-primary text-primary-foreground hover:bg-primary/90"
                              }`}
                            >
                              {selectedClipFilename === previewClip.filename
                                ? "✓ Selected"
                                : "Select"}
                            </button>
                            <button
                              onClick={() => setAllClipsOpen(true)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              All Clips
                            </button>
                            <button
                              onClick={() => setPreviewClip(null)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Close preview ✕
                            </button>
                            {trimmingShot === selectedShot ? (
                              <span className="text-[10px] text-muted-foreground animate-pulse">
                                finding best moment…
                              </span>
                            ) : (
                              previewClip.start != null &&
                              previewClip.end != null && (
                                <span className="text-[10px] font-mono text-muted-foreground">
                                  playing suggested moment{" "}
                                  {previewClip.start.toFixed(1)}s →{" "}
                                  {previewClip.end.toFixed(1)}s
                                </span>
                              )
                            )}
                          </div>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                      {selectedRecs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No good B-roll match in the analyzed library for this
                          shot.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedRecs.map((r) => (
                            <div
                              key={r.filename}
                              className={`flex gap-2 items-start rounded-md border p-2 ${
                                r.filename === selectedClipFilename
                                  ? "border-green-500/60"
                                  : previewClip?.filename === r.filename
                                    ? "border-primary"
                                    : "border-border"
                              }`}
                            >
                              <button
                                onClick={() =>
                                  setPreviewClip(
                                    previewClip?.filename === r.filename
                                      ? null
                                      : {
                                          filename: r.filename,
                                          start: r.trim_start ?? null,
                                          end: r.trim_end ?? null,
                                        }
                                  )
                                }
                                className="shrink-0 rounded overflow-hidden border border-border hover:border-primary transition-colors"
                                title="Preview clip"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={thumbSrc(r.filename)}
                                  alt={r.filename}
                                  className="h-16 w-12 object-cover bg-muted"
                                  loading="lazy"
                                />
                              </button>
                              <div className="min-w-0 flex flex-col gap-0.5">
                                <p className="text-xs font-medium text-foreground truncate">
                                  {r.filename}
                                  {r.duration != null && (
                                    <span className="text-muted-foreground font-normal">
                                      {" "}
                                      · {r.duration.toFixed(1)}s
                                    </span>
                                  )}
                                </p>
                                <div className="flex items-center gap-1 flex-wrap">
                                  {r.filename === selectedClipFilename && (
                                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-green-500/15 text-green-600 dark:text-green-400">
                                      ✓ selected
                                    </span>
                                  )}
                                  <span
                                    className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${CONFIDENCE_STYLES[r.confidence]}`}
                                  >
                                    {r.confidence}
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] uppercase">
                                    {r.source === "gemini"
                                      ? "semantic"
                                      : r.source === "manual"
                                        ? "your pick"
                                        : r.source === "generated"
                                          ? "⚡ AI generated"
                                          : "tag match"}
                                  </span>
                                  {r.trim_start != null &&
                                    r.trim_end != null && (
                                      <span className="px-1.5 py-0.5 rounded-full bg-primary/15 text-primary text-[9px] font-semibold font-mono">
                                        ✂ {r.trim_start.toFixed(1)}s →{" "}
                                        {r.trim_end.toFixed(1)}s
                                      </span>
                                    )}
                                  {r.tag_overlap.map((tag) => (
                                    <span
                                      key={tag}
                                      className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[9px]"
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                                <p className="text-[11px] text-muted-foreground leading-snug">
                                  {r.reason}
                                </p>
                                <button
                                  onClick={() => brollPlaceRec(selectedShot, r)}
                                  disabled={brollBusy != null}
                                  title="Cover this shot with the clip on the B-roll track; trim it on the timeline afterwards"
                                  className="self-start mt-0.5 px-2 py-0.5 rounded-md bg-violet-600 text-white text-[10px] font-semibold hover:bg-violet-500 disabled:opacity-50"
                                >
                                  Place on timeline ▸
                                </button>
                                {r.moment_note && (
                                  <p className="text-[10px] text-primary/90 leading-snug">
                                    ⏱ {r.moment_note}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      </div>
                      </div>
                      {videoId && shot && (
                        <GenerationPanel
                          videoId={videoId}
                          shotIndex={selectedShot}
                          shotDuration={shot.end_time - shot.start_time}
                          gap={gapForShot(selectedShot)}
                          generation={generation}
                          selectedRec={
                            selectedClipFilename
                              ? {
                                  filename: selectedClipFilename,
                                  duration:
                                    selectedRecs.find(
                                      (r) =>
                                        r.filename === selectedClipFilename
                                    )?.duration ?? null,
                                }
                              : null
                          }
                          onGeneration={setGeneration}
                          onAccept={(g, newRecs) => {
                            setGeneration(g);
                            const parsed = newRecs as ShotRecommendations;
                            setRecs(parsed);
                            // Show the freshly accepted clip in the preview
                            const rec = parsed.shots
                              .find((s) => s.shot_index === selectedShot)
                              ?.recommendations.find(
                                (r) => r.source === "generated"
                              );
                            if (rec) {
                              setPreviewClip({
                                filename: rec.filename,
                                start: rec.trim_start ?? null,
                                end: rec.trim_end ?? null,
                              });
                            }
                          }}
                        />
                      )}
                    </div>
                  ))}

                {panelTab === "storyboards" &&
                  project?.kind === "master" &&
                  videoId && (
                    <StoryboardPanel
                      videoId={videoId}
                      filename={filename}
                      onSeek={seekTo}
                    />
                  )}

                {/* Render Details: once a render exists, TikTok drafts +
                    warnings come first; then the pipeline buttons + render
                    settings, the analysis summary, and the render output */}
                {panelTab === "render" && (
                  <div className="flex flex-col gap-3">
                    {render && (
                    <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                          📱 Send to TikTok drafts
                        </p>
                        {tiktokStatus?.connected && (
                          <p className="text-[10px] text-muted-foreground">
                            connected
                            {tiktokStatus.displayName
                              ? ` as ${tiktokStatus.displayName}`
                              : ""}{" "}
                            ·{" "}
                            <button
                              onClick={handleTiktokDisconnect}
                              className="underline hover:text-foreground"
                            >
                              disconnect
                            </button>
                          </p>
                        )}
                      </div>

                      {!tiktokStatus?.connected ? (
                        <div className="flex flex-col gap-1.5 items-start">
                          <p className="text-[11px] text-muted-foreground">
                            Connect your TikTok account to upload this render
                            straight to your drafts. You log in on TikTok&apos;s
                            site — this app never sees your password.
                          </p>
                          <button
                            onClick={handleTiktokConnect}
                            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold"
                          >
                            Connect TikTok
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1.5 items-start">
                          <p className="text-[11px] text-muted-foreground">
                            Drafts can&apos;t carry a caption — copy it here, then
                            paste it in the TikTok app when you post.
                          </p>
                          {captions && captions.captions.length > 0 && (
                            <button
                              onClick={() =>
                                copyText(
                                  "tiktok-caption",
                                  [
                                    captions.captions[0].text,
                                    captions.hashtags
                                      .map((h) => `#${h.tag}`)
                                      .join(" "),
                                  ]
                                    .filter(Boolean)
                                    .join("\n")
                                )
                              }
                              className="px-2 py-1 rounded-md border border-border text-[10px] font-semibold text-foreground hover:bg-muted/40"
                            >
                              {copiedKey === "tiktok-caption"
                                ? "✓ Caption copied"
                                : "Copy caption + hashtags"}
                            </button>
                          )}
                          <button
                            onClick={handleTiktokUpload}
                            disabled={tiktokUploading || rendering}
                            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-60"
                          >
                            {tiktokUploading
                              ? "Uploading to TikTok…"
                              : "Send to TikTok drafts"}
                          </button>
                        </div>
                      )}

                      {tiktokResult && (
                        <p
                          className={`text-[11px] break-words ${
                            tiktokResult.ok
                              ? "text-green-600 dark:text-green-400"
                              : "text-red-500"
                          }`}
                        >
                          {tiktokResult.ok ? "✓ " : "✗ "}
                          {tiktokResult.message}
                        </p>
                      )}
                    </div>
                    )}

                    {render && render.warnings.length > 0 && (
                      <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-2 flex flex-col gap-0.5">
                        {render.warnings.map((w, i) => (
                          <p
                            key={i}
                            className="text-[11px] text-yellow-700 dark:text-yellow-400 break-words"
                          >
                            ⚠ {w}
                          </p>
                        ))}
                        <p className="text-[10px] text-yellow-700/80 dark:text-yellow-400/80 mt-0.5">
                          Add a ✎ fix note on a shot (Video Editing tab or the
                          render output below) to direct how to solve it (e.g.
                          &ldquo;loop the clip to fill the shot&rdquo;), then
                          re-render.
                        </p>
                      </div>
                    )}

                    {renderStale && (
                      <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-2">
                        <p className="text-[11px] text-yellow-700 dark:text-yellow-400">
                          Shot times changed after this render — render again to apply them.
                        </p>
                      </div>
                    )}

                    {geminiActions}

                    {analysisCard}

                    {render && (
                  <div className="rounded-lg border border-border p-3 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                        Render output · {render.durationSeconds.toFixed(1)}s
                        {render.broll?.length
                          ? ` · ${render.broll.length} B-roll segment${render.broll.length === 1 ? "" : "s"}`
                          : ""}
                        {render.time_mode === "follow_original"
                          ? " · follows original lighting"
                          : render.time_target
                            ? ` · ${render.time_target}-consistent`
                            : ""}
                        {render.audio === "music" && render.music
                          ? ` · song: ${render.music.title}${render.music.looped ? " (looped)" : ""}`
                          : render.audio === "original"
                            ? " · original audio"
                            : " · silent (pick an audio option and re-render)"}
                        {render.text_burn
                          ? ` · text burned (${render.text_burn.shots_burned} shot${render.text_burn.shots_burned === 1 ? "" : "s"}, ${render.text_burn.preset.replaceAll("_", " ")})`
                          : ""}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        rendered {new Date(render.renderedAt).toLocaleString()}
                      </p>
                    </div>

                    {rendering && (
                      <p className="text-[11px] font-semibold text-primary animate-pulse">
                        Re-rendering with your fixes… (~1 min) — the video and
                        shot list below update when it finishes.
                      </p>
                    )}

                    <div className="flex gap-3 items-start flex-wrap">
                      <div className="rounded-lg overflow-hidden border border-border bg-black aspect-[9/16] w-[220px] shrink-0">
                        <video
                          key={render.renderedAt}
                          controls
                          className="w-full h-full object-contain"
                        >
                          <source
                            src={`/api/renders/${render.videoId}?v=${encodeURIComponent(render.renderedAt)}`}
                            type="video/mp4"
                          />
                        </video>
                      </div>

                      <div className="flex-1 min-w-[240px] flex flex-col gap-1.5">
                        {render.shots.map((s) => (
                          <div
                            key={s.shot_index}
                            className="flex gap-2 items-start rounded-md border border-border p-2"
                          >
                            {s.clip ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={thumbSrc(s.clip)}
                                alt={s.clip}
                                className="h-16 w-12 object-cover bg-muted rounded shrink-0"
                                loading="lazy"
                              />
                            ) : (
                              <div className="h-16 w-12 rounded bg-black shrink-0 flex items-center justify-center text-[9px] text-white/60">
                                black
                              </div>
                            )}
                            <div className="min-w-0 flex flex-col gap-0.5">
                              <p className="text-xs font-medium text-foreground truncate">
                                #{s.shot_index + 1} ·{" "}
                                {s.clip ?? "no eligible clip"}
                                <span className="text-muted-foreground font-normal">
                                  {" "}
                                  · {s.duration.toFixed(1)}s
                                </span>
                              </p>
                              <div className="flex items-center gap-1 flex-wrap">
                                <span
                                  className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${CLIP_SOURCE_BADGES[s.clip_source].className}`}
                                >
                                  {CLIP_SOURCE_BADGES[s.clip_source].label}
                                </span>
                                {s.trim_start != null && s.trim_end != null && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-primary/15 text-primary text-[9px] font-semibold font-mono">
                                    ✂ {s.trim_start.toFixed(1)}s →{" "}
                                    {s.trim_end.toFixed(1)}s
                                  </span>
                                )}
                                {s.time_of_day && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] uppercase">
                                    {s.time_of_day === "night"
                                      ? "🌙 "
                                      : s.time_of_day === "indoor_lighting"
                                        ? "💡 "
                                        : s.time_of_day === "unclear"
                                          ? ""
                                          : "☀️ "}
                                    {s.time_of_day.replaceAll("_", " ")}
                                  </span>
                                )}
                                {s.padded_seconds > 0 && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 text-[9px] font-semibold">
                                    +{s.padded_seconds.toFixed(1)}s{" "}
                                    {FILL_LABELS[s.fill ?? "freeze"]}
                                  </span>
                                )}
                              </div>
                              {s.moment_note && (
                                <p className="text-[10px] text-primary/90 leading-snug">
                                  ⏱ {s.moment_note}
                                </p>
                              )}
                              {s.burned_text != null ? (
                                <p className="text-[10px] text-primary/90 leading-snug line-clamp-2">
                                  🔥 burned:{" "}
                                  <span className="italic">
                                    {s.burned_text}
                                  </span>
                                </p>
                              ) : (
                                s.on_screen_text && (
                                  <p className="text-[10px] text-foreground/90 italic leading-snug line-clamp-2">
                                    {s.on_screen_text}
                                  </p>
                                )
                              )}
                              {s.skipped.length > 0 && (
                                <p className="text-[10px] text-muted-foreground leading-snug">
                                  skipped:{" "}
                                  {s.skipped
                                    .map((k) => `${k.filename} (${k.reason})`)
                                    .join("; ")}
                                </p>
                              )}
                              {s.edit_applied && (
                                <p className="text-[10px] text-green-600 dark:text-green-400 leading-snug">
                                  ✔ fix applied: {s.edit_applied}
                                </p>
                              )}
                              {noteEditor(
                                s.shot_index,
                                !s.clip || s.skipped.length > 0
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border">
                      <button
                        onClick={() => setScriptOpen((v) => !v)}
                        className="w-full px-3 py-2 text-left text-xs font-semibold text-foreground flex justify-between items-center"
                      >
                        Script to re-add (on-screen + spoken text)
                        <span className="text-muted-foreground">
                          {scriptOpen ? "▾" : "▸"}
                        </span>
                      </button>
                      {scriptOpen && (
                        <div className="px-3 pb-2 flex flex-col gap-1">
                          {render.shots.filter(
                            (s) =>
                              s.on_screen_text || s.spoken_text || s.burned_text
                          ).length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No on-screen or spoken text in this video.
                            </p>
                          ) : (
                            render.shots
                              .filter(
                                (s) =>
                                  s.on_screen_text ||
                                  s.spoken_text ||
                                  s.burned_text
                              )
                              .map((s) => (
                                <div key={s.shot_index} className="text-xs">
                                  <span className="font-mono text-muted-foreground">
                                    #{s.shot_index + 1} ·{" "}
                                    {s.start_time.toFixed(1)}s →{" "}
                                    {s.end_time.toFixed(1)}s
                                  </span>
                                  {(s.burned_text ?? s.on_screen_text) && (
                                    <p className="italic text-foreground/90 whitespace-pre-wrap">
                                      {s.burned_text != null && (
                                        <span className="not-italic text-green-600 dark:text-green-400">
                                          ✓ burned ·{" "}
                                        </span>
                                      )}
                                      {s.burned_text ?? s.on_screen_text}
                                    </p>
                                  )}
                                  {s.spoken_text && (
                                    <p className="text-muted-foreground">
                                      🗣 {s.spoken_text}
                                    </p>
                                  )}
                                </div>
                              ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                    )}
                  </div>
                )}

                {/* Captions: the concept steers the writer; the button is
                    the hero before a run and a compact action after */}
                {panelTab === "captions" && (
                  <div className="rounded-lg border border-border p-4 flex flex-col gap-3">
                    {captions && (
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                          Recommended caption + hashtags
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {captions.model} ·{" "}
                          {new Date(captions.generatedAt).toLocaleString()}
                        </p>
                      </div>
                    )}

                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium text-muted-foreground">
                        Concept
                      </span>
                      <textarea
                        value={captionConcept}
                        onChange={(e) => setCaptionConcept(e.target.value)}
                        disabled={captionsLoading}
                        rows={captions ? 2 : 3}
                        maxLength={2000}
                        placeholder="Describe the video you want, e.g. “a 30-second montage of the duck on different dashboards, ending on the Tesla screen frame”"
                        className="w-full text-sm rounded-lg border border-input bg-transparent px-3 py-2 outline-none focus:border-primary resize-y disabled:opacity-60"
                      />
                    </label>

                    {captions ? (
                      <button
                        onClick={handleGenerateCaptions}
                        disabled={captionsLoading}
                        className="self-start px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-base"
                      >
                        {captionsLoading
                          ? "Writing captions + sizing hashtags…"
                          : "Re-generate Captions and Hashtags"}
                      </button>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <button
                          onClick={handleGenerateCaptions}
                          disabled={captionsLoading}
                          className={actionButtonClass}
                        >
                          {captionsLoading
                            ? "Writing captions + sizing hashtags…"
                            : "Generate Captions and Hashtags"}
                        </button>
                        {!captionsLoading && (
                          <p className="text-xs text-muted-foreground">
                            Gemini drafts captions for the remake from the
                            analysis and your concept, then picks up to 5
                            hashtags sized against TikHub view counts.
                          </p>
                        )}
                      </div>
                    )}

                    {captionsError && (
                      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                        <p className="text-sm font-medium text-red-500">
                          Caption generation failed
                        </p>
                        <p className="mt-1 text-xs text-red-500/90 break-words">
                          {captionsError}
                        </p>
                      </div>
                    )}

                    {captions && (
                      <>
                        <div className="flex flex-col gap-2">
                          {captions.captions.map((c, i) => {
                            const tagString = captions.hashtags
                              .map((h) => `#${h.tag}`)
                              .join(" ");
                            return (
                              <div
                                key={i}
                                className="rounded-md border border-border p-2.5 flex flex-col gap-1.5"
                              >
                                <span className="self-start px-2 py-0.5 rounded-full bg-primary/15 text-primary text-[10px] font-semibold uppercase tracking-wide">
                                  {c.angle}
                                </span>
                                <p className="text-sm text-foreground whitespace-pre-wrap">
                                  {c.text}
                                </p>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <button
                                    onClick={() => copyText(`cap-${i}`, c.text)}
                                    className="px-2 py-1 rounded-md border border-border text-[10px] font-semibold text-foreground hover:bg-muted/40"
                                  >
                                    {copiedKey === `cap-${i}`
                                      ? "✓ Copied"
                                      : "Copy caption"}
                                  </button>
                                  <button
                                    onClick={() =>
                                      copyText(
                                        `capfull-${i}`,
                                        `${c.text}\n\n${tagString}`
                                      )
                                    }
                                    className="px-2 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-semibold hover:bg-primary/90"
                                  >
                                    {copiedKey === `capfull-${i}`
                                      ? "✓ Copied"
                                      : "Copy caption + hashtags"}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                              Hashtags ({captions.hashtags.length})
                            </p>
                            <button
                              onClick={() =>
                                copyText(
                                  "tags",
                                  captions.hashtags
                                    .map((h) => `#${h.tag}`)
                                    .join(" ")
                                )
                              }
                              className="px-2 py-0.5 rounded-md border border-border text-[10px] font-semibold text-foreground hover:bg-muted/40"
                            >
                              {copiedKey === "tags" ? "✓ Copied" : "Copy all"}
                            </button>
                          </div>
                          <div className="flex flex-col gap-1">
                            {captions.hashtags.map((h) => (
                              <div
                                key={h.tag}
                                className="flex items-center gap-2 flex-wrap rounded-md border border-border px-2 py-1.5"
                              >
                                <span className="text-sm font-medium text-primary">
                                  #{h.tag}
                                </span>
                                {h.viewCount != null && (
                                  <span className="text-[10px] font-mono text-muted-foreground">
                                    {formatViews(h.viewCount)} views
                                  </span>
                                )}
                                <span
                                  className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${ZONE_BADGES[h.zone].className}`}
                                >
                                  {ZONE_BADGES[h.zone].label}
                                </span>
                                {h.source === "original" && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] uppercase">
                                    from original
                                  </span>
                                )}
                                <span className="text-[10px] text-muted-foreground min-w-0 flex-1 truncate">
                                  {h.reason}
                                </span>
                              </div>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            {captions.tikhubChecked
                              ? "Sizes are lifetime tag views from TikHub — “sweet spot” = 10M–500M, big enough to circulate without burying you."
                              : "TikHub sizing unavailable (no API key or lookups failed) — tags are in relevance order, unverified."}
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Editing-style timeline: shot columns sized by duration, with
            thumbnail / time / description tracks connected by timestamps */}
        {analysis && shot && (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-bold text-foreground uppercase tracking-wide">
              Timeline
            </h2>
            <ShotTimeline
              shots={analysis.shots.map((s) => ({
                ...s,
                screenshot: shotThumb(s),
                title: s.on_screen_text || s.description,
              }))}
              selectedShot={selectedShot}
              playheadTime={playheadTime}
              timelineRef={timelineRef}
              pxPerSec={PX_PER_SEC}
              sectionFor={(i) => {
                const section = sectionForShot(i);
                return section ? SECTION_BADGES[section] : null;
              }}
              onSelectShot={selectShot}
              confidenceStyles={CONFIDENCE_STYLES}
              recs={
                recs
                  ? {
                      byShot: recsByShot,
                      selectedByShot,
                      keepSourceByShot,
                      gapForShot,
                      thumbSrc,
                      sourceBadgeClass: CLIP_SOURCE_BADGES.source.className,
                      onGenerate: (i) => {
                        selectShot(i, false);
                        setPanelTab("clips");
                      },
                      onPreview: (i, r) => {
                        selectShot(i, false);
                        setPanelTab("clips");
                        setPreviewClip({
                          filename: r.filename,
                          start: r.trim_start ?? null,
                          end: r.trim_end ?? null,
                        });
                      },
                    }
                  : null
              }
              resize={timelineResize}
              broll={timelineBroll}
            />
            {timelineResize && (
              <p className="text-[10px] text-muted-foreground">
                {timelineResize.mode === "source"
                  ? "Drag a line between shots to change where that shot ends in the footage (Alt-drag: where the next one starts). The target length is a goal — cuts snap to words and flag mid-sentence."
                  : "Drag a line between shots to move the cut. The video's length doesn't change."}
                {retiming ? " · saving…" : ""}
              </p>
            )}

            {analysis.full_transcript && (
              <div className="rounded-lg border border-border">
                <button
                  onClick={() => setTranscriptOpen((v) => !v)}
                  className="w-full px-4 py-2 text-left text-sm font-semibold text-foreground flex justify-between items-center"
                >
                  Full transcript
                  <span className="text-muted-foreground">
                    {transcriptOpen ? "▾" : "▸"}
                  </span>
                </button>
                {transcriptOpen && (
                  <p className="px-4 pb-3 text-sm text-muted-foreground whitespace-pre-wrap">
                    {analysis.full_transcript}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <ClipLibraryModal
        open={allClipsOpen}
        onClose={() => {
          setAllClipsOpen(false);
          setBrollLibraryFor(null);
        }}
        shotDuration={
          brollLibraryFor
            ? (() => {
                const b = brollBlocks.find((x) => x.id === brollLibraryFor);
                return b ? b.end - b.start : null;
              })()
            : shot
              ? shot.end_time - shot.start_time
              : null
        }
        selectedFilename={
          brollLibraryFor
            ? (brollTrack?.segments.find((s) => s.id === brollLibraryFor)?.clip?.filename ?? null)
            : selectedClipFilename
        }
        onSelect={(filename) => {
          if (brollLibraryFor) {
            brollSetClip(brollLibraryFor, filename, null);
            setAllClipsOpen(false);
            setBrollLibraryFor(null);
          } else {
            selectFromLibrary(filename);
          }
        }}
      />
      {brollSelected &&
        brollTrack &&
        (() => {
          const seg = brollTrack.segments.find((s) => s.id === brollSelected);
          const block = brollBlocks.find((b) => b.id === brollSelected);
          if (!seg || !block) return null;
          return (
            <BrollSegmentPopover
              segment={{ ...block, candidates: seg.candidates }}
              anchorRect={brollRect}
              thumbSrc={thumbSrc}
              clipSrc={clipSrc}
              busy={brollBusy}
              onClose={() => setBrollSelected(null)}
              onUseCandidate={(c) => brollSetClip(seg.id, c.filename, c.clip_start)}
              onOpenLibrary={() => {
                setBrollLibraryFor(seg.id);
                setAllClipsOpen(true);
              }}
              onMatch={() => runBroll("match", [seg.id])}
              onRepickMoment={() => runBroll("moment", [seg.id])}
              onAccept={() => brollUpdate(seg.id, (s) => ({ ...s, status: "placed" }))}
              onRemove={() => brollRemove(seg.id)}
            />
          );
        })()}
    </div>
  );
}

// useSearchParams needs a Suspense boundary for static rendering
export default function VideoViewerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="size-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
        </div>
      }
    >
      <VideoViewerContent />
    </Suspense>
  );
}
