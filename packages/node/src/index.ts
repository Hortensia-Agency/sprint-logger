/**
 * Sprint Signals server SDK (P2). Framework-agnostic Node capture: ships
 * server-side exceptions to a Sprint project's ingest endpoint.
 *
 *   import { init, captureException } from "@sprint-logger/node";
 *   init({ key: process.env.SPRINT_SIGNALS_KEY!, release: "v1.2.3" });
 *   // automatic: process 'uncaughtException' + 'unhandledRejection'
 *   // manual:
 *   try { ... } catch (e) { captureException(e, { route: "/api/checkout" }); }
 *
 * The ingest endpoint resolves tenant+project FROM THE KEY — this SDK never
 * sends a tenant/project id. Context is pseudonymous only (D6): pass an opaque
 * userToken you control, never an email/IP. Capture is fire-and-forget and
 * MUST NOT throw into the host app's hot path (F-1).
 */

import * as os from "node:os";

export type Severity = "low" | "medium" | "high" | "blocker";

/**
 * Pseudonymous Node env (enrichment plan, D-3). Collected once at init — the
 * server tz/locale/runtime don't change per-error. Deliberately NEVER reads
 * os.hostname() (identity leak). timezone is the SERVER tz, surfaced with a
 * "(server)" label downstream — a documented limitation, not the user's tz.
 */
function collectNodeEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = { platform: "node" };
  try {
    env.osName = os.platform(); // 'darwin' | 'linux' | 'win32' | …
    env.osVersion = os.release();
    env.runtimeVersion = `node ${process.version}`;
    env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    env.utcOffset = -new Date().getTimezoneOffset();
    const lang = process.env.LANG || process.env.LC_ALL;
    if (lang) env.locale = lang.split(".")[0]; // strip ".UTF-8"
  } catch {
    /* env is best-effort; a probe failure must never block capture */
  }
  return env;
}

export interface SignalsConfig {
  /** Project ingest key, `sk_sig_…`. */
  key: string;
  /**
   * Sprint origin. Defaults to the production Sprint. Override for staging /
   * self-hosted (e.g. "https://sprint.staging.hortensia-agency.com").
   */
  origin?: string;
  /** Optional release/version tag attached to every event. */
  release?: string;
  /** Install process-level handlers for uncaught errors. Default true. */
  installGlobalHandlers?: boolean;
  /** Called (best-effort) if a capture POST fails. For host-side debugging. */
  onError?: (err: unknown) => void;
}

export interface CaptureContext {
  /** Pseudonymous opaque id — NEVER an email/name/IP (D6). */
  userToken?: string;
  /** Logical route/handler, e.g. "/api/checkout". */
  route?: string;
  severity?: Severity;
  /** Bounded breadcrumb list — last-N actions. Keep values PII-free. */
  breadcrumbs?: unknown[];
}

interface ResolvedConfig extends Required<Omit<SignalsConfig, "release" | "onError">> {
  release?: string;
  onError?: (err: unknown) => void;
  env: Record<string, unknown>;
}

const DEFAULT_ORIGIN = "https://sprint.hortensia-agency.com";

let config: ResolvedConfig | null = null;

export function init(cfg: SignalsConfig): void {
  if (!cfg.key || !cfg.key.startsWith("sk_sig_")) {
    // Don't throw — a misconfigured telemetry SDK must never break boot.
    cfg.onError?.(new Error("sprint-signals: invalid or missing key"));
    return;
  }
  config = {
    key: cfg.key,
    origin: (cfg.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, ""),
    release: cfg.release,
    installGlobalHandlers: cfg.installGlobalHandlers ?? true,
    onError: cfg.onError,
    env: collectNodeEnv(),
  };
  if (config.installGlobalHandlers) installHandlers();
}

let handlersInstalled = false;
function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("uncaughtException", (err) => {
    void capture(err, {}, false);
  });
  process.on("unhandledRejection", (reason) => {
    void capture(reason, {}, false);
  });
}

function normalizeError(input: unknown): {
  message: string;
  stack?: string;
  errorType?: string;
} {
  if (input instanceof Error) {
    return {
      message: input.message || input.name,
      stack: input.stack,
      errorType: input.name,
    };
  }
  if (typeof input === "string") return { message: input };
  try {
    return { message: JSON.stringify(input).slice(0, 2000) };
  } catch {
    return { message: String(input) };
  }
}

/**
 * Capture an exception. Fire-and-forget: resolves once the POST settles but
 * NEVER rejects — a telemetry failure must not become an application failure.
 * Public manual capture is `handled:true`; global handlers call capture(...)
 * directly with handled:false.
 */
export async function captureException(
  error: unknown,
  ctx: CaptureContext = {}
): Promise<void> {
  return capture(error, ctx, true);
}

async function capture(
  error: unknown,
  ctx: CaptureContext,
  handled: boolean
): Promise<void> {
  if (!config) return; // init() not called or failed — silently no-op.
  const { message, stack, errorType } = normalizeError(error);
  await post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken,
    route: ctx.route,
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: ctx.breadcrumbs?.slice(0, 50),
    occurredAt: new Date().toISOString(),
    env: { ...config.env, handled, ...(errorType ? { errorType } : {}) },
  });
}

/** Capture a plain message (no Error object). */
export async function captureMessage(
  message: string,
  ctx: CaptureContext = {}
): Promise<void> {
  return captureException(new Error(message), ctx);
}

async function post(body: Record<string, unknown>): Promise<void> {
  if (!config) return;
  try {
    // Node 18+ has global fetch. Drop unknown undefined fields.
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v;
    const res = await fetch(`${config.origin}/api/signals/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signal-Key": config.key,
      },
      body: JSON.stringify(clean),
    });
    // 202 expected; 402/404/422/429 are non-fatal — surface to onError only.
    if (!res.ok && res.status !== 202) {
      config.onError?.(new Error(`sprint-signals ingest ${res.status}`));
    }
  } catch (err) {
    config?.onError?.(err);
  }
}

/** Test/teardown helper — clears config + handler flag. */
export function _reset(): void {
  config = null;
  handlersInstalled = false;
}
