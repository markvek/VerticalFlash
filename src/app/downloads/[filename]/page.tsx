"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
import type { DownloadEntryProject } from "@/lib/download-types";

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
  clip_source: "selected" | "top_recommendation" | "generated" | "none";
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
}

// Timeline scale: pixels per second of video
const PX_PER_SEC = 56;

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

export default function VideoViewerPage() {
  const params = useParams();
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
    "video" | "clips" | "render" | "captions"
  >("video");
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

  useEffect(() => {
    // Use the API route to serve the video file
    setVideoUrl(`/api/downloads/${encodeURIComponent(filename)}`);
    setPlaybackError(false);
  }, [filename]);

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
        // chose otherwise
        if (proj?.music && !audioInitialized.current) {
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
        if (!cancelled && data) setCaptions(data);
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
      if (video.paused) video.play().catch(() => {});
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
    if (video.paused) video.play().catch(() => {});
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
        video.currentTime = analysis.shots[clamped].start_time;
        video.play().catch(() => {});
      }
    }
  };

  // Follow playback: move the playhead and highlight the shot under it
  const handleTimeUpdate = () => {
    if (!analysis) return;
    const video = videoRef.current;
    if (!video) return;
    const t = video.currentTime;

    // Loop mode: cycle the selected shot instead of playing through
    if (loopShot) {
      const s = analysis.shots[selectedShot];
      if (s && (t >= s.end_time || t < s.start_time - 0.05)) {
        video.currentTime = s.start_time;
        setPlayheadTime(s.start_time);
        video.play().catch(() => {});
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

  // Turning the loop on restarts both players at their loop-in points
  const toggleLoopShot = () => {
    const next = !loopShot;
    setLoopShot(next);
    if (!next) return;
    const s = analysis?.shots[selectedShot];
    const video = videoRef.current;
    if (video && s) {
      video.currentTime = s.start_time;
      setPlayheadTime(s.start_time);
      video.play().catch(() => {});
    }
    const preview = previewVideoRef.current;
    if (preview) {
      preview.currentTime = previewClip?.start ?? 0;
      preview.play().catch(() => {});
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
  const selectedRecs = recsByShot.get(selectedShot) || [];
  const selectedClipFilename =
    recs?.shots.find((s) => s.shot_index === selectedShot)
      ?.selected_filename ?? null;

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

  // What a render would use per shot: your pick, the top match, or nothing
  const renderBreakdown = recs
    ? recs.shots.reduce(
        (acc, s) => {
          if (s.selected_filename) acc.selected += 1;
          else if (s.recommendations.length > 0) acc.fallback += 1;
          else acc.none += 1;
          return acc;
        },
        { selected: 0, fallback: 0, none: 0 }
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
            ["original", project ? "Placeholder track" : "Original"],
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

  // Title, filename, and Gemini actions — shown standalone before an
  // analysis exists, and at the top of the "Video info" tab afterwards
  const headerActions = (
    <>
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
              {displayName || "Download"}
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
            : project
              ? `Idea project · ${project.targetDuration}s • Tap to play/pause`
              : "Downloaded video • Tap to play/pause"}
        </p>
        {project?.prompt && (
          <p className="text-xs text-foreground/80 mt-1 line-clamp-3">
            {project.prompt}
          </p>
        )}
      </div>

      {videoId && (
        <button
          onClick={handleAnalyze}
          disabled={analyzing}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {analyzing
            ? project
              ? "Planning shots with Gemini… (can take a minute)"
              : "Analyzing with Gemini… (can take a minute)"
            : analysis
              ? project
                ? "Re-plan shots with Gemini"
                : "Re-process with Gemini"
              : project
                ? "Plan shots with Gemini"
                : "Process with Gemini"}
        </button>
      )}

      {videoId && analysis && (
        <button
          onClick={handleMatch}
          disabled={matching}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {matching
            ? "Matching library clips…"
            : recs
              ? "Re-match library clips"
              : "Match library clips"}
        </button>
      )}

      {videoId && analysis && (
        <button
          onClick={handleGenerateTags}
          disabled={tagging}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {tagging
            ? "Tagging shots…"
            : analysis.taggedAt
              ? "Re-tag shots"
              : "Generate shot tags"}
        </button>
      )}

      {videoId && analysis && recs && (
        <div className="flex flex-col gap-1">
          <button
            onClick={handleRender}
            disabled={rendering}
            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {rendering
              ? "Rendering remake… (~1 min)"
              : render
                ? "Re-render remake"
                : "Render remake"}
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
                  className="text-xs rounded-md border border-border bg-transparent px-1.5 py-1 outline-none focus:border-primary disabled:opacity-60"
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
                  className="text-xs rounded-md border border-border bg-transparent px-1.5 py-1 outline-none focus:border-primary disabled:opacity-60"
                >
                  <option value="top">Upper third</option>
                  <option value="center">Center</option>
                  <option value="bottom">Lower third</option>
                </select>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Edit each shot&apos;s text in the Library clips tab · burned as
                ASS subtitles
              </p>
            </div>
          )}
          {renderBreakdown && (
            <p className="text-[10px] text-muted-foreground">
              {renderBreakdown.selected} shot
              {renderBreakdown.selected === 1 ? "" : "s"} use your selected
              clip · {renderBreakdown.fallback} fall back to the top match
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
    </>
  );
  const totalDuration = analysis?.shots.length
    ? analysis.shots[analysis.shots.length - 1].end_time
    : 0;

  return (
    <div className="downloads-layout flex flex-col items-center min-h-screen p-4 bg-background text-foreground">
      <div
        className={`flex flex-col gap-6 w-full ${analysis ? "" : "max-w-sm"}`}
      >
        {/* Ribbon 1: video player + general info */}
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
                    autoPlay
                    className="w-full h-full object-contain"
                    onError={() => setPlaybackError(true)}
                    onTimeUpdate={handleTimeUpdate}
                  >
                    <source src={videoUrl} type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                )
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 min-w-0">
            {!analysis && headerActions}

            {analysis && (
              <div className="flex flex-col gap-3 min-w-0">
                <div className="flex rounded-lg border border-border overflow-hidden self-start text-xs font-semibold">
                  <button
                    onClick={() => setPanelTab("video")}
                    className={`px-4 py-2 transition-colors ${
                      panelTab === "video"
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    }`}
                  >
                    Video info
                  </button>
                  <button
                    onClick={() => setPanelTab("clips")}
                    className={`px-4 py-2 border-l border-border transition-colors ${
                      panelTab === "clips"
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    }`}
                  >
                    Library clips
                  </button>
                  {render && (
                    <button
                      onClick={() => setPanelTab("render")}
                      className={`px-4 py-2 border-l border-border transition-colors ${
                        panelTab === "render"
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                      }`}
                    >
                      Remake render
                    </button>
                  )}
                  <button
                    onClick={() => setPanelTab("captions")}
                    className={`px-4 py-2 border-l border-border transition-colors ${
                      panelTab === "captions"
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    }`}
                  >
                    Captions
                  </button>
                </div>

                {panelTab === "video" && (
                  <>
                    {headerActions}
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
                  {analysis.music.usage_note &&
                    ` · ${analysis.music.usage_note}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {analysis.model}
                  {analysis.usage?.totalTokens
                    ? ` · ${analysis.usage.totalTokens.toLocaleString()} tokens`
                    : ""}
                  {cost ? ` · est. ${cost}` : ""}
                </p>
              </div>
                  </>
                )}

                {panelTab === "clips" &&
                  (!recs ? (
                    <div className="rounded-lg border border-border p-4">
                      <p className="text-sm text-muted-foreground">
                        No clip matches yet — hit &ldquo;Match library
                        clips&rdquo; to compare this video&apos;s shots against
                        the analyzed clip library.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                          Library clips for shot #{selectedShot + 1}
                        </p>
                        <div className="flex items-center gap-2">
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
                      <div className="flex gap-3 items-start">
                      {previewClip && (
                        <div className="flex flex-col gap-1 shrink-0 w-[220px]">
                          <div className="rounded-lg overflow-hidden border border-border bg-black aspect-[9/16] max-w-[240px]">
                            <video
                              ref={previewVideoRef}
                              key={`${previewClip.filename}-${previewClip.start ?? "full"}`}
                              controls
                              autoPlay
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
                                    v.play().catch(() => {});
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
                                  : "Loop this shot + clip on repeat"
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
                          No good match in the analyzed library for this shot.
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

                {panelTab === "render" && render && (
                  <div className="rounded-lg border border-border p-3 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                        Remake · {render.durationSeconds.toFixed(1)}s
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

                    {renderError && (
                      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2">
                        <p className="text-[11px] text-red-500 break-words">
                          Render failed: {renderError}
                        </p>
                      </div>
                    )}

                    {render.warnings.length > 0 && (
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
                          Add a ✎ fix note on a shot below to direct how to
                          solve it (e.g. &ldquo;loop the clip to fill the
                          shot&rdquo;), then re-render.
                        </p>
                      </div>
                    )}

                    <div className="rounded-lg border border-border p-2 flex flex-col gap-2">
                      {audioControls}
                      <button
                        onClick={handleRender}
                        disabled={rendering}
                        className="self-start px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-60"
                      >
                        {rendering ? "Rendering…" : "Re-render with this audio"}
                      </button>
                    </div>

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
                              {noteShot === s.shot_index ? (
                                <div className="flex flex-col gap-1 mt-0.5">
                                  <textarea
                                    autoFocus
                                    value={noteDraft}
                                    onChange={(e) =>
                                      setNoteDraft(e.target.value)
                                    }
                                    rows={2}
                                    maxLength={500}
                                    placeholder='How should this shot be fixed? e.g. "loop the clip to fill the shot", "use IMG_0072 and start at 3s", "reuse the clip from shot 3". Save empty to clear.'
                                    className="w-full text-xs rounded-md border border-border bg-transparent p-1.5 outline-none focus:border-primary resize-y"
                                  />
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                      onClick={() =>
                                        saveNoteAndRender(s.shot_index)
                                      }
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
                                      onClick={() => saveNote(s.shot_index)}
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
                                    setNoteShot(s.shot_index);
                                    setNoteDraft(
                                      editNotes[String(s.shot_index)] || ""
                                    );
                                  }}
                                  className={`self-start text-left text-[10px] mt-0.5 rounded-md px-1.5 py-0.5 border transition-colors ${
                                    editNotes[String(s.shot_index)]
                                      ? "border-primary/40 text-primary hover:bg-primary/10"
                                      : !s.clip || s.skipped.length > 0
                                        ? "border-yellow-500/50 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-500/10"
                                        : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                  }`}
                                >
                                  ✎{" "}
                                  {editNotes[String(s.shot_index)] ||
                                    "Add fix note"}
                                </button>
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
                  </div>
                )}

                {panelTab === "captions" && (
                  <div className="rounded-lg border border-border p-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-xs font-bold text-foreground uppercase tracking-wide">
                        Recommended caption + hashtags
                      </p>
                      {captions && (
                        <p className="text-[10px] text-muted-foreground">
                          {captions.model} ·{" "}
                          {new Date(captions.generatedAt).toLocaleString()}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={handleGenerateCaptions}
                        disabled={captionsLoading}
                        className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm"
                      >
                        {captionsLoading
                          ? "Writing captions + sizing hashtags…"
                          : captions
                            ? "Re-generate captions"
                            : "Generate captions"}
                      </button>
                      {!captions && !captionsLoading && (
                        <p className="text-xs text-muted-foreground">
                          Gemini drafts captions for the remake and
                          picks up to 5 hashtags, sized against TikHub view
                          counts.
                        </p>
                      )}
                    </div>

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
            <h2 className="text-sm font-bold text-foreground">
              Shot breakdown ({analysis.shots.length})
            </h2>
            <div className="flex rounded-lg border border-border overflow-hidden">
              {/* Track labels */}
              <div className="flex flex-col shrink-0 bg-muted/40 border-r border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <div className="h-24 flex items-center px-2">Video</div>
                <div className="h-10 flex items-center px-2 border-y border-border">
                  Time
                </div>
                <div className="h-16 flex items-center px-2 border-b border-border">
                  On-screen
                </div>
                <div className="h-16 flex items-center px-2 border-b border-border">
                  Spoken
                </div>
                <div className="h-20 flex items-center px-2">Notes</div>
                <div className="h-14 flex items-center px-2 border-t border-border">
                  Tags
                </div>
                {recs && (
                  <div className="h-20 flex items-center px-2 border-t border-border text-primary">
                    Remake
                  </div>
                )}
              </div>

              {/* Scrollable tracks */}
              <div ref={timelineRef} className="relative overflow-x-auto">
                <div
                  className="relative"
                  style={{ width: totalDuration * PX_PER_SEC }}
                >
                  {/* Playhead */}
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 pointer-events-none"
                    style={{ left: playheadTime * PX_PER_SEC }}
                  />
                  <div className="flex">
                  {analysis.shots.map((s) => (
                    <button
                      key={s.index}
                      onClick={() => selectShot(s.index)}
                      style={{
                        width: (s.end_time - s.start_time) * PX_PER_SEC,
                      }}
                      className={`flex flex-col shrink-0 text-left border-l first:border-l-0 border-border transition-colors ${
                        s.index === selectedShot
                          ? "bg-primary/10"
                          : "hover:bg-muted/40"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.screenshot}
                        alt={`Shot ${s.index + 1}`}
                        className="w-full h-24 object-cover bg-muted"
                        loading="lazy"
                      />
                      <div
                        className={`h-10 w-full px-1 flex flex-col justify-center border-y ${
                          s.index === selectedShot
                            ? "border-primary/50 bg-primary/15"
                            : "border-border bg-muted/30"
                        }`}
                      >
                        <span className="text-[10px] font-mono text-foreground leading-tight truncate">
                          {s.start_time.toFixed(1)}s
                        </span>
                        <span className="text-[9px] font-mono text-muted-foreground leading-tight truncate">
                          +{(s.end_time - s.start_time).toFixed(1)}s
                        </span>
                      </div>
                      <div className="h-16 w-full px-1 py-1 overflow-hidden border-b border-border">
                        <p className="text-[9px] leading-tight text-foreground line-clamp-4 break-words italic">
                          {s.on_screen_text || <span className="text-muted-foreground">—</span>}
                        </p>
                      </div>
                      <div className="h-16 w-full px-1 py-1 overflow-hidden border-b border-border">
                        <p className="text-[9px] leading-tight text-foreground line-clamp-4 break-words">
                          {s.spoken_text || <span className="text-muted-foreground">—</span>}
                        </p>
                      </div>
                      <div className="h-20 w-full px-1 py-1 overflow-hidden">
                        <p className="text-[10px] leading-tight text-foreground line-clamp-5 break-words">
                          {s.description}
                        </p>
                      </div>
                      <div className="h-14 w-full px-1 py-1 overflow-hidden border-t border-border">
                        {s.tags?.length ? (
                          <div className="flex flex-wrap gap-0.5">
                            {s.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full bg-muted px-1.5 py-px text-[8px] leading-tight text-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[9px] text-muted-foreground">—</p>
                        )}
                      </div>
                    </button>
                  ))}
                  </div>

                  {/* Recommended library clips track (outside the shot
                      buttons — thumbnails are clickable themselves) */}
                  {recs && (
                    <div className="flex border-t border-border">
                      {analysis.shots.map((s) => {
                        const allShotRecs = recsByShot.get(s.index) || [];
                        // Float the confirmed pick to the front so its green
                        // ring is visible (manual picks append past the cap)
                        const sel = selectedByShot.get(s.index);
                        const shotRecs = sel
                          ? [
                              ...allShotRecs.filter((r) => r.filename === sel),
                              ...allShotRecs.filter((r) => r.filename !== sel),
                            ]
                          : allShotRecs;
                        return (
                          <div
                            key={s.index}
                            style={{
                              width: (s.end_time - s.start_time) * PX_PER_SEC,
                            }}
                            className={`h-20 shrink-0 border-l first:border-l-0 border-border px-1 py-1 flex items-center gap-1 overflow-hidden ${
                              s.index === selectedShot ? "bg-primary/10" : ""
                            }`}
                          >
                            {gapForShot(s.index) && (
                              <button
                                onClick={() => {
                                  selectShot(s.index, false);
                                  setPanelTab("clips");
                                }}
                                title="No library clip covers this shot — generate an AI clip"
                                className="shrink-0 px-1 py-0.5 rounded-md border border-yellow-500/60 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-[9px] font-semibold hover:bg-yellow-500/20 transition-colors"
                              >
                                ⚡ generate
                              </button>
                            )}
                            {shotRecs.length === 0 ? (
                              !gapForShot(s.index) && (
                                <span className="text-[10px] text-muted-foreground">
                                  —
                                </span>
                              )
                            ) : (
                              <>
                                {shotRecs.slice(0, 2).map((r) => (
                                  <button
                                    key={r.filename}
                                    onClick={() => {
                                      selectShot(s.index, false);
                                      setPanelTab("clips");
                                      setPreviewClip({
                                        filename: r.filename,
                                        start: r.trim_start ?? null,
                                        end: r.trim_end ?? null,
                                      });
                                    }}
                                    title={`${r.filename} (${r.confidence}) — ${r.reason}${
                                      r.trim_start != null && r.trim_end != null
                                        ? ` — use ${r.trim_start.toFixed(1)}s → ${r.trim_end.toFixed(1)}s`
                                        : ""
                                    }`}
                                    className={`relative shrink-0 rounded overflow-hidden border transition-colors ${
                                      selectedByShot.get(s.index) === r.filename
                                        ? "border-green-500 ring-2 ring-green-500/60"
                                        : "border-border hover:border-primary"
                                    }`}
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={thumbSrc(r.filename)}
                                      alt={r.filename}
                                      className="h-16 w-12 object-cover bg-muted"
                                      loading="lazy"
                                    />
                                    <span
                                      className={`absolute bottom-0 left-0 right-0 text-[8px] text-center font-semibold ${CONFIDENCE_STYLES[r.confidence]} backdrop-blur-sm`}
                                    >
                                      {r.confidence}
                                    </span>
                                  </button>
                                ))}
                                {shotRecs.length > 2 && (
                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                    +{shotRecs.length - 2}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Selected shot details */}
            <div className="rounded-lg border border-border p-3 flex flex-col gap-1">
              <p className="text-xs font-mono text-muted-foreground">
                #{shot.index + 1} · {shot.start_time.toFixed(1)}s →{" "}
                {shot.end_time.toFixed(1)}s ·{" "}
                {shot.camera_style.replaceAll("_", " ")}
              </p>
              <p className="text-sm text-foreground">{shot.description}</p>
              {shot.on_screen_text && (
                <p className="text-xs text-foreground/90 border-l-2 border-primary/50 pl-2 italic">
                  {shot.on_screen_text}
                </p>
              )}
              {shot.spoken_text && (
                <p className="text-xs text-muted-foreground">
                  🗣 {shot.spoken_text}
                </p>
              )}
              {shot.tags && shot.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {shot.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

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
        onClose={() => setAllClipsOpen(false)}
        shotDuration={shot ? shot.end_time - shot.start_time : null}
        selectedFilename={selectedClipFilename}
        onSelect={selectFromLibrary}
      />
    </div>
  );
}
