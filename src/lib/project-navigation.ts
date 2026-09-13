import type { DownloadEntry } from "./download-types";
export function projectStage(_file: Pick<DownloadEntry, "stage" | "project">): "editing" { void _file; return "editing"; }
export function projectHref(file: Pick<DownloadEntry, "stage" | "project" | "name">): string {
  if (file.project?.kind === "cutdown") return `/editing/${encodeURIComponent(file.project.masterFilename)}?edit=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ""))}&view=video`;
  return `/editing/${encodeURIComponent(file.name)}${file.project?.kind === "master" ? "?view=storyboards" : ""}`;
}
export function workspaceProjects(files: DownloadEntry[]) {
  const parents = new Set(files.filter(f => f.project?.kind === "master").map(f => f.videoId));
  return files.filter(f => f.project?.kind !== "cutdown" || !parents.has(f.project.masterId)).map(file => file.project?.kind === "master"
    ? { ...file, lastEditedAt: Math.max(file.lastEditedAt ?? file.modified, ...files.filter(child => child.project?.kind === "cutdown" && child.project.masterId === file.videoId).map(child => child.lastEditedAt ?? child.modified)) }
    : file);
}
