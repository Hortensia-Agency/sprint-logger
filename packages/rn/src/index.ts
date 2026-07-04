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
 * AsyncStorage is an optional peer dependency — if absent, the token is
 * per-session (in-memory) so affected-user counts degrade gracefully rather
 * than crash a host that didn't install it.
 */

// Metro/RN provide `require` at runtime; declare it for the typecheck so we
// don't have to pull @types/node into a React Native package.
declare const require: (id: string) => { default: AsyncStorageLike };

interface AsyncStorageLike {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
}

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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RN = require("react-native") as unknown as {
      Platform?: {
        OS?: string;
        Version?: string | number;
        constants?: { Release?: string; reactNativeVersion?: unknown };
      };
    };
    const P = RN.Platform;
    if (P?.OS === "ios" || P?.OS === "android") env.platform = P.OS;
    if (P?.OS) env.osName = P.OS === "ios" ? "iOS" : "Android";
    if (P?.Version != null) env.osVersion = String(P.Version);
  } catch {
    /* react-native unexpectedly absent — leave platform undefined */
  }
  // expo-device (optional) for the device model + app version.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Device = require("expo-device") as {
      modelName?: string | null;
    };
    if (Device?.modelName) env.deviceModel = Device.modelName;
  } catch {
    /* no expo-device — skip deviceModel */
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

// AsyncStorage is optional — require lazily so a host without it still loads.
async function loadToken(): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AsyncStorage = require("@react-native-async-storage/async-storage").default;
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
  await post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken ?? config.userToken,
    route: ctx.route,
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: trail.length ? trail : undefined,
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
}

/** Test-only: read the current breadcrumb buffer. */
export function _breadcrumbs(): Breadcrumb[] {
  return getBreadcrumbs();
}
