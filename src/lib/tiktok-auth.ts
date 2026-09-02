import { promises as fs } from "fs";

// Single-user token store: one TikTok account, one JSON file at the project
// root (gitignored). No database — this tool runs locally for one person.
import { TIKTOK_TOKEN_PATH as TOKEN_PATH } from "./paths";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

export interface TikTokToken {
  access_token: string;
  refresh_token: string;
  // Unix ms when access_token expires
  expires_at: number;
  open_id: string;
  display_name?: string;
  // Space/comma-separated scopes TikTok actually granted
  scopes?: string;
}

// Refresh grants keep the token's original scopes — a token minted before a
// scope was added to the login URL only gains it through a full reconnect.
export function tokenHasScope(token: TikTokToken, scope: string): boolean {
  if (!token.scopes) return false;
  return token.scopes.split(/[\s,]+/).includes(scope);
}

export class TikTokNotConnectedError extends Error {
  constructor(message = "No TikTok account connected") {
    super(message);
    this.name = "TikTokNotConnectedError";
  }
}

export function getClientCredentials(): {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = process.env.TIKTOK_REDIRECT_URI;
  if (!clientKey || !clientSecret || !redirectUri) {
    throw new Error(
      "Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI in .env.local"
    );
  }
  return { clientKey, clientSecret, redirectUri };
}

export async function readToken(): Promise<TikTokToken | null> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw) as TikTokToken;
  } catch {
    return null;
  }
}

export async function saveToken(token: TikTokToken): Promise<void> {
  // Owner-only: this file holds a live access + refresh token
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearToken(): Promise<void> {
  await fs.rm(TOKEN_PATH, { force: true });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  open_id: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postTokenGrant(
  params: Record<string, string>
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(
      `TikTok token request failed: ${data.error_description || data.error || `HTTP ${res.status}`}`
    );
  }
  return data;
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier?: string
): Promise<TikTokToken> {
  const { clientKey, clientSecret, redirectUri } = getClientCredentials();
  const data = await postTokenGrant({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });
  const token: TikTokToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    open_id: data.open_id,
    scopes: data.scope,
  };
  await saveToken(token);
  return token;
}

// Returns a usable access token, refreshing it first if it expires within
// 5 minutes. Throws TikTokNotConnectedError when no account is linked.
export async function getValidAccessToken(): Promise<string> {
  const token = await readToken();
  if (!token) throw new TikTokNotConnectedError();

  if (token.expires_at - Date.now() > 5 * 60 * 1000) {
    return token.access_token;
  }

  const { clientKey, clientSecret } = getClientCredentials();
  const data = await postTokenGrant({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  });
  const refreshed: TikTokToken = {
    ...token,
    access_token: data.access_token,
    refresh_token: data.refresh_token || token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    open_id: data.open_id || token.open_id,
    scopes: data.scope || token.scopes,
  };
  await saveToken(refreshed);
  return refreshed.access_token;
}
