import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { z } from "zod";
import { STORYBOARDS_DIR } from "./paths";
import { TIMING_SOURCES } from "./project-kinds";
import { MasterJobStatusZ } from "./master-job-schema";
import type { AssembleMasterInput } from "./master-assemble";

const JobZ = MasterJobStatusZ.extend({
  workerId: z.string(),
  input: z.object({ clips: z.array(z.string()), title: z.string(), timingEngine: z.enum(TIMING_SOURCES).nullable() }),
});
type Job = z.infer<typeof JobZ>;
const state = globalThis as typeof globalThis & { masterJobWorkerId?: string; masterJobsRunning?: Set<string> };
const workerId = state.masterJobWorkerId ??= randomUUID();
const running = state.masterJobsRunning ??= new Set<string>();
const directory = join(STORYBOARDS_DIR, ".jobs");

function jobPath(videoId: string) {
  if (!/^master-[\w-]+$/.test(videoId)) throw new Error("Invalid master ID");
  return join(directory, `${videoId}.json`);
}

async function writeJob(job: Job) {
  await fs.mkdir(directory, { recursive: true });
  const path = jobPath(job.videoId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(job, null, 2));
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function readMasterJob(videoId: string): Promise<Job | null> {
  try {
    const job = JobZ.parse(JSON.parse(await fs.readFile(jobPath(videoId), "utf8")));
    if (job.workerId !== workerId && (job.status === "preparing" || job.status === "analyzing")) {
      return { ...job, status: "failed", error: "Processing was interrupted by a server restart. Please retry." };
    }
    return job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function createMasterJob(input: AssembleMasterInput) {
  const videoId = `master-${randomUUID()}`;
  const job: Job = { videoId, filename: `${videoId}.mp4`, title: input.title, input, workerId, status: "preparing", error: null };
  await writeJob(job);
  return job;
}

export async function retryMasterJob(videoId: string) {
  const job = await readMasterJob(videoId);
  if (!job || job.status !== "failed" || running.has(videoId)) return null;
  const next: Job = { ...job, workerId, status: "preparing", error: null };
  await writeJob(next);
  return next;
}

export async function runMasterJob(videoId: string) {
  if (running.has(videoId)) return;
  running.add(videoId);
  let job: Job | null = null;
  try {
    job = await readMasterJob(videoId);
    if (!job || job.status === "ready") return;
    const { assembleMaster, probeDuration } = await import("./master-assemble");
    const { readProjectMeta } = await import("./project-meta");
    const { analyzeAndStoreMaster, storyboardDryRun } = await import("./master-analyze");
    const { getGeminiClient } = await import("./gemini");
    const videoPath = join(STORYBOARDS_DIR, job.filename);
    let project = await readProjectMeta(videoPath);
    let duration = project?.kind === "master" ? await probeDuration(videoPath) : null;
    if (project?.kind !== "master" || duration == null) {
      const result = await assembleMaster(job.input, videoId);
      duration = result.duration;
      project = await readProjectMeta(videoPath);
    }
    if (project?.kind !== "master") throw new Error("Could not read the storyboard project");
    job = { ...job, status: "analyzing", error: null };
    await writeJob(job);
    await analyzeAndStoreMaster(storyboardDryRun() ? null : getGeminiClient(), videoPath, videoId, project, duration);
    await writeJob({ ...job, status: "ready" });
  } catch (error) {
    console.error("Storyboard processing failed:", error);
    if (job) await writeJob({ ...job, status: "failed", error: error instanceof Error ? error.message : "Storyboard processing failed" });
  } finally {
    running.delete(videoId);
  }
}
