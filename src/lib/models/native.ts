import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { ANALYSIS_DIR, sidecarPath } from "../paths";
import { GEMINI_MODEL } from "../gemini";
import { assertModelAvailable } from "./providers";
import { isValidVideoId } from "../video-id";

// The existing video/audio inspection routes use Gemini's native Files API.
// Cross-provider text + frame comparison is available in storyboard benchmarks.
export function nativeModel(raw: unknown): string {
  if (raw == null || raw === "") return GEMINI_MODEL;
  if (typeof raw !== "string") throw new Error("Invalid model selection");
  assertModelAvailable({ provider: "gemini", model: raw });
  return raw;
}
export async function projectModel(
  videoId: string,
  requested?: unknown,
): Promise<string> {
  if (!isValidVideoId(videoId)) throw new Error("Invalid project id");
  if (requested != null && requested !== "") return nativeModel(requested);
  try {
    return nativeModel(
      JSON.parse(
        await fs.readFile(sidecarPath(videoId, "model-selection"), "utf8"),
      ).model,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return GEMINI_MODEL;
    throw e;
  }
}
export async function saveProjectModel(videoId: string, model: string) {
  if (!isValidVideoId(videoId)) throw new Error("Invalid project id");
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
  const path = sidecarPath(videoId, "model-selection");
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temp,
    JSON.stringify({ videoId, model: nativeModel(model) }),
  );
  await fs.rename(temp, path);
}
