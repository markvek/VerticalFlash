import { randomUUID } from "crypto";
import { VariationsZ, type Variations, type Variation, variationsPath } from "@/lib/variations-schema";
import { applyVariation } from "@/lib/apply-variation";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { join } from "path";
import { extractVideoId, splitVersion } from "@/lib/video-id";
import { SIDECAR_KINDS } from "@/lib/sidecars";
import { analysisPath, ANALYSIS_DIR, DOWNLOADS_DIR, EDITING_DIR, GENERATED_DIR, RENDERS_DIR } from "@/lib/paths";
import { listProjectFiles, resolveProjectFile } from "@/lib/download-files";

const NAMES_FILE = join(DOWNLOADS_DIR, ".names.json");

// One fork per source at a time (same pattern as the render route)
const inFlight = new Set<string>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  );
}

async function loadNames(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(NAMES_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Copy a JSON sidecar with a patch applied; missing/corrupt sources are skipped
async function copyJsonRewritten(
  src: string,
  dest: string,
  patch: (obj: Record<string, unknown>) => void
): Promise<void> {
  try {
    const obj = JSON.parse(await fs.readFile(src, "utf8"));
    if (!obj || typeof obj !== "object") return;
    patch(obj);
    await fs.writeFile(dest, JSON.stringify(obj, null, 2));
  } catch {
    // sidecar absent — nothing to fork
  }
}

// Fork a rendered video into a fully independent copy: the source mp4 plus
// every analysis/edit/generation/render artifact is duplicated under a new
// versioned id (123 -> 123-v2), so the fork can be re-edited and re-rendered
// without ever touching the original.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename: rawFilename } = await params;
  const srcFile = decodeURIComponent(rawFilename);

  if (
    srcFile.includes("..") ||
    srcFile.includes("/") ||
    srcFile.includes("\\") ||
    srcFile.startsWith(".")
  ) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const srcId = extractVideoId(srcFile);
  if (!srcId) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const source = await resolveProjectFile(srcFile);
  if (!source) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  let variations: Variations | null = null;
  let variation: Variation | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.variation_id !== undefined) {
      variations = VariationsZ.parse(JSON.parse(await fs.readFile(variationsPath(srcId), "utf8")));
      variation = variations.suggestions.find(v => v.id === body.variation_id) ?? null;
      if (!variation) throw new Error("Suggestion not found");
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid suggestion" }, { status: 400 });
  }
  const hasRender = await exists(join(RENDERS_DIR, `${srcId}.render.json`));
  if (!hasRender && !variation && !await exists(analysisPath(srcId))) {
    return NextResponse.json(
      { error: "Analyze this video before duplicating its edit" },
      { status: 409 }
    );
  }

  if (inFlight.has(srcFile)) {
    return NextResponse.json(
      { error: "A fork of this video is already running" },
      { status: 409 }
    );
  }
  inFlight.add(srcFile);

  try {
    await fs.mkdir(EDITING_DIR, { recursive: true });
    // Version numbering is per family: strip any -vN so forking a fork
    // (or forking v1 twice) always yields max existing version + 1
    const extMatch = srcFile.match(/\.(?:mp4|mov)$/i);
    const ext = extMatch ? extMatch[0] : ".mp4";
    const baseStem = srcFile
      .replace(/\.(?:mp4|mov)$/i, "")
      .replace(/-v\d+$/, "");
    const { baseId } = splitVersion(srcId);

    const familyRegex = new RegExp(
      `^${escapeRegExp(baseStem)}(?:-v(\\d+))?\\.(?:mp4|mov)$`,
      "i"
    );
    let maxVersion = 1;
    for (const entry of await listProjectFiles()) {
      const m = entry.filename.match(familyRegex);
      if (m) maxVersion = Math.max(maxVersion, m[1] ? parseInt(m[1], 10) : 1);
    }

    let nextV = maxVersion + 1;
    let newFile = "";
    let newId = "";
    for (;;) {
      newFile = `${baseStem}-v${nextV}${ext}`;
      newId = `${baseId}-v${nextV}`;
      const clashes = await Promise.all([
        resolveProjectFile(newFile).then(Boolean),
        exists(join(RENDERS_DIR, `${newId}.mp4`)),
        exists(join(ANALYSIS_DIR, `${newId}.json`)),
      ]);
      if (!clashes.some(Boolean)) break;
      nextV++;
    }

    // The source mp4 is the one required copy
    await fs.copyFile(source.path, join(EDITING_DIR, newFile));

    try {
      // TikTok metadata sidecar describes the upstream video — copy verbatim
      await fs
        .copyFile(
          `${source.path}.metadata.json`,
          join(EDITING_DIR, `${newFile}.metadata.json`)
        )
        .catch(() => {});

      // Shot screenshots and generated AI clips (clip references elsewhere
      // are basenames resolved per-videoId, so directory copies stay valid)
      await fs
        .cp(join(ANALYSIS_DIR, srcId), join(ANALYSIS_DIR, newId), {
          recursive: true,
        })
        .catch(() => {});
      await fs
        .cp(join(GENERATED_DIR, srcId), join(GENERATED_DIR, newId), {
          recursive: true,
        })
        .catch(() => {});

      // The rendered remake itself — required for a "completed" fork
      if (hasRender && !variation) await fs.copyFile(
        join(RENDERS_DIR, `${srcId}.mp4`),
        join(RENDERS_DIR, `${newId}.mp4`)
      );

      await copyJsonRewritten(
        join(ANALYSIS_DIR, `${srcId}.json`),
        join(ANALYSIS_DIR, `${newId}.json`),
        (obj) => {
          obj.videoId = newId;
          if (Array.isArray(obj.shots)) {
            for (const shot of obj.shots) {
              if (shot && typeof shot.index === "number") {
                shot.screenshot = `/api/analysis-shot/${newId}/${shot.index}`;
              }
            }
          }
        }
      );

      for (const kind of SIDECAR_KINDS) {
        if (kind === "timeline-history") continue; // A fork starts its own undo history.
        await copyJsonRewritten(
          join(ANALYSIS_DIR, `${srcId}.${kind}.json`),
          join(ANALYSIS_DIR, `${newId}.${kind}.json`),
          (obj) => {
            obj.videoId = newId;
          }
        );
      }

      // Render manifest must exist (checked above) and point at the fork
      if (hasRender && !variation) {
        const manifest = JSON.parse(
          await fs.readFile(join(RENDERS_DIR, `${srcId}.render.json`), "utf8")
        );
        manifest.videoId = newId;
        manifest.exportId = randomUUID();
        delete manifest.editRevision;
        if (manifest.framing) manifest.framing.videoId = newId;
        manifest.output = `${newId}.mp4`;
        // Prompt projects render with a null sourceVideo — keep it null
        if (manifest.sourceVideo != null) manifest.sourceVideo = newFile;
        await fs.writeFile(
          join(RENDERS_DIR, `${newId}.render.json`),
          JSON.stringify(manifest, null, 2)
        );

      }
      if (variation && variations) await applyVariation(newId, variation, variations);

      const names = await loadNames();
      const displayName = `${names[srcFile] ?? baseStem} (v${nextV})`.slice(
        0,
        100
      );
      names[newFile] = displayName;
      await fs.writeFile(NAMES_FILE, JSON.stringify(names, null, 2));

      return NextResponse.json({
        success: true,
        filename: newFile,
        videoId: newId,
        displayName,
      });
    } catch (error) {
      // Roll back so no half-fork lingers in the listing
      await Promise.all([
        fs.unlink(join(EDITING_DIR, newFile)).catch(() => {}),
        fs
          .unlink(join(EDITING_DIR, `${newFile}.metadata.json`))
          .catch(() => {}),
        fs.unlink(join(ANALYSIS_DIR, `${newId}.json`)).catch(() => {}),
        fs
          .rm(join(ANALYSIS_DIR, newId), { recursive: true, force: true })
          .catch(() => {}),
        ...SIDECAR_KINDS.map((kind) =>
          fs.unlink(join(ANALYSIS_DIR, `${newId}.${kind}.json`)).catch(() => {})
        ),
        fs
          .rm(join(GENERATED_DIR, newId), { recursive: true, force: true })
          .catch(() => {}),
        fs.unlink(join(RENDERS_DIR, `${newId}.mp4`)).catch(() => {}),
        fs.unlink(join(RENDERS_DIR, `${newId}.render.json`)).catch(() => {}),
      ]);
      throw error;
    }
  } catch (error) {
    console.error("Failed to fork download:", error);
    return NextResponse.json(
      { error: "Failed to fork video" },
      { status: 500 }
    );
  } finally {
    inFlight.delete(srcFile);
  }
}
