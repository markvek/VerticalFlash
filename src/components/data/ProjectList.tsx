"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DownloadCard } from "@/components/data/DownloadCard";
import type { DownloadEntry } from "@/lib/download-types";
import { MATCH_MIN_VIEWS } from "@/lib/match-published";
import { projectHref, projectStage } from "@/lib/project-navigation";
import Link from "next/link";

export function ProjectList({ stage }: { stage?: "storyboarding" | "editing" }) {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  // filename → view count of the matched published post (> MATCH_MIN_VIEWS)
  const [hitViews, setHitViews] = useState<Record<string, number>>({});
  const router = useRouter();

  // Proven winners: match published posts over the view threshold back to
  // their local downloads (same scoring the analytics page uses). Best-effort
  // — no TikTok connection just means no highlights.
  const loadHits = useCallback(async () => {
    try {
      const res = await fetch("/api/tiktok/videos");
      if (!res.ok) return;
      const data = await res.json();
      const winners = (data.videos || [])
        .filter((v: { viewCount: number }) => v.viewCount > MATCH_MIN_VIEWS)
        .map((v: { id: string; title: string; duration: number; createTime: number }) => ({
          id: v.id,
          title: v.title,
          duration: v.duration,
          createTime: v.createTime,
        }));
      if (winners.length === 0) return;
      const views = new Map<string, number>(
        (data.videos || []).map((v: { id: string; viewCount: number }) => [
          v.id,
          v.viewCount,
        ])
      );
      const matchRes = await fetch("/api/published-matches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: winners }),
      });
      if (!matchRes.ok) return;
      const matchData = await matchRes.json();
      const map: Record<string, number> = {};
      for (const m of matchData.matches || []) {
        const count = views.get(m.publishedId) ?? 0;
        // Two matched posts can share a download — keep the bigger hit
        map[m.filename] = Math.max(map[m.filename] ?? 0, count);
      }
      setHitViews(map);
    } catch {
      // decorative — never surface an error for it
    }
  }, []);

  const loadDownloads = useCallback(async () => {
    try {
      const response = await fetch("/api/downloads");
      if (response.ok) {
        const data = await response.json();
        setDownloads(data.files || []);
      }
    } catch (error) {
      console.error("Failed to load downloads:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDownloads();
    loadHits();
    // Stay in sync with sidebar deletes/renames and fresh downloads
    window.addEventListener("downloads-changed", loadDownloads);
    return () => window.removeEventListener("downloads-changed", loadDownloads);
  }, [loadDownloads, loadHits]);

  const handleDelete = async (filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return;

    try {
      const response = await fetch("/api/downloads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });

      if (response.ok) {
        window.dispatchEvent(new Event("downloads-changed"));
        await loadDownloads();
      } else {
        const body = await response.json().catch(() => null);
        alert(body?.error ?? "Failed to delete file");
      }
    } catch {
      alert("Failed to delete file");
    }
  };

  const handleFork = async (filename: string) => {
    setForking(filename);
    try {
      const response = await fetch(
        `/api/downloads/${encodeURIComponent(filename)}/fork`,
        { method: "POST" }
      );
      if (response.ok) {
        window.dispatchEvent(new Event("downloads-changed"));
        await loadDownloads();
      } else {
        const body = await response.json().catch(() => null);
        alert(body?.error ?? "Fork failed");
      }
    } catch {
      alert("Fork failed");
    } finally {
      setForking(null);
    }
  };

  const handleRename = async (filename: string, displayName: string) => {
    try {
      const response = await fetch("/api/downloads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, displayName }),
      });
      if (response.ok) {
        window.dispatchEvent(new Event("downloads-changed"));
        await loadDownloads();
      }
    } catch (error) {
      console.error("Failed to rename download:", error);
    }
  };

  // API order is oldest-first (keeps "Download N" numbering stable); the feed
  // reads better most-recently-edited-first — except proven winners (matched
  // to a published post over the view threshold), which lead sorted by views
  const visible = downloads.filter((file) => !stage || projectStage(file) === stage);
  const sorted = [...visible].sort((a, b) => {
    const hitA = hitViews[a.name] ?? 0;
    const hitB = hitViews[b.name] ?? 0;
    if (hitA !== hitB) return hitB - hitA;
    return (
      (b.lastEditedAt ?? b.modified) - (a.lastEditedAt ?? a.modified)
    );
  });

  return (
    <div className="downloads-layout min-h-screen bg-background text-foreground">
      <div className="max-w-5xl mx-auto p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">{stage === "storyboarding" ? "Storyboarding" : stage === "editing" ? "Editing" : "Downloads"}</h1>
          <p className="text-muted-foreground mt-2">
            {visible.length} project{visible.length !== 1 ? "s" : ""}
          </p>
          {stage === "storyboarding" && <Link href="/storyboard" className="mt-3 inline-block text-sm underline">New storyboard project</Link>}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">
              No {stage === "storyboarding" ? "storyboard" : stage === "editing" ? "editing" : "saved"} projects yet
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sorted.map((file) => (
              <DownloadCard
                key={file.name}
                file={file}
                matchedViews={hitViews[file.name] ?? null}
                playing={playing === file.name}
                onPlay={() => setPlaying(file.name)}
                onOpen={() =>
                  router.push(projectHref(file))
                }
                onFork={() => handleFork(file.name)}
                forking={forking === file.name}
                onDelete={() => handleDelete(file.name)}
                onRename={(name) => handleRename(file.name, name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
