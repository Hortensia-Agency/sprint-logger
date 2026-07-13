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
 * expo-web-browser + expo-crypto are needed. The SDK first tries to `require`
 * them itself (works when they're hoisted next to the SDK), but under strict
 * pnpm the SDK's own resolution can miss host-installed peers even though the
 * HOST can resolve them. So the host may INJECT the two modules via the widget's
 * `oauthDeps` prop; injected deps win over the SDK's own require.
 */

import { WebBrowser as RequiredWebBrowser, ExpoCrypto as RequiredCrypto } from "./optional-deps";

/** The two host-provided native modules the OAuth flow needs. */
export interface OAuthDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WebBrowser?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ExpoCrypto?: any;
}

/** Resolve deps: injected first (host resolved them), else the SDK's own require. */
function resolveDeps(injected?: OAuthDeps): { wb: any; cr: any } | null {
  const wb = injected?.WebBrowser ?? RequiredWebBrowser;
  const cr = injected?.ExpoCrypto ?? RequiredCrypto;
  if (wb?.openAuthSessionAsync && cr?.getRandomBytes && cr?.digestStringAsync) {
    return { wb, cr };
  }
  return null;
}

/** Is OAuth usable — with the given injected deps, or the SDK's own require. */
export function isOAuthAvailable(injected?: OAuthDeps): boolean {
  return resolveDeps(injected) !== null;
}

export type OAuthResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa exists in RN's Hermes/JSC global scope.
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makePkce(cr: any): Promise<{ verifier: string; challenge: string }> {
  const raw: Uint8Array = cr.getRandomBytes(32);
  const verifier = b64url(raw);
  const digestHex: string = await cr.digestStringAsync(
    cr.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: cr.CryptoEncoding.HEX }
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
  deps?: OAuthDeps;
}): Promise<OAuthResult> {
  const resolved = resolveDeps(opts.deps);
  if (!resolved) return { ok: false, error: "oauth_unavailable" };
  const { wb, cr } = resolved;

  const { verifier, challenge } = await makePkce(cr);
  const startUrl =
    `${opts.origin}/api/widget/mobile-auth/start` +
    `?key=${encodeURIComponent(opts.widgetKey)}` +
    `&redirect=${encodeURIComponent(opts.redirectUri)}` +
    `&device=${encodeURIComponent(opts.deviceId)}` +
    `&challenge=${encodeURIComponent(challenge)}`;

  const result = await wb.openAuthSessionAsync(startUrl, opts.redirectUri);
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
