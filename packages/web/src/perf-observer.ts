/**
 * Client perf observers (Signals v2, Step 4) — the "a function/interaction took
 * too long" signals the user asked for. Cheap, in-browser, no span pipeline:
 * a single PerformanceObserver watching long-tasks + the web-vitals entry types,
 * emitting a `perf` signal only when a metric exceeds its "good" threshold (so a
 * fast page never burns quota).
 *
 * Thresholds are Google's Core Web Vitals "good" boundaries (verbatim):
 *   LCP <= 2500ms, INP <= 200ms, CLS <= 0.1, and a long-task is any main-thread
 *   block > 50ms (the definition of a long task). Only breaches emit.
 *
 * Fingerprint seed is the metric label (evidence.op), so all LCP breaches on a
 * route collapse into one inbox group; the observed value + threshold ride in
 * evidence but never in the fingerprint.
 *
 * Every observer is wrapped defensively — an unsupported entry type or a throw
 * inside the callback must never break the host. Disable by not installing.
 */

export interface PerfEmit {
  op: string; // "LCP" | "INP" | "CLS" | "long-task"
  valueMs: number;
  threshold: number;
  title: string;
}

export type EmitFn = (e: PerfEmit) => void;

// Core Web Vitals "good" thresholds + the long-task definition.
const LCP_GOOD = 2500;
const INP_GOOD = 200;
const CLS_GOOD = 0.1;
const LONG_TASK_MS = 50;
// Don't spam: a long-task only emits if it's meaningfully long (a 51ms task is
// noise; a sustained block is the signal). Tunable ceiling above the definition.
const LONG_TASK_REPORT = 200;

let installed = false;

export function installPerfObserver(emit: EmitFn): () => void {
  if (installed) return () => {};
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined")
    return () => {};
  installed = true;

  const observers: PerformanceObserver[] = [];
  // De-dupe per metric within a short window so a burst doesn't flood.
  const lastEmit: Record<string, number> = {};
  const DEDUPE_MS = 5000;

  const nowMs = () => {
    try {
      return performance.now();
    } catch {
      return Date.now();
    }
  };

  function fire(op: string, valueMs: number, threshold: number): void {
    try {
      const t = nowMs();
      if (lastEmit[op] != null && t - lastEmit[op] <= DEDUPE_MS) return;
      lastEmit[op] = t;
      emit({
        op,
        valueMs: Math.round(valueMs),
        threshold,
        title: `${op} ${Math.round(valueMs)}ms exceeds ${threshold}`,
      });
    } catch {
      /* swallow */
    }
  }

  // A single observer per entry type — each in its own try so an unsupported
  // type (older browsers) doesn't prevent the others from installing.
  function observe(type: string, cb: (entries: PerformanceEntryList) => void): void {
    try {
      const po = new PerformanceObserver((list) => {
        try {
          cb(list.getEntries());
        } catch {
          /* swallow */
        }
      });
      // buffered:true replays entries that fired before we attached (LCP often
      // fires at load).
      po.observe({ type, buffered: true } as PerformanceObserverInit);
      observers.push(po);
    } catch {
      /* entry type unsupported */
    }
  }

  // Long tasks — main-thread blocks. Report only sustained ones.
  observe("longtask", (entries) => {
    for (const e of entries) {
      if (e.duration >= LONG_TASK_REPORT) fire("long-task", e.duration, LONG_TASK_MS);
    }
  });

  // LCP — keep the latest; report if the final value is poor.
  observe("largest-contentful-paint", (entries) => {
    const last = entries[entries.length - 1] as (PerformanceEntry & { renderTime?: number }) | undefined;
    if (last) {
      const v = last.startTime || last.renderTime || 0;
      if (v > LCP_GOOD) fire("LCP", v, LCP_GOOD);
    }
  });

  // INP proxy via the Event Timing API — report an interaction whose processing
  // duration is poor. (Full INP is a percentile over the session; this reports
  // the individual bad interaction, which is what a triager can act on.)
  observe("event", (entries) => {
    for (const e of entries as Array<PerformanceEntry & { duration: number }>) {
      if (e.duration > INP_GOOD) fire("INP", e.duration, INP_GOOD);
    }
  });

  // CLS — accumulate layout shift; report if it crosses "good". CLS is unitless;
  // we pass it scaled by 1000 into valueMs so the wire (which expects ms-ish
  // numbers) carries it, with the threshold scaled the same way.
  let cls = 0;
  observe("layout-shift", (entries) => {
    for (const e of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (!e.hadRecentInput) cls += e.value;
    }
    if (cls > CLS_GOOD) fire("CLS", cls * 1000, CLS_GOOD * 1000);
  });

  return function teardown() {
    installed = false;
    try {
      for (const po of observers) po.disconnect();
      observers.length = 0;
    } catch {
      /* best-effort */
    }
  };
}
