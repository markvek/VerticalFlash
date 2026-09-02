import { execFile } from "child_process";
import { promisify } from "util";
import { NextResponse } from "next/server";

// One shared execFile promise wrapper and one preflight for the two external
// binaries the whole render/analysis pipeline depends on. A missing binary
// surfaces as FfmpegMissingError (with install instructions) instead of a
// bare ENOENT, whichever call site hits it first.
const rawExecFileAsync = promisify(execFile);

export const execFileAsync: typeof rawExecFileAsync = ((
  file: string,
  args?: readonly string[] | null,
  options?: Parameters<typeof rawExecFileAsync>[2]
) =>
  rawExecFileAsync(file, args ?? [], options ?? {}).catch((error: unknown) => {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT" && (file === "ffmpeg" || file === "ffprobe")) {
      throw new FfmpegMissingError(file);
    }
    throw error;
  })) as typeof rawExecFileAsync;

export const FFMPEG_INSTALL_HINT =
  "ffmpeg/ffprobe not found on PATH. Install ffmpeg: `brew install ffmpeg` (macOS), " +
  "`sudo apt install ffmpeg` (Debian/Ubuntu), or download from https://ffmpeg.org/download.html";

export class FfmpegMissingError extends Error {
  constructor(public readonly tool: "ffmpeg" | "ffprobe") {
    super(`${tool} is not installed or not on PATH. ${FFMPEG_INSTALL_HINT}`);
    this.name = "FfmpegMissingError";
  }
}

let checked: Promise<void> | undefined;

// Resolves once both binaries answer `-version`; memoized on success so
// routes can call it freely. A failed check is not cached, so installing
// ffmpeg while the server runs takes effect on the next request.
export function ensureFfmpeg(): Promise<void> {
  if (!checked) {
    checked = (async () => {
      for (const tool of ["ffmpeg", "ffprobe"] as const) {
        try {
          await execFileAsync(tool, ["-version"]);
        } catch {
          throw new FfmpegMissingError(tool);
        }
      }
    })().catch((error) => {
      checked = undefined;
      throw error;
    });
  }
  return checked;
}

// For API routes: a JSON 500 with install instructions when the error is a
// missing binary, otherwise null so the route can handle it its own way.
export function ffmpegErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof FfmpegMissingError) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return null;
}
