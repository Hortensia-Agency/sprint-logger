import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { theme, severityColor } from "./theme";
import type { SprintQaClient } from "../client";
import type { QueueTask } from "../contract";

export function QueueView({
  client,
  onOpenTask,
}: {
  client: SprintQaClient;
  onOpenTask: (taskId: number) => void;
}) {
  const [tasks, setTasks] = useState<QueueTask[] | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    client
      .queue()
      .then((r) => {
        if (!alive) return;
        setTasks(r.tasks);
        setBlocked(r.blocked);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [client]);

  if (error) {
    return <Text style={styles.empty}>Couldn&apos;t load the queue.</Text>;
  }
  if (tasks === null) {
    return <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />;
  }
  if (blocked || tasks.length === 0) {
    return (
      <Text style={styles.empty}>
        {blocked ? "You don't have access to this project's queue." : "No tasks in the QA queue."}
      </Text>
    );
  }

  return (
    <FlatList
      data={tasks}
      keyExtractor={(t: QueueTask) => String(t.id)}
      contentContainerStyle={{ paddingBottom: 24 }}
      renderItem={({ item }: { item: QueueTask }) => (
        <Pressable style={styles.card} onPress={() => onOpenTask(item.id)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.state}>{item.state.replace(/_/g, " ")}</Text>
          </View>
          {item.severity && (
            <View
              style={[styles.sevDot, { backgroundColor: severityColor[item.severity] }]}
            />
          )}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  empty: { color: theme.muted, textAlign: "center", marginTop: 32, fontSize: 14 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.borderSolid,
    borderRadius: theme.radiusSm,
    padding: 12,
    marginBottom: 8,
  },
  title: { color: theme.fg, fontSize: 14, fontWeight: "600" },
  state: { color: theme.muted, fontSize: 12, marginTop: 4, textTransform: "capitalize" },
  sevDot: { width: 10, height: 10, borderRadius: 5 },
});
