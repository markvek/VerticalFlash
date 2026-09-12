import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { z } from "zod";
import { DATA_ROOT } from "./paths";
import { withProjectEdit } from "./project-edit-lock";

const state = globalThis as typeof globalThis & { activityWorker?: string };
const worker = state.activityWorker ??= randomUUID();
const directory = join(DATA_ROOT, "workflow-activity");
const ActivityZ = z.object({
  id: z.string().uuid(), videoId: z.string(), stage: z.string(), worker: z.string(),
  startedAt: z.string(), finishedAt: z.string().nullable(),
  status: z.enum(["running", "complete", "failed", "interrupted"]),
  attempt: z.number(), error: z.string().nullable(), issues: z.number().default(0),
});
export type WorkflowActivity = z.infer<typeof ActivityZ>;
async function save(record: WorkflowActivity) {
  await fs.mkdir(directory, { recursive: true });
  const path = join(directory, `${record.id}.json`), temp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(ActivityZ.parse(record)));
  await fs.rename(temp, path);
}
export async function readActivity(videoId?: string): Promise<WorkflowActivity[]> {
  let files: string[];
  try { files = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(files.filter(f => f.endsWith(".json")).map(async file => {
    const record = ActivityZ.parse(JSON.parse(await fs.readFile(join(directory, file), "utf8")));
    if (record.status === "running" && record.worker !== worker)
      return { ...record, status: "interrupted" as const, error: "The server restarted. Check the saved result before retrying this action." };
    return record;
  }));
  return records.filter(r => !videoId || r.videoId === videoId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export async function beginActivity(videoId: string, stage: string): Promise<WorkflowActivity | null> {
  return withProjectEdit(`activity:${videoId}:${stage}`, async () => {
    const prior = (await readActivity(videoId)).filter(r => r.stage === stage);
    if (prior.some(r => r.status === "running")) return null;
    const record: WorkflowActivity = { id: randomUUID(), videoId, stage, worker, startedAt: new Date().toISOString(), finishedAt: null, status: "running", attempt: prior.length + 1, error: null, issues: 0 };
    await save(record); return record;
  });
}
export async function finishActivity(record: WorkflowActivity, error: string | null, issues = 0) {
  await save({ ...record, finishedAt: new Date().toISOString(), status: error ? "failed" : "complete", error, issues });
}
export function activitySummary(records: WorkflowActivity[]) {
  const failures: Record<string, number> = {};
  for (const r of records) if (r.status === "failed" || r.status === "interrupted") failures[r.stage] = (failures[r.stage] ?? 0) + 1;
  const previewTimes: number[] = [];
  for (const id of new Set(records.map(r => r.videoId))) {
    const project = records.filter(r => r.videoId === id);
    const first = Math.min(...project.map(r => Date.parse(r.startedAt)));
    const previews = project.filter(r => r.stage === "Render preview" && r.status === "complete" && r.finishedAt).map(r => Date.parse(r.finishedAt!));
    if (previews.length) previewTimes.push(Math.min(...previews) - first);
  }
  return { failures, previews: previewTimes.length, meanTimeToPreviewMs: previewTimes.length ? previewTimes.reduce((a, b) => a + b, 0) / previewTimes.length : null,
    exportsWithIssues: records.filter(r => r.stage === "Render preview" && r.issues > 0).length,
    corrections: records.filter(r => r.stage === "Correct library metadata" && r.status === "complete").length,
    acceptedSuggestions: records.filter(r => r.stage === "Accept storyboard" && r.status === "complete").length };
}
