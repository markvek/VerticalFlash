import { NextResponse } from "next/server";
import { clearToken, readToken } from "@/lib/tiktok-auth";

export async function GET() {
  const token = await readToken();
  if (!token) {
    return NextResponse.json({ connected: false });
  }
  return NextResponse.json({
    connected: true,
    displayName: token.display_name || null,
    openId: token.open_id,
    expiresAt: token.expires_at,
    scopes: token.scopes || null,
  });
}

export async function DELETE() {
  await clearToken();
  return NextResponse.json({ connected: false });
}
