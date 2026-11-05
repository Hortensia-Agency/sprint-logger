import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ExpoAudioModern } from "../optional-deps";
import type { AudioRecorder, AudioPart } from "../audio";
import { useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";

export interface VoiceNote extends AudioPart {
  id: string;
  seconds: number;
}

/** Voice notes are transcribed, and the transcriber stops at two minutes. */
const MAX_SECONDS = 120;

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether this host can record a voice note at all. */
export function voiceAvailable(legacy: AudioRecorder | null | undefined): boolean {
  return !!ExpoAudioModern || !!legacy;
}

/**
 * Several voice notes per report, as on the web: record, play back, remove.
 * Records with expo-audio when the host has it, else the expo-av recorder.
 */
export function VoiceNotes({
  notes,
  onChange,
  legacy,
  onError,
}: {
  notes: VoiceNote[];
  onChange: (next: VoiceNote[]) => void;
  legacy?: AudioRecorder | null;
  onError: (message: string | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const add = (n: VoiceNote) => onChange([...notes, n]);
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{t("voiceNote")}</Text>
      {ExpoAudioModern ? (
        <ModernRecorder onDone={add} onError={onError} />
      ) : legacy ? (
        <LegacyRecorder recorder={legacy} onDone={add} onError={onError} />
      ) : null}
      <Text style={styles.hint}>{t("voiceHint")}</Text>
      {notes.map((n) => (
        <NoteRow key={n.id} note={n} onRemove={() => onChange(notes.filter((x) => x.id !== n.id))} />
      ))}
    </View>
  );
}

function RecordButton({
  recording,
  seconds,
  onPress,
}: {
  recording: boolean;
  seconds: number;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  return (
    <Pressable
      style={({ pressed }) => [styles.rec, recording && styles.recOn, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={recording ? t("stop", { time: fmtDuration(seconds) }) : t("recordVoiceNote")}
    >
      <View style={[styles.dot, recording && styles.dotOn]} />
      <Text style={[styles.recText, recording && styles.recTextOn]}>
        {recording ? t("stop", { time: fmtDuration(seconds) }) : t("recordVoiceNote")}
      </Text>
    </Pressable>
  );
}

function ModernRecorder({ onDone, onError }: { onDone: (n: VoiceNote) => void; onError: (m: string | null) => void }) {
  const t = useStrings();
  const A = ExpoAudioModern;
  const recorder = A.useAudioRecorder(A.RecordingPresets.HIGH_QUALITY);
  const state = A.useAudioRecorderState(recorder, 250);
  const [on, setOn] = useState(false);
  const seconds = (state?.durationMillis ?? 0) / 1000;

  const stop = async () => {
    setOn(false);
    try {
      await recorder.stop();
      await A.setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      const uri: string | null = recorder.uri;
      if (uri) onDone({ id: String(Date.now()), uri, name: "voice-note.m4a", type: "audio/mp4", seconds: Math.round(seconds) });
    } catch {
      onError(t("voiceSaveFailed"));
    }
  };

  useEffect(() => {
    if (on && seconds >= MAX_SECONDS) void stop();
  }, [on, seconds]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    onError(null);
    const perm = await A.requestRecordingPermissionsAsync();
    if (!perm?.granted) {
      onError(t("micOff"));
      return;
    }
    try {
      await A.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setOn(true);
    } catch {
      onError(t("micOff"));
    }
  };

  return <RecordButton recording={on} seconds={seconds} onPress={() => void (on ? stop() : start())} />;
}

function LegacyRecorder({
  recorder,
  onDone,
  onError,
}: {
  recorder: AudioRecorder;
  onDone: (n: VoiceNote) => void;
  onError: (m: string | null) => void;
}) {
  const t = useStrings();
  const [on, setOn] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clear = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const stop = async () => {
    clear();
    setOn(false);
    try {
      const part = await recorder.stop();
      if (part) onDone({ ...part, id: String(Date.now()), seconds });
    } catch {
      onError(t("voiceSaveFailed"));
    }
  };
  const start = async () => {
    onError(null);
    try {
      await recorder.start();
    } catch {
      onError(t("micOff"));
      return;
    }
    setSeconds(0);
    setOn(true);
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) void stop();
        return s + 1;
      });
    }, 1000);
  };
  return <RecordButton recording={on} seconds={seconds} onPress={() => void (on ? stop() : start())} />;
}

function NoteRow({ note, onRemove }: { note: VoiceNote; onRemove: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const player = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(
    () => () => {
      player.current?.remove?.();
    },
    []
  );
  const toggle = () => {
    if (!ExpoAudioModern) return;
    if (!player.current) {
      player.current = ExpoAudioModern.createAudioPlayer(note.uri);
      player.current.addListener?.("playbackStatusUpdate", (s: { playing?: boolean; didJustFinish?: boolean }) => {
        setPlaying(!!s.playing && !s.didJustFinish);
        if (s.didJustFinish) player.current?.seekTo?.(0);
      });
    }
    if (playing) player.current.pause();
    else player.current.play();
  };
  return (
    <View style={styles.note}>
      {ExpoAudioModern ? (
        <Pressable onPress={toggle} hitSlop={8} accessibilityRole="button" accessibilityLabel={playing ? t("pauseVoiceNote") : t("playVoiceNote")} style={styles.play}>
          <Text style={styles.playText}>{playing ? "❚❚" : "▶"}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.noteText}>
        {t("voiceNote")} · {fmtDuration(note.seconds)}
      </Text>
      <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("removeItem", { item: t("voiceNote") })}>
        <Text style={styles.remove}>{t("remove")}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(t: Theme) {
  return {
    wrap: { gap: 6, marginTop: 10 },
    label: { color: t.c["muted-foreground"], fontSize: 13, fontWeight: "500" as const },
    hint: { color: t.c["subtle-foreground"], fontSize: 12, lineHeight: 16 },
    rec: {
      minHeight: 44,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      borderWidth: 1,
      borderColor: t.c.border,
      borderRadius: t.radius.md,
      paddingHorizontal: 12,
    },
    recOn: { borderColor: t.c.destructive, backgroundColor: t.c["destructive-soft"] },
    dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: t.c.destructive },
    dotOn: { borderRadius: 2 },
    recText: { color: t.c.foreground, fontSize: 15, fontWeight: "500" as const },
    recTextOn: { color: t.c.destructive, fontVariant: ["tabular-nums" as const] },
    note: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 12,
      borderRadius: t.radius.md,
      backgroundColor: t.c["bg-elev-2"],
    },
    play: { width: 28, height: 28, borderRadius: 14, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: t.c.signal },
    playText: { color: t.c["signal-foreground"], fontSize: 11, fontWeight: "700" as const },
    noteText: { flex: 1, color: t.c.foreground, fontSize: 14, fontVariant: ["tabular-nums" as const] },
    remove: { color: t.c.destructive, fontSize: 14, fontWeight: "500" as const },
    pressed: { opacity: 0.85 },
  };
}
