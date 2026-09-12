"use client";

import { NativeModelSelector } from "@/components/form/NativeModelSelector";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatCount } from "@/lib/utils";
import type { TikTokUserStats, TikTokVideoStats } from "@/lib/tiktok-display";
import type { DownloadEntry } from "@/lib/download-types";
import type { PublishedSource } from "@/lib/variations-schema";

const TOP_N = 5;

type FetchError =
  | { kind: "not_connected" }
  | { kind: "scope_missing"; message: string }
  | { kind: "other"; message: string };

type Stage =
  | "downloading"
  | "analyzing"
  | "tagging"
  | "suggesting"
  | "done"
  | "error";

const STAGE_LABELS: Record<Exclude<Stage, "done" | "error">, string> = {
  downloading: "Importing the published video…",
  analyzing: "Analyzing shots with Gemini…",
  tagging: "Tagging shots…",
  suggesting: "Reading the stats for improvements…",
};

interface Progress {
  stage: Stage;
  error?: string;
  filename?: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export default function IteratePage() {
  const router = useRouter();
  const [model, setModel] = useState("");
  const [videos, setVideos] = useState<TikTokVideoStats[]>([]);
  const [user, setUser] = useState<TikTokUserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Published id -> local download filename, for posts already retransferred
  const [downloadsById, setDownloadsById] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, Progress>>({});

  const loadDownloads = useCallback(async () => {
    try {
      const res = await fetch("/api/downloads");
      if (!res.ok) return;
      const data = await res.json();
      const map: Record<string, string> = {};
      for (const f of (data.files || []) as DownloadEntry[]) {
        // Only the original retransfer counts — forks (-vN) are its children
        if (f.videoId && f.version === 1) map[f.videoId] = f.name;
      }
      setDownloadsById(map);
    } catch {
      // the list is a convenience; the flow re-checks server-side anyway
    }
  }, []);

  const loadVideos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tiktok/videos");
      const data = await res.json();
      if (res.status === 401) {
        setError({ kind: "not_connected" });
      } else if (res.status === 403 && data?.error === "scope_missing") {
        setError({ kind: "scope_missing", message: data.message });
      } else if (!res.ok) {
        setError({
          kind: "other",
          message: data?.error || `HTTP ${res.status}`,
        });
      } else {
        setVideos(data.videos || []);
        setUser(data.user || null);
      }
    } catch (err) {
      setError({
        kind: "other",
        message: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tiktok_connected")) {
      setNotice("TikTok connected");
      window.history.replaceState({}, "", "/iterate");
    } else if (params.get("tiktok_error")) {
      setNotice(`TikTok connection failed: ${params.get("tiktok_error")}`);
      window.history.replaceState({}, "", "/iterate");
    }
    loadVideos();
    loadDownloads();
  }, [loadVideos, loadDownloads]);

  const handleConnect = () => {
    window.location.href = "/api/tiktok/auth/login?return_to=/iterate";
  };

  // A token can't gain scopes via refresh — disconnect + fresh authorize
  const handleReconnect = async () => {
    await fetch("/api/tiktok/auth/status", { method: "DELETE" });
    handleConnect();
  };

  const withStats = videos.filter(
    (v) => v.viewCount > 0 || v.likeCount > 0 || v.commentCount > 0
  );
  const top = [...withStats]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, TOP_N);

  const benchmark: PublishedSource["benchmark"] =
    withStats.length > 0
      ? {
          videoCount: withStats.length,
          medianViews: median(withStats.map((v) => v.viewCount)) ?? 0,
          medianCompletionRate: median(
            withStats
              .map((v) => v.completionRate)
              .filter((c): c is number => c != null)
          ),
        }
      : undefined;

  const setStage = (id: string, p: Progress) =>
    setProgress((prev) => ({ ...prev, [id]: p }));

  // Retransfer the published post into a normal project (download by aweme
  // id through the existing proxy, analyze, tag), then ask Gemini for
  // stat-grounded improvements. Every step is skipped when its output
  // already exists, so re-clicking is cheap.
  const createAlternate = async (v: TikTokVideoStats) => {
    const current = progress[v.id]?.stage;
    if (current && current !== "done" && current !== "error") return;

    try {
      let filename = downloadsById[v.id];
      if (!filename) {
        setStage(v.id, { stage: "downloading" });
        const requested = `published_${v.id}.mp4`;
        const res = await fetch(
          `/api/proxy-video?videoId=${encodeURIComponent(v.id)}&filename=${encodeURIComponent(requested)}`
        );
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || `Download failed (HTTP ${res.status})`);
        }
        // The server saved the file before responding; the body itself
        // isn't needed here
        await res.body?.cancel();
        filename = res.headers.get("X-Saved-Filename") || requested;
        setDownloadsById((prev) => ({ ...prev, [v.id]: filename! }));
        // Name it after the post so the sidebar isn't a wall of "Download N"
        await fetch("/api/downloads", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename,
            displayName: `Iterate: ${v.title || v.id}`.slice(0, 100),
          }),
        }).catch(() => {});
        window.dispatchEvent(new Event("downloads-changed"));
      }

      const prepare = await fetch("/api/iterate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename, model }) });
      const prepared = await prepare.json();
      if (!prepare.ok) throw new Error(prepared.error || "Could not prepare iteration");
      filename = prepared.filename;
      const projectId = prepared.videoId;

      let analysis = await fetch(`/api/analyze/${projectId}`).then((r) =>
        r.ok ? r.json() : null
      );
      if (!analysis) {
        setStage(v.id, { stage: "analyzing", filename });
        const res = await fetch(`/api/analyze/${projectId}`, { method: "POST" });
        analysis = await res.json();
        if (!res.ok) throw new Error(analysis?.error || "Analysis failed");
      }

      if (!analysis.taggedAt) {
        setStage(v.id, { stage: "tagging", filename });
        const res = await fetch(`/api/analyze/${projectId}/tags`, {
          method: "POST",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || "Shot tagging failed");
        }
      }

      const existing = await fetch(`/api/analyze/${projectId}/variations`).then(
        (r) => r.ok
      );
      if (!existing) {
        setStage(v.id, { stage: "suggesting", filename });
        const source: PublishedSource = {
          publishedId: v.id,
          title: v.title,
          shareUrl: v.shareUrl,
          duration: v.duration,
          createTime: v.createTime,
          viewCount: v.viewCount,
          likeCount: v.likeCount,
          commentCount: v.commentCount,
          shareCount: v.shareCount,
          completionRate: v.completionRate ?? null,
          newFollowersGained: v.newFollowersGained ?? null,
          benchmark,
        };
        const res = await fetch(`/api/analyze/${projectId}/variations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || "Suggestion generation failed");
        }
      }

      setStage(v.id, { stage: "done", filename });
      router.push(
        `/downloads/${encodeURIComponent(filename)}?view=variations`
      );
    } catch (err) {
      setStage(v.id, {
        stage: "error",
        error: err instanceof Error ? err.message : "Something failed",
      });
    }
  };

  const anyRunning = Object.values(progress).some(
    (p) => p.stage !== "done" && p.stage !== "error"
  );

  return (
    <div className="flex flex-col items-center min-h-screen p-4 bg-background text-foreground">
      <div className="flex flex-col gap-6 w-full max-w-4xl">
        <NativeModelSelector value={model} onChange={setModel} />
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-foreground">
              Iterate on a top video
            </h1>
            <p className="text-sm text-muted-foreground mt-2">
              {user
                ? `${user.displayName}'s top ${TOP_N} posts by views — pick one and build an alternate version from its stats`
                : "Your best-performing published videos, ready to remix"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/analytics"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Full analytics →
            </Link>
            <button
              onClick={() => {
                loadVideos();
                loadDownloads();
              }}
              disabled={loading}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent transition-colors disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {notice && (
          <div className="rounded-lg border border-border bg-accent/40 p-3">
            <p className="text-sm text-foreground">{notice}</p>
          </div>
        )}

        {error?.kind === "not_connected" && (
          <div className="rounded-lg border border-border p-8 text-center flex flex-col items-center gap-4">
            <p className="text-muted-foreground">
              Connect your TikTok account to see which of your published
              videos are worth iterating on.
            </p>
            <button
              onClick={handleConnect}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Connect TikTok
            </button>
          </div>
        )}

        {error?.kind === "scope_missing" && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-6 flex flex-col items-start gap-4">
            <p className="text-sm text-foreground">{error.message}</p>
            <button
              onClick={handleReconnect}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Reconnect TikTok
            </button>
          </div>
        )}

        {error?.kind === "other" && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <p className="text-sm text-red-500">{error.message}</p>
          </div>
        )}

        {!error && !loading && top.length === 0 && (
          <div className="rounded-lg border border-border p-8 text-center">
            <p className="text-muted-foreground">
              No published videos with stats yet
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              TikTok only returns public videos, and sandbox apps only see
              the connected sandbox account.
            </p>
          </div>
        )}

        {!error && top.length > 0 && (
          <div className="flex flex-col gap-3">
            {top.every((v) => v.completionRate == null) && (
              <p className="text-xs text-muted-foreground">
                Completion rates appear once you&apos;ve run &ldquo;Sync
                TikHub&rdquo; on the{" "}
                <Link href="/analytics" className="underline hover:text-foreground">
                  analytics page
                </Link>
                — suggestions get sharper with them.
              </p>
            )}
            {top.map((v, rank) => {
              const p = progress[v.id];
              const running =
                p && p.stage !== "done" && p.stage !== "error";
              const retransferred = downloadsById[v.id];
              return (
                <div
                  key={v.id}
                  className="rounded-lg border border-border p-3 flex gap-4 items-start"
                >
                  <div className="relative w-20 aspect-[9/16] rounded bg-muted overflow-hidden shrink-0">
                    {v.coverImageUrl && (
                      // Cover URLs expire after a few hours; hide a broken
                      // image and let the gray box show through
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={v.coverImageUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    )}
                    <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded-full bg-black/70 text-white text-[10px] font-semibold">
                      #{rank + 1}
                    </span>
                  </div>

                  <div className="min-w-0 flex-1 flex flex-col gap-2">
                    <div className="min-w-0">
                      <a
                        href={v.shareUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-sm font-medium text-foreground hover:text-primary transition-colors"
                      >
                        {v.title || "(untitled)"}
                      </a>
                      <p className="text-xs text-muted-foreground">
                        {v.createTime
                          ? new Date(v.createTime * 1000).toLocaleDateString()
                          : "—"}{" "}
                        · {formatDuration(v.duration)}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 flex-wrap text-sm tabular-nums">
                      <span>
                        <span className="text-muted-foreground text-xs">views </span>
                        <span className="font-semibold">{formatCount(v.viewCount)}</span>
                      </span>
                      <span>
                        <span className="text-muted-foreground text-xs">likes </span>
                        {formatCount(v.likeCount)}
                      </span>
                      <span>
                        <span className="text-muted-foreground text-xs">comments </span>
                        {formatCount(v.commentCount)}
                      </span>
                      <span>
                        <span className="text-muted-foreground text-xs">shares </span>
                        {formatCount(v.shareCount)}
                      </span>
                      <span>
                        <span className="text-muted-foreground text-xs">completion </span>
                        {v.completionRate != null
                          ? `${v.completionRate.toFixed(1)}%`
                          : "—"}
                      </span>
                      {v.newFollowersGained != null && (
                        <span>
                          <span className="text-muted-foreground text-xs">new followers </span>
                          {formatCount(v.newFollowersGained)}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        onClick={() => createAlternate(v)}
                        disabled={running || anyRunning}
                        className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {running
                          ? STAGE_LABELS[p.stage as keyof typeof STAGE_LABELS]
                          : retransferred
                            ? "Open alternate version"
                            : "Create alternate version"}
                      </button>
                      {retransferred && !running && (
                        <Link
                          href={`/downloads/${encodeURIComponent(retransferred)}`}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Already imported · open source
                        </Link>
                      )}
                      {p?.stage === "error" && (
                        <span className="text-xs text-red-500 break-words">
                          {p.error}
                        </span>
                      )}
                      {p?.stage === "done" && p.filename && (
                        <Link
                          href={`/downloads/${encodeURIComponent(p.filename)}?view=variations`}
                          className="text-xs text-primary hover:underline"
                        >
                          Ready — open in editor
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
