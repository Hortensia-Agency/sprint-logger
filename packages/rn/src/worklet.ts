/**
 * Reanimated UI-runtime error capture (0.2.0).
 *
 * WHY THIS EXISTS: `ErrorUtils.setGlobalHandler` only covers the MAIN JS
 * runtime. React Native Reanimated runs worklets in a SEPARATE JS runtime on
 * the UI thread. An error thrown inside a worklet — a `useAnimatedScrollHandler`
 * that recurses through `scrollTo` until the native stack is exhausted, say —
 * never passes through the main runtime's handler, so the SDK saw nothing while
 * the app died. That is the exact shape of the Stelify HeroSection crash.
 *
 * Reanimated exposes its own UI-runtime error hook. The API has moved across
 * versions, so we probe for what's present rather than pinning one:
 *   - `setUpErrorHandler` / `reportFatalErrorOnJS` (3.6+ internals)
 *   - the `ReanimatedError` global the runtime installs
 * Everything is behind try/catch and a soft require: an app WITHOUT Reanimated
 * installed must not fail to start, and an unrecognised Reanimated version must
 * degrade to "no worklet capture", never a crash.
 *
 * Reanimated is NOT a dependency of this package — it is soft-resolved from the
 * host. That keeps `@sprint-logger/rn` zero-native and installable in apps that
 * do not use Reanimated at all.
 */

type Reporter = (error: unknown, source: string) => void;

/** Shape of the bits of Reanimated we probe for. All optional by design. */
interface ReanimatedLike {
  setUpErrorHandler?: (h: (e: unknown) => void) => void;
  runOnJS?: <T extends (...a: never[]) => unknown>(fn: T) => T;
}

/**
 * Soft-resolve the host's Reanimated. Returns null when it is not installed.
 *
 * A bare `require` is used deliberately and is NOT the dynamic-require hazard
 * documented in index.ts: that hazard applies to modules this package DEPENDS
 * on (Metro must see them in the graph). Reanimated is an optional host module
 * — if the host uses it, the host's own bundle already contains it, and this
 * lookup resolves against that. Wrapped so an unresolved module is a no-op.
 */
function resolveReanimated(): ReanimatedLike | null {
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req !== "function") return null;
    const mod = req("react-native-reanimated") as
      | ReanimatedLike
      | { default?: ReanimatedLike }
      | undefined;
    if (!mod) return null;
    return ((mod as { default?: ReanimatedLike }).default ?? mod) as ReanimatedLike;
  } catch {
    return null;
  }
}

/**
 * Install UI-runtime error capture. Returns a teardown, or null when nothing
 * could be hooked (no Reanimated, or a version exposing none of the hooks).
 *
 * `report` is invoked on the MAIN runtime — callers must not assume worklet
 * context. Reanimated marshals across the boundary itself for its own handler.
 */
export function installWorkletHandler(report: Reporter): (() => void) | null {
  const reanimated = resolveReanimated();
  if (!reanimated) return null;

  let installed = false;
  const teardowns: Array<() => void> = [];

  // Path 1 — Reanimated's own UI-runtime error handler.
  try {
    if (typeof reanimated.setUpErrorHandler === "function") {
      reanimated.setUpErrorHandler((e: unknown) => {
        try {
          report(e, "reanimated");
        } catch {
          /* reporting must never re-throw into the animation runtime */
        }
      });
      installed = true;
    }
  } catch {
    /* hook unavailable in this version */
  }

  // Path 2 — the global the UI runtime installs for fatal marshalling. Some
  // versions route worklet errors here instead of through setUpErrorHandler.
  try {
    const g = globalThis as unknown as {
      __reanimatedLoggerConfig?: { logFunction?: (...a: unknown[]) => void };
    };
    const cfg = g.__reanimatedLoggerConfig;
    if (cfg && typeof cfg.logFunction === "function") {
      const orig = cfg.logFunction;
      cfg.logFunction = function (this: unknown, ...args: unknown[]) {
        try {
          // Reanimated logs warnings here too; only escalate real errors.
          const first = args[0] as { level?: string; message?: string } | undefined;
          const level = typeof first === "object" && first ? first.level : undefined;
          if (level === "error" || level === "fatal") {
            report(first?.message ?? args[0], "reanimated-logger");
          }
        } catch {
          /* swallow */
        }
        return orig.apply(this, args);
      };
      teardowns.push(() => {
        try {
          cfg.logFunction = orig;
        } catch {
          /* swallow */
        }
      });
      installed = true;
    }
  } catch {
    /* logger config not present */
  }

  if (!installed) return null;
  return () => {
    for (const t of teardowns) {
      try {
        t();
      } catch {
        /* best-effort */
      }
    }
  };
}
