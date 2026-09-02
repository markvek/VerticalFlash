import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { extractVideoId, splitVersion } from "@/lib/video-id";
import type {
  DownloadEntry,
  DownloadEntryMeta,
  DownloadEntryProject,
} from "@/lib/download-types";
import { ProjectMetaZ } from "@/lib/project-meta";
import { ANALYSIS_DIR, DOWNLOADS_DIR, GENERATED_DIR, RENDERS_DIR } from "@/lib/paths";

// User-given display names: { [filename]: name }
const NAMES_FILE = join(DOWNLOADS_DIR, ".names.json");

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// All edit-state sidecar kinds kept under analysis/<videoId>.<kind>.json
const SIDECAR_KINDS = [
  "recommendations",
  "generation",
  "edit-notes",
  "text-overlays",
  "captions",
];

// Analysis, render, and generated-clip state for one download, so the
// downloads homepage can show status badges without extra round trips.
// fileModifiedMs is the mp4's own mtime, folded into lastEditedAt.
async function enrichEntry(
  name: string,
  fileModifiedMs: number
): Promise<{
  videoId: string | null;
  version: number;
  meta: DownloadEntryMeta | null;
  project: DownloadEntryProject | null;
  analysis: DownloadEntry["analysis"];
  render: DownloadEntry["render"];
  generatedClips: number;
  lastEditedAt: number | null;
}> {
  const videoId = extractVideoId(name);
  const version = videoId ? splitVersion(videoId).version : 1;

  // Last-edited = max mtime across every file the project writes as you work
  const editedPaths = [
    join(DOWNLOADS_DIR, `${name}.metadata.json`),
    ...(videoId
      ? [
          join(ANALYSIS_DIR, `${videoId}.json`),
          ...SIDECAR_KINDS.map((kind) =>
            join(ANALYSIS_DIR, `${videoId}.${kind}.json`)
          ),
          join(RENDERS_DIR, `${videoId}.render.json`),
        ]
      : []),
  ];
  const mtimes = await Promise.all(
    editedPaths.map((p) =>
      fs
        .stat(p)
        .then((s) => s.mtime.getTime())
        .catch(() => 0)
    )
  );
  const lastEditedAt = Math.max(fileModifiedMs, ...mtimes);

  const metaRaw = await readJson(join(DOWNLOADS_DIR, `${name}.metadata.json`));
  // Created projects carry a brief instead of TikTok stats
  const projectParsed = metaRaw ? ProjectMetaZ.safeParse(metaRaw) : null;
  const project: DownloadEntryProject | null = projectParsed?.success
    ? {
        kind: projectParsed.data.kind,
        prompt: projectParsed.data.prompt,
        targetDuration: projectParsed.data.targetDuration,
        music: projectParsed.data.music,
      }
    : null;
  const meta: DownloadEntryMeta | null = metaRaw && !project
    ? {
        caption: String(metaRaw.caption ?? ""),
        authorHandle: String(metaRaw.authorHandle ?? ""),
        authorName: String(metaRaw.authorName ?? ""),
        playCount: Number(metaRaw.playCount ?? 0),
        likeCount: Number(metaRaw.likeCount ?? 0),
        commentCount: Number(metaRaw.commentCount ?? 0),
        shareCount: Number(metaRaw.shareCount ?? 0),
        duration: Number(metaRaw.duration ?? 0),
        createdAt: Number(metaRaw.createdAt ?? 0),
      }
    : null;

  let analysis: DownloadEntry["analysis"] = null;
  let render: DownloadEntry["render"] = null;
  let generatedClips = 0;

  if (videoId) {
    const analysisRaw = await readJson(join(ANALYSIS_DIR, `${videoId}.json`));
    if (analysisRaw) {
      analysis = {
        analyzedAt:
          typeof analysisRaw.analyzedAt === "string"
            ? analysisRaw.analyzedAt
            : null,
        shotCount: Array.isArray(analysisRaw.shots)
          ? analysisRaw.shots.length
          : 0,
      };
    }

    const manifest = await readJson(
      join(RENDERS_DIR, `${videoId}.render.json`)
    );
    if (manifest) {
      render = {
        renderedAt:
          typeof manifest.renderedAt === "string" ? manifest.renderedAt : null,
        durationSeconds:
          typeof manifest.durationSeconds === "number"
            ? manifest.durationSeconds
            : null,
      };
    }

    const generated = await fs
      .readdir(join(GENERATED_DIR, videoId))
      .catch(() => [] as string[]);
    generatedClips = generated.filter((f) =>
      /^gen_s\d+_a\d+\.mp4$/.test(f)
    ).length;
  }

  return {
    videoId,
    version,
    meta,
    project,
    analysis,
    render,
    generatedClips,
    lastEditedAt,
  };
}

// Ensure downloads directory exists
async function ensureDownloadsDir() {
  try {
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  } catch (e) {
    // Directory already exists or cannot be created
  }
}

async function loadNames(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(NAMES_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function saveNames(names: Record<string, string>) {
  await ensureDownloadsDir();
  await fs.writeFile(NAMES_FILE, JSON.stringify(names, null, 2));
}

export async function GET() {
  try {
    await ensureDownloadsDir();

    const files = (await fs.readdir(DOWNLOADS_DIR)).filter(
      (name) => !name.endsWith(".metadata.json") && !name.startsWith(".")
    );
    const fileStats = await Promise.all(
      files.map(async (filename) => {
        try {
          const stat = await fs.stat(join(DOWNLOADS_DIR, filename));
          return {
            name: filename,
            size: stat.size,
            modified: stat.mtime.getTime(),
          };
        } catch {
          return null;
        }
      })
    );

    // Stable "Download N" defaults: numbered by download time, oldest first
    const names = await loadNames();
    const present = fileStats
      .filter((f) => f !== null)
      .sort((a, b) => a!.modified - b!.modified)
      .map((f, i) => ({
        ...f!,
        displayName: names[f!.name] || `Download ${i + 1}`,
      }));

    const entries: DownloadEntry[] = await Promise.all(
      present.map(async (f) => ({
        ...f,
        ...(await enrichEntry(f.name, f.modified)),
      }))
    );

    return NextResponse.json({
      files: entries,
      total: entries.length,
    });
  } catch (error) {
    console.error("Failed to list downloads:", error);
    return NextResponse.json(
      { error: "Failed to list downloads" },
      { status: 500 }
    );
  }
}

// Rename a download (display name only — the file itself is untouched)
export async function PATCH(request: NextRequest) {
  try {
    const { filename, displayName } = await request.json();

    if (!filename || typeof filename !== "string") {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }
    if (typeof displayName !== "string" || displayName.length > 100) {
      return NextResponse.json(
        { error: "displayName must be a string of at most 100 characters" },
        { status: 400 }
      );
    }
    if (
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("\\")
    ) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    await ensureDownloadsDir();
    await fs.access(join(DOWNLOADS_DIR, filename)).catch(() => {
      throw new Error("File not found");
    });

    const names = await loadNames();
    const trimmed = displayName.trim();
    if (trimmed) {
      names[filename] = trimmed;
    } else {
      // Empty name reverts to the "Download N" default
      delete names[filename];
    }
    await saveNames(names);

    return NextResponse.json({ success: true, displayName: trimmed || null });
  } catch (error) {
    console.error("Failed to rename download:", error);
    return NextResponse.json(
      { error: "Failed to rename download" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { filename } = await request.json();

    if (!filename || typeof filename !== "string") {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      );
    }

    // Prevent directory traversal
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 }
      );
    }

    await ensureDownloadsDir();
    const filePath = join(DOWNLOADS_DIR, filename);

    // Verify the file is within the downloads directory
    const realPath = await fs.realpath(filePath).catch(() => null);
    const realDownloadDir = await fs.realpath(DOWNLOADS_DIR);

    if (!realPath || !realPath.startsWith(realDownloadDir)) {
      return NextResponse.json(
        { error: "Invalid file path" },
        { status: 400 }
      );
    }

    await fs.unlink(filePath);

    // Remove the metadata sidecar too; absence is fine
    await fs.unlink(`${filePath}.metadata.json`).catch(() => {});

    // Drop its display name, if one was set
    const names = await loadNames();
    if (names[filename]) {
      delete names[filename];
      await saveNames(names);
    }

    // Remove every per-video artifact: analysis + screenshots, all edit-state
    // sidecars, generated AI clips, and the remake render
    const videoId = extractVideoId(filename);
    if (videoId) {
      await Promise.all([
        fs.unlink(join(ANALYSIS_DIR, `${videoId}.json`)).catch(() => {}),
        fs
          .rm(join(ANALYSIS_DIR, videoId), { recursive: true, force: true })
          .catch(() => {}),
        ...SIDECAR_KINDS.map((kind) =>
          fs
            .unlink(join(ANALYSIS_DIR, `${videoId}.${kind}.json`))
            .catch(() => {})
        ),
        fs
          .rm(join(GENERATED_DIR, videoId), { recursive: true, force: true })
          .catch(() => {}),
        fs.unlink(join(RENDERS_DIR, `${videoId}.mp4`)).catch(() => {}),
        fs.unlink(join(RENDERS_DIR, `${videoId}.render.json`)).catch(() => {}),
        fs
          .unlink(join(RENDERS_DIR, ".thumbs", `${videoId}.jpg`))
          .catch(() => {}),
        fs
          .unlink(join(DOWNLOADS_DIR, ".thumbs", `${filename}.jpg`))
          .catch(() => {}),
      ]);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete file:", error);
    return NextResponse.json(
      { error: "Failed to delete file" },
      { status: 500 }
    );
  }
}
