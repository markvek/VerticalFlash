import { NextRequest, NextResponse } from "next/server";
import { TextStyleZ } from "@/lib/text-overlays-schema";
import { rasterizeTextBlock } from "@/lib/png-overlays";
export async function GET(request: NextRequest) {
  try {
    const text = request.nextUrl.searchParams.get("text") ?? "";
    if (!text.trim() || text.length > 500) throw new Error("Invalid text");
    const style = TextStyleZ.parse(JSON.parse(request.nextUrl.searchParams.get("style") ?? "null"));
    const png = await rasterizeTextBlock(text, style);
    return new NextResponse(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" } });
  } catch { return NextResponse.json({ error: "Cannot preview this text" }, { status: 400 }); }
}
