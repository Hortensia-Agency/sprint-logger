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

export interface SignalsRnConfig {
  key: string;
  origin?: string;
  release?: string;
  /** Hook RN's global ErrorUtils handler. Default true. */
  installGlobalHandler?: boolean;
  onError?: (err: unknown) => void;
}

export interface CaptureContext {
  userToken?: string;
  route?: string;
  severity?: Severity;
  breadcrumbs?: unknown[];
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
  await post({
    message: message.slice(0, 2000),
    stack: stack ? stack.slice(0, 20000) : undefined,
    userToken: ctx.userToken ?? config.userToken,
    route: ctx.route,
    release: config.release,
    severity: ctx.severity,
    breadcrumbs: ctx.breadcrumbs?.slice(0, 50),
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
}
