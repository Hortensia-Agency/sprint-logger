import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "./theme";
import { isPatShape, resolveOrigin } from "../config";
import { getDeviceId } from "../storage";
import { oauthAvailable, signInWithSprint } from "../oauth";

/**
 * L3 gate — shown when no valid mobile_widget PAT is stored. Primary path is
 * "Sign in with Sprint" (OAuth via the tester's existing GitHub/Google account,
 * which mints a per-device token behind the scenes). A manual paste field
 * remains as a fallback for provider outages or edge cases.
 */
export function PatGate({
  onSubmit,
  origin,
  widgetKey,
  redirectUri,
}: {
  onSubmit: (pat: string) => void;
  origin?: string;
  widgetKey: string;
  redirectUri?: string;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isPatShape(value.trim());

  const canOAuth = oauthAvailable && Boolean(redirectUri);

  async function doOAuth() {
    if (!redirectUri) return;
    setBusy(true);
    setError(null);
    try {
      const device = await getDeviceId();
      const res = await signInWithSprint({
        origin: resolveOrigin({ widgetKey, host: "", pat: null, origin }),
        widgetKey,
        redirectUri,
        deviceId: device,
      });
      if (res.ok) {
        onSubmit(res.token);
      } else if (res.error !== "cancelled" && res.error !== "dismissed") {
        setError(errorMessage(res.error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Connect your Sprint account</Text>

      {canOAuth ? (
        <>
          <Text style={styles.body}>
            Sign in with your Sprint account to start reporting bugs. You only do
            this once on this device.
          </Text>
          <Pressable
            style={[styles.btn, busy && { opacity: 0.6 }]}
            disabled={busy}
            onPress={doOAuth}
          >
            {busy ? (
              <ActivityIndicator color={theme.primaryFg} />
            ) : (
              <Text style={styles.btnText}>Sign in with Sprint</Text>
            )}
          </Pressable>
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.dividerText}>or paste a token</Text>
            <View style={styles.line} />
          </View>
        </>
      ) : (
        <Text style={styles.body}>
          Paste a Mobile QA widget token from Sprint below. You only do this once
          on this device.
        </Text>
      )}

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
        style={[styles.btnSecondary, !valid && { opacity: 0.5 }]}
        disabled={!valid}
        onPress={() => onSubmit(value.trim())}
      >
        <Text style={styles.btnText}>Connect</Text>
      </Pressable>
    </View>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "not_a_qa_member":
      return "This Sprint account isn't a QA member of this project. Ask your manager to add you.";
    case "widget_disabled":
      return "The QA widget is disabled for this project.";
    case "not_authenticated":
      return "Sign-in didn't complete. Please try again.";
    case "network":
      return "Network error. Check your connection and try again.";
    default:
      return "Sign-in failed. Please try again.";
  }
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
  btnSecondary: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnText: { color: theme.primaryFg, fontWeight: "700" },
  error: { color: theme.destructive, fontSize: 13, lineHeight: 18 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  line: { flex: 1, height: 1, backgroundColor: theme.borderSolid },
  dividerText: { color: theme.muted, fontSize: 12 },
});
