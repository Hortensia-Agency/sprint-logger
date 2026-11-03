import React, { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { severityColor, stateColor, useTheme, useThemedStyles, type Theme } from "./theme";
import type { SprintQaClient } from "../client";
import type { QueueTask } from "../contract";

export function QueueView({
  client,
  onOpenTask,
}: {
  client: SprintQaClient;
  onOpenTask: (taskId: number) => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
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
    return <Text style={styles.empty}>Couldn&apos;t load the queue. Pull the sheet down and open it again.</Text>;
  }
  if (tasks === null) {
    return (
      <View accessibilityLabel="Loading the queue">
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.row}>
            <View style={[styles.ring, styles.skeleton]} />
            <View style={{ flex: 1, gap: 6 }}>
              <View style={[styles.skeleton, { height: 12, width: "70%" }]} />
              <View style={[styles.skeleton, { height: 10, width: "35%" }]} />
            </View>
          </View>
        ))}
      </View>
    );
  }
  if (blocked || tasks.length === 0) {
    return (
      <Text style={styles.empty}>
        {blocked ? "You don't have access to this project's queue." : "Nothing is waiting for QA."}
      </Text>
    );
  }

  return (
    <FlatList
      data={tasks}
      keyExtractor={(t: QueueTask) => String(t.id)}
      contentContainerStyle={{ paddingBottom: 24 }}
      renderItem={({ item }: { item: QueueTask }) => (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => onOpenTask(item.id)}
          accessibilityRole="button"
        >
          <View style={[styles.ring, { borderColor: stateColor(theme, item.state) }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.state}>{stateLabel(item.state)}</Text>
          </View>
          {item.severity && (
            <View
              style={[styles.sevDot, { backgroundColor: severityColor(theme, item.severity) }]}
              accessibilityLabel={`${item.severity} severity`}
            />
          )}
        </Pressable>
      )}
    />
  );
}

export function stateLabel(state: string): string {
  const s = state.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function makeStyles(t: Theme) {
  return {
    empty: { color: t.c["muted-foreground"], textAlign: "center" as const, marginTop: 32, fontSize: 15, lineHeight: 21 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      minHeight: 56,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderColor: t.c.border,
    },
    pressed: { backgroundColor: t.c["bg-hover"] },
    ring: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
    skeleton: { backgroundColor: t.c["bg-elev-2"], borderRadius: t.radius.sm, borderWidth: 0 },
    title: { color: t.c.foreground, fontSize: 15, fontWeight: "500" as const },
    state: { color: t.c["muted-foreground"], fontSize: 13, marginTop: 3 },
    sevDot: { width: 8, height: 8, borderRadius: 4 },
  };
}
