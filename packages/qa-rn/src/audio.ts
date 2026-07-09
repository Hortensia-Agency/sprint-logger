/**
 * Voice-note recording via expo-av — the RN counterpart to the web SDK's
 * MediaRecorder capture. Tester-initiated only.
 *
 * expo-av is an OPTIONAL peer: when it isn't installed, makeAudioRecorder
 * returns null and the ReportView hides the "Record voice note" control, so
 * the report flow proceeds without audio rather than crashing.
 *
 * PRIVACY: a voice note is visible to everyone on the project's QA roster
 * (same tenant), the same as a screenshot. Recording is opt-in per report.
 *
 * The recorder yields a file part shaped like the screenshot part
 * ({ uri, name, type }) so it uploads through the same client path.
 */

import { ExpoAudio } from "./optional-deps";

export type AudioPart = { uri: string; name: string; type: string };

export interface AudioRecorder {
  /** Request mic permission + begin recording. Rejects if permission denied. */
  start(): Promise<void>;
  /** Stop + return the recorded file part, or null if nothing was captured. */
  stop(): Promise<AudioPart | null>;
}

/**
 * Build a recorder bound to expo-av. Returns null when expo-av isn't installed
 * (optional peer) so the caller can hide the control entirely.
 */
export function makeAudioRecorder(): AudioRecorder | null {
  if (!ExpoAudio) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let recording: any = null;

  return {
    async start() {
      const perm = await ExpoAudio.requestPermissionsAsync();
      if (!perm?.granted) throw new Error("microphone permission denied");
      await ExpoAudio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording: rec } = await ExpoAudio.Recording.createAsync(
        ExpoAudio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recording = rec;
    },

    async stop() {
      if (!recording) return null;
      const r = recording;
      recording = null;
      try {
        await r.stopAndUnloadAsync();
      } catch {
        /* already stopped */
      }
      // Release the recording audio mode so playback isn't forced to the
      // earpiece afterwards.
      try {
        await ExpoAudio.setAudioModeAsync({ allowsRecordingIOS: false });
      } catch {
        /* best effort */
      }
      const uri: string | null = r.getURI?.() ?? null;
      if (!uri) return null;
      // HIGH_QUALITY preset records .m4a (audio/mp4) on iOS and Android — both
      // on the server allow-list. Name by the uri extension when present.
      const ext = uri.split(".").pop()?.toLowerCase() || "m4a";
      const type =
        ext === "webm"
          ? "audio/webm"
          : ext === "ogg"
            ? "audio/ogg"
            : ext === "mp3"
              ? "audio/mpeg"
              : "audio/mp4";
      return { uri, name: `voice-note.${ext}`, type };
    },
  };
}
