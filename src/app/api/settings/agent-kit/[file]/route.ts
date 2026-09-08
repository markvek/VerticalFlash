import { NextRequest, NextResponse } from "next/server";
import { buildAgentDownload } from "@/lib/agent-kit-download";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  try {
    const download = await buildAgentDownload(file);
    if (!download) return NextResponse.json({ error: "Download not found" }, { status: 404 });
    return new Response(download.bytes, { headers: {
      "Content-Type": download.contentType,
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    console.error("Agent kit download failed:", error);
    return NextResponse.json({ error: "Could not prepare the download. Please try again." }, { status: 500 });
  }
}
