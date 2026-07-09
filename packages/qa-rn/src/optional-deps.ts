/**
 * Optional native deps resolved at runtime. react-native-view-shot is an
 * OPTIONAL peer — hosts that don't want screenshot capture skip installing it,
 * and the widget degrades to report-without-screenshot rather than crashing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _viewShot: any = null;
try {
  // captureRef is the imperative API used by the host's captureScreenshot fn.
  _viewShot = require("react-native-view-shot");
} catch {
  _viewShot = null;
}
export const captureRef = _viewShot?.captureRef ?? null;
