/**
 * Screenshot capture (S4) via react-native-view-shot — the RN equivalent of
 * the web SDK's DOM-to-image capture. Tester-initiated only.
 *
 * PII WARNING: a captured screen is visible to everyone on the project's QA
 * roster (same tenant). The host should not surface this on screens showing
 * other users' personal data without a redaction step. Documented in README.
 *
 * The host owns the capture target — typically a ref to its root view — and
 * passes the resulting factory to <SprintQaWidget captureScreenshot={…} />.
 */

import { captureRef } from "./optional-deps";

export type ScreenshotPart = { uri: string; name: string; type: string };

/**
 * Build a capture function bound to a host view ref. Returns null when
 * react-native-view-shot isn't installed (optional peer) so the report flow
 * silently proceeds without a screenshot.
 */
export function makeScreenshotCapture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewRef: any
): () => Promise<ScreenshotPart | null> {
  return async () => {
    if (!captureRef || !viewRef?.current) return null;
    try {
      const uri: string = await captureRef(viewRef, {
        format: "png",
        quality: 0.9,
        result: "tmpfile",
      });
      return { uri, name: "screenshot.png", type: "image/png" };
    } catch {
      return null;
    }
  };
}
