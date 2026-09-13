// Shape of one file in the GET /api/downloads listing, shared by the API
// route and the client views that render it (downloads homepage, sidebar).

export interface DownloadEntryMeta {
  caption: string;
  authorHandle: string;
  authorName: string;
  playCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  duration: number;
  createdAt: number;
}

export interface DownloadEntryMusic {
  filename: string;
  title: string;
  author: string;
  duration: number | null;
}

// Creation brief for projects started from /create: the flow, the prompt,
// the target length, and the song
export interface DownloadEntryBriefProject {
  kind: "music" | "prompt";
  prompt: string;
  targetDuration: number;
  music: DownloadEntryMusic | null;
}

// The long-form source of the storyboard flow (the user's own footage)
export interface DownloadEntryMasterProject {
  kind: "master";
  title: string;
  sourceClips: Array<{ filename: string; start: number; end: number }>;
  timingEngine: "whisperx" | "gemini" | null;
}

// A short accepted from a master's storyboard
export interface DownloadEntryCutdownProject {
  kind: "cutdown";
  masterId: string;
  masterFilename: string;
  storyboardId: string;
  storyboardRevision?: number;
  title: string;
  hookLine: string;
  targetDuration: number;
  timingSource: "whisperx" | "gemini";
  beats: Array<{
    section: "hook" | "main" | "end";
    start: number;
    end: number;
    show: "source" | "broll";
  }>;
}

// Absent for TikTok downloads
export type DownloadEntryProject =
  | DownloadEntryBriefProject
  | DownloadEntryMasterProject
  | DownloadEntryCutdownProject;

export interface DownloadEntry {
  stage?: "storyboarding" | "editing";
  name: string;
  size: number;
  modified: number;
  // Max mtime (ms) across the project's files (mp4, metadata, analysis +
  // sidecars, render manifest) — "last time I made changes to this project"
  lastEditedAt: number | null;
  displayName: string;
  videoId: string | null;
  version: number;
  meta: DownloadEntryMeta | null;
  project: DownloadEntryProject | null;
  analysis: { analyzedAt: string | null; shotCount: number } | null;
  render: { renderedAt: string | null; durationSeconds: number | null } | null;
  generatedClips: number;
}
