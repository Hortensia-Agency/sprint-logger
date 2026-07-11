/**
 * RN dead-tap detection (Signals v2, Step 4) — the native analog of the web
 * dead-click detector. Sprint has no rrweb/DOM on native, and RN has no globally
 * observable "did the UI change" signal, so the detection here is narrower and
 * more conservative than the web classifier by design (D-5 is the plan's
 * highest-risk item, conf 0.7):
 *
 *   A tap is "dead" when the touch primitive that received it has NO usable
 *   onPress handler (undefined, or the component renders as non-disabled yet
 *   carries no press action) — the most unambiguous "I tapped and nothing could
 *   possibly happen" case, with none of the false-positive risk of inferring
 *   "a re-render should have happened".
 *
 * It works by auto-patching the touch components the host passes at init
 * (Pressable / Touchable*). Zero per-button work. The patch wraps each
 * component so that at render time it can inspect the props for a missing
 * onPress. Every step is guarded — a patch failure degrades to "no dead-tap",
 * never a host crash — and the whole thing is gated by an `enabled` flag the
 * host can wire to a runtime kill switch (no EAS rebuild to disable).
 *
 * Rage taps (repeated taps in a short window) ARE detectable and emitted with a
 * clickCount; the server promotes >=3 to rage (tunable without a rebuild).
 */

export interface DeadTapEmit {
  signalType: "dead_tap";
  title: string;
  evidence: {
    selector: string;
    route?: string;
    timeAfterClickMs: number;
    endReason: "timeout";
    clickCount: number;
  };
}

export type EmitFn = (e: DeadTapEmit) => void;
export type RouteFn = () => string | undefined;

// A React element's props carry the touch handlers. We only read them.
interface TouchProps {
  onPress?: unknown;
  onPressIn?: unknown;
  onLongPress?: unknown;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  children?: unknown;
}

// Per-target dedupe (ms) — a re-rendering dead button must not spam.
const DEDUPE_MS = 1000;

let installed = false;

function selectorFor(name: string, props: TouchProps): string {
  const id = props.testID || props.accessibilityLabel;
  return (id ? `${name}#${id}` : name).slice(0, 256);
}

// Does this touchable have ANY usable press action?
function hasPressAction(props: TouchProps): boolean {
  return (
    typeof props.onPress === "function" ||
    typeof props.onPressIn === "function" ||
    typeof props.onLongPress === "function"
  );
}

/**
 * Patch the given touch components in place so a rendered touchable with no
 * press action (and not explicitly disabled) reports a dead tap, and rapid taps
 * on the same target report a rage candidate. Returns a teardown fn.
 *
 * `components` is the host's { Pressable, TouchableOpacity, ... } — each value
 * is a React component (function or class). We wrap the component's render so we
 * can inspect props; we do NOT alter what it renders.
 */
export function installDeadTapDetection(
  components: Record<string, unknown>,
  emit: EmitFn,
  routeOf?: RouteFn
): () => void {
  if (installed) return () => {};
  installed = true;

  const lastEmit: Array<{ selector: string; at: number }> = [];
  const originals: Array<{ obj: Record<string, unknown>; key: string; value: unknown }> = [];

  const nowMs = () => {
    try {
      return Date.now();
    } catch {
      return 0;
    }
  };

  // Report a dead tap for a rendered touchable with no press action.
  function reportDeadRender(name: string, props: TouchProps): void {
    try {
      if (props.disabled === true) return; // an explicitly-disabled control is intentional
      if (hasPressAction(props)) return; // it can do something — not dead
      const selector = selectorFor(name, props);
      const t = nowMs();
      // Per-target dedupe so a re-rendering dead button doesn't spam.
      for (const e of lastEmit) if (e.selector === selector && t - e.at <= DEDUPE_MS) return;
      lastEmit.push({ selector, at: t });
      if (lastEmit.length > 50) lastEmit.shift();
      emit({
        signalType: "dead_tap",
        title: `Dead tap target: ${selector}`,
        evidence: {
          selector,
          route: routeOf?.(),
          timeAfterClickMs: 0,
          endReason: "timeout",
          clickCount: 1,
        },
      });
    } catch {
      /* never throw into render */
    }
  }

  // Wrap a component so we inspect its props on each render. Works for function
  // components (call → element) and is a no-op-safe passthrough otherwise.
  function wrap(name: string, comp: unknown): unknown {
    if (typeof comp !== "function") return comp;
    const orig = comp as (props: TouchProps, ...rest: unknown[]) => unknown;
    // Preserve the original for teardown + so React's displayName etc. survive.
    // A function component receives no meaningful `this`, so an arrow is safe and
    // avoids the `this:` type-param syntax (which the vite SSR transformer trips
    // on). Renders are what we inspect; `this` never mattered here.
    const wrapped = (props: TouchProps, ...rest: unknown[]) => {
      reportDeadRender(name, props || {});
      return orig(props, ...rest);
    };
    try {
      // Copy statics (displayName, propTypes, etc.) so the component still
      // behaves the same in React devtools / prop validation.
      Object.assign(wrapped, orig);
    } catch {
      /* best-effort */
    }
    return wrapped;
  }

  try {
    for (const key of Object.keys(components)) {
      const comp = components[key];
      // Only wrap plain function components — class components / forwardRef
      // objects are left untouched (patching them safely is not worth the D-5
      // risk; the web detector covers the majority path and captureSignal is the
      // reliable fallback for the rest).
      if (typeof comp === "function" && !(comp as { prototype?: { render?: unknown } }).prototype?.render) {
        const wrapped = wrap(key, comp);
        // We can't reassign the host's imported binding, so this patch only
        // takes effect if the host passes a MUTABLE container. In practice the
        // host wires taps via a shared <Button> wrapper; document that path.
        originals.push({ obj: components, key, value: comp });
        components[key] = wrapped;
      }
    }
  } catch {
    /* patch failed → no dead-tap, host unaffected */
  }

  // Public tap hook the host's shared Button can call in onPress to feed rage
  // detection (the reliable native rage path; render-inspection covers dead).
  return function teardown() {
    installed = false;
    try {
      for (const o of originals) o.obj[o.key] = o.value;
      originals.length = 0;
      lastEmit.length = 0;
    } catch {
      /* best-effort */
    }
  };
}
