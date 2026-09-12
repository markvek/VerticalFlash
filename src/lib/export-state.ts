import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { ANALYSIS_DIR, LIBRARY_DIR, GENERATED_DIR, MUSIC_DIR, LIBRARY_METADATA_FILE, RENDERS_DIR, sidecarPath } from "./paths";
import { findDownloadFile } from "./download-files";
import { readProjectMeta } from "./project-meta";
import { isValidVideoId } from "./video-id";
import type { RenderManifest } from "./render-schema";

import type { ExportOptions } from "./export-options";
export { ExportOptionsZ, type ExportOptions } from "./export-options";
const kinds = ["recommendations", "framing", "broll", "edit-notes", "text-overlays", "model-selection", "export-options"];
const read = async (path: string) => fs.readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });

// Hash the complete saved render inputs. Preview settings are compared separately.
export async function editRevision(videoId: string): Promise<string> {
  if (!isValidVideoId(videoId)) throw new Error("Invalid project ID");
  const source = await findDownloadFile(videoId);
  const files = [join(ANALYSIS_DIR, `${videoId}.json`), ...kinds.map(k => sidecarPath(videoId, k)), LIBRARY_METADATA_FILE];
  if (source) files.push(`${source.path}.metadata.json`);
  const values = await Promise.all(files.map(read));
  const stat = source ? await fs.stat(source.path) : null;
  const media: Array<[string, number, number]> = [];
  for (const directory of [LIBRARY_DIR, MUSIC_DIR, join(GENERATED_DIR, videoId)]) {
    const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names.sort()) {
      if (!/\.(mp4|mov|mkv|avi|mp3|wav|m4a|aac)$/i.test(name)) continue;
      const path = join(directory, name), file = await fs.stat(path);
      media.push([path, file.size, file.mtimeMs]);
    }
  }
  const meta = source ? await readProjectMeta(source.path) : null;
  if (meta?.kind === "cutdown") {
    const master = await findDownloadFile(meta.masterId);
    if (master) {
      const file = await fs.stat(master.path);
      media.push([master.path, file.size, file.mtimeMs]);
      values.push(await read(`${master.path}.metadata.json`));
      values.push(await read(sidecarPath(meta.masterId, "segments")));
    }
  }
  return createHash("sha256").update(JSON.stringify({ values, source: stat && [stat.size, stat.mtimeMs], media })).digest("hex");
}

export function exportIssues(manifest: Pick<RenderManifest, "warnings" | "shots" | "audio">, options: ExportOptions): string[] {
  return [...new Set([
    ...manifest.shots.filter(s => s.clip_source === "none" || s.fill === "black").map(s => `Shot ${s.shot_index + 1} contains missing footage. Choose a clip or change its timing.`),
    ...manifest.warnings.filter(w => /failed|without|silent|skipped|falling back|could not|cannot|unavailable|no aligned|nothing to burn/i.test(w)),
    ...(options.audio !== (manifest.audio ?? "none") ? ["The exported audio differs from the selected audio. Check the soundtrack and render again."] : []),
  ])];
}

export function exportPaths(videoId: string, exportId: string) {
  if (!isValidVideoId(videoId) || !/^[a-f0-9-]{36}$/.test(exportId)) throw new Error("Invalid export ID");
  const dir = join(RENDERS_DIR, videoId, "exports");
  return { dir, video: join(dir, `${exportId}.mp4`), manifest: join(dir, `${exportId}.json`) };
}

export async function archiveExport(path: string, manifest: RenderManifest, revision: string, options: ExportOptions): Promise<RenderManifest> {
  const exportId = randomUUID();
  const files = exportPaths(manifest.videoId, exportId);
  const issues = exportIssues(manifest, options);
  const saved: RenderManifest = { ...manifest, exportId, editRevision: revision, requested: options, issues, readiness: issues.length ? "issues" : "ready" };
  await fs.mkdir(files.dir, { recursive: true });
  await fs.copyFile(path, files.video, fs.constants.COPYFILE_EXCL);
  await fs.writeFile(files.manifest, JSON.stringify(saved, null, 2), { flag: "wx" });
  return saved;
}

export async function exportState(manifest: RenderManifest) {
  const revision = await editRevision(manifest.videoId);
  const stale = !manifest.editRevision || manifest.editRevision !== revision;
  return { currentRevision: revision, stale, ready: !stale && manifest.readiness === "ready", issues: manifest.issues ?? ["Render again to verify this legacy export."] };
}
