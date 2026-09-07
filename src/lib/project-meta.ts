import { z } from "zod";
import { promises as fs } from "fs";
import { FootageSourceZ, StoryboardZ } from "./segments-schema";

// Projects that did not start from a TikTok download carry a `kind` in their
// downloads/<file>.metadata.json sidecar instead of TikTok stats:
//
// - "music" / "prompt": started from /create with a brief (and a song). The
//   analyze route plans shots from the brief rather than watching a video.
// - "master": the long-form source for the storyboard flow — the user's own
//   footage joined into one video. Analysis transcribes it into timed
//   segments; storyboards are cut from it.
// - "cutdown": a short accepted from a master's storyboard. Its source mp4
//   is the storyboard's beats trimmed and joined from the master, so its
//   analysis is written from the beats (no Gemini call) and its audio is
//   already aligned.
import {
  PROJECT_KINDS,
  STORYBOARD_SECTIONS,
  TIMING_SOURCES,
} from "./project-kinds";
export {
  PROJECT_KINDS,
  STORYBOARD_SECTIONS,
  TIMING_SOURCES,
  type ProjectKind,
  type StoryboardSection,
  type TimingSource,
} from "./project-kinds";

export const ProjectMusicZ = z.object({
  filename: z.string(),
  title: z.string(),
  author: z.string(),
  duration: z.number().nullable(),
});

export type ProjectMusic = z.infer<typeof ProjectMusicZ>;

const briefFields = {
  prompt: z.string(),
  targetDuration: z.number(),
  music: ProjectMusicZ.nullable(),
  createdAt: z.string(),
};

export const MusicProjectMetaZ = z.object({
  kind: z.literal("music"),
  ...briefFields,
});

export const PromptProjectMetaZ = z.object({
  kind: z.literal("prompt"),
  ...briefFields,
});

// One library clip's span inside the joined master (master time)
export const MasterSourceClipZ = z.object({
  filename: z.string(),
  start: z.number(),
  end: z.number(),
});

export type MasterSourceClip = z.infer<typeof MasterSourceClipZ>;

export const MasterProjectMetaZ = z.object({
  kind: z.literal("master"),
  title: z.string(),
  createdAt: z.string(),
  sourceClips: z.array(MasterSourceClipZ),
  // The user's timing-engine choice for this master (null = env default)
  timingEngine: z.enum(TIMING_SOURCES).nullable().optional(),
});

export type MasterProjectMeta = z.infer<typeof MasterProjectMetaZ>;

// A beat as stored on the cutdown: where it came from in the master and
// where it landed on the short's own timeline
export const CutdownBeatZ = z.object({
  source: FootageSourceZ.optional(),
  fix_note: z.string().optional(),
  section: z.enum(STORYBOARD_SECTIONS),
  // Master time
  source_start: z.number(),
  source_end: z.number(),
  // Short time
  start: z.number(),
  end: z.number(),
  text: z.string(),
  on_screen_text: z.string(),
  show: z.enum(["source", "broll"]),
});

export type CutdownBeat = z.infer<typeof CutdownBeatZ>;

export const CutdownProjectMetaZ = z.object({
  kind: z.literal("cutdown"),
  masterId: z.string(),
  masterFilename: z.string(),
  storyboardId: z.string(),
  storyboardSnapshot: StoryboardZ.optional(),
  title: z.string(),
  hookLine: z.string(),
  targetDuration: z.number(),
  timingSource: z.enum(TIMING_SOURCES),
  createdAt: z.string(),
  beats: z.array(CutdownBeatZ),
});

export type CutdownProjectMeta = z.infer<typeof CutdownProjectMetaZ>;

export const ProjectMetaZ = z.discriminatedUnion("kind", [
  MusicProjectMetaZ,
  PromptProjectMetaZ,
  MasterProjectMetaZ,
  CutdownProjectMetaZ,
]);

export type ProjectMeta = z.infer<typeof ProjectMetaZ>;

// The two brief-based kinds share a shape (shot-plan.ts plans from it)
export type BriefProjectMeta = z.infer<typeof MusicProjectMetaZ> | z.infer<typeof PromptProjectMetaZ>;

export function isBriefProject(meta: ProjectMeta): meta is BriefProjectMeta {
  return meta.kind === "music" || meta.kind === "prompt";
}

// null for ordinary TikTok downloads (no `kind`) and unreadable sidecars
export async function readProjectMeta(
  videoPath: string
): Promise<ProjectMeta | null> {
  try {
    const raw = JSON.parse(await fs.readFile(`${videoPath}.metadata.json`, "utf8"));
    const parsed = ProjectMetaZ.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
