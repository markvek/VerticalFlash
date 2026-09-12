"use client";

import { useCallback, useEffect, useState } from "react";
import { matchesCohort } from "@/lib/metric-cohorts";
import Link from "next/link";
import { formatCount } from "@/lib/utils";
import type { TikTokUserStats, TikTokVideoStats } from "@/lib/tiktok-display";


type RemakeMatch = { filename: string; displayName: string | null; videoId: string; exportId?: string; confirmed?: boolean };
type ExportCandidate = { videoId: string; filename: string; exportId?: string; renderedAt: string };

type SortKey =
  | "createTime"
  | "viewCount"
  | "likeCount"
  | "commentCount"
  | "shareCount"
  | "completionRate";

type FetchError =
  | { kind: "not_connected" }
  | { kind: "scope_missing"; message: string }
  | { kind: "other"; message: string };

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "createTime", label: "Posted" },
  { key: "viewCount", label: "Views" },
  { key: "completionRate", label: "Completion %" },
  { key: "likeCount", label: "Likes" },
  { key: "commentCount", label: "Comments" },
  { key: "shareCount", label: "Shares" },
];

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimeUntilExpiry(expiresAt: number): string {
  const now = Date.now();
  if (expiresAt <= now) return "Expired";
  const diffMs = expiresAt - now;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Sandbox / unaudited apps can report counts as 0 or absent — render a dash
// instead of a misleading zero when the whole row has no engagement data
function statCell(value: number, rowHasStats: boolean): string {
  if (!rowHasStats && value === 0) return "—";
  return formatCount(value);
}

export default function AnalyticsPage() {
  const [videos, setVideos] = useState<TikTokVideoStats[]>([]);
  const [user, setUser] = useState<TikTokUserStats | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FetchError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ageGroup, setAgeGroup] = useState("all");
  const [durationGroup, setDurationGroup] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("createTime");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [tikhubLoading, setTikhubLoading] = useState(false);
  const [tikhubCachedAt, setTikhubCachedAt] = useState<number | null>(null);
  const [tikhubCacheExpiresAt, setTikhubCacheExpiresAt] = useState<number | null>(null);
  const [tikhubError, setTikhubError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ExportCandidate[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Record<string, RemakeMatch>>({});

  // Suggest links from published posts to historical render snapshots to
  // find which download each published post came from. Best-effort — the
  // table works fine without the Remake column populated.
  const loadMatches = useCallback(async (rows: TikTokVideoStats[]) => {
    const winners = rows
      .slice(0, 1000)
      .map((v) => ({
        id: v.id,
        title: v.title,
        duration: v.duration,
        createTime: v.createTime,
      }));
    if (winners.length === 0) return;
    try {
      const res = await fetch("/api/published-matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: winners }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load export links");
      setCandidates(data.candidates ?? []);
      const map: Record<string, RemakeMatch> = {};
      for (const m of data.matches || []) {
        map[m.publishedId] = {
          filename: m.filename, videoId: m.videoId, exportId: m.exportId, confirmed: m.confirmed,
          displayName: m.displayName ?? null,
        };
      }
      setMatches(map);
    } catch (e) { setLinkError(e instanceof Error ? e.message : "Could not load export links"); }
  }, []);

  const linkExport = async (publishedId: string, value: string) => {
    setLinkError(null);
    const chosen = candidates.find(c => `${c.videoId}:${c.exportId ?? ""}` === value);
    try { const response = await fetch("/api/published-matches", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publishedId, videoId: chosen?.videoId ?? null, exportId: chosen?.exportId }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error); await loadMatches(videos);
    } catch (e) { setLinkError(e instanceof Error ? e.message : "Could not save export link"); }
  };

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
        setTikhubCachedAt(data.tikhubCachedAt ?? null);
        setTikhubCacheExpiresAt(data.tikhubCacheExpiresAt ?? null);
        setVideos(data.videos || []);
        setUser(data.user || null);
        setFetchedAt(data.fetchedAt || Date.now());
        loadMatches(data.videos || []);
      }
    } catch (err) {
      setError({
        kind: "other",
        message: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setLoading(false);
    }
  }, [loadMatches]);

  const syncTikhubData = useCallback(async () => {
    setTikhubLoading(true);
    setTikhubError(null);
    try {
      const res = await fetch("/api/tiktok/videos/tikhub");
      const data = await res.json();
      if (!res.ok) {
        setTikhubError(data?.message || data?.error || `HTTP ${res.status}`);
      } else {
        setTikhubCachedAt(data.cachedAt);
        setTikhubCacheExpiresAt(data.cacheExpiresAt);
        // Merge TikHub stats back into videos
        const tikhubMap = new Map(
          (data.videos || []).map(
            (v: {
              aweme_id: string;
              completion_rate?: number | null;
              new_follower_cnt?: number | null;
            }) => [
            v.aweme_id,
            { completionRate: v.completion_rate, newFollowersGained: v.new_follower_cnt },
          ])
        );
        const merged = videos.map((v) => {
          const tikhubStats = tikhubMap.get(v.id);
          return tikhubStats ? { ...v, ...tikhubStats } : v;
        });
        setVideos(merged);
      }
    } catch (err) {
      setTikhubError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setTikhubLoading(false);
    }
  }, [videos]);

  useEffect(() => {
    // Post-OAuth feedback from the callback redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get("tiktok_connected")) {
      setNotice("TikTok connected");
      window.history.replaceState({}, "", "/analytics");
    } else if (params.get("tiktok_error")) {
      setNotice(`TikTok connection failed: ${params.get("tiktok_error")}`);
      window.history.replaceState({}, "", "/analytics");
    }
    loadVideos();
  }, [loadVideos]);

  const handleConnect = () => {
    window.location.href = "/api/tiktok/auth/login?return_to=/analytics";
  };

  // The saved token can't gain scopes via refresh, so a scope fix is always
  // disconnect + fresh authorize in one click
  const handleReconnect = async () => {
    await fetch("/api/tiktok/auth/status", { method: "DELETE" });
    handleConnect();
  };

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sorted = videos.filter(v => matchesCohort(v, ageGroup, durationGroup, fetchedAt ?? Date.now())).sort((a, b) => {
    const aVal = a[sortKey as keyof typeof a] as number | undefined;
    const bVal = b[sortKey as keyof typeof b] as number | undefined;
    // Handle undefined values — sort to the end
    if (aVal === undefined && bVal === undefined) return 0;
    if (aVal === undefined) return sortDir === "desc" ? 1 : -1;
    if (bVal === undefined) return sortDir === "desc" ? -1 : 1;
    return sortDir === "desc" ? bVal - aVal : aVal - bVal;
  });

  const totalViews = videos.reduce((sum, v) => sum + v.viewCount, 0);

  return (
    <div className="flex flex-col items-center min-h-screen p-4 bg-background text-foreground">
      <div className="flex flex-col gap-6 w-full max-w-6xl">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold text-foreground">
              TikTok Analytics
            </h1>
            <p className="text-sm text-muted-foreground mt-2">
              {user ? (
                <>
                  {user.displayName}
                  {user.followerCount !== undefined &&
                    ` · ${formatCount(user.followerCount)} followers`}
                  {user.likesCount !== undefined &&
                    ` · ${formatCount(user.likesCount)} likes`}
                  {user.videoCount !== undefined &&
                    ` · ${user.videoCount} videos`}
                </>
              ) : (
                "Stats for your published videos"
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3">
              {fetchedAt && (
                <span className="text-xs text-muted-foreground">
                  fetched {new Date(fetchedAt).toLocaleTimeString()}
                </span>
              )}
              <button
                onClick={loadVideos}
                disabled={loading}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent transition-colors disabled:opacity-50"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {tikhubCacheExpiresAt && (
                <>
                  <span className="text-muted-foreground">
                    {tikhubCacheExpiresAt > Date.now()
                      ? `TikHub cache expires in ${formatTimeUntilExpiry(tikhubCacheExpiresAt)}`
                      : "TikHub cache expired"}
                  </span>
                  <button
                    onClick={syncTikhubData}
                    disabled={tikhubLoading || (tikhubCacheExpiresAt > Date.now())}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {tikhubLoading ? "Syncing…" : "Sync TikHub"}
                  </button>
                </>
              )}
              {!tikhubCacheExpiresAt && (
                <button
                  onClick={syncTikhubData}
                  disabled={tikhubLoading}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                >
                  {tikhubLoading ? "Syncing…" : "Sync TikHub Data"}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2 text-xs text-muted-foreground">
          <p>Views, likes, comments and shares: TikTok Display API lifetime totals{fetchedAt ? `, fetched ${new Date(fetchedAt).toLocaleString()}` : ""}.</p>
          <p>Completion and follower gains: TikHub{tikhubCachedAt ? `, observed ${new Date(tikhubCachedAt).toLocaleString()}` : ", not synced"}{tikhubCacheExpiresAt && tikhubCacheExpiresAt < Date.now() ? " · Stale cache — sync to refresh." : ""}.</p>
          <div className="flex flex-wrap items-center gap-3">
            <label>Post age <select aria-label="Filter by post age" value={ageGroup} onChange={e => setAgeGroup(e.target.value)} className="rounded border bg-background p-1"><option value="all">All ages</option><option value="week">0–7 days</option><option value="month">8–30 days</option><option value="older">Over 30 days</option></select></label>
            <label>Video length <select aria-label="Filter by video length" value={durationGroup} onChange={e => setDurationGroup(e.target.value)} className="rounded border bg-background p-1"><option value="all">All lengths</option><option value="short">Up to 15s</option><option value="medium">Over 15–30s</option><option value="long">Over 30s</option></select></label>
          </div>
          <p>Compare posts of similar age and length. Lifetime views and completion rates are not controlled experiments or evidence that a particular edit caused an outcome.</p>
        </div>
        {linkError && <p role="alert" className="text-sm text-destructive">{linkError}</p>}
        {notice && (
          <div className="rounded-lg border border-border bg-accent/40 p-3">
            <p className="text-sm text-foreground">{notice}</p>
          </div>
        )}

        {error?.kind === "not_connected" && (
          <div className="rounded-lg border border-border p-8 text-center flex flex-col items-center gap-4">
            <p className="text-muted-foreground">
              Connect your TikTok account to see analytics for your published
              videos.
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

        {tikhubError && (
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3">
            <p className="text-sm text-yellow-700">{tikhubError}</p>
          </div>
        )}

        {!error && !loading && videos.length === 0 && (
          <div className="rounded-lg border border-border p-8 text-center">
            <p className="text-muted-foreground">No public videos found</p>
            <p className="text-xs text-muted-foreground mt-2">
              TikTok only returns public videos — and sandbox apps only see
              videos on the connected sandbox account.
            </p>
          </div>
        )}

        {!error && videos.length > 0 && (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="p-3 font-medium">Video</th>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      className="p-3 font-medium cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap"
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1">
                          {sortDir === "desc" ? "↓" : "↑"}
                        </span>
                      )}
                    </th>
                  ))}
                  <th className="p-3 font-medium">Remake</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((v) => {
                  const rowHasStats =
                    v.viewCount > 0 ||
                    v.likeCount > 0 ||
                    v.commentCount > 0 ||
                    v.shareCount > 0;
                  return (
                    <tr
                      key={v.id}
                      className="border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors"
                    >
                      <td className="p-3">
                        <a
                          href={v.shareUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-3 group"
                        >
                          <div className="w-10 aspect-[9/16] rounded bg-muted overflow-hidden shrink-0">
                            {v.coverImageUrl && (
                              // Cover URLs expire after a few hours; hide the
                              // broken image and let the gray box show through
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
                          </div>
                          <div className="min-w-0">
                            <p className="truncate max-w-xs text-foreground group-hover:text-primary transition-colors">
                              {v.title || "(untitled)"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDuration(v.duration)}
                            </p>
                          </div>
                        </a>
                      </td>
                      <td className="p-3 whitespace-nowrap text-muted-foreground">
                        {v.createTime
                          ? new Date(v.createTime * 1000).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="p-3 tabular-nums">
                        {statCell(v.viewCount, rowHasStats)}
                      </td>
                      <td className="p-3 tabular-nums">
                        {v.completionRate !== undefined ? `${v.completionRate.toFixed(1)}%` : "—"}
                      </td>
                      <td className="p-3 tabular-nums">
                        {statCell(v.likeCount, rowHasStats)}
                      </td>
                      <td className="p-3 tabular-nums">
                        {statCell(v.commentCount, rowHasStats)}
                      </td>
                      <td className="p-3 tabular-nums">
                        {statCell(v.shareCount, rowHasStats)}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {matches[v.id] ? (
                          <Link
                            href={`/downloads/${encodeURIComponent(matches[v.id].filename)}`}
                            title={matches[v.id].displayName ?? matches[v.id].filename}
                            className="inline-block rounded border border-border px-2 py-1 text-xs hover:bg-accent hover:text-foreground transition-colors"
                          >
                            {matches[v.id].confirmed ? "Open confirmed edit" : "Open suggested edit"}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Unlinked</span>
                        )}
                        <select aria-label={`Confirm or correct export for ${v.title || v.id}`} value="" onChange={e => void linkExport(v.id, e.target.value)} className="mt-1 block max-w-48 rounded border bg-background p-1 text-xs">
                          <option value="" disabled>Confirm or correct link…</option>
                          <option value="unlink">No matching export</option>
                          {candidates.map(c => <option key={`${c.videoId}:${c.exportId}`} value={`${c.videoId}:${c.exportId ?? ""}`}>{c.filename} · {new Date(c.renderedAt).toLocaleString()}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {videos.length > 1 && (
                <tfoot>
                  <tr className="border-t border-border text-muted-foreground">
                    <td className="p-3 font-medium">
                      {videos.length} videos
                    </td>
                    <td className="p-3" />
                    <td className="p-3 tabular-nums font-medium">
                      {totalViews > 0 ? formatCount(totalViews) : "—"}
                    </td>
                    <td className="p-3" colSpan={4} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
