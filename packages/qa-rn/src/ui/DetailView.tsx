import React, { useEffect, useState } from "react";
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

interface TaskDetail {
  task: { id: number; title: string; state: string; description: string | null };
  activeVerifiedCount: number;
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

const styles = StyleSheet.create({
  empty: { color: theme.muted, textAlign: "center", marginTop: 32 },
  back: { color: theme.primary, fontSize: 14, marginBottom: 12 },
  title: { color: theme.fg, fontSize: 18, fontWeight: "700" },
  state: { color: theme.muted, fontSize: 12, marginTop: 4, textTransform: "capitalize" },
  desc: { color: theme.fg, fontSize: 14, marginTop: 12, lineHeight: 20 },
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
