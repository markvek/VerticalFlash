import { NextResponse } from "next/server";
import { getClientCredentials, readToken } from "@/lib/tiktok-auth";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

// Self-serve health check: confirms the app's TikTok credentials work
// (live client_credentials grant) and shows the exact redirect URI the
// app sends, so portal mismatches are visible at a glance. No secrets
// are returned.
export async function GET() {
  const clientKeyPresent = Boolean(process.env.TIKTOK_CLIENT_KEY);
  const clientSecretPresent = Boolean(process.env.TIKTOK_CLIENT_SECRET);
  const redirectUri = process.env.TIKTOK_REDIRECT_URI || null;

  let credentialCheck: {
    status: number | null;
    ok: boolean;
    error?: string;
  };
  try {
    const { clientKey, clientSecret } = getClientCredentials();
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    credentialCheck = {
      status: res.status,
      ok: res.ok && Boolean(data.access_token),
      ...(res.ok
        ? {}
        : { error: data.error_description || data.error || "unknown" }),
    };
  } catch (error) {
    credentialCheck = {
      status: null,
      ok: false,
      error: error instanceof Error ? error.message : "request failed",
    };
  }

  const token = await readToken();

  return NextResponse.json({
    clientKeyPresent,
    clientSecretPresent,
    redirectUri,
    redirectUriNote:
      "This exact string must be registered in the sandbox's Login Kit settings on developers.tiktok.com",
    credentialCheck,
    tokenFile: token
      ? {
          exists: true,
          displayName: token.display_name || null,
          scopes: token.scopes || null,
          expiresAt: new Date(token.expires_at).toISOString(),
          expired: token.expires_at < Date.now(),
        }
      : { exists: false },
  });
}
