"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, ChevronRight, ClipboardCheck, Film, Home, Menu, PanelLeftClose, PanelLeftOpen, RotateCcw, Search, Settings2, Trash2, X } from "lucide-react";
import { useScanHistory } from "@/app/context/scan-history";
import type { DownloadEntry } from "@/lib/download-types";
import { projectHref, projectStage, workspaceProjects } from "@/lib/project-navigation";

export function HistorySidebar() {
  const { scans, currentScanId, deleteScan } = useScanHistory();
  const pathname = usePathname();
  const [files, setFiles] = useState<DownloadEntry[]>([]);
  const [open, setOpen] = useState({ scans: true, storyboarding: true, editing: true });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("navigation-collapsed") === "true"); } catch { /* Storage may be unavailable. */ }
  }, []);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem("navigation-collapsed", String(next)); } catch { /* Keep the in-session choice. */ }
  };

  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/downloads");
      if (!response.ok) throw new Error("Could not load local projects");
      const data = await response.json();
      setFiles(data.files ?? []);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load local projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
    window.addEventListener("downloads-changed", loadProjects);
    window.addEventListener("focus", loadProjects);
    return () => {
      window.removeEventListener("downloads-changed", loadProjects);
      window.removeEventListener("focus", loadProjects);
    };
  }, [loadProjects, pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const removeProject = async (file: DownloadEntry) => {
    if (!confirm(`Delete "${file.displayName}" and its local project files?`)) return;
    setDeleting(file.name);
    try {
      const response = await fetch("/api/downloads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not delete project");
      window.dispatchEvent(new Event("downloads-changed"));
      if (pathname.endsWith(`/${encodeURIComponent(file.name)}`)) {
        window.location.assign("/editing");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete project");
    } finally {
      setDeleting(null);
    }
  };

  const navClass = "flex min-h-7 items-center gap-2 text-sm font-semibold hover:text-primary";
  const closeMobile = () => setMobileOpen(false);
  const chain: string[] = [];
  let current = scans.find((scan) => scan.id === currentScanId);
  while (current && !chain.includes(current.id)) {
    chain.unshift(current.id);
    const parentId = current.parentScanId;
    current = scans.find((scan) => scan.id === parentId);
  }

  return (
    <>
      <button type="button" onClick={() => setMobileOpen(true)} aria-label="Open navigation" title="Open navigation"
        className="fixed left-3 top-3 z-40 flex size-10 items-center justify-center rounded-md border border-border bg-card md:hidden">
        <Menu className="size-5" />
      </button>
      {mobileOpen && <button aria-label="Close navigation" onClick={closeMobile} className="fixed inset-0 z-40 bg-black/30 md:hidden" />}
      <aside aria-label="Main navigation"
        className={`${mobileOpen ? "fixed inset-y-0 left-0 z-50 flex" : "hidden"} w-56 shrink-0 flex-col border-r border-border bg-card md:sticky md:top-0 md:flex md:h-screen ${collapsed ? "md:w-14" : "md:w-56"}`}>
        <div className="flex shrink-0 items-center p-3">
          <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"} aria-expanded={!collapsed} aria-controls="site-navigation"
            className="ml-auto hidden size-8 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary md:flex">
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
          <button onClick={closeMobile} aria-label="Close navigation" title="Close navigation"
            className="ml-auto flex size-8 items-center justify-center md:hidden"><X className="size-4" /></button>
        </div>
        <nav id="site-navigation" className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 ${collapsed ? "md:hidden" : ""}`} onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) closeMobile();
        }}>
          <div className="space-y-1">
            <Link href="/" className={navClass}><Home className="size-4 shrink-0" />Start</Link>
            <Link href="/scan" className={navClass}><Search className="size-4 shrink-0" />New scan</Link>
          </div>

          <section className="border-t border-border pt-4">
            <button onClick={() => setOpen((value) => ({ ...value, scans: !value.scans }))}
              aria-expanded={open.scans} aria-controls="sidebar-scans" className="flex w-full items-center gap-2 text-left text-sm font-semibold">
              <ChevronRight className={`size-3.5 shrink-0 ${open.scans ? "rotate-90" : ""}`} />Scan History
            </button>
            {open.scans && chain.length > 0 && <p className="mt-1 break-words text-xs text-muted-foreground">
              {chain.map((id) => `Scan ${scans.findIndex((scan) => scan.id === id) + 1}`).join(" > ")}
            </p>}
            {open.scans && <div id="sidebar-scans" className="mt-3 max-h-64 space-y-1 overflow-y-auto">
              {scans.length === 0 && <p className="px-2 text-xs text-muted-foreground">No scans yet</p>}
              {scans.map((scan, index) => {
                const selected = scan.id === currentScanId;
                const seeds = [...scan.seeds.hashtags.slice(0, 1), ...scan.seeds.keywords.slice(0, 1), ...scan.seeds.competitors.slice(0, 1)].join(", ");
                return <div key={scan.id}>
                  <Link href={`/results?scan=${scan.id}`} aria-current={selected ? "page" : undefined}
                    className={`block rounded-md px-3 py-2 text-sm ${selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}>
                    <div className="font-medium">Scan {index + 1}</div>
                    <div className="truncate text-xs" title={seeds}>{seeds || "No seeds"}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{new Date(scan.timestamp).toLocaleTimeString()}</div>
                  </Link>
                  {selected && <button className="flex items-center gap-1 px-3 py-1 text-xs text-destructive"
                    onClick={() => { if (confirm("Delete this scan from history?")) deleteScan(scan.id); }}>
                    <Trash2 className="size-3" />Delete Scan
                  </button>}
                </div>;
              })}
            </div>}
          </section>

          {(["editing"] as const).map((stage) => {
            const title = "Editing";
            const entries = workspaceProjects(files).filter((file) => projectStage(file) === stage)
              .sort((a, b) => (b.lastEditedAt ?? b.modified) - (a.lastEditedAt ?? a.modified));
            const href = "/editing";
            return <section key={stage} className="space-y-2 border-t border-border pt-4">
              <div className="flex min-h-5 items-center gap-2">
                <button onClick={() => setOpen((value) => ({ ...value, [stage]: !value[stage] }))}
                  aria-expanded={open[stage]} aria-controls={`sidebar-${stage}`} aria-label={`Toggle ${title}`} title={`Toggle ${title}`}
                  className="flex size-5 shrink-0 items-center justify-center">
                  <ChevronRight className={`size-3.5 ${open[stage] ? "rotate-90" : ""}`} />
                </button>
                <Link href={href} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
                  {title}<span className="ml-auto min-w-5 rounded bg-muted px-1 text-center text-xs leading-5 tabular-nums">{entries.length}</span>
                </Link>
              </div>
              {open[stage] && <div id={`sidebar-${stage}`} className="max-h-48 space-y-1 overflow-y-auto">
                {loading ? <p className="px-2 text-xs text-muted-foreground">Loading...</p>
                  : entries.length === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">No {"editing projects"} yet</p>
                  : entries.map((file) => {
                    const selected = pathname.endsWith(`/${encodeURIComponent(file.name)}`);
                    return <div key={file.name} className={`group flex min-h-11 items-center gap-1 rounded px-2 py-1.5 ${selected ? "bg-muted" : "hover:bg-muted/50"}`}>
                      <Link href={projectHref(file)} aria-current={selected ? "page" : undefined} className="min-w-0 flex-1 text-xs" title={file.displayName}>
                        <div className="truncate">{file.displayName}</div>
                        <div className="mt-0.5 truncate text-muted-foreground">{file.project?.kind === "master" ? "Storyboards & edits" : file.name}</div>
                      </Link>
                      <button onClick={() => removeProject(file)} disabled={deleting === file.name}
                        aria-label={`Delete ${file.displayName}`} title="Delete project"
                        className="flex size-6 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive focus:opacity-100 md:opacity-0 md:group-hover:opacity-100 disabled:opacity-50">
                        <X className="size-3" />
                      </button>
                    </div>;
                  })}
              </div>}
            </section>;
          })}

          {error && <div role="alert" className="space-y-2 text-xs text-destructive">
            <p className="break-words">{error}</p>
            <button onClick={loadProjects} className="flex items-center gap-1"><RotateCcw className="size-3" />Retry</button>
          </div>}

          <div className="border-t border-border pt-4">
            <Link href="/library" className={navClass}><Film className="size-4 shrink-0" />Clip library</Link>
          </div>
          <div className="space-y-2 border-t border-border pt-4">
            <Link href="/analytics" className={navClass}><BarChart3 className="size-4 shrink-0" />TikTok analytics</Link>
            <Link href="/iterate" className={navClass}><RotateCcw className="size-4 shrink-0" />Iterate on a top video</Link>
            <Link href="/benchmarks" className={navClass}><ClipboardCheck className="size-4 shrink-0" />Benchmarks</Link>
          </div>
          <div className="border-t border-border pt-4">
            <Link href="/settings" aria-current={pathname === "/settings" ? "page" : undefined}
              className={`${navClass} ${pathname === "/settings" ? "text-primary" : ""}`}><Settings2 className="size-4 shrink-0" />Settings</Link>
          </div>
        </nav>
      </aside>
    </>
  );
}
