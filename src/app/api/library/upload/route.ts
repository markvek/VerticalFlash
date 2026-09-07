import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { basename, extname, join } from "path";
import { LIBRARY_DIR } from "@/lib/paths";
import { ensureFfmpeg, execFileAsync, ffmpegErrorResponse } from "@/lib/ffmpeg";
import { VIDEO_EXTENSIONS, type LibraryClip } from "@/lib/library-schema";
import { loadLibrary, saveLibrary } from "@/lib/library-store";
import { analyzeLibraryClip } from "@/lib/library-analyze";
import { isValidMusicFilename } from "@/lib/music-schema";

// Browser upload into the clip library (storyboard flow). request.formData()
// buffers the whole body, so per-file size is capped; bigger files go
// straight into the library folder by hand.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

interface UploadError {
  name: string;
  error: string;
}

// Safe library filename from whatever the browser sent: basename only, no
// traversal, no hidden files, whitespace collapsed, extension lowercased.
// null when the extension is not a supported video type.
function sanitizeUploadName(raw: string): string | null {
  const base = basename(raw.replace(/\\/g, "/"));
  const ext = extname(base).toLowerCase();
  if (!(VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return null;

  let stem = base.slice(0, base.length - ext.length);
  stem = stem
    .replace(/[/\\]/g, "")
    .replace(/\.\.+/g, "")
    .replace(/^\.+/, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  if (!stem) stem = "clip";

  const name = `${stem}${ext}`;
  return isValidMusicFilename(name) ? name : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

// IMG_0001.mov → IMG_0001-2.mov, IMG_0001-3.mov, … until free
async function uniqueLibraryName(name: string): Promise<string> {
  if (!(await exists(join(LIBRARY_DIR, name)))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!(await exists(join(LIBRARY_DIR, candidate)))) return candidate;
  }
}

async function probeDuration(videoPath: string): Promise<number | null> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    videoPath,
  ]);
  const raw = parseFloat(stdout.trim());
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 10) / 10 : null;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function POST(request: NextRequest) {
  const analyze = request.nextUrl.searchParams.get("analyze") === "1";

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    console.error("[library/upload] could not parse form data:", error);
    return NextResponse.json(
      { error: "Invalid upload: expected multipart form data" },
      { status: 400 }
    );
  }

  const files = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.length === 0) {
    return NextResponse.json(
      { error: "No files received (field name must be \"files\")" },
      { status: 400 }
    );
  }

  // Size check up front so an oversized batch is rejected before anything
  // lands on disk
  const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
  if (tooBig) {
    return NextResponse.json(
      {
        error:
          `"${tooBig.name}" is ${formatMb(tooBig.size)}, over the ${formatMb(
            MAX_UPLOAD_BYTES
          )} browser upload limit. Drop it into the library folder instead, then click Refresh.`,
      },
      { status: 413 }
    );
  }

  try {
    await ensureFfmpeg();
  } catch (error) {
    return ffmpegErrorResponse(error)!;
  }

  await fs.mkdir(LIBRARY_DIR, { recursive: true });

  const clips: LibraryClip[] = [];
  const errors: UploadError[] = [];

  for (const file of files) {
    const safeName = sanitizeUploadName(file.name);
    if (!safeName) {
      errors.push({
        name: file.name,
        error: `Unsupported file type (allowed: ${VIDEO_EXTENSIONS.join(", ")})`,
      });
      continue;
    }

    let filename: string;
    try {
      filename = await uniqueLibraryName(safeName);
      await fs.writeFile(
        join(LIBRARY_DIR, filename),
        Buffer.from(await file.arrayBuffer())
      );
    } catch (error) {
      console.error(`[library/upload] failed to save ${file.name}:`, error);
      errors.push({
        name: file.name,
        error: error instanceof Error ? error.message : "Could not save the file",
      });
      continue;
    }

    let duration: number | null = null;
    try {
      duration = await probeDuration(join(LIBRARY_DIR, filename));
    } catch (error) {
      console.error(`[library/upload] ffprobe failed for ${filename}:`, error);
    }

    // Register in the metadata store (reload each time: analyzeLibraryClip
    // also writes it)
    const library = await loadLibrary();
    const now = new Date().toISOString();
    const existingIndex = library.videos.findIndex((v) => v.filename === filename);
    const existing = existingIndex !== -1 ? library.videos[existingIndex] : undefined;
    let clip: LibraryClip = {
      ...(existing ?? { createdAt: now }),
      filename,
      source: "upload",
      duration: duration ?? existing?.duration ?? null,
      tags: existing?.tags ?? [],
      updatedAt: now,
    };
    if (existingIndex !== -1) {
      library.videos[existingIndex] = clip;
    } else {
      library.videos.push(clip);
    }
    library.lastUpdated = now;
    await saveLibrary(library);

    if (analyze) {
      try {
        const result = await analyzeLibraryClip(filename);
        clip = result.updated;
      } catch (error) {
        console.error(`[library/upload] analysis failed for ${filename}:`, error);
        errors.push({
          name: filename,
          error: `Uploaded, but Gemini analysis failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    clips.push(clip);
  }

  return NextResponse.json({ clips, errors });
}
