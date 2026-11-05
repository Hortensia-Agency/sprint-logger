/**
 * "Record the screen" through react-native-nitro-screen-recorder, an optional
 * peer. iOS records the app's own window (ReplayKit in-app recording, no
 * broadcast extension); Android records the screen through MediaProjection,
 * after the system asks the person for consent each time.
 */

import { Platform } from "react-native";
import { ScreenRecorder } from "./optional-deps";
import type { VideoPart } from "./video";

export function screenRecordAvailable(): boolean {
  if (!ScreenRecorder) return false;
  return Platform.OS === "ios"
    ? typeof ScreenRecorder.startInAppRecording === "function"
    : typeof ScreenRecorder.startGlobalRecording === "function";
}

/**
 * The permission step, kept apart from starting so the countdown runs after
 * the system dialog rather than under it. False when the person declines.
 */
export async function prepareScreenRecording(withMic: boolean): Promise<boolean> {
  if (!ScreenRecorder) return false;
  if (withMic && typeof ScreenRecorder.requestMicrophonePermission === "function") {
    const mic = await ScreenRecorder.requestMicrophonePermission().catch(() => null);
    if (!mic?.granted && mic?.status !== "granted") return false;
  }
  if (Platform.OS === "android") {
    return Boolean(await ScreenRecorder.requestScreenRecordingConsent().catch(() => false));
  }
  return true;
}

export async function startScreenRecording(withMic: boolean, onError: (message: string) => void): Promise<void> {
  if (Platform.OS === "ios") {
    await ScreenRecorder.startInAppRecording({
      options: { enableMic: withMic, enableCamera: false },
      onRecordingFinished: () => {},
    });
    return;
  }
  ScreenRecorder.startGlobalRecording({
    options: { enableMic: withMic, usePreparedConsent: true },
    onRecordingError: (e: { message?: string }) => onError(e?.message ?? "Recording stopped."),
  });
}

/** Stops and hands back the clip, or null when nothing was saved. */
export async function stopScreenRecording(): Promise<VideoPart | null> {
  const file =
    Platform.OS === "ios"
      ? await ScreenRecorder.stopInAppRecording()
      : await ScreenRecorder.stopGlobalRecording({ settledTimeMs: 800 });
  if (!file?.path) return null;
  const uri = String(file.path).startsWith("file://") ? file.path : `file://${file.path}`;
  return {
    uri,
    name: file.name || `bug-${Date.now()}.mp4`,
    type: "video/mp4",
    sizeBytes: Math.max(1, Math.round(file.size ?? 1)),
    durationSec: file.duration ? Math.max(1, Math.round(file.duration)) : null,
  };
}

/** Drops a recording in progress, or the Android consent taken for one. */
export async function cancelScreenRecording(): Promise<void> {
  if (!ScreenRecorder) return;
  try {
    if (Platform.OS === "ios") await ScreenRecorder.cancelInAppRecording();
    else if (ScreenRecorder.getScreenRecordingSessionState?.() === "recording") await ScreenRecorder.stopGlobalRecording();
    else ScreenRecorder.releaseScreenRecordingConsent?.();
  } catch {
    // Nothing to cancel.
  }
}
