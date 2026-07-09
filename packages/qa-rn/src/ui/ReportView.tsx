import React, { useState } from "react";
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

const SEVERITIES: Severity[] = ["low", "medium", "high", "blocker"];

export function ReportView({
  client,
  onReported,
  captureScreenshot,
  getContext,
}: {
  client: SprintQaClient;
  onReported: (taskId: number) => void;
  captureScreenshot?: () => Promise<{ uri: string; name: string; type: string } | null>;
  getContext?: () => HostContext | undefined;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [withShot, setWithShot] = useState(!!captureScreenshot);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const res = await client.report(body);
      if (withShot && captureScreenshot) {
        const shot = await captureScreenshot();
        if (shot) {
          await client.uploadScreenshot(res.bugTaskId, shot).catch(() => {
            /* report already filed; screenshot is best-effort */
          });
        }
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
