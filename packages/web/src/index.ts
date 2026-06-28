/**
 * Sprint Signals web SDK — for BUNDLED browser apps (Next.js, Vite, CRA,
 * Astro, SvelteKit, …). The npm-package counterpart to the hosted
 * `signals.js` <script> tag: you import it and call init() once, PostHog-style,
 * instead of dropping a script tag.
 *
 *   // instrumentation-client.ts (Next.js) — or your app entry
 *   import { init } from "@sprint-logger/web";
 *   init(process.env.NEXT_PUBLIC_SPRINT_SIGNALS_KEY!, { release: "1.2.3" });
 *
 *   // anywhere — manual capture
 *   import { capture } from "@sprint-logger/web";
 *   try { ... } catch (e) { capture(e, { route: "/checkout" }); }
 *
 * Tenant + project resolve FROM THE KEY server-side — this SDK never sends a
 * tenant/project id. Context is pseudonymous only: an opaque client-chosen
 * userToken (persisted in localStorage), never an email/name/IP. Capture is
 * fire-and-forget and never throws into the host app. Use the hosted <script>
 * (`signals.js`) instead for plain-HTML / no-build sites.
 *
 * The enriched diagnostic context (platform/OS/browser/timezone/locale/…) is
 * collected via UA Client Hints with a navigator.userAgent fallback for
 * Safari/Firefox. All fields are optional and non-identifying (no
 * hostname/IP/geo); the Sprint ingest endpoint validates and rejects PII.
 */

export type Severity = "low" | "medium" | "high" | "blocker";

export interface SignalsWebConfig {
  /**
   * Sprint origin. Defaults to production Sprint. Override for staging /
   * self-hosted (e.g. "https://sprint.staging.hortensia-agency.com").
   */
  origin?: string;
  /** Optional release/version tag attached to every event. */
  release?: string;
  /** Hook window 'error' + 'unhandledrejection'. Default true. */
  installGlobalHandlers?: boolean;
  /** Called (best-effort) if a capture POST fails. For host-side debugging. */
  onError?: (err: unknown) => void;
}

export interface CaptureContext {
  /** Pseudonymous opaque id — NEVER an email/name/IP (D6). */
  userToken?: string;
  route?: string;
  severity?: Severity;
  /** Bounded breadcrumb list — last-N actions. Keep values PII-free. */
  breadcrumbs?: unknown[];
}

interface Resolved {
  key: string;
  origin: string;
  release?: string;
  onError?: (err: unknown) => void;
  userToken: string;
}

const DEFAULT_ORIGIN = "https://sprint.hortensia-agency.com";
const TOKEN_KEY = "_sprint_sig_uid";

let config: Resolved | null = null;
let env: Record<string, unknown> = {};

/**
 * Initialize Signals. Call once at app start (e.g. Next.js
 * `instrumentation-client.ts`). A missing/malformed key is a silent no-op —
 * a misconfigured telemetry SDK must never break the host app's boot.
 */
export function init(key: string, cfg: SignalsWebConfig = {}): void {
  if (typeof window === "undefined") return; // SSR pass — no-op, client re-runs it
  if (!key || key.indexOf("sk_sig_") !== 0) {
    cfg.onError?.(new Error("sprint-signals-web: invalid or missing key"));
    return;
  }
  config = {
    key,
    origin: (cfg.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, ""),
    release: cfg.release,
    onError: cfg.onError,
    userToken: loadToken(),
  };
  env = buildEnv();
  void enrichFromClientHints();
  if (cfg.installGlobalHandlers ?? true) installHandlers();
}

// ---- pseudonymous token (D6) ------------------------------------------
function loadToken(): string {
  try {
    const existing = window.localStorage.getItem(TOKEN_KEY);
    if (existing) return existing;
    const fresh = "anon_" + randHex();
    window.localStorage.setItem(TOKEN_KEY, fresh);
    return fresh;
  } catch {
    return "anon_" + randHex();
  }
}

function randHex(): string {
  try {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let s = "";
    for (let i = 0; i < 16; i++)
      s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
    return s;
  }
}

// ---- diagnostic context (enrichment) ----------------------------------
function coarseBrowser(ua: string): { browserName?: string; engine?: string } {
  if (!ua) return {};
  if (/Edg\//.test(ua)) return { browserName: "Edge", engine: "Blink" };
  if (/OPR\//.test(ua)) return { browserName: "Opera", engine: "Blink" };
  if (/Firefox\//.test(ua)) return { browserName: "Firefox", engine: "Gecko" };
  if (/Chrome\//.test(ua)) return { browserName: "Chrome", engine: "Blink" };
  if (/Safari\//.test(ua)) return { browserName: "Safari", engine: "WebKit" };
  return {};
}

function coarseOs(ua: string): string | undefined {
  if (!ua) return undefined;
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

function posInt(n: number): number | undefined {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

function buildEnv(): Record<string, unknown> {
  const e: Record<string, unknown> = { platform: "web" };
  try {
    const ua = navigator.userAgent || "";
    const cb = coarseBrowser(ua);
    e.browserName = cb.browserName;
    e.engine = cb.engine;
    e.osName = coarseOs(ua);
    e.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // getTimezoneOffset is minutes WEST of UTC + inverted → negate for the
    // contract's "minutes east of UTC".
    e.utcOffset = -new Date().getTimezoneOffset();
    e.locale = navigator.language;
    if (window.innerWidth)
      e.viewport = { w: posInt(window.innerWidth), h: posInt(window.innerHeight) };
    if (window.screen)
      e.screen = { w: posInt(window.screen.width), h: posInt(window.screen.height) };
    const conn = (navigator as unknown as { connection?: { effectiveType?: string } })
      .connection;
    if (conn?.effectiveType) e.networkType = conn.effectiveType;
  } catch {
    /* best-effort */
  }
  return e;
}

// UA-CH high-entropy fills in structured os/browser/device async; mutates the
// shared `env` so later captures carry the richer values.
async function enrichFromClientHints(): Promise<void> {
  try {
    const uad = (navigator as unknown as {
      userAgentData?: {
        getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>>;
      };
    }).userAgentData;
    if (!uad?.getHighEntropyValues) return;
    const h = await uad.getHighEntropyValues([
      "platform",
      "platformVersion",
      "model",
      "uaFullVersion",
      "fullVersionList",
    ]);
    if (h.platform) env.osName = h.platform;
    if (h.platformVersion) env.osVersion = h.platformVersion;
    if (h.model) env.deviceModel = h.model;
    if (h.uaFullVersion) env.browserVersion = h.uaFullVersion;
    const list = h.fullVersionList as Array<{ brand?: string; version?: string }> | undefined;
    if (list?.length) {
      for (const b of list) {
        if (b.brand && /Chrome|Edge|Opera|Firefox|Safari/.test(b.brand)) {
          env.browserName = b.brand;
          if (b.version) env.browserVersion = b.version;
        }
      }
    }
  } catch {
    /* UA-CH unavailable (Safari/Firefox) — coarse env already set */
  }
}

function envFor(handled: boolean, errorType?: string): Record<string, unknown> {
  return { ...env, handled, ...(errorType ? { errorType } : {}) };
}

// ---- global handlers (uncaught → handled:false) -----------------------
let handlersInstalled = false;
function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  window.addEventListener("error", (e) => {
    const err = (e as ErrorEvent).error;
    if (err) captureWith(err, {}, false);
    else if ((e as ErrorEvent).message)
      report((e as ErrorEvent).message, undefined, {}, false);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    if (r && r.message) captureWith(r, {}, false);
    else if (r) report(String(r), undefined, {}, false);
  });
}

function normalizeError(input: unknown): {
  message: string;
  stack?: string;
  errorType?: string;
} {
  if (input instanceof Error)
    return { message: input.message || input.name, stack: input.stack, errorType: input.name };
  if (typeof input === "string") return { message: input };
  try {
    return { message: JSON.stringify(input).slice(0, 2000) };
  } catch {
    return { message: String(input) };
  }
}

/**
 * Capture an exception. Public manual capture → handled:true. Fire-and-forget;
 * never rejects.
 */
export function capture(error: unknown, ctx: CaptureContext = {}): void {
  captureWith(error, ctx, true);
}

// Internal capture with the handled flag controlled by the caller (global
// handlers pass false; the public capture() passes true).
function captureWith(error: unknown, ctx: CaptureContext, handled: boolean): void {
  if (!config) return;
  const { message, stack, errorType } = normalizeError(error);
  report(message, stack, ctx, handled, errorType);
}

/** Capture a plain message (no Error). handled:true. */
export function captureMessage(message: string, ctx: CaptureContext = {}): void {
  report(message, undefined, ctx, true);
}

function report(
  message: string,
  stack: string | undefined,
  ctx: CaptureContext,
  handled: boolean,
  errorType?: string
): void {
  if (!config || !message) return;
  void post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken ?? config.userToken,
    route: ctx.route ?? route(),
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: ctx.breadcrumbs?.slice(0, 50),
    occurredAt: new Date().toISOString(),
    env: envFor(handled, errorType),
  });
}

function route(): string | undefined {
  try {
    return location.pathname.slice(0, 500);
  } catch {
    return undefined;
  }
}

async function post(body: Record<string, unknown>): Promise<void> {
  if (!config) return;
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v;
    const res = await fetch(`${config.origin}/api/signals/ingest`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", "X-Signal-Key": config.key },
      body: JSON.stringify(clean),
    });
    if (!res.ok && res.status !== 202) {
      config.onError?.(new Error(`sprint-signals-web ingest ${res.status}`));
    }
  } catch (err) {
    config?.onError?.(err);
  }
}

/** Test/teardown helper — clears config + handler flag. */
export function _reset(): void {
  config = null;
  env = {};
  handlersInstalled = false;
}
