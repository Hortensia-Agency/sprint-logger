/**
 * Sprint Signals React Native SDK (P2). Captures native JS exceptions and
 * ships them to a Sprint project's ingest endpoint.
 *
 *   import { init, captureException } from "@sprint-logger/rn";
 *   await init({ key: "sk_sig_…", release: "1.2.3" });
 *
 * Tenant+project resolve FROM THE KEY server-side — this SDK never sends a
 * tenant/project id. Context is pseudonymous only (D6): the persisted
 * userToken is a random opaque id (AsyncStorage), never PII. Capture is
 * fire-and-forget and never throws into the host app.
 *
 * Peers: `react-native` is a required peer (it IS the host). `expo-device` and
 * `@react-native-async-storage/async-storage` are DECLARED DEPENDENCIES (not
 * optional) — they must be statically imported so Metro resolves them into the
 * host graph (a runtime require() gets bundled into a dynamic-require shim Metro
 * can't resolve, crashing the host at launch). Usage stays guarded so a native
 * module that throws at call time degrades gracefully instead of crashing.
 */

import { installDeadTapDetection } from "./dead-tap";

// Static imports (NOT runtime require) so Metro resolves them in the host's
// bundle graph. esbuild rewrites a bundled `require("react-native")` into a
// dynamic-require Proxy shim that Metro cannot statically resolve, which crashes
// the host at launch (`Requiring unknown module "react-native"`). react-native
// is always present (it IS the host); expo-device and AsyncStorage are declared
// dependencies of this package, so all three resolve. Usage is still guarded so
// a native module that throws at call time degrades instead of crashing.
import { Platform } from "react-native";
import * as Device from "expo-device";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type Severity = "low" | "medium" | "high" | "blocker";

/**
 * A single breadcrumb — one thing that happened before an error. Mirrors the
 * server's BreadcrumbSchema (lib/signals/context.ts) by hand: this package has
 * no dependency on the Sprint monorepo, so the wire shape is duplicated, not
 * imported. Keep the three SDKs (web/rn/node) in lock-step.
 *
 * RN has no DOM, so the categories map to platform-appropriate sources:
 *   console  → console.error / console.warn (auto)
 *   click    → a UI press/tap (host-instrumented via addBreadcrumb / a helper)
 *   navigation → a React-Navigation screen change (host-instrumented)
 *   fetch    → the global fetch (auto)
 * The server enum is shared; "click" is the closest wire category for a press.
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
 * by hand. Captured from the fetch instrumentation on a failed request and
 * attached to the next captured error. NO headers/body/cookies — ever.
 */
export interface HttpContext {
  method: string;
  url: string;
  statusCode?: number;
  durationMs?: number;
}

export interface SignalsRnConfig {
  key: string;
  origin?: string;
  release?: string;
  /** Hook RN's global ErrorUtils handler. Default true. */
  installGlobalHandler?: boolean;
  /**
   * Auto-collect breadcrumbs (console + fetch) into a bounded trail attached to
   * each captured event. Press + navigation crumbs are added by the host via
   * addBreadcrumb() / the navigation helper (RN has no globally-patchable
   * gesture or router). Default true. Set false to disable all instrumentation.
   */
  captureBreadcrumbs?: boolean;
  /**
   * Signals v2 — enable dead-tap detection by auto-patching the RN touch
   * primitives passed here. This is the native analog of the web dead-click
   * detector. Zero per-button work: pass your RN module's touch components ONCE
   * and every <Pressable>/<TouchableOpacity>/… in the app is instrumented.
   *
   * Behind a flag because it monkey-patches RN internals (D-5, the plan's
   * highest-risk item) — a patch that fails degrades to "no dead-tap", never a
   * host crash. Omit to disable entirely. Usage: bring Pressable/TouchableOpacity
   * in from react-native and pass them as
   * `init({ key, deadTap: { components: { Pressable, TouchableOpacity } } })`.
   *
   * `enabled` lets the host wire it to a runtime-config kill switch (fetched
   * from its own backend) so the detector can be turned off WITHOUT an EAS
   * rebuild — the same posture as the QA widget's runtime kill switch.
   */
  deadTap?: {
    components: Record<string, unknown>;
    enabled?: boolean;
  };
  onError?: (err: unknown) => void;
}

export interface CaptureContext {
  userToken?: string;
  route?: string;
  severity?: Severity;
  /**
   * Explicit breadcrumb list. If omitted, the auto-collected trail is attached.
   * Bounded to the last 50. Keep values PII-free (the server re-scrubs, but
   * source-side hygiene is cheaper).
   */
  breadcrumbs?: Breadcrumb[];
  /**
   * Explicit failing-request context. If omitted, the last auto-captured
   * failing request (from the fetch instrumentation) is attached.
   */
  httpContext?: HttpContext;
}

const DEFAULT_ORIGIN = "https://sprint.hortensia-agency.com";
const TOKEN_KEY = "@sprint_signals_uid";

interface Resolved {
  key: string;
  origin: string;
  release?: string;
  onError?: (err: unknown) => void;
  userToken: string;
  env: Record<string, unknown>;
}

let config: Resolved | null = null;

/**
 * Pseudonymous RN env (enrichment plan, D-3). react-native's Platform is a
 * required peer (it IS the host); expo-device / NetInfo are optional — absent
 * → those fields stay undefined, never a crash. No identifying fields:
 * Device.modelName is a model class ("iPhone 15"), not a serial/UDID.
 */
function collectRnEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  try {
    if (Platform?.OS === "ios" || Platform?.OS === "android") env.platform = Platform.OS;
    if (Platform?.OS) env.osName = Platform.OS === "ios" ? "iOS" : "Android";
    if (Platform?.Version != null) env.osVersion = String(Platform.Version);
  } catch {
    /* Platform unexpectedly unusable — leave platform undefined */
  }
  try {
    if (Device?.modelName) env.deviceModel = Device.modelName;
  } catch {
    /* expo-device native module unavailable — skip deviceModel */
  }
  try {
    env.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    env.utcOffset = -new Date().getTimezoneOffset();
    env.locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    /* Intl unavailable on an old RN runtime — skip */
  }
  return env;
}

// AsyncStorage persists the pseudonymous token across launches. Usage is
// guarded: if the native module misbehaves the token degrades to per-session
// (in-memory) rather than crashing capture.
async function loadToken(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(TOKEN_KEY);
    if (existing) return existing;
    const fresh = "anon_" + randHex();
    await AsyncStorage.setItem(TOKEN_KEY, fresh);
    return fresh;
  } catch {
    return "anon_" + randHex();
  }
}

function randHex(): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return s;
}

// ---- breadcrumbs (auto-capture) ---------------------------------------
//
// A bounded ring buffer of what happened before an error. RN's auto-sources are
// console + the global fetch (both defensively wrapped — a throw in a wrapper
// must never break the host's own call). Press + navigation crumbs have no
// global hook in RN, so the host adds them via addBreadcrumb() (or the
// navigationBreadcrumb helper). Values are scrubbed at the source; the server
// re-scrubs regardless (the key is public), so this is best-effort hygiene.

const CRUMB_MAX = 50;
const CRUMB_MSG_MAX = 512;
const crumbs: Breadcrumb[] = [];
let breadcrumbsInstalled = false;

// The most-recent FAILING request (P2), attached to the next captured error if
// fresh (a stale failure probably didn't cause this error).
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

// Strip query/hash from a URL so tokens/emails in query strings never leave the
// device. Non-URL strings pass through the scrubber.
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
 * Record a manual breadcrumb (a press, a screen change, a domain event). The
 * host calls this because RN has no globally-patchable gesture/router. The
 * message is scrubbed and clamped; unknown categories are coerced to "click".
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

/**
 * Convenience for React-Navigation: pass this to the NavigationContainer
 * `onStateChange`/`onReady` or call it from your screen-focus effect with the
 * active route name. Records a "navigation" crumb.
 *
 *   <NavigationContainer onStateChange={(s) => navigationBreadcrumb(activeRoute(s))}>
 */
export function navigationBreadcrumb(routeName: string | undefined): void {
  if (!routeName) return;
  addBreadcrumb({ category: "navigation", level: "info", message: routeName });
  // Also track it as the current route so dead-tap / captureSignal evidence can
  // carry the screen (RN has no location.pathname).
  setRoute(routeName);
}

function installBreadcrumbs(): void {
  if (breadcrumbsInstalled) return;
  breadcrumbsInstalled = true;

  // console.error / console.warn
  try {
    const c = globalThis.console as unknown as Record<string, unknown>;
    for (const lvl of ["error", "warn"] as const) {
      const orig = c[lvl];
      if (typeof orig !== "function") continue;
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

  // global fetch (RN provides a WHATWG fetch)
  try {
    const g = globalThis as unknown as { fetch?: (...a: unknown[]) => Promise<{ ok: boolean; status: number }> };
    const origFetch = g.fetch;
    if (typeof origFetch === "function") {
      g.fetch = function (this: unknown, ...args: unknown[]) {
        const input = args[0] as unknown;
        const opts = args[1] as { method?: string } | undefined;
        const method = String(
          opts?.method ||
            (typeof input === "object" && input && "method" in input
              ? (input as { method?: string }).method
              : undefined) ||
            "GET"
        ).toUpperCase();
        const url =
          typeof input === "string"
            ? input
            : typeof input === "object" && input && "url" in input
              ? (input as { url: string }).url
              : String(input);
        const started = nowMs();
        return (origFetch as (...a: unknown[]) => Promise<{ ok: boolean; status: number }>)
          .apply(this, args)
          .then(
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
                    durationMs: Math.max(0, nowMs() - started),
                  });
              } catch {
                /* swallow */
              }
              return res;
            },
            (err: unknown) => {
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
                  durationMs: Math.max(0, nowMs() - started),
                });
              } catch {
                /* swallow */
              }
              throw err;
            }
          );
      } as typeof g.fetch;
    }
  } catch {
    /* fetch not patchable */
  }
}

export async function init(cfg: SignalsRnConfig): Promise<void> {
  if (!cfg.key || !cfg.key.startsWith("sk_sig_")) {
    cfg.onError?.(new Error("sprint-signals-rn: invalid or missing key"));
    return;
  }
  config = {
    key: cfg.key,
    origin: (cfg.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, ""),
    release: cfg.release,
    onError: cfg.onError,
    userToken: await loadToken(),
    env: collectRnEnv(),
  };
  if (cfg.captureBreadcrumbs ?? true) installBreadcrumbs();
  if (cfg.installGlobalHandler ?? true) installHandler();
  // Signals v2 dead-tap (D-5) — only when the host passed touch components AND
  // the runtime flag is on (default on when the block is present). Wrapped so a
  // patch failure degrades to no-op.
  if (cfg.deadTap && (cfg.deadTap.enabled ?? true) && cfg.deadTap.components) {
    try {
      teardownDeadTap = installDeadTapDetection(
        cfg.deadTap.components,
        (d) => void emitSignal({ signalType: d.signalType, title: d.title, evidence: d.evidence }),
        () => currentRoute
      );
    } catch (e) {
      cfg.onError?.(e);
    }
  }
}

// The host's current route, fed via navigationBreadcrumb / setRoute so dead-tap
// evidence can carry it (RN has no location.pathname).
let currentRoute: string | undefined;
let teardownDeadTap: (() => void) | null = null;

/** Tell the SDK the current screen (for dead-tap route evidence). */
export function setRoute(route: string | undefined): void {
  currentRoute = route ? String(route).slice(0, 512) : undefined;
}

function installHandler(): void {
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
    };
  };
  const eu = g.ErrorUtils;
  if (!eu?.setGlobalHandler) return;
  const prev = eu.getGlobalHandler?.();
  eu.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    // Global handler → uncaught (handled:false).
    void capture(error, { severity: isFatal ? "blocker" : undefined }, false);
    prev?.(error, isFatal); // preserve RedBox / host behavior
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
  if (!config) return;
  const { message, stack, errorType } = normalizeError(error);
  // Manual breadcrumbs win if present; otherwise attach the auto-collected
  // trail. Both bounded to 50.
  const trail = ctx.breadcrumbs ? ctx.breadcrumbs.slice(-50) : getBreadcrumbs();
  const httpContext = ctx.httpContext ?? freshHttp();
  await post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken ?? config.userToken,
    route: ctx.route,
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: trail.length ? trail : undefined,
    httpContext,
    occurredAt: new Date().toISOString(),
    env: { ...config.env, handled, ...(errorType ? { errorType } : {}) },
  });
}

export async function captureMessage(
  message: string,
  ctx: CaptureContext = {}
): Promise<void> {
  return captureException(new Error(message), ctx);
}

// ---- Signals v2 (non-error signals) -----------------------------------
//
// RN counterpart to captureSignal()/startSpan(). Mirrors the server's
// SignalType/SignalEvidence by hand. On native the v2 surface is Engine B
// (captureSignal for an invariant), perf (startSpan), and — via the Step-4
// auto-patch of Pressable/Touchable — dead_tap, which calls emitSignal()
// internally. Fire-and-forget; never rejects.

export type SignalType =
  | "dead_tap"
  | "http_error"
  | "broken_navigation"
  | "slow_operation"
  | "perf"
  | "custom"
  | "meta";

export interface SignalEvidence {
  selector?: string;
  route?: string;
  timeAfterClickMs?: number;
  endReason?: "timeout" | "mutation";
  clickCount?: number;
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
 * Assert an app-level problem the SDK can't infer. Emits a `custom` signal;
 * fingerprint seeded by `type`. Fire-and-forget.
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
    userToken: input.userToken ?? config.userToken,
    route: input.route,
  });
}

// Shared non-error emit path (captureSignal + the dead_tap auto-patch).
// Exported for the Step-4 tap instrumentation in this package; hosts use
// captureSignal(). The `dead_tap` mapping to the server's dead_click family is
// applied here so the wire matches the server contract.
export async function emitSignal(body: {
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
  // Native taps map onto the server's dead_click type (there is no separate
  // 'dead_tap' server enum member — the platform is carried in env).
  const wireType = body.signalType === "dead_tap" ? "dead_click" : body.signalType;
  await post({
    signalType: wireType,
    type: body.type,
    title: body.title,
    fingerprint: body.fingerprint,
    evidence: body.evidence,
    severity: body.severity,
    context: body.context,
    userToken: body.userToken ?? config.userToken,
    route: body.route,
    release: config.release,
    breadcrumbs: trail.length ? trail : undefined,
    occurredAt: new Date().toISOString(),
    env: { ...config.env, handled: true },
  });
}

/**
 * Time an operation; emit a `slow_operation` signal if it exceeds thresholdMs.
 * Under threshold → nothing emitted.
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

async function post(body: Record<string, unknown>): Promise<void> {
  if (!config) return;
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v;
    const res = await fetch(`${config.origin}/api/signals/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signal-Key": config.key },
      body: JSON.stringify(clean),
    });
    if (!res.ok && res.status !== 202) {
      config.onError?.(new Error(`sprint-signals-rn ingest ${res.status}`));
    }
  } catch (err) {
    config?.onError?.(err);
  }
}

export function _reset(): void {
  config = null;
  breadcrumbsInstalled = false;
  crumbs.length = 0;
  lastHttp = null;
  analyticsSessionToken = null;
  currentRoute = undefined;
  try {
    teardownDeadTap?.();
  } catch {
    /* best-effort */
  }
  teardownDeadTap = null;
}

/** Test-only: read the current breadcrumb buffer. */
export function _breadcrumbs(): Breadcrumb[] {
  return getBreadcrumbs();
}

// ---- analytics (P5) ---------------------------------------------------
//
// RN has no route URLs to auto-track, so screenviews are host-driven:
// trackScreenview(name) from your navigation listener. Pseudonymous; the client
// event_id makes each beacon idempotent server-side.

let analyticsSessionToken: string | null = null;

function analyticsSid(): string {
  if (!analyticsSessionToken) analyticsSessionToken = "sess_" + randHex();
  return analyticsSessionToken;
}

function uuid(): string {
  return randHex() + randHex();
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

/** Record a screen view (call from your React-Navigation state listener). */
export function trackScreenview(screenName: string): void {
  if (!config || !screenName) return;
  void sendAnalytics({
    eventId: uuid(),
    type: "screenview",
    route: String(screenName).slice(0, 500),
    sessionToken: analyticsSid(),
    platform: (config.env.platform as string) ?? "ios",
    occurredAt: new Date().toISOString(),
  });
}
