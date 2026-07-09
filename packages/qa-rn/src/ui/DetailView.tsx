import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "./theme";
import type { SprintQaClient } from "../client";
import { ExpoAudio } from "../optional-deps";

interface AudioNote {
  id: number;
  filename: string;
  mimeType: string;
  url: string;
}

interface TaskDetail {
  task: { id: number; title: string; state: string; description: string | null };
  activeVerifiedCount: number;
  audioNotes?: AudioNote[];
}

export function DetailView({
  client,
  taskId,
  onBack,
}: {
  client: SprintQaClient;
  taskId: number;
  onBack: () => void;
}) {
  const [data, setData] = useState<TaskDetail | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");

  function load() {
    setData(null);
    client
      .taskDetail(taskId)
      .then((d) => setData(d as TaskDetail))
      .catch(() => setError(true));
  }
  useEffect(load, [taskId]);

  async function take() {
    setBusy(true);
    try {
      await client.take(taskId);
      load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function verify(verdict: "verified" | "bug_found") {
    setBusy(true);
    try {
      await client.verify(taskId, { verdict, notes: notes.trim() || undefined });
      load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Text style={styles.empty}>Couldn&apos;t load this task.</Text>;
  if (!data) return <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <Pressable onPress={onBack}>
        <Text style={styles.back}>← Queue</Text>
      </Pressable>
      <Text style={styles.title}>{data.task.title}</Text>
      <Text style={styles.state}>
        {data.task.state.replace(/_/g, " ")} · {data.activeVerifiedCount} verified
      </Text>
      {data.task.description ? (
        <Text style={styles.desc}>{data.task.description}</Text>
      ) : null}

      {data.audioNotes && data.audioNotes.length > 0 && (
        <View style={styles.audioWrap}>
          <Text style={styles.audioHeading}>Voice notes</Text>
          {data.audioNotes.map((a) => (
            <AudioNotePlayer key={a.id} url={a.url} />
          ))}
        </View>
      )}

      <TextInput
        style={styles.input}
        value={notes}
        onChangeText={setNotes}
        placeholder="Verdict notes (optional)"
        placeholderTextColor={theme.muted}
        multiline
      />

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={take} disabled={busy}>
          <Text style={styles.btnGhostText}>Take</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.success }]}
          onPress={() => verify("verified")}
          disabled={busy}
        >
          <Text style={styles.btnText}>Verify</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { backgroundColor: theme.destructive }]}
          onPress={() => verify("bug_found")}
          disabled={busy}
        >
          <Text style={styles.btnText}>Bug found</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * Tap-to-play voice-note player backed by expo-av's Audio.Sound. When expo-av
 * isn't installed the row renders disabled — playback needs the same peer the
 * recorder uses.
 */
function AudioNotePlayer({ url }: { url: string }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const soundRef = useRef<any>(null);

  useEffect(
    () => () => {
      void soundRef.current?.unloadAsync?.();
    },
    []
  );

  async function toggle() {
    if (!ExpoAudio) return;
    try {
      if (soundRef.current) {
        if (playing) {
          await soundRef.current.pauseAsync();
          setPlaying(false);
        } else {
          await soundRef.current.playAsync();
          setPlaying(true);
        }
        return;
      }
      setLoading(true);
      await ExpoAudio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await ExpoAudio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true }
      );
      soundRef.current = sound;
      setPlaying(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sound.setOnPlaybackStatusUpdate((s: any) => {
        if (s?.didJustFinish) setPlaying(false);
      });
    } catch {
      /* playback best-effort */
    } finally {
      setLoading(false);
    }
  }

  const disabled = !ExpoAudio;
  return (
    <Pressable
      style={[styles.audioBtn, disabled && { opacity: 0.5 }]}
      onPress={toggle}
      disabled={disabled}
    >
      {loading ? (
        <ActivityIndicator color={theme.primary} />
      ) : (
        <Text style={styles.audioBtnText}>
          {disabled ? "🎙 Voice note (install expo-av to play)" : playing ? "⏸ Pause voice note" : "▶ Play voice note"}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { color: theme.muted, textAlign: "center", marginTop: 32 },
  back: { color: theme.primary, fontSize: 14, marginBottom: 12 },
  title: { color: theme.fg, fontSize: 18, fontWeight: "700" },
  state: { color: theme.muted, fontSize: 12, marginTop: 4, textTransform: "capitalize" },
  desc: { color: theme.fg, fontSize: 14, marginTop: 12, lineHeight: 20 },
  audioWrap: { marginTop: 16, gap: 6 },
  audioHeading: { color: theme.muted, fontSize: 12 },
  audioBtn: {
    borderWidth: 1,
    borderColor: theme.borderSolid,
    borderRadius: theme.radiusSm,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  audioBtnText: { color: theme.fg, fontSize: 14, fontWeight: "600" },
  input: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.borderSolid,
    borderRadius: theme.radiusSm,
    color: theme.fg,
    padding: 10,
    marginTop: 16,
    minHeight: 60,
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", gap: 8, marginTop: 16 },
  btn: {
    flex: 1,
    borderRadius: theme.radiusSm,
    paddingVertical: 10,
    alignItems: "center",
  },
  btnGhost: { borderWidth: 1, borderColor: theme.borderSolid },
  btnGhostText: { color: theme.fg, fontWeight: "600" },
  btnText: { color: "#fff", fontWeight: "700" },
});
