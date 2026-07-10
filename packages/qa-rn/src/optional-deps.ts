/**
 * Optional native deps resolved at runtime. react-native-view-shot (screenshot)
 * and expo-av (voice notes) are OPTIONAL peers — hosts that don't want a given
 * capability skip installing them, and the widget degrades to
 * report-without-that-feature rather than crashing.
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

// expo-av's Audio.Recording drives voice-note capture. Optional — absent means
// the "Record voice note" control never appears.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _expoAv: any = null;
try {
  _expoAv = require("expo-av");
} catch {
  _expoAv = null;
}
export const ExpoAudio = _expoAv?.Audio ?? null;

// expo-web-browser drives the OAuth "Sign in with Sprint" flow. Optional —
// absent means the sign-in button hides and only manual PAT paste is offered.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _webBrowser: any = null;
try {
  _webBrowser = require("expo-web-browser");
} catch {
  _webBrowser = null;
}
export const WebBrowser = _webBrowser ?? null;

// expo-crypto generates the PKCE verifier/challenge. Optional peer of the OAuth
// flow — absent (like WebBrowser) means the sign-in button hides.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _crypto: any = null;
try {
  _crypto = require("expo-crypto");
} catch {
  _crypto = null;
}
export const ExpoCrypto = _crypto ?? null;
