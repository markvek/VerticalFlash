import { readActivity } from "./workflow-activity";
import { randomUUID } from "crypto";
import { withProjectEdit } from "./project-edit-lock";
import { promises as fs } from "fs";
import { dirname } from "path";
import {
  ShotGenerationsZ,
  generationPath,
  emptyGenerations,
  type ShotGenerations,
  type ShotGeneration,
} from "./generation-schema";

// A "generating" entry older than this is a leftover from a server that
// died mid-call; treat it as failed so the UI isn't stuck on a spinner.
export const GENERATING_STALE_MS = 15 * 60 * 1000;

export async function loadGenerations(
  videoId: string
): Promise<ShotGenerations> {
  let stored: ShotGenerations;
  try {
    const raw = await fs.readFile(generationPath(videoId), "utf8");
    stored = ShotGenerationsZ.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyGenerations(videoId);
  }

  // Expire stale in-flight markers on read
  const activities = await readActivity(videoId);
  for (const shot of Object.values(stored.shots)) {
    if (shot.status !== "generating") continue;
    const started = shot.startedAt ? Date.parse(shot.startedAt) : NaN;
    if (!Number.isFinite(started) || Date.now() - started > GENERATING_STALE_MS || activities.find(r => r.stage === `Generate clip ${shot.shot_index + 1}` || r.stage === `Extend clip ${shot.shot_index + 1}`)?.status === "interrupted") {
      shot.status = shot.attempts.some((a) => a.status === "ready")
        ? "ready"
        : "failed";
      shot.startedAt = null;
    }
  }
  // Return an expired marker without racing a concurrent prompt/attempt save.
  return stored;
}

export async function saveGenerations(
  generations: ShotGenerations
): Promise<void> {
  generations.updatedAt = new Date().toISOString();
  const path = generationPath(generations.videoId);
  await fs.mkdir(dirname(path), { recursive: true });
  // Temp-file + rename so a crash mid-write can't truncate the file
  const tmp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify(ShotGenerationsZ.parse(generations), null, 2)
  );
  await fs.rename(tmp, path);
}

export function getOrCreateShot(
  generations: ShotGenerations,
  shotIndex: number
): ShotGeneration {
  const key = String(shotIndex);
  let shot = generations.shots[key];
  if (!shot) {
    shot = {
      shot_index: shotIndex,
      prompt: "",
      prompt_source: "gemini",
      status: "idle",
      startedAt: null,
      accepted_file: null,
      attempts: [],
    };
    generations.shots[key] = shot;
  }
  return shot;
}

export async function mutateGenerations(videoId: string, change: (value: ShotGenerations) => void): Promise<ShotGenerations> {
  return withProjectEdit(videoId, async () => {
    const value = await loadGenerations(videoId);
    change(value);
    await saveGenerations(value);
    return value;
  });
}
