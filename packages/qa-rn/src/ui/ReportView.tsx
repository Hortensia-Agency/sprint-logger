import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme, severityColor } from "./theme";
import { buildContext, type HostContext } from "../context";
import type { SprintQaClient } from "../client";
import type { Severity } from "../contract";
import type { AudioRecorder, AudioPart } from "../audio";

const SEVERITIES: Severity[] = ["low", "medium", "high", "blocker"];
const AUDIO_MAX_SECONDS = 120; // 2-minute soft cap

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

export function ReportView({
  client,
  onReported,
  captureScreenshot,
  audioRecorder,
  getContext,
}: {
  client: SprintQaClient;
  onReported: (taskId: number) => void;
  captureScreenshot?: () => Promise<{ uri: string; name: string; type: string } | null>;
  audioRecorder?: AudioRecorder | null;
  getContext?: () => HostContext | undefined;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [withShot, setWithShot] = useState(!!captureScreenshot);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [audio, setAudio] = useState<AudioPart | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCap = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRecTimers = () => {
    if (recTimer.current) clearInterval(recTimer.current);
    if (recCap.current) clearTimeout(recCap.current);
    recTimer.current = null;
    recCap.current = null;
  };

  const stopRecording = async (): Promise<AudioPart | null> => {
    if (!audioRecorder) return null;
    clearRecTimers();
    setRecording(false);
    try {
      const part = await audioRecorder.stop();
      if (part) setAudio(part);
      return part;
    } catch {
      setError("Couldn't save the voice note.");
      return null;
    }
  };

  const startRecording = async () => {
    if (!audioRecorder) return;
    setError(null);
    try {
      await audioRecorder.start();
    } catch {
      setError("Microphone access denied — allow it to record a voice note.");
      return;
    }
    setAudio(null);
    setRecSeconds(0);
    setRecording(true);
    recTimer.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    recCap.current = setTimeout(() => void stopRecording(), AUDIO_MAX_SECONDS * 1000);
  };

  useEffect(() => () => clearRecTimers(), []);

  async function submit() {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body = buildContext(
        {
          title: title.trim(),
          description: description.trim() || undefined,
          severity,
        },
        getContext?.()
      );
      // Flush an in-progress recording before filing so it isn't lost.
      const voiceNote = recording ? await stopRecording() : audio;
      const res = await client.report(body);
      if (withShot && captureScreenshot) {
        const shot = await captureScreenshot();
        if (shot) {
          await client.uploadScreenshot(res.bugTaskId, shot).catch(() => {
            /* report already filed; screenshot is best-effort */
          });
        }
      }
      if (voiceNote) {
        await client.uploadAudioNote(res.bugTaskId, voiceNote).catch(() => {
          /* report already filed; voice note is best-effort */
        });
      }
      onReported(res.bugTaskId);
    } catch {
      setError("Couldn't file the report. Check your token and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Title</Text>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder="What's broken?"
        placeholderTextColor={theme.muted}
        maxLength={500}
      />

      <Text style={styles.label}>Description</Text>
      <TextInput
        style={[styles.input, styles.multiline]}
        value={description}
        onChangeText={setDescription}
        placeholder="Steps to reproduce, expected vs actual…"
        placeholderTextColor={theme.muted}
        multiline
        maxLength={50000}
      />

      <Text style={styles.label}>Severity</Text>
      <View style={styles.row}>
        {SEVERITIES.map((s) => {
          const active = s === severity;
          return (
            <Pressable
              key={s}
              onPress={() => setSeverity(s)}
              style={[
                styles.sevChip,
                {
                  borderColor: severityColor[s],
                  backgroundColor: active ? severityColor[s] : "transparent",
                },
              ]}
            >
              <Text style={[styles.sevText, active && { color: "#fff" }]}>{s}</Text>
            </Pressable>
          );
        })}
      </View>

      {captureScreenshot && (
        <Pressable style={styles.checkboxRow} onPress={() => setWithShot((v) => !v)}>
          <View style={[styles.checkbox, withShot && styles.checkboxOn]} />
          <Text style={styles.checkboxLabel}>Attach a screenshot of this screen</Text>
        </Pressable>
      )}

      {audioRecorder && (
        <View>
          <Text style={styles.label}>Voice note</Text>
          <Pressable
            style={[styles.recBtn, recording && styles.recBtnOn]}
            onPress={() => (recording ? void stopRecording() : void startRecording())}
          >
            <Text style={[styles.recText, recording && styles.recTextOn]}>
              {recording
                ? `◼ Stop (${fmtDuration(recSeconds)})`
                : audio
                  ? "🎙 Re-record voice note"
                  : "🎙 Record voice note"}
            </Text>
          </Pressable>
          {audio && !recording && (
            <View style={styles.audioRow}>
              <Text style={styles.audioLabel}>🎙 Voice note attached</Text>
              <Pressable onPress={() => setAudio(null)}>
                <Text style={styles.audioRemove}>Remove</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.submit, submitting && { opacity: 0.6 }]}
        onPress={submit}
        disabled={submitting}
      >
        {submitting ? (
          <ActivityIndicator color={theme.primaryFg} />
        ) : (
          <Text style={styles.submitText}>File bug</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: { color: theme.muted, fontSize: 12, marginTop: 8 },
  input: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.borderSolid,
    borderRadius: theme.radiusSm,
    color: theme.fg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  sevChip: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  sevText: { color: theme.fg, fontSize: 13, textTransform: "capitalize" },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.muted,
  },
  checkboxOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  checkboxLabel: { color: theme.fg, fontSize: 13 },
  recBtn: {
    borderWidth: 1,
    borderColor: theme.borderSolid,
    borderRadius: theme.radiusSm,
    paddingVertical: 10,
    alignItems: "center",
    marginTop: 4,
  },
  recBtnOn: { borderColor: theme.destructive },
  recText: { color: theme.fg, fontSize: 14, fontWeight: "600" },
  recTextOn: { color: theme.destructive },
  audioRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
  },
  audioLabel: { color: theme.fg, fontSize: 13 },
  audioRemove: { color: theme.destructive, fontSize: 13 },
  error: { color: theme.destructive, fontSize: 13, marginTop: 4 },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 12,
  },
  submitText: { color: theme.primaryFg, fontWeight: "700", fontSize: 15 },
});
