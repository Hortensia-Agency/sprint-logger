/**
 * Auto-captured repro context — the RN analog of the web SDK's
 * location.href + viewport + navigator.userAgent block.
 *
 * Two sources:
 *   1. SDK-only (this module): viewport (Dimensions) + a userAgent-style
 *      string (Platform.OS + version). No host cooperation needed.
 *   2. Host-supplied (HostContext): the current route/screen — which the SDK
 *      cannot read on its own (only the host's navigation lib knows it) — plus
 *      any free-form extra. The host passes a `getContext` thunk read at
 *      report time so the route is current, not stale-from-mount.
 *
 * The result maps onto the EXISTING server contract (POST /api/widget/report):
 * route → reproUrl, viewport/userAgent/extra → autoContext. No server change.
 */

import { Dimensions, Platform } from "react-native";
import type { ReportInput } from "./contract";

/** What the host can hand the widget at report time. All fields optional. */
export interface HostContext {
  /** Current screen/route, e.g. "Checkout/Payment". Becomes the task reproUrl. */
  route?: string;
  /** Arbitrary key/values folded into the auto-captured context comment. */
  extra?: Record<string, string | number | boolean>;
}

/** A userAgent-style identifier the server already knows how to store. */
export function nativeUserAgent(): string {
  const v = Platform.Version;
  return `ReactNative/${Platform.OS} ${v}`;
}

/** SDK-only viewport, mirroring window.innerWidth/Height. */
export function nativeViewport(): { w: number; h: number } {
  const { width, height } = Dimensions.get("window");
  return { w: Math.round(width), h: Math.round(height) };
}

/**
 * Merge SDK-captured context with host-supplied context into the existing
 * ReportInput shape. `extra` is serialized into consoleErrors (the only
 * free-text array the server stores) so nothing is silently dropped.
 */
export function buildContext(
  base: { title: string; description?: string; severity: ReportInput["severity"] },
  host?: HostContext
): ReportInput {
  const extra = host?.extra
    ? Object.entries(host.extra).map(([k, val]) => `${k}: ${val}`)
    : undefined;
  return {
    ...base,
    reproUrl: host?.route,
    autoContext: {
      viewport: nativeViewport(),
      userAgent: nativeUserAgent(),
      ...(extra && extra.length ? { consoleErrors: extra } : {}),
    },
  };
}
