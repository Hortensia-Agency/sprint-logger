import { createHash } from "node:crypto";
import { connect as tlsConnect } from "node:tls";

export type TokenKind = "personal" | "machine";
export type PullSource = "shared" | "override" | "proxy" | "dynamic" | "none" | "error";

export interface PulledVar {
  key: string;
  kind: string;
  source: PullSource;
  value?: string;
  reason?: string;
}

export interface Pulled {
  env: string;
  tokenKind: TokenKind;
  vars: PulledVar[];
}

/**
 * `rejected`: the server refused the token (revoked, expired, or its holder
 * lost access). `unavailable`: Sprint or its encryption backend could not
 * answer; a dev start may continue with local values.
 */
export class PullError extends Error {
  readonly reason: "rejected" | "unavailable";

  constructor(reason: "rejected" | "unavailable", message: string) {
    super(message);
    this.reason = reason;
  }
}

export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith("sprint_dev_")) return "personal";
  if (token.startsWith("sprint_svc_")) return "machine";
  return null;
}

const SOURCES = new Set<string>(["shared", "override", "proxy", "dynamic", "none", "error"]);

function isPulled(body: unknown): body is Pulled {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.env !== "string" || (b.tokenKind !== "personal" && b.tokenKind !== "machine")) {
    return false;
  }
  return (
    Array.isArray(b.vars) &&
    b.vars.every((v: Record<string, unknown>) => {
      return (
        typeof v?.key === "string" &&
        typeof v.kind === "string" &&
        SOURCES.has(v.source as string) &&
        (v.value === undefined || typeof v.value === "string")
      );
    })
  );
}

/**
 * Compare the server's leaf-certificate public key with a pinned base64
 * sha256, on a separate connection, before the token is ever sent. Defeats a
 * rogue or corporate CA on a CI box.
 */
async function verifyCertPin(apiUrl: URL, pin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: apiUrl.hostname,
        port: apiUrl.port ? Number(apiUrl.port) : 443,
        servername: apiUrl.hostname,
      },
      () => {
        const cert = socket.getPeerCertificate(true);
        socket.end();
        if (!cert?.pubkey) return reject(new Error("no peer certificate"));
        const got = createHash("sha256").update(cert.pubkey).digest("base64");
        if (got !== pin) return reject(new Error(`server key ${got} does not match the pin`));
        resolve();
      }
    );
    socket.on("error", reject);
  });
}

export async function pull(cfg: {
  apiUrl: string;
  token: string;
  certPin?: string;
  timeoutMs?: number;
  /** Leave out variables not available in this phase; omitted = everything. */
  phase?: "build" | "runtime" | null;
}): Promise<Pulled> {
  const base = new URL(cfg.apiUrl);
  if (cfg.certPin) {
    if (base.protocol !== "https:") {
      throw new PullError("rejected", "SPRINT_CERT_PIN needs an https SPRINT_API_URL.");
    }
    try {
      await verifyCertPin(base, cfg.certPin);
    } catch (err) {
      // A pin mismatch is an attack signal, not an outage: never fall back.
      throw new PullError("rejected", `certificate pin check failed: ${(err as Error).message}`);
    }
  }

  let res: Response;
  try {
    const url = new URL("/api/env/pull", base);
    if (cfg.phase) url.searchParams.set("phase", cfg.phase);
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new PullError("unavailable", `Sprint is unreachable (${(err as Error).message}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new PullError(
      "rejected",
      "Sprint rejected the token: it was revoked, it expired, or you no longer have access."
    );
  }
  if (!res.ok) {
    throw new PullError("unavailable", `Sprint answered ${res.status}.`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isPulled(body)) throw new PullError("unavailable", "Sprint sent a response this loader does not understand.");
  return body;
}
