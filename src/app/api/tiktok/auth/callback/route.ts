import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForToken,
  readToken,
  saveToken,
} from "@/lib/tiktok-auth";

const USER_INFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";

// Failures render a page instead of redirecting — a silent bounce to "/"
// looks like "nothing happened" and hides the actual problem
function errorPage(title: string, detail: string, backTo: string) {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>TikTok connect failed</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 80px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 20px; } p { line-height: 1.5; color: #444; }
  a { color: #0070f3; }
  code { background: #f4f4f4; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
</style></head>
<body>
  <h1>⚠️ TikTok connect failed</h1>
  <p><strong>${title}</strong></p>
  <p>${detail}</p>
  <p><a href="${backTo}">← Back to the app</a></p>
</body>
</html>`;
  return new NextResponse(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const errorParam = request.nextUrl.searchParams.get("error");
  const cookieState = request.cookies.get("tiktok_oauth_state")?.value;
  const codeVerifier = request.cookies.get("tiktok_code_verifier")?.value;
  const returnTo = request.cookies.get("tiktok_return_to")?.value || "/";
  const safeReturnTo = returnTo.startsWith("/") ? returnTo : "/";

  if (errorParam) {
    console.error(
      `TikTok callback: TikTok returned error=${errorParam}`,
      Object.fromEntries(request.nextUrl.searchParams)
    );
    return errorPage(
      `TikTok said: ${errorParam}`,
      errorParam === "access_denied"
        ? "The login was cancelled, or this TikTok account isn't in the sandbox's target user list on the developer portal."
        : "See the server console for the full parameters TikTok sent back.",
      safeReturnTo
    );
  }

  if (!code) {
    console.error("TikTok callback: no ?code param in callback URL");
    return errorPage(
      "TikTok didn't send an authorization code",
      "The redirect arrived without a code. Check that the redirect URI registered on the developer portal is exactly <code>" +
        (process.env.TIKTOK_REDIRECT_URI || "(TIKTOK_REDIRECT_URI unset)") +
        "</code>.",
      safeReturnTo
    );
  }

  if (!cookieState) {
    console.error("TikTok callback: state cookie missing (expired or different browser)");
    return errorPage(
      "Login session expired",
      "The security cookie from when you clicked Connect is gone — it expires after 30 minutes, and it won't exist if the login finished in a different browser than it started in. Go back and click Connect TikTok again.",
      safeReturnTo
    );
  }

  if (state !== cookieState) {
    console.error(
      `TikTok callback: state mismatch (got ${state}, expected ${cookieState}) — likely an older Connect click's cookie was overwritten by a newer one`
    );
    return errorPage(
      "Login attempt out of date",
      "This login started from an older Connect click than the most recent one (e.g. two tabs). Go back and click Connect TikTok once, then finish the login in that same tab.",
      safeReturnTo
    );
  }

  try {
    await exchangeCodeForToken(code, codeVerifier);

    // Best-effort: grab the display name so the UI can show who's connected
    try {
      const token = await readToken();
      if (token) {
        const res = await fetch(USER_INFO_URL, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        if (res.ok) {
          const data = await res.json();
          const name = data?.data?.user?.display_name;
          if (name) await saveToken({ ...token, display_name: name });
        }
      }
    } catch {
      // display name is cosmetic
    }

    const url = new URL(safeReturnTo, request.nextUrl.origin);
    url.searchParams.set("tiktok_connected", "1");
    const res = NextResponse.redirect(url.toString());
    res.cookies.delete("tiktok_oauth_state");
    res.cookies.delete("tiktok_code_verifier");
    res.cookies.delete("tiktok_return_to");
    return res;
  } catch (error) {
    console.error("TikTok callback: token exchange failed:", error);
    return errorPage(
      "Couldn't exchange the login code for a token",
      error instanceof Error ? error.message : "Unknown error — see server console.",
      safeReturnTo
    );
  }
}
