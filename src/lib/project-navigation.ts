import type { DownloadEntry } from "./download-types";

export function projectStage(file: Pick<DownloadEntry, "stage" | "project">) {
  return file.stage ?? (file.project?.kind === "master" ? "storyboarding" : "editing");
}

export function projectHref(file: Pick<DownloadEntry, "stage" | "project" | "name">): string {
  const base = projectStage(file) === "storyboarding" ? "/storyboards" : "/editing";
  return `${base}/${encodeURIComponent(file.name)}`;
}
