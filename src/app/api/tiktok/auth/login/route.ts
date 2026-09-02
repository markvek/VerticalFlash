import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { getClientCredentials } from "@/lib/tiktok-auth";

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";

// video.upload = drafts/inbox upload only (no direct posting, by design);
// requires the Content Posting API product on developers.tiktok.com.
// video.list + user.info.stats power the /analytics page.
const SCOPES = "user.info.basic,user.info.stats,video.upload,video.list";

export async function GET(request: NextRequest) {
  let clientKey: string, redirectUri: string;
  try {
    ({ clientKey, redirectUri } = getClientCredentials());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Missing config" },
      { status: 500 }
    );
  }

  const state = randomBytes(16).toString("hex");
  // PKCE — TikTok requires it and, unlike the RFC, wants the challenge as
  // the plain hex SHA-256 of the verifier (not base64url)
  const codeVerifier = randomBytes(32).toString("hex");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("hex");
  // Where to send the user after the callback (must be a local path)
  const returnTo = request.nextUrl.searchParams.get("return_to") || "/";
  const safeReturnTo = returnTo.startsWith("/") ? returnTo : "/";

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_key", clientKey);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Hint TikTok to render its pages in English (it otherwise localizes by
  // the viewer's account language / region)
  url.searchParams.set("lang", "en");

  const res = NextResponse.redirect(url.toString());
  // 30 min — the first login can involve portal detours on TikTok's side,
  // and an expired state cookie turns into a confusing state_mismatch
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 1800,
    secure: request.nextUrl.protocol === "https:",
  };
  res.cookies.set("tiktok_oauth_state", state, cookieOpts);
  res.cookies.set("tiktok_code_verifier", codeVerifier, cookieOpts);
  res.cookies.set("tiktok_return_to", safeReturnTo, cookieOpts);
  return res;
}
