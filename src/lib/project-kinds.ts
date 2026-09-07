// Pure constants shared by server schemas and client components (no fs,
// no path helpers) — safe to import from "use client" files.

export const PROJECT_KINDS = ["music", "prompt", "master", "cutdown"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const TIMING_SOURCES = ["whisperx", "gemini"] as const;
export type TimingSource = (typeof TIMING_SOURCES)[number];

export const STORYBOARD_SECTIONS = ["hook", "main", "end"] as const;
export type StoryboardSection = (typeof STORYBOARD_SECTIONS)[number];
