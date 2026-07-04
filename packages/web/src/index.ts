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

/**
 * A single breadcrumb — one thing that happened before an error. Mirrors the
 * server's BreadcrumbSchema (lib/signals/context.ts) by hand: this package has
 * no dependency on the Sprint monorepo, so the wire shape is duplicated, not
 * imported. Keep the two in lock-step.
 */
export interface Breadcrumb {
  category: "console" | "click" | "navigation" | "fetch" | "xhr";
  type?: string;
  level?: "debug" | "info" | "warning" | "error";
  message?: string;
  /** ms epoch, client clock — advisory ordering only. */
  timestamp?: number;
  data?: Record<string, string | number | boolean | null>;
}

/**
 * The failing HTTP request context (P2). Mirrors the server's HttpContextSchema
 * by hand (this package has no monorepo dependency). Captured from the fetch/XHR
 * instrumentation on a failed request (network error or status >= 400) and
 * attached to the NEXT captured error — most errors are request-driven, and this
 * is the request that most likely caused it. NO headers/body/cookies — ever.
 */
export interface HttpContext {
  method: string;
  url: string;
  statusCode?: number;
  durationMs?: number;
}

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
  /**
   * Auto-collect breadcrumbs (console/click/navigation/fetch/XHR) into a
   * bounded trail attached to each captured event. Default true. Set false to
   * fully disable the instrumentation (the kill switch if a host-app conflict
   * surfaces).
   */
  captureBreadcrumbs?: boolean;
  /**
   * Send traffic/usage analytics beacons (pageviews + session) to the separate
   * analytics endpoint. Default false — analytics is opt-in per host, gated by
   * the tenant's entitlement server-side. When true, an initial pageview fires
   * on init and each SPA route change (history API) sends another.
   */
  enableAnalytics?: boolean;
  /** Called (best-effort) if a capture POST fails. For host-side debugging. */
  onError?: (err: unknown) => void;
}

export interface CaptureContext {
  /** Pseudonymous opaque id — NEVER an email/name/IP (D6). */
  userToken?: string;
  route?: string;
  severity?: Severity;
  /**
   * Explicit breadcrumb list. If omitted, the auto-collected trail is attached
   * instead. Bounded to the last 50. Keep values PII-free (the server also
   * scrubs, but source-side hygiene is cheaper).
   */
  breadcrumbs?: Breadcrumb[];
  /**
   * Explicit failing-request context. If omitted, the last auto-captured
   * failing request (from the fetch/XHR instrumentation) is attached.
   */
  httpContext?: HttpContext;
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
  if (cfg.captureBreadcrumbs ?? true) installBreadcrumbs();
  if (cfg.installGlobalHandlers ?? true) installHandlers();
  if (cfg.enableAnalytics) installAnalytics();
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

// ---- breadcrumbs (auto-capture) ---------------------------------------
//
// A bounded ring buffer of what happened before an error: console lines,
// clicks, navigations, network calls. Every source is wrapped DEFENSIVELY — a
// throw inside a wrapper must never break the host app's own call, so each
// wrapper try/catches its own bookkeeping and always delegates to the original.
// Values are scrubbed at the source (query strings stripped, email/IP redacted);
// the server re-scrubs regardless (the key is public), so this is best-effort
// hygiene, not the security boundary.

const CRUMB_MAX = 50;
const CRUMB_MSG_MAX = 512;
const crumbs: Breadcrumb[] = [];
let breadcrumbsInstalled = false;

// The most-recent FAILING request (P2). Attached to the next captured error if
// it's fresh — a stale failure from minutes ago probably didn't cause this
// error, so it's only attached within HTTP_FRESH_MS.
const HTTP_FRESH_MS = 30_000;
let lastHttp: { ctx: HttpContext; at: number } | null = null;

function recordFailingHttp(ctx: HttpContext): void {
  try {
    lastHttp = { ctx, at: now() };
  } catch {
    /* swallow */
  }
}

function freshHttp(): HttpContext | undefined {
  try {
    if (lastHttp && now() - lastHttp.at <= HTTP_FRESH_MS) return lastHttp.ctx;
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
  // Copy so a later push can't mutate an in-flight payload.
  return crumbs.slice(-CRUMB_MAX);
}

const EMAIL_RE_G = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const IPV4_RE_G = /\b\d{1,3}(\.\d{1,3}){3}\b/g;

function scrubCrumb(v: string): string {
  let s = v.length > CRUMB_MSG_MAX ? v.slice(0, CRUMB_MSG_MAX) : v;
  s = s.replace(EMAIL_RE_G, "[email]").replace(IPV4_RE_G, "[ip]");
  return s;
}

// Strip query/hash from a URL so tokens/emails in query strings never leave the
// browser. Non-URL strings pass through.
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

function now(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

// Best-effort one-line label for a clicked element: tag + id + first class.
function describeTarget(t: EventTarget | null): string | undefined {
  try {
    const el = t as Element | null;
    if (!el || !el.tagName) return undefined;
    let s = el.tagName.toLowerCase();
    const id = (el as HTMLElement).id;
    if (id) s += `#${id}`;
    const cls = (el as HTMLElement).className;
    if (typeof cls === "string" && cls.trim())
      s += `.${cls.trim().split(/\s+/)[0]}`;
    return s.slice(0, 128);
  } catch {
    return undefined;
  }
}

function installBreadcrumbs(): void {
  if (breadcrumbsInstalled) return;
  if (typeof window === "undefined") return;
  breadcrumbsInstalled = true;

  // console.error / console.warn
  try {
    for (const lvl of ["error", "warn"] as const) {
      const orig = console[lvl];
      if (typeof orig !== "function") continue;
      console[lvl] = function (...args: unknown[]) {
        try {
          pushCrumb({
            category: "console",
            type: lvl,
            level: lvl === "warn" ? "warning" : "error",
            message: scrubCrumb(args.map(stringifyArg).join(" ")),
            timestamp: now(),
          });
        } catch {
          /* swallow */
        }
        return orig.apply(this, args as []);
      };
    }
  } catch {
    /* console not patchable */
  }

  // click (capture phase, passive — never interferes with the host)
  try {
    window.addEventListener(
      "click",
      (e) => {
        try {
          const label = describeTarget((e as MouseEvent).target);
          pushCrumb({
            category: "click",
            level: "info",
            message: label,
            timestamp: now(),
          });
        } catch {
          /* swallow */
        }
      },
      { capture: true, passive: true }
    );
  } catch {
    /* addEventListener unavailable */
  }

  // navigation: history.pushState / replaceState + popstate
  try {
    const h = window.history;
    for (const m of ["pushState", "replaceState"] as const) {
      const orig = h[m];
      if (typeof orig !== "function") continue;
      h[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
        try {
          const url = args[2];
          pushCrumb({
            category: "navigation",
            type: m,
            level: "info",
            message: url != null ? stripUrl(String(url)) : undefined,
            timestamp: now(),
          });
        } catch {
          /* swallow */
        }
        return orig.apply(this, args);
      };
    }
    window.addEventListener("popstate", () => {
      try {
        pushCrumb({
          category: "navigation",
          type: "popstate",
          level: "info",
          message: stripUrl(location.pathname + location.search),
          timestamp: now(),
        });
      } catch {
        /* swallow */
      }
    });
  } catch {
    /* history not patchable */
  }

  // fetch
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (
        this: typeof window,
        ...args: Parameters<typeof fetch>
      ) {
        const [input, opts] = args;
        const method =
          (opts?.method ||
            (typeof input === "object" && input && "method" in input
              ? (input as Request).method
              : undefined) ||
            "GET").toUpperCase();
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        const started = now();
        return origFetch.apply(this, args).then(
          (res) => {
            try {
              pushCrumb({
                category: "fetch",
                type: method,
                level: res.ok ? "info" : "error",
                message: stripUrl(String(url)),
                timestamp: started,
                data: { status: res.status },
              });
              if (!res.ok)
                recordFailingHttp({
                  method,
                  url: stripUrl(String(url)),
                  statusCode: res.status,
                  durationMs: Math.max(0, now() - started),
                });
            } catch {
              /* swallow */
            }
            return res;
          },
          (err) => {
            try {
              pushCrumb({
                category: "fetch",
                type: method,
                level: "error",
                message: stripUrl(String(url)),
                timestamp: started,
                data: { error: 1 },
              });
              recordFailingHttp({
                method,
                url: stripUrl(String(url)),
                durationMs: Math.max(0, now() - started),
              });
            } catch {
              /* swallow */
            }
            throw err;
          }
        );
      };
    }
  } catch {
    /* fetch not patchable */
  }

  // XMLHttpRequest
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (
        this: XMLHttpRequest & { __sig?: { method: string; url: string } },
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ) {
        try {
          this.__sig = { method: String(method).toUpperCase(), url: String(url) };
        } catch {
          /* swallow */
        }
        // @ts-expect-error variadic passthrough to the native open
        return origOpen.apply(this, [method, url, ...rest]);
      };
      XHR.prototype.send = function (
        this: XMLHttpRequest & { __sig?: { method: string; url: string } },
        ...args: unknown[]
      ) {
        try {
          const meta = this.__sig;
          const started = now();
          this.addEventListener("loadend", () => {
            try {
              const failed = this.status >= 400 || this.status === 0;
              pushCrumb({
                category: "xhr",
                type: meta?.method,
                level: failed ? "error" : "info",
                message: meta ? stripUrl(meta.url) : undefined,
                timestamp: started,
                data: { status: this.status },
              });
              if (failed && meta)
                recordFailingHttp({
                  method: meta.method,
                  url: stripUrl(meta.url),
                  statusCode: this.status || undefined,
                  durationMs: Math.max(0, now() - started),
                });
            } catch {
              /* swallow */
            }
          });
        } catch {
          /* swallow */
        }
        // @ts-expect-error variadic passthrough to the native send
        return origSend.apply(this, args);
      };
    }
  } catch {
    /* XHR not patchable */
  }
}

// Compact a console arg to a short string without throwing on circular refs.
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
  // Manual breadcrumbs (passed to capture()) win if present; otherwise attach
  // the auto-collected trail. Both bounded to 50.
  const crumbs = ctx.breadcrumbs
    ? (ctx.breadcrumbs as Breadcrumb[]).slice(-50)
    : getBreadcrumbs();
  // Explicit httpContext wins; otherwise attach the last fresh failing request.
  const httpContext = ctx.httpContext ?? freshHttp();
  void post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken ?? config.userToken,
    route: ctx.route ?? route(),
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: crumbs.length ? crumbs : undefined,
    httpContext,
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

// ---- analytics (P5) ---------------------------------------------------
//
// A lightweight traffic/usage beacon on a SEPARATE endpoint from error capture.
// One session per browser session (sessionStorage), pageviews on init + each SPA
// route change. Fire-and-forget via sendBeacon with a fetch keepalive fallback.
// Every field is pseudonymous; the client event_id makes the beacon idempotent
// server-side (ON CONFLICT). PII never leaves here — the route is query-stripped.

const SESSION_KEY = "_sprint_analytics_sid";
let analyticsInstalled = false;
let lastAnalyticsPath: string | null = null;

function sessionToken(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh = "sess_" + randHex();
    sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return "sess_" + randHex();
  }
}

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return (crypto as unknown as { randomUUID(): string }).randomUUID();
    }
  } catch {
    /* fall through */
  }
  return randHex() + randHex();
}

function analyticsPath(): string | undefined {
  try {
    return location.pathname.slice(0, 500);
  } catch {
    return undefined;
  }
}

function sendAnalytics(body: Record<string, unknown>): void {
  if (!config) return;
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v;
    const url = `${config.origin}/api/analytics/ingest`;
    const payload = JSON.stringify(clean);
    // sendBeacon can't set X-Signal-Key, so the beacon path uses fetch keepalive
    // (which can). sendBeacon is the fallback when fetch keepalive is absent.
    if (typeof fetch === "function") {
      void fetch(url, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", "X-Signal-Key": config.key },
        body: payload,
      }).catch(() => {});
      return;
    }
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    }
  } catch {
    /* analytics is best-effort */
  }
}

/** Send one pageview beacon (deduped against the last path). */
export function trackPageview(path?: string): void {
  if (!config) return;
  const p = path ?? analyticsPath();
  if (!p || p === lastAnalyticsPath) return;
  lastAnalyticsPath = p;
  sendAnalytics({
    eventId: uuid(),
    type: "pageview",
    route: p,
    sessionToken: sessionToken(),
    platform: "web",
    occurredAt: new Date().toISOString(),
  });
}

function installAnalytics(): void {
  if (analyticsInstalled) return;
  if (typeof window === "undefined") return;
  analyticsInstalled = true;

  // One session-start beacon per browser session.
  try {
    const isNew = !sessionStorage.getItem(SESSION_KEY);
    if (isNew) {
      sendAnalytics({
        eventId: uuid(),
        type: "session",
        sessionToken: sessionToken(),
        platform: "web",
        occurredAt: new Date().toISOString(),
      });
    }
  } catch {
    /* sessionStorage unavailable — skip the session beacon, still track views */
  }

  // Initial + SPA route-change pageviews. The breadcrumb collector already
  // patches history; here we listen for our own signal by re-wrapping softly.
  trackPageview();
  try {
    const h = window.history;
    for (const m of ["pushState", "replaceState"] as const) {
      const orig = h[m];
      if (typeof orig !== "function") continue;
      h[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const r = orig.apply(this, args);
        try {
          trackPageview();
        } catch {
          /* swallow */
        }
        return r;
      };
    }
    window.addEventListener("popstate", () => {
      try {
        trackPageview();
      } catch {
        /* swallow */
      }
    });
  } catch {
    /* history not patchable — only the initial pageview fires */
  }
}

/** Test/teardown helper — clears config, handler flag, and breadcrumb buffer. */
export function _reset(): void {
  config = null;
  env = {};
  handlersInstalled = false;
  breadcrumbsInstalled = false;
  crumbs.length = 0;
  lastHttp = null;
  analyticsInstalled = false;
  lastAnalyticsPath = null;
}

/** Test-only: read the current breadcrumb buffer. */
export function _breadcrumbs(): Breadcrumb[] {
  return getBreadcrumbs();
}
