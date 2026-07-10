/**
 * OAuth "Sign in with Sprint" for the mobile QA widget.
 *
 * Flow (mirrors app/api/widget/mobile-auth on the server):
 *   1. Generate a PKCE verifier + challenge.
 *   2. Open `<origin>/api/widget/mobile-auth/start?key&redirect&device&challenge`
 *      in an auth session browser (expo-web-browser). The tester logs into
 *      Sprint there with their existing GitHub/Google account.
 *   3. Sprint redirects back to `<redirect>?code=…` (or `?error=…`). The auth
 *      session resolves with that URL — tied to the calling app, so a rogue app
 *      registering the same scheme can't intercept it.
 *   4. POST { code, verifier } to `/exchange`; Sprint verifies PKCE and returns
 *      the per-device mobile_widget PAT. We never receive the token in a URL.
 *
 * Requires the optional peers expo-web-browser + expo-crypto. `oauthAvailable`
 * is false when either is missing (the sign-in button then hides).
 */

import { WebBrowser, ExpoCrypto } from "./optional-deps";

export const oauthAvailable = Boolean(WebBrowser && ExpoCrypto);

export type OAuthResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa exists in RN's Hermes/JSC global scope.
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function makePkce(): Promise<{ verifier: string; challenge: string }> {
  const raw: Uint8Array = ExpoCrypto.getRandomBytes(32);
  const verifier = b64url(raw);
  const digestHex: string = await ExpoCrypto.digestStringAsync(
    ExpoCrypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: ExpoCrypto.CryptoEncoding.HEX }
  );
  // Convert hex digest → bytes → base64url, matching Node's
  // createHash("sha256").update(verifier).digest("base64url") on the server.
  const bytes = new Uint8Array(digestHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(digestHex.substr(i * 2, 2), 16);
  }
  return { verifier, challenge: b64url(bytes) };
}

function paramFromUrl(url: string, key: string): string | null {
  const m = url.match(new RegExp(`[?&]${key}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function signInWithSprint(opts: {
  origin: string;
  widgetKey: string;
  redirectUri: string;
  deviceId: string;
}): Promise<OAuthResult> {
  if (!oauthAvailable) return { ok: false, error: "oauth_unavailable" };

  const { verifier, challenge } = await makePkce();
  const startUrl =
    `${opts.origin}/api/widget/mobile-auth/start` +
    `?key=${encodeURIComponent(opts.widgetKey)}` +
    `&redirect=${encodeURIComponent(opts.redirectUri)}` +
    `&device=${encodeURIComponent(opts.deviceId)}` +
    `&challenge=${encodeURIComponent(challenge)}`;

  const result = await WebBrowser.openAuthSessionAsync(startUrl, opts.redirectUri);
  if (result.type !== "success" || !result.url) {
    return { ok: false, error: result.type === "cancel" ? "cancelled" : "dismissed" };
  }

  const err = paramFromUrl(result.url, "error");
  if (err) return { ok: false, error: err };
  const code = paramFromUrl(result.url, "code");
  if (!code) return { ok: false, error: "no_code" };

  try {
    const res = await fetch(`${opts.origin}/api/widget/mobile-auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: j.error ?? `exchange_${res.status}` };
    }
    const j = (await res.json()) as { token?: string };
    if (!j.token) return { ok: false, error: "no_token" };
    return { ok: true, token: j.token };
  } catch {
    return { ok: false, error: "network" };
  }
}
