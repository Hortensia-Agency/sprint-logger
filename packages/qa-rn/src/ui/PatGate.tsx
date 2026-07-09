import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "./theme";
import { isPatShape } from "../config";

/**
 * L3 fallback — shown when no valid mobile_widget PAT is stored. The tester
 * mints one in Sprint (Settings → Personal access tokens → Mobile QA widget)
 * and pastes it here once; it persists per-device.
 */
export function PatGate({ onSubmit }: { onSubmit: (pat: string) => void }) {
  const [value, setValue] = useState("");
  const valid = isPatShape(value.trim());
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Connect your Sprint account</Text>
      <Text style={styles.body}>
        Mint a Mobile QA widget token in Sprint (Settings → Personal access
        tokens) and paste it below. You only do this once on this device.
      </Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="sprint_pat_…"
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        style={[styles.btn, !valid && { opacity: 0.5 }]}
        disabled={!valid}
        onPress={() => onSubmit(value.trim())}
      >
        <Text style={styles.btnText}>Connect</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  title: { color: theme.fg, fontSize: 16, fontWeight: "700" },
  body: { color: theme.muted, fontSize: 13, lineHeight: 19 },
  input: {
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.borderSolid,
    borderRadius: theme.radiusSm,
    color: theme.fg,
    padding: 12,
    fontFamily: "monospace",
  },
  btn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnText: { color: theme.primaryFg, fontWeight: "700" },
});
