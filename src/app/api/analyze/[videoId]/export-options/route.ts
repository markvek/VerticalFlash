import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { ExportOptionsZ } from "@/lib/export-options";
import { ANALYSIS_DIR, sidecarPath } from "@/lib/paths";
import { withProjectEdit } from "@/lib/project-edit-lock";
type Context = { params: Promise<{ videoId: string }> };
export async function GET(_request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  try { return NextResponse.json(ExportOptionsZ.parse(JSON.parse(await fs.readFile(sidecarPath(videoId, "export-options"), "utf8")))); }
  catch (error) { return NextResponse.json({ error: "Export settings could not be loaded" }, { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500 }); }
}
export async function PUT(request: NextRequest, { params }: Context) {
  const { videoId } = await params;
  if (!/^[\w-]+$/.test(videoId)) return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  try {
    const options = ExportOptionsZ.parse(await request.json());
    await withProjectEdit(videoId, async () => {
      await fs.mkdir(ANALYSIS_DIR, { recursive: true });
      const path = sidecarPath(videoId, "export-options"), temp = `${path}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(options)); await fs.rename(temp, path);
    });
    return NextResponse.json(options);
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save export settings" }, { status: 400 }); }
}
