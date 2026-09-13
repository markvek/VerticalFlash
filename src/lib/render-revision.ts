import { createHash } from "crypto";
import { promises as fs } from "fs";
import { z } from "zod";
import { analysisPath, sidecarPath } from "./paths";
import { findDownloadFile } from "./download-files";
import type { RenderManifest } from "./render-schema";

export const RenderOptionsZ = z.object({
  audio: z.enum(["music", "original", "none"]),
  music_filename: z.string().nullable(),
  burn_text: z.boolean(),
});
export type RenderOptions = z.infer<typeof RenderOptionsZ>;

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// All saved inputs that can affect the exported edit, including options that
// previously lived only in the browser. Capture before reading render inputs.
export async function captureRenderInputs(videoId: string, options: RenderOptions) {
  const file = await findDownloadFile(videoId);
  const meta = file ? await readJson(`${file.path}.metadata.json`) : null;
  const masterId = (meta as { masterId?: string } | null)?.masterId;
  const inputs: unknown[] = await Promise.all([
    readJson(analysisPath(videoId)),
    ...["recommendations", "edit-notes", "text-overlays", "framing", "broll", "model-selection"].map(kind => readJson(sidecarPath(videoId, kind))),
    masterId ? readJson(sidecarPath(masterId, "segments")) : null,
  ]);
  return { inputs, meta, options };
}

export type RenderInputSnapshot = Awaited<ReturnType<typeof captureRenderInputs>>;
export function revisionFromSnapshot(snapshot: RenderInputSnapshot): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}
export async function renderRevision(videoId: string, options: RenderOptions): Promise<string> {
  return revisionFromSnapshot(await captureRenderInputs(videoId, options));
}

export async function renderIsStale(manifest: RenderManifest): Promise<boolean> {
  if (!manifest.editRevision || !manifest.requestedOptions) return true;
  return manifest.editRevision !== await renderRevision(manifest.videoId, manifest.requestedOptions);
}

export async function renderDeliveryError(manifest: RenderManifest): Promise<string | null> {
  if (await renderIsStale(manifest)) return "Your latest changes have not been exported. Export again before downloading or uploading.";
  if (manifest.status !== "ready") return "Preview with issues: fix the listed render warnings and export again before downloading or uploading.";
  return null;
}

// Shared by render and delivery routes, including separately bundled routes.
const processState = globalThis as typeof globalThis & { exportOperations?: Set<string> };
export const exportOperations = processState.exportOperations ??= new Set<string>();

export function renderBytesMatch(manifest: RenderManifest, bytes: Uint8Array): boolean {
  return !!manifest.outputSha256 && createHash("sha256").update(bytes).digest("hex") === manifest.outputSha256;
}
