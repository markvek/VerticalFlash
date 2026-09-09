import { NextRequest, NextResponse } from "next/server";
import { createReadStream, promises as fs } from "fs";
import { Readable } from "stream";
import { resolveProjectFile } from "@/lib/download-files";
import { findLibraryFile } from "@/lib/library-store";
import { isGeneratedClip, resolveClipPath } from "@/lib/generation-schema";
import { framingPreview } from "@/lib/framing-preview";

export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    const source = request.nextUrl.searchParams.get("source") ?? "";
    const match = source.match(/^\/api\/(library\/clips|downloads|generated\/([\w-]+))\/([^/?]+)$/);
    if (!match) return NextResponse.json({ error: "Invalid preview source" }, { status: 400 });
    const filename = decodeURIComponent(match[3]);
    if (filename.startsWith(".") || /[\\/\0]/.test(filename) || filename.includes("..")) return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    const path = match[1] === "library/clips" ? await findLibraryFile(filename)
      : match[1] === "downloads" ? (await resolveProjectFile(filename))?.path
      : isGeneratedClip(filename) ? resolveClipPath(match[2], filename) : null;
    if (!path) return NextResponse.json({ error: "Video not found" }, { status: 404 });
    const output = await framingPreview(path);
    const { size } = await fs.stat(output);
    let start = 0, end = size - 1;
    const range = request.headers.get("range");
    if (range) {
      const part = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!part || (!part[1] && !part[2])) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      start = part[1] ? Number(part[1]) : Math.max(0, size - Number(part[2]));
      end = part[1] && part[2] ? Math.min(size - 1, Number(part[2])) : size - 1;
      if (start > end || start >= size) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new NextResponse(Readable.toWeb(createReadStream(output, { start, end })) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cannot prepare preview" }, { status: 500 });
  }
}
