/**
 * Sprint Signals SDK for Firebase Cloud Functions v2.
 *
 *   import { init, wrapEvent, wrapCallable } from "@sprint-logger/firebase";
 *   init({ key: SPRINT_SIGNALS_KEY.value(), release: "v1.2.3" });
 *
 *   export const userCreated = wrapEvent(
 *     "userCreated",
 *     onDocumentCreated("users/{id}", async (event) => { ... })
 *   );
 *
 * This package is a thin Functions-v2 layer over `@sprint-logger/node`: it
 * re-exports that SDK's entire surface (captureException, captureSignal,
 * startSpan, addBreadcrumb, trackNPlusOne, trackEvent, …) unchanged, and adds
 * the wrappers below. Anything the node SDK can do, this package can do.
 *
 * Why a wrapper at all, when the node SDK already installs process-level
 * handlers: in Functions v2 those handlers are the wrong tool. A throw out of a
 * Firestore trigger is caught by the Functions runtime (which retries it), so
 * `uncaughtException` never fires and the error is invisible to Signals. The
 * wrappers capture at the handler boundary instead — the only place the error
 * is actually observable — and re-throw so the runtime's own retry/reporting
 * semantics are completely unchanged.
 *
 * The serverless freeze problem (F-2): a container may be frozen the instant a
 * handler's promise settles, killing an in-flight ingest POST. Every wrapper
 * here AWAITS the capture before re-throwing or returning, so the event is on
 * the wire before the handler completes. This is why fire-and-forget capture
 * inside a Cloud Function drops events under low traffic — never `void` a
 * capture in this environment.
 */

import {
  captureException,
  captureSignal,
  addBreadcrumb,
  type Severity,
} from "@sprint-logger/node";

// Full parity with @sprint-logger/node — a host installs THIS package and gets
// the entire Signals surface from one import, no second dependency. Re-exported
// rather than re-implemented so the two can never drift.
export {
  init,
  captureException,
  captureMessage,
  captureRequestError,
  captureSignal,
  startSpan,
  trackNPlusOne,
  trackEvent,
  addBreadcrumb,
  _reset,
  _breadcrumbs,
} from "@sprint-logger/node";

export type {
  SignalsConfig,
  CaptureContext,
  CaptureSignalInput,
  SignalType,
  SignalEvidence,
  Severity,
  Breadcrumb,
  HttpContext,
} from "@sprint-logger/node";

/**
 * What kind of Functions v2 trigger a wrapped handler is. Rides along on every
 * captured event as `context.triggerType`, so the inbox can facet by it.
 */
export type TriggerType =
  | "callable"
  | "http"
  | "firestore"
  | "scheduled"
  | "storage"
  | "pubsub"
  | "task"
  | "unknown";

export interface WrapOptions<A extends unknown[] = unknown[]> {
  /**
   * Logical name for the function, used as the event `route` and as part of the
   * fingerprint seed. Defaults to the wrapped function's `.name` when it has
   * one — always pass it explicitly for inline arrow handlers, which don't.
   */
  name?: string;
  /** Trigger kind, for the inbox facet. Defaults to "unknown". */
  triggerType?: TriggerType;
  /** Severity for errors out of this handler. Default "high". */
  severity?: Severity;
  /**
   * Derive a pseudonymous user token from the handler's own arguments. NEVER
   * return an email/phone/IP — an opaque id only (D6). Firebase uids are
   * already opaque and are the natural choice.
   */
  userToken?: (...args: A) => string | undefined;
  /**
   * Emit a `slow_operation` signal when the handler exceeds this many ms.
   * Omit to disable timing for this handler.
   */
  slowAfterMs?: number;
}

/** Best-effort function name; inline arrows have `.name === ""`. */
function nameOf(fn: unknown, explicit: string | undefined): string {
  if (explicit) return explicit;
  const n = (fn as { name?: string } | null)?.name;
  return n && n.length > 0 ? n : "anonymous";
}

/**
 * Pull a pseudonymous id out of a Functions v2 argument WITHOUT ever touching a
 * field that could carry PII. Only two shapes are read:
 *   - CallableRequest.auth.uid   (callables)
 *   - CloudEvent.params.*        (Firestore path wildcards, e.g. users/{id})
 * Anything else yields undefined. Wrapped in try/catch because a malformed
 * event must never break capture.
 */
function inferUserToken(arg: unknown): string | undefined {
  try {
    if (!arg || typeof arg !== "object") return undefined;
    const a = arg as {
      auth?: { uid?: unknown };
      params?: Record<string, unknown>;
    };
    if (typeof a.auth?.uid === "string") return a.auth.uid;
    const params = a.params;
    if (params && typeof params === "object") {
      // A single wildcard is almost always the owning entity id.
      const vals = Object.values(params).filter(
        (v): v is string => typeof v === "string"
      );
      if (vals.length === 1) return vals[0];
    }
  } catch {
    /* never let context inference break capture */
  }
  return undefined;
}

/**
 * Core wrap. Captures any throw with handler context attached, AWAITS the
 * capture (see the freeze note in the file header), then re-throws the original
 * error untouched so Firebase's retry/reporting behaviour is unchanged.
 */
function wrap<A extends unknown[], R>(
  handler: (...args: A) => R | Promise<R>,
  opts: WrapOptions<A> = {}
): (...args: A) => Promise<R> {
  const route = nameOf(handler, opts.name);
  const triggerType = opts.triggerType ?? "unknown";
  const severity = opts.severity ?? "high";

  return async function wrapped(...args: A): Promise<R> {
    const started = Date.now();
    // A breadcrumb per invocation gives the trail a "which function am I in"
    // anchor — the closest server analogue of the web SDK's navigation crumb.
    addBreadcrumb({
      category: "navigation",
      message: `${triggerType}:${route}`,
      level: "info",
      timestamp: started,
    });

    try {
      const result = await handler(...args);

      if (opts.slowAfterMs !== undefined) {
        const elapsed = Date.now() - started;
        if (elapsed >= opts.slowAfterMs) {
          await captureSignal({
            type: `slow:${route}`,
            title: `${route} took ${elapsed}ms`,
            severity: "medium",
            route,
            context: {
              triggerType,
              valueMs: elapsed,
              threshold: opts.slowAfterMs,
            },
          });
        }
      }

      return result;
    } catch (err) {
      const userToken =
        (opts.userToken ? opts.userToken(...args) : undefined) ??
        inferUserToken(args[0]);

      // AWAITED, not fire-and-forget — the container can freeze the moment this
      // handler's promise settles, and an in-flight POST would be lost.
      // captureException never rejects, so this cannot mask the real error.
      //
      // handled:false — this error ESCAPED the handler; we only see it because
      // the wrapper is on the boundary, and it is re-thrown below. Marking it
      // handled would put genuine crashes in the same bucket as errors the code
      // deliberately caught.
      await captureException(err, {
        route,
        severity,
        userToken,
        handled: false,
      });

      // Re-throw the ORIGINAL error: Firebase decides retry/dead-lettering from
      // it, and the host's own error handling must see exactly what it would
      // have seen without this wrapper.
      throw err;
    }
  };
}

/**
 * Wrap a Firestore/Storage/PubSub CloudEvent handler.
 *
 *   export const userCreated = onDocumentCreated(
 *     "users/{id}",
 *     wrapEvent("userCreated", async (event) => { ... })
 *   );
 *
 * Note the shape: wrap the HANDLER, then pass it to onDocumentCreated — not the
 * other way round. Wrapping the built function would replace the trigger
 * definition object Firebase needs at deploy time with a plain async function,
 * and the function would silently fail to deploy.
 */
export function wrapEvent<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => R | Promise<R>,
  opts: Omit<WrapOptions<A>, "name" | "triggerType"> & {
    triggerType?: TriggerType;
  } = {}
): (...args: A) => Promise<R> {
  return wrap(handler, {
    ...opts,
    name,
    triggerType: opts.triggerType ?? "firestore",
  });
}

/**
 * Wrap an onCall handler. Captures throws — including HttpsError, which is a
 * deliberate signal too (a thrown `permission-denied` under load is worth
 * seeing) — and infers userToken from `request.auth.uid`.
 *
 *   export const acceptLesson = onCall(
 *     wrapCallable("acceptLesson", async (request) => { ... })
 *   );
 */
export function wrapCallable<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => R | Promise<R>,
  opts: Omit<WrapOptions<A>, "name" | "triggerType"> = {}
): (...args: A) => Promise<R> {
  return wrap(handler, { ...opts, name, triggerType: "callable" });
}

/**
 * Wrap an onRequest handler. Because an HTTP function usually reports failure
 * by WRITING a 5xx rather than throwing, this also captures a non-throwing 5xx
 * response as an `http_error` signal — the "silent failure" an exception-only
 * wrapper would miss entirely.
 */
export function wrapHttp<
  Req extends { method?: string; path?: string; url?: string },
  Res extends { statusCode?: number; on?: (ev: string, cb: () => void) => void },
>(
  name: string,
  handler: (req: Req, res: Res) => unknown | Promise<unknown>,
  opts: Omit<WrapOptions<[Req, Res]>, "name" | "triggerType"> = {}
): (req: Req, res: Res) => Promise<void> {
  const inner = wrap<[Req, Res], unknown>(handler, {
    ...opts,
    name,
    triggerType: "http",
  });

  return async function wrappedHttp(req: Req, res: Res): Promise<void> {
    await inner(req, res);

    // Non-throwing 5xx — the handler "succeeded" but the caller got an error.
    // Read after the handler resolves, since that's when the status is final.
    try {
      const status = res?.statusCode;
      if (typeof status === "number" && status >= 500) {
        await captureSignal({
          type: `http:${name}`,
          title: `${name} responded ${status}`,
          severity: "high",
          route: name,
          context: {
            triggerType: "http",
            status,
            method: req?.method ?? "UNKNOWN",
            // Path only — never the query string, which routinely carries
            // tokens and ids the server would have to scrub anyway.
            path: (req?.path ?? req?.url ?? "").split("?")[0] || "/",
          },
        });
      }
    } catch {
      /* status inspection is best-effort; never break the response */
    }
  };
}

/**
 * Wrap a scheduled (cron) handler. Scheduled jobs are the classic silent
 * failure — nobody is watching when a 5-minute job starts throwing — so this
 * defaults to `blocker` severity rather than `high`.
 */
export function wrapScheduled<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => R | Promise<R>,
  opts: Omit<WrapOptions<A>, "name" | "triggerType"> = {}
): (...args: A) => Promise<R> {
  return wrap(handler, {
    severity: "blocker",
    ...opts,
    name,
    triggerType: "scheduled",
  });
}
