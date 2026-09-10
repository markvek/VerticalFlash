import { NextRequest, NextResponse } from "next/server";
import { promises as fs, constants, createReadStream } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { EDITING_DIR } from "@/lib/paths";
import { nativeModel, saveProjectModel } from "@/lib/models/native";
import { resolveProjectFile } from "@/lib/download-files";
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.filename !== "string" || /[/\\]|\.\./.test(body.filename))
      throw new Error("Invalid source filename");
    const source = await resolveProjectFile(body.filename);
    if (!source) throw new Error("Source video not found");
    const model = nativeModel(body.model);
    const hash = createHash("sha256").update(`iterate-v1:${source.filename}:${model}:`);
    for await (const chunk of createReadStream(source.path)) hash.update(chunk);
    const videoId = `iterate-${hash.digest("hex").slice(0, 24)}`;
    const filename = `${videoId}.mp4`;
    await fs.mkdir(EDITING_DIR, { recursive: true });
    await fs
      .copyFile(
        source.path,
        join(EDITING_DIR, filename),
        constants.COPYFILE_EXCL,
      )
      .catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    await saveProjectModel(videoId, model);
    return NextResponse.json({ filename, videoId, model });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not prepare iteration" },
      { status: 400 },
    );
  }
}
