/**
 * Absence-of-effect detector (Signals v2, Step 3) — the headline "clicked and
 * nothing happened" feature. Sprint has no rrweb, so this supplies its OWN three
 * observers (MutationObserver + capture-phase scroll + capture-phase click) and
 * feeds them into Sentry's ClickDetector classifier, copied VERBATIM. The only
 * new code is the observers; the algorithm + constants are settled, not invented
 * (see scratchpad-signals-v2-research.md).
 *
 * Constants (Sentry, verbatim):
 *   - slowClickTimeout       = 7000ms  — a click that produced no effect within
 *                                        this window is a TRUE dead click.
 *   - SLOW_CLICK_THRESHOLD   = 3000ms  — a DOM mutation within this window means
 *                                        "it did something" (not dead).
 *   - SLOW_CLICK_SCROLL_TIMEOUT = 300ms — a scroll within this window counts as
 *                                        an effect (tiny; programmatic scroll-to).
 *   - same-node dedupe       = 1000ms  — collapse repeated clicks on one node.
 *   - check tick             = 1000ms  — how often we evaluate pending clicks.
 *   - element gate           = A / BUTTON / INPUT (input only submit|button;
 *                                        <a> excluded if download or target≠_self).
 *
 * Rage promotion (clickCount ≥ 3) is NOT decided here — the raw clickCount is
 * emitted and the SERVER promotes, so the threshold is tunable without an SDK
 * rebuild.
 *
 * FP suppressors baked in (Phase 6): isTrusted only; affordance-shaped targets
 * only; a mutation OR scroll OR navigation cancels the "dead" verdict; per-node
 * dedupe. The detector never throws into the host (every path is guarded) and is
 * fully disabled by simply not installing it.
 */

// Verbatim Sentry constants.
const SLOW_CLICK_TIMEOUT = 7000;
const SLOW_CLICK_THRESHOLD = 3000;
const SLOW_CLICK_SCROLL_TIMEOUT = 300;
const SAME_NODE_DEDUPE_MS = 1000;
const CHECK_TICK_MS = 1000;
const MULTI_CLICK_WINDOW = SLOW_CLICK_TIMEOUT; // accumulate multi-clicks within the dead window

const CLICK_TAGS = new Set(["A", "BUTTON", "INPUT"]);

/** The evidence a detected dead/rage click carries to the emit callback. */
export interface DeadClickEmit {
  signalType: "dead_click" | "rage_click";
  evidence: {
    selector: string;
    route: string;
    timeAfterClickMs: number;
    endReason: "timeout" | "mutation";
    clickCount: number;
  };
  title: string;
}

export type EmitFn = (e: DeadClickEmit) => void;

interface Pending {
  node: Element;
  selector: string;
  route: string;
  startedAt: number;
  clickCount: number;
  mutatedAt: number | null;
  scrolledAt: number | null;
  navigatedAt: number | null;
}

// Best-effort selector for a node — tag#id.class, bounded. Mirrors the SDK's
// describeTarget so the fingerprint seed is consistent across surfaces.
function selectorFor(el: Element | null): string {
  try {
    if (!el || !el.tagName) return "";
    let s = el.tagName.toLowerCase();
    const id = (el as HTMLElement).id;
    if (id) s += `#${id}`;
    const cls = (el as HTMLElement).className;
    if (typeof cls === "string" && cls.trim()) s += `.${cls.trim().split(/\s+/)[0]}`;
    return s.slice(0, 256);
  } catch {
    return "";
  }
}

// The element gate — only affordance-shaped targets can be "dead" (FP suppressor
// #2). Walks up from the event target to the nearest gated ancestor (a click
// often lands on an inner <span> of a <button>).
function gatedTarget(start: Element | null): Element | null {
  let el: Element | null = start;
  let hops = 0;
  while (el && hops < 5) {
    const tag = el.tagName;
    if (CLICK_TAGS.has(tag)) {
      if (tag === "INPUT") {
        const type = (el as HTMLInputElement).type;
        if (type === "submit" || type === "button") return el;
      } else if (tag === "A") {
        const a = el as HTMLAnchorElement;
        // Exclude downloads and cross-target links — a new tab/download IS an
        // effect the observers can't see.
        if (!a.hasAttribute("download") && (a.target === "" || a.target === "_self")) return el;
      } else {
        return el; // BUTTON
      }
      return null; // a gated tag that failed its sub-check
    }
    el = el.parentElement;
    hops++;
  }
  return null;
}

function routeNow(): string {
  try {
    return location.pathname.slice(0, 512);
  } catch {
    return "";
  }
}

let installed = false;

/**
 * Install the detector. `emit` is the SDK's non-error emit callback. Returns a
 * teardown fn (used by tests / the SDK reset). No-op if already installed or if
 * there's no DOM.
 */
export function installDeadClickDetector(emit: EmitFn): () => void {
  if (installed) return () => {};
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  installed = true;

  const pending: Pending[] = [];
  let mutationSeenAt: number | null = null;
  let scrollSeenAt: number | null = null;
  let lastEmittedNodeAt = new WeakMap<Element, number>();

  const nowMs = () => {
    try {
      return performance.now();
    } catch {
      return Date.now();
    }
  };

  // ---- Observer 1: DOM mutations = "something happened" ----------------
  let mo: MutationObserver | null = null;
  try {
    mo = new MutationObserver(() => {
      mutationSeenAt = nowMs();
      // Attribute the mutation to every in-flight click (Sentry marks the whole
      // pending window as "had a mutation").
      for (const p of pending) if (p.mutatedAt == null) p.mutatedAt = mutationSeenAt;
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  } catch {
    /* MutationObserver unavailable — detector degrades to scroll/nav only */
  }

  // ---- Observer 2: scroll = "something happened" (capture, passive) ----
  const onScroll = () => {
    scrollSeenAt = nowMs();
    for (const p of pending) if (p.scrolledAt == null) p.scrolledAt = scrollSeenAt;
  };
  // ---- navigation = "something happened" -------------------------------
  const onNav = () => {
    const t = nowMs();
    for (const p of pending) if (p.navigatedAt == null) p.navigatedAt = t;
  };

  // ---- Observer 3: click (capture, passive) ----------------------------
  const onClick = (ev: Event) => {
    try {
      // FP suppressor #1: synthetic clicks (isTrusted=false) are ignored.
      if (!(ev as MouseEvent).isTrusted) return;
      const node = gatedTarget(ev.target as Element | null);
      if (!node) return; // FP suppressor #2: only affordance-shaped targets

      const t = nowMs();
      // Multi-click accumulation: a click on the SAME node within the dead
      // window increments the existing pending entry (rage candidate).
      const existing = pending.find(
        (p) => p.node === node && t - p.startedAt <= MULTI_CLICK_WINDOW
      );
      if (existing) {
        existing.clickCount++;
        return;
      }
      pending.push({
        node,
        selector: selectorFor(node),
        route: routeNow(),
        startedAt: t,
        clickCount: 1,
        mutatedAt: null,
        scrolledAt: null,
        navigatedAt: null,
      });
    } catch {
      /* never throw into the host click path */
    }
  };

  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("popstate", onNav, { capture: true, passive: true });
  // pushState/replaceState are patched by the breadcrumb collector; a popstate
  // + the mutation that a client-route change causes cover SPA nav in practice.
  window.addEventListener("click", onClick, { capture: true, passive: true });

  // ---- the check tick: evaluate pending clicks -------------------------
  const evaluate = () => {
    const t = nowMs();
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const age = t - p.startedAt;

      // Effect within grace windows → NOT dead. Drop it.
      const hadMutation = p.mutatedAt != null && p.mutatedAt - p.startedAt <= SLOW_CLICK_THRESHOLD;
      const hadScroll =
        p.scrolledAt != null && p.scrolledAt - p.startedAt <= SLOW_CLICK_SCROLL_TIMEOUT;
      const hadNav = p.navigatedAt != null;
      if (hadMutation || hadScroll || hadNav) {
        pending.splice(i, 1);
        continue;
      }

      // Not yet timed out → keep waiting.
      if (age < SLOW_CLICK_TIMEOUT) continue;

      // Timed out with no effect → DEAD click. Per-node dedupe (FP #5).
      const lastAt = lastEmittedNodeAt.get(p.node);
      if (lastAt == null || t - lastAt > SAME_NODE_DEDUPE_MS) {
        lastEmittedNodeAt.set(p.node, t);
        try {
          const isRage = p.clickCount >= 3; // hint only; server is authoritative
          emit({
            signalType: isRage ? "rage_click" : "dead_click",
            title: isRage
              ? `Rage click on ${p.selector || "element"}`
              : `Dead click on ${p.selector || "element"}`,
            evidence: {
              selector: p.selector,
              route: p.route,
              timeAfterClickMs: Math.round(age),
              endReason: "timeout",
              clickCount: p.clickCount,
            },
          });
        } catch {
          /* emit must not throw into the tick */
        }
      }
      pending.splice(i, 1);
    }
  };

  const timer = setInterval(() => {
    try {
      evaluate();
    } catch {
      /* keep the tick alive */
    }
  }, CHECK_TICK_MS);

  return function teardown() {
    installed = false;
    try {
      clearInterval(timer);
      mo?.disconnect();
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener("popstate", onNav, { capture: true } as EventListenerOptions);
      window.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
      pending.length = 0;
      mutationSeenAt = null;
      scrollSeenAt = null;
      lastEmittedNodeAt = new WeakMap();
    } catch {
      /* best-effort */
    }
  };
}
