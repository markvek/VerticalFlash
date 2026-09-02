"use client";

import { useEffect, useState } from "react";
import { useScanHistory } from "@/app/context/scan-history";
import { formatCount } from "@/lib/utils";
import { useRouter } from "next/navigation";

interface DownloadFile {
  name: string;
  size: number;
  modified: number;
  displayName: string;
}

export function HistorySidebar() {
  const { scans, currentScanId, deleteScan } = useScanHistory();
  const router = useRouter();
  const [downloads, setDownloads] = useState<DownloadFile[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(true);
  const [loadingDownloads, setLoadingDownloads] = useState(false);

  useEffect(() => {
    loadDownloads();
    // Re-fetch when another view renames or changes downloads
    const onChanged = () => loadDownloads();
    window.addEventListener("downloads-changed", onChanged);
    return () => window.removeEventListener("downloads-changed", onChanged);
  }, []);

  const loadDownloads = async () => {
    setLoadingDownloads(true);
    try {
      const response = await fetch("/api/downloads");
      if (response.ok) {
        const data = await response.json();
        setDownloads(data.files || []);
      }
    } catch (error) {
      console.error("Failed to load downloads:", error);
    } finally {
      setLoadingDownloads(false);
    }
  };

  const handleDeleteDownload = async (filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return;

    try {
      const response = await fetch("/api/downloads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });

      if (response.ok) {
        await loadDownloads();
      } else {
        alert("Failed to delete file");
      }
    } catch (error) {
      alert("Failed to delete file");
    }
  };

  // Build chain from current scan back to root
  const getCurrentChain = (): string[] => {
    if (!currentScanId) return [];
    const chain: string[] = [];
    let current = scans.find((s) => s.id === currentScanId);
    while (current) {
      chain.unshift(current.id);
      const parentId = current.parentScanId;
      current = parentId ? scans.find((s) => s.id === parentId) : undefined;
    }
    return chain;
  };

  const currentChain = getCurrentChain();

  return (
    <div className="w-56 border-r border-border bg-card">
      <div className="space-y-4 p-4">
        {/* Global entry points */}
        <div className="space-y-1">
          <button
            onClick={() => router.push("/")}
            className="w-full text-left flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors"
          >
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"
              />
            </svg>
            Start
          </button>
          <button
            onClick={() => router.push("/scan")}
            className="w-full text-left flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors"
          >
            <svg
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
              />
            </svg>
            New scan
          </button>
        </div>

        <div className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-foreground">
            Scan History
          </h2>
          {currentChain.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {currentChain.map((id, idx) => (
                <span key={id}>
                  {idx > 0 && " → "}
                  Scan {scans.findIndex((s) => s.id === id) + 1}
                </span>
              ))}
            </p>
          )}
        </div>

        {scans.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No scans yet. Start scanning to build history.
          </p>
        )}

        <div className="space-y-2 max-h-96 overflow-y-auto">
          {scans.map((scan, idx) => {
            const isSelected = scan.id === currentScanId;
            const isInChain = currentChain.includes(scan.id);
            const seedsPreview = [
              scan.seeds.hashtags.slice(0, 1).join(", "),
              scan.seeds.keywords.slice(0, 1).join(", "),
              scan.seeds.competitors.slice(0, 1).join(", "),
            ]
              .filter(Boolean)
              .join(", ");

            return (
              <div key={scan.id}>
                <button
                  onClick={() => router.push(`/results?scan=${scan.id}`)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    isSelected
                      ? "bg-primary/10 border-primary/50 border text-foreground font-medium"
                      : isInChain
                        ? "bg-muted/50 text-foreground hover:bg-muted"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                  }`}
                >
                  <div className="font-medium">Scan {idx + 1}</div>
                  <div className="text-xs mt-0.5 line-clamp-1">
                    {seedsPreview || "No seeds"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {new Date(scan.timestamp).toLocaleTimeString()}
                  </div>
                </button>
                {isSelected && (
                  <button
                    onClick={() => {
                      if (
                        confirm("Delete this scan from history?")
                      ) {
                        deleteScan(scan.id);
                        router.push("/scan");
                      }
                    }}
                    className="w-full text-xs mt-1 px-2 py-1 text-destructive hover:bg-destructive/10 rounded transition-colors"
                  >
                    Delete Scan
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Downloads Section */}
        <div className="border-t border-border pt-4 space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDownloadsOpen(!downloadsOpen)}
              aria-label="Toggle downloads list"
              className="text-foreground hover:text-primary transition-colors"
            >
              <svg
                className={`size-4 transition-transform ${downloadsOpen ? "rotate-90" : ""}`}
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <button
              onClick={() => router.push("/downloads")}
              className="flex-1 text-left flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors"
            >
              Downloads
              {downloads.length > 0 && (
                <span className="text-xs ml-auto bg-primary/20 px-2 py-0.5 rounded">
                  {downloads.length}
                </span>
              )}
            </button>
          </div>

          {downloadsOpen && (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {loadingDownloads ? (
                <p className="text-xs text-muted-foreground px-2">Loading...</p>
              ) : downloads.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2">
                  No downloads yet
                </p>
              ) : (
                downloads.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded hover:bg-muted/50 group"
                  >
                    <button
                      onClick={() => router.push(`/downloads/${encodeURIComponent(file.name)}`)}
                      className="flex-1 min-w-0 text-left hover:text-primary transition-colors"
                    >
                      <p className="truncate text-foreground">
                        {file.displayName}
                      </p>
                      <p className="truncate text-muted-foreground">
                        {file.name} · {(file.size / 1024 / 1024).toFixed(1)}MB
                      </p>
                    </button>
                    <button
                      onClick={() => handleDeleteDownload(file.name)}
                      className="opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive/80 transition-opacity"
                      title="Delete"
                    >
                      <svg className="size-3" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Clip library */}
        <div className="border-t border-border pt-4">
          <button
            onClick={() => router.push("/library")}
            className="w-full text-left flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
              />
            </svg>
            Clip library
          </button>
        </div>

        {/* TikTok analytics */}
        <div className="border-t border-border pt-4">
          <button
            onClick={() => router.push("/analytics")}
            className="w-full text-left flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 20h18M6 16v-4m4 4V8m4 8v-6m4 6V4"
              />
            </svg>
            TikTok analytics
          </button>
          <button
            onClick={() => router.push("/iterate")}
            className="w-full text-left flex items-center gap-2 text-sm font-semibold text-foreground hover:text-primary transition-colors mt-3"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h5M20 20v-5h-5M5.6 9A8 8 0 0119 8.3M18.4 15A8 8 0 015 15.7"
              />
            </svg>
            Iterate on a top video
          </button>
        </div>
      </div>
    </div>
  );
}
