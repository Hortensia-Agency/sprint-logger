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
import type * as httpTypes from "node:http";
import { createRequire } from "node:module";

// The ESM `import * as http` namespace is a frozen binding — assigning
// http.request = wrapper is a silent no-op. Load the MUTABLE CJS module objects
// so the outbound-request wrapper actually replaces .request. This is the same
// object host code sees whether it did `require("http")` or
// `import http from "node:http"` (both resolve to this singleton).
const _require = createRequire(import.meta.url);
const httpMod = _require("node:http") as typeof httpTypes;
const httpsMod = _require("node:https") as typeof import("node:https");

export type Severity = "low" | "medium" | "high" | "blocker";

/**
 * A single breadcrumb — one thing that happened before an error. Mirrors the
 * server's BreadcrumbSchema (lib/signals/context.ts) by hand: this package has
 * no dependency on the Sprint monorepo, so the wire shape is duplicated, not
 * imported. Keep the three SDKs (web/rn/node) in lock-step.
 *
 * Node has no DOM; the categories map to server-appropriate sources:
 *   console → console.error / console.warn (auto)
 *   fetch   → an outbound http/https request (auto — the closest wire category)
 * click/navigation are web-only and never emitted by this SDK.
 */
export interface Breadcrumb {
  category: "console" | "click" | "navigation" | "fetch" | "xhr";
  type?: string;
  level?: "debug" | "info" | "warning" | "error";
  message?: string;
  /** ms epoch — advisory ordering only. */
  timestamp?: number;
  data?: Record<string, string | number | boolean | null>;
}

/**
 * The failing HTTP request context (P2). Mirrors the server's HttpContextSchema
 * by hand. Captured from the outbound http/https instrumentation on a failed
 * request and attached to the next captured error. NO headers/body/cookies.
 */
export interface HttpContext {
  method: string;
  url: string;
  statusCode?: number;
  durationMs?: number;
}

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
  /**
   * Auto-collect breadcrumbs (console + outbound http/https) into a bounded
   * trail attached to each captured event. Default true. Set false to disable
   * the instrumentation (the kill switch if a host-app conflict surfaces).
   */
  captureBreadcrumbs?: boolean;
  /** Called (best-effort) if a capture POST fails. For host-side debugging. */
  onError?: (err: unknown) => void;
}

export interface CaptureContext {
  /** Pseudonymous opaque id — NEVER an email/name/IP (D6). */
  userToken?: string;
  /** Logical route/handler, e.g. "/api/checkout". */
  route?: string;
  severity?: Severity;
  /**
   * Explicit breadcrumb list. If omitted, the auto-collected trail is attached.
   * Bounded to the last 50. Keep values PII-free (the server re-scrubs).
   */
  breadcrumbs?: Breadcrumb[];
  /**
   * Explicit failing-request context. If omitted, the last auto-captured
   * failing outbound request is attached.
   */
  httpContext?: HttpContext;
}

interface ResolvedConfig
  extends Required<Omit<SignalsConfig, "release" | "onError" | "captureBreadcrumbs">> {
  release?: string;
  onError?: (err: unknown) => void;
  env: Record<string, unknown>;
}

const DEFAULT_ORIGIN = "https://sprint.hortensia-agency.com";

let config: ResolvedConfig | null = null;

// ---- breadcrumbs (auto-capture) ---------------------------------------
//
// A bounded ring buffer of what happened before an error. Node's auto-sources
// are console + outbound http/https requests. Each wrapper is defensive — a
// throw inside it must never break the host's own call or its request. Values
// are scrubbed at the source; the server re-scrubs regardless.

const CRUMB_MAX = 50;
const CRUMB_MSG_MAX = 512;
const crumbs: Breadcrumb[] = [];
let breadcrumbsInstalled = false;
// Saved originals so _reset() can un-patch http/https (matters for tests and
// for a host that toggles capture); console originals restored likewise.
let origHttpRequest: typeof httpMod.request | null = null;
let origHttpsRequest: typeof httpsMod.request | null = null;
let origConsole: { error?: unknown; warn?: unknown } = {};

// The most-recent FAILING outbound request (P2), attached to the next captured
// error if fresh (a stale failure probably didn't cause this error).
const HTTP_FRESH_MS = 30_000;
let lastHttp: { ctx: HttpContext; at: number } | null = null;

function recordFailingHttp(ctx: HttpContext): void {
  try {
    lastHttp = { ctx, at: nowMs() };
  } catch {
    /* swallow */
  }
}

function freshHttp(): HttpContext | undefined {
  try {
    if (lastHttp && nowMs() - lastHttp.at <= HTTP_FRESH_MS) return lastHttp.ctx;
  } catch {
    /* swallow */
  }
  return undefined;
}

function pushCrumb(c: Breadcrumb): void {
  try {
    crumbs.push(c);
    if (crumbs.length > CRUMB_MAX) crumbs.shift();
  } catch {
    /* never let bookkeeping throw into a wrapped host call */
  }
}

function getBreadcrumbs(): Breadcrumb[] {
  return crumbs.slice(-CRUMB_MAX);
}

const EMAIL_RE_G = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const IPV4_RE_G = /\b\d{1,3}(\.\d{1,3}){3}\b/g;

function scrubCrumb(v: string): string {
  let s = v.length > CRUMB_MSG_MAX ? v.slice(0, CRUMB_MSG_MAX) : v;
  s = s.replace(EMAIL_RE_G, "[email]").replace(IPV4_RE_G, "[ip]");
  return s;
}

function stripUrl(u: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
      const parsed = new URL(u);
      return scrubCrumb(parsed.origin + parsed.pathname);
    }
    if (u.startsWith("/")) {
      const q = u.search(/[?#]/);
      return scrubCrumb(q === -1 ? u : u.slice(0, q));
    }
  } catch {
    /* fall through */
  }
  return scrubCrumb(u);
}

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function stringifyArg(a: unknown): string {
  try {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === "object" && a !== null) return JSON.stringify(a).slice(0, 256);
    return String(a);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Manually record a breadcrumb — for domain events the auto-sources can't see
 * (a job start, a queue pop). Message is scrubbed and clamped.
 */
export function addBreadcrumb(c: Breadcrumb): void {
  if (!breadcrumbsInstalled) return;
  try {
    pushCrumb({
      category: c.category,
      type: c.type,
      level: c.level,
      message: c.message != null ? scrubCrumb(String(c.message)) : undefined,
      timestamp: c.timestamp ?? nowMs(),
      data: c.data,
    });
  } catch {
    /* swallow */
  }
}

// Derive a scrubbed "METHOD host/path" label + the request URL from the varied
// http.request call signatures: (url), (url, opts), (opts), (url|opts, opts, cb).
function describeRequest(
  arg0: unknown,
  arg1: unknown
): { method: string; url: string } {
  let method = "GET";
  let url = "";
  try {
    const optsCandidate =
      arg1 && typeof arg1 === "object" ? arg1 : arg0 && typeof arg0 === "object" && !(arg0 instanceof URL) ? arg0 : undefined;
    const o = optsCandidate as
      | { method?: string; protocol?: string; host?: string; hostname?: string; port?: number | string; path?: string }
      | undefined;
    if (o?.method) method = String(o.method).toUpperCase();

    if (typeof arg0 === "string") {
      url = arg0;
    } else if (arg0 instanceof URL) {
      url = arg0.href;
    } else if (o) {
      const proto = (o.protocol || "http:").replace(/:$/, "");
      const host = o.hostname || o.host || "localhost";
      const port = o.port ? `:${o.port}` : "";
      url = `${proto}://${host}${port}${o.path || "/"}`;
    }
  } catch {
    /* best-effort label */
  }
  return { method, url };
}

function installBreadcrumbs(): void {
  if (breadcrumbsInstalled) return;
  breadcrumbsInstalled = true;

  // console.error / console.warn
  try {
    const c = console as unknown as Record<string, unknown>;
    for (const lvl of ["error", "warn"] as const) {
      const orig = c[lvl];
      if (typeof orig !== "function") continue;
      origConsole[lvl] = orig;
      c[lvl] = function (this: unknown, ...args: unknown[]) {
        try {
          pushCrumb({
            category: "console",
            type: lvl,
            level: lvl === "warn" ? "warning" : "error",
            message: scrubCrumb(args.map(stringifyArg).join(" ")),
            timestamp: nowMs(),
          });
        } catch {
          /* swallow */
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  } catch {
    /* console not patchable */
  }

  // outbound http / https .request — record on response 'close', capturing the
  // status. The request itself is never altered; a throw in bookkeeping is
  // swallowed and the original request proceeds.
  try {
    origHttpRequest = httpMod.request;
    origHttpsRequest = httpsMod.request;
    const wrap = (
      orig: typeof httpMod.request
    ): typeof httpMod.request =>
      function (this: unknown, ...args: unknown[]) {
        let meta: { method: string; url: string } | undefined;
        const started = nowMs();
        try {
          meta = describeRequest(args[0], args[1]);
        } catch {
          /* swallow */
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const req = (orig as any).apply(this, args) as httpTypes.ClientRequest;
        try {
          req.on("response", (res: httpTypes.IncomingMessage) => {
            try {
              const status = res.statusCode ?? 0;
              const failed = status >= 400 || status === 0;
              pushCrumb({
                category: "fetch",
                type: meta?.method ?? "GET",
                level: failed ? "error" : "info",
                message: meta ? stripUrl(meta.url) : undefined,
                timestamp: started,
                data: { status },
              });
              if (failed && meta)
                recordFailingHttp({
                  method: meta.method,
                  url: stripUrl(meta.url),
                  statusCode: status || undefined,
                  durationMs: Math.max(0, nowMs() - started),
                });
            } catch {
              /* swallow */
            }
          });
          req.on("error", () => {
            try {
              pushCrumb({
                category: "fetch",
                type: meta?.method ?? "GET",
                level: "error",
                message: meta ? stripUrl(meta.url) : undefined,
                timestamp: started,
                data: { error: 1 },
              });
              if (meta)
                recordFailingHttp({
                  method: meta.method,
                  url: stripUrl(meta.url),
                  durationMs: Math.max(0, nowMs() - started),
                });
            } catch {
              /* swallow */
            }
          });
        } catch {
          /* swallow */
        }
        return req;
      } as typeof httpMod.request;
    httpMod.request = wrap(origHttpRequest);
    httpsMod.request = wrap(origHttpsRequest);
  } catch {
    /* http/https not patchable */
  }
}

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
  if (cfg.captureBreadcrumbs ?? true) installBreadcrumbs();
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
  // Manual breadcrumbs win if present; otherwise attach the auto-collected
  // trail. Both bounded to 50.
  const trail = ctx.breadcrumbs ? ctx.breadcrumbs.slice(-50) : getBreadcrumbs();
  const httpContext = ctx.httpContext ?? freshHttp();
  await post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken,
    route: ctx.route,
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: trail.length ? trail : undefined,
    httpContext,
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

/**
 * Signals v2 — Next.js App Router server-error bridge. Export this ONE line from
 * instrumentation.ts to auto-capture errors thrown in Server Components, Route
 * Handlers, middleware, and Server Actions (which never reach a client handler):
 *
 *   // instrumentation.ts
 *   export const onRequestError = captureRequestError;
 *
 * Matches Next's onRequestError signature. Fire-and-forget; never rethrows.
 */
export async function captureRequestError(
  error: unknown,
  request?: { path?: string; method?: string },
  context?: { routerKind?: string; routePath?: string }
): Promise<void> {
  try {
    if (!config) return;
    await capture(
      error,
      {
        route: request?.path ?? context?.routePath,
        // Server-error = uncaught from the app's perspective.
      },
      false
    );
  } catch {
    /* never rethrow into Next's error pipeline */
  }
}

// ---- Signals v2 (non-error signals) -----------------------------------
//
// The Node counterpart to the web SDK's captureSignal()/startSpan(). Mirrors
// the server's SignalType/SignalEvidence (lib/signals/context.ts) by hand — no
// monorepo dependency. On a server the primary v2 use is Engine B
// (captureSignal for a violated invariant) and server perf (startSpan around a
// slow endpoint/query). Fire-and-forget; never rejects.

export type SignalType =
  | "http_error"
  | "slow_operation"
  | "perf"
  | "custom"
  | "meta";

export interface SignalEvidence {
  http?: { method: string; path: string; status: number };
  op?: string;
  valueMs?: number;
  threshold?: number;
  reason?: string;
}

export interface CaptureSignalInput {
  /** Stable sub-slug — the fingerprint seed. Low-cardinality. */
  type: string;
  title: string;
  severity?: Severity;
  fingerprint?: string;
  context?: Record<string, string | number | boolean | null>;
  route?: string;
  userToken?: string;
}

/**
 * Assert an app-level problem the SDK can't infer (a violated business
 * invariant). Emits a `custom` signal; fingerprint seeded by `type`.
 */
export async function captureSignal(input: CaptureSignalInput): Promise<void> {
  if (!config || !input?.type || !input?.title) return;
  return emitSignal({
    signalType: "custom",
    type: input.type.slice(0, 200),
    title: input.title.slice(0, 500),
    fingerprint: input.fingerprint?.slice(0, 200),
    severity: input.severity,
    context: input.context,
    userToken: input.userToken,
    route: input.route,
  });
}

// Shared non-error emit path. Fire-and-forget.
async function emitSignal(body: {
  signalType: SignalType;
  title?: string;
  type?: string;
  fingerprint?: string;
  evidence?: SignalEvidence;
  severity?: Severity;
  context?: Record<string, string | number | boolean | null>;
  userToken?: string;
  route?: string;
}): Promise<void> {
  if (!config) return;
  const trail = getBreadcrumbs();
  await post({
    signalType: body.signalType,
    type: body.type,
    title: body.title,
    fingerprint: body.fingerprint,
    evidence: body.evidence,
    severity: body.severity,
    context: body.context,
    userToken: body.userToken,
    route: body.route,
    release: config.release,
    breadcrumbs: trail.length ? trail : undefined,
    occurredAt: new Date().toISOString(),
    env: { ...config.env, handled: true },
  });
}

/**
 * Time a server operation; emit a `slow_operation` signal if it exceeds
 * `thresholdMs`. Under threshold → nothing emitted. The "this endpoint/query is
 * too slow" primitive. finish() is fire-and-forget (returns void, not a Promise,
 * so it drops cleanly into a finally block).
 */
export function startSpan(
  op: string,
  thresholdMs = 1000
): { finish: (extra?: Record<string, string | number | boolean | null>) => void } {
  const started = Date.now();
  let done = false;
  return {
    finish(extra) {
      if (done || !config) return;
      done = true;
      const valueMs = Math.max(0, Date.now() - started);
      if (valueMs < thresholdMs) return;
      void emitSignal({
        signalType: "slow_operation",
        title: `${op} took ${valueMs}ms`,
        evidence: { op: op.slice(0, 256), valueMs, threshold: thresholdMs },
        context: extra,
      });
    },
  };
}

/**
 * N+1 query detector for one request/unit of work. The host calls query(key)
 * once per DB call with a NORMALIZED query shape as the key (e.g.
 * "SELECT * FROM users WHERE id = ?"); on finish(), any shape seen more than
 * `threshold` times in the same request emits a `perf` signal — the classic
 * "N sequential identical queries that should have been one" bug the user asked
 * to catch. Per-request state; call once per request. Never throws.
 *
 *   const q = trackNPlusOne(route);
 *   for (const row of rows) { q.query("SELECT ... WHERE id = ?"); await load(row.id); }
 *   q.finish(); // if the same shape ran > threshold times → a perf signal
 */
export function trackNPlusOne(
  route: string,
  threshold = 10
): { query: (shape: string) => void; finish: () => void } {
  const counts = new Map<string, number>();
  let done = false;
  return {
    query(shape: string) {
      try {
        const k = shape.slice(0, 256);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } catch {
        /* swallow */
      }
    },
    finish() {
      if (done || !config) return;
      done = true;
      try {
        for (const [shape, n] of counts) {
          if (n > threshold) {
            void emitSignal({
              signalType: "perf",
              title: `N+1: ${n}× ${shape} in ${route}`,
              // op = route + shape so all N+1 of the same shape on a route group.
              evidence: { op: `n+1:${route}:${shape}`.slice(0, 256), valueMs: n, threshold },
              context: { route: route.slice(0, 256), count: n },
            });
          }
        }
      } catch {
        /* swallow */
      }
    },
  };
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

/** Test/teardown helper — clears config, handler flag, breadcrumb state, and
 * un-patches console/http/https so a wrapper can't leak into another test. */
export function _reset(): void {
  config = null;
  handlersInstalled = false;
  crumbs.length = 0;
  lastHttp = null;
  if (breadcrumbsInstalled) {
    try {
      const c = console as unknown as Record<string, unknown>;
      if (typeof origConsole.error === "function") c.error = origConsole.error;
      if (typeof origConsole.warn === "function") c.warn = origConsole.warn;
      if (origHttpRequest) httpMod.request = origHttpRequest;
      if (origHttpsRequest) httpsMod.request = origHttpsRequest;
    } catch {
      /* best-effort restore */
    }
  }
  origConsole = {};
  origHttpRequest = null;
  origHttpsRequest = null;
  breadcrumbsInstalled = false;
}

/** Test-only: read the current breadcrumb buffer. */
export function _breadcrumbs(): Breadcrumb[] {
  return getBreadcrumbs();
}

// ---- analytics (P5) ---------------------------------------------------
//
// A server has no pageviews, so Node analytics is for custom usage events only:
// trackEvent(name) — e.g. a job ran, an API route was hit. Pseudonymous; the
// client event_id makes each beacon idempotent server-side.

function uuid(): string {
  // Prefer crypto.randomUUID (Node 16+); fall back to a random hex.
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

async function sendAnalytics(body: Record<string, unknown>): Promise<void> {
  if (!config) return;
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v;
    await fetch(`${config.origin}/api/analytics/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signal-Key": config.key },
      body: JSON.stringify(clean),
    });
  } catch (err) {
    config?.onError?.(err);
  }
}

/**
 * Record a custom usage event from a Node service (e.g. "job.completed"). The
 * name is sent as the route dimension. Pseudonymous — pass no PII.
 */
export function trackEvent(name: string, sessionToken?: string): void {
  if (!config || !name) return;
  void sendAnalytics({
    eventId: uuid(),
    type: "custom",
    route: name.slice(0, 500),
    sessionToken,
    platform: "node",
    occurredAt: new Date().toISOString(),
  });
}
