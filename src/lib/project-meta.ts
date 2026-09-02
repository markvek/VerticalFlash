import { z } from "zod";
import { promises as fs } from "fs";

// Projects started from the /create page have no TikTok source video. Their
// downloads/<file>.metadata.json sidecar carries the creation brief instead
// of TikTok stats; the analyze route reads `kind` to plan shots from the
// brief (and the song) rather than from a video.
export const PROJECT_KINDS = ["music", "prompt"] as const;

export const ProjectMusicZ = z.object({
  filename: z.string(),
  title: z.string(),
  author: z.string(),
  duration: z.number().nullable(),
});

export type ProjectMusic = z.infer<typeof ProjectMusicZ>;

export const ProjectMetaZ = z.object({
  kind: z.enum(PROJECT_KINDS),
  prompt: z.string(),
  targetDuration: z.number(),
  music: ProjectMusicZ.nullable(),
  createdAt: z.string(),
});

export type ProjectMeta = z.infer<typeof ProjectMetaZ>;

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
