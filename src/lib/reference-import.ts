import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { dirname } from "path";
import { NextRequest } from "next/server";
import { analysisPath, sidecarPath } from "./paths";
import { findDownloadFile } from "./download-files";
import { withProjectEdit } from "./project-edit-lock";
import { ReferenceImportZ, type ReferenceImport } from "./reference-import-schema";

const state = globalThis as typeof globalThis & { referenceWorker?: string; referenceRunning?: Set<string> };
const workerId = state.referenceWorker ??= randomUUID();
const running = state.referenceRunning ??= new Set();
export async function atomicReferenceJson(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.rename(tmp, path); }
  finally { await fs.rm(tmp, { force: true }); }
}
export async function readReferenceImport(videoId: string): Promise<ReferenceImport | null> {
  if (!/^\d+$/.test(videoId)) return null;
  try {
    const job = ReferenceImportZ.parse(JSON.parse(await fs.readFile(sidecarPath(videoId, "reference-import"), "utf8")));
    if (job.workerId !== workerId && !["ready", "failed"].includes(job.status)) return { ...job, status: "failed", error: "Preparation was interrupted by a server restart. Retry to continue from the saved stage." };
    return job;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export async function startReferenceImport(videoId: string, author = "tiktok") {
  if (!/^\d+$/.test(videoId)) throw new Error("Invalid TikTok video ID");
  return withProjectEdit(videoId, async () => {
    const existing = await readReferenceImport(videoId);
    if (existing && existing.status !== "failed") return existing;
    const file = await findDownloadFile(videoId);
    const job: ReferenceImport = { videoId, filename: file?.filename ?? existing?.filename ?? `${author.replace(/[^\w-]/g, "_") || "tiktok"}_${videoId}.mp4`, status: file ? "analyzing" : "downloading", error: null, workerId, updatedAt: new Date().toISOString() };
    await atomicReferenceJson(sidecarPath(videoId, "reference-import"), job);
    return job;
  });
}

// Route handlers run locally, so processing is independent of the scan page
// and does not send internal HTTP requests through a public origin.
export async function runReferenceImport(videoId: string) {
  if (running.has(videoId)) return;
  running.add(videoId);
  let job: ReferenceImport | null = null;
  const stage = async (status: ReferenceImport["status"], error: string | null = null) => {
    job = { ...job!, status, error, workerId, updatedAt: new Date().toISOString() };
    await atomicReferenceJson(sidecarPath(videoId, "reference-import"), job);
  };
  const context = { params: Promise.resolve({ videoId }) };
  const request = (path: string) => new NextRequest(`http://localhost${path}`, { method: "POST" });
  const checked = async (response: Response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Preparation failed");
    return data;
  };
  try {
    job = await readReferenceImport(videoId);
    if (!job || job.status === "ready") return;
    if (!await findDownloadFile(videoId)) {
      await stage("downloading");
      const { saveTikTokVideo } = await import("./tiktok-download");
      await saveTikTokVideo(videoId, job.filename);
    }
    const { GET, POST } = await import("@/app/api/analyze/[videoId]/route");
    let analysisResponse: Response = await GET(request(`/api/analyze/${videoId}`), context);
    if (!analysisResponse.ok) { await stage("analyzing"); analysisResponse = await POST(request(`/api/analyze/${videoId}`), context); }
    let analysis = await checked(analysisResponse);
    if (!analysis.taggedAt) {
      await stage("tagging");
      const { POST: tags } = await import("@/app/api/analyze/[videoId]/tags/route");
      analysis = await checked(await tags(request(`/api/analyze/${videoId}/tags`), context));
    }
    await stage("matching");
    const { GET: getMatches, POST: match } = await import("@/app/api/analyze/[videoId]/recommendations/route");
    const saved = await getMatches(request(`/api/analyze/${videoId}/recommendations`), context);
    const recs = saved.ok ? await saved.json() : null;
    if (!recs?.mode) await checked(await match(request(`/api/analyze/${videoId}/recommendations`), context));
    // Keep analysis on disk as the authoritative segment structure.
    await fs.access(analysisPath(videoId));
    await stage("ready");
  } catch (e) { if (job) await stage("failed", e instanceof Error ? e.message : "Preparation failed"); }
  finally { running.delete(videoId); }
}
