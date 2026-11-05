/**
 * Optional native deps resolved at runtime: react-native-view-shot
 * (screenshots), expo-audio or expo-av (voice notes), expo-video, react-native-svg
 * and the screen recorder. Hosts that don't want a capability skip installing
 * it, and the widget leaves that feature out rather than crashing.
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

// expo-image-picker selects an OS-recorded demo video from the library.
// Optional — absent means the "Attach video" control never appears.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _imagePicker: any = null;
try {
  _imagePicker = require("expo-image-picker");
} catch {
  _imagePicker = null;
}
export const ImagePicker = _imagePicker ?? null;

// expo-file-system streams the video PUT from disk (uploadAsync
// BINARY_CONTENT) — fetch+blob would buffer the whole clip in the JS heap and
// OOM the host on big files, so video attach REQUIRES this dep (E7).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fileSystem: any = null;
try {
  _fileSystem = require("expo-file-system/legacy");
} catch {
  try {
    _fileSystem = require("expo-file-system");
  } catch {
    _fileSystem = null;
  }
}
export const FileSystem =
  _fileSystem && typeof _fileSystem.uploadAsync === "function"
    ? _fileSystem
    : null;

// expo-audio records and plays voice notes on current Expo SDKs (expo-av is
// deprecated there). Preferred over expo-av when both are installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _expoAudioModern: any = null;
try {
  _expoAudioModern = require("expo-audio");
} catch {
  _expoAudioModern = null;
}
export const ExpoAudioModern =
  _expoAudioModern && typeof _expoAudioModern.useAudioRecorder === "function" ? _expoAudioModern : null;

// expo-video plays a recorded bug video back on the review screen, so the
// trim handles have a picture to follow. Absent: the trim track still works.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _expoVideo: any = null;
try {
  _expoVideo = require("expo-video");
} catch {
  _expoVideo = null;
}
export const ExpoVideo = _expoVideo && _expoVideo.VideoView ? _expoVideo : null;

// react-native-svg draws annotations (screenshot markup, drawing while
// recording). Absent: screenshots are sent without markup tools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _svg: any = null;
try {
  _svg = require("react-native-svg");
} catch {
  _svg = null;
}
export const Svg = _svg && _svg.Svg ? _svg : null;

// react-native-nitro-screen-recorder records the app's screen for "Record the
// screen": in-app (ReplayKit) on iOS, MediaProjection on Android. Absent: the
// control never appears and a video from the library is the fallback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _screenRecorder: any = null;
try {
  _screenRecorder = require("react-native-nitro-screen-recorder");
} catch {
  _screenRecorder = null;
}
export const ScreenRecorder = _screenRecorder ?? null;
