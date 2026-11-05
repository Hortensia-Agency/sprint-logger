import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings, type StringKey } from "./strings";
import { isPatShape, resolveOrigin } from "../config";
import { getDeviceId, markResume, takeResume } from "../storage";
import { isOAuthAvailable, signInWithSprint, type OAuthDeps } from "../oauth";

/**
 * L3 gate, shown when no valid mobile_widget PAT is stored. Primary path is
 * "Sign in" (OAuth with the person's GitHub or Google account,
 * which mints a per-device token behind the scenes). A manual paste field
 * remains as a fallback for provider outages or edge cases.
 */
export function PatGate({
  onSubmit,
  origin,
  widgetKey,
  redirectUri,
  oauthDeps,
}: {
  onSubmit: (pat: string) => void;
  origin?: string;
  widgetKey: string;
  redirectUri?: string;
  oauthDeps?: OAuthDeps;
}) {
  const theme = useTheme();
  const t = useStrings();
  const styles = useThemedStyles(makeStyles);
  const [value, setValue] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isPatShape(value.trim());

  const canOAuth = isOAuthAvailable(oauthDeps) && Boolean(redirectUri);

  async function doOAuth() {
    if (!redirectUri) return;
    setBusy(true);
    setError(null);
    try {
      const device = await getDeviceId();
      await markResume();
      const res = await signInWithSprint({
        origin: resolveOrigin({ widgetKey, host: "", pat: null, origin }),
        widgetKey,
        redirectUri,
        deviceId: device,
        deps: oauthDeps,
      });
      if (!res.ok) await takeResume();
      if (res.ok) {
        onSubmit(res.token);
      } else if (res.error !== "cancelled" && res.error !== "dismissed") {
        setError(t(errorKey(res.error)));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{t("signInTitle")}</Text>

      {canOAuth ? (
        <>
          <Text style={styles.body}>{t("signInBody")}</Text>
          <Pressable
            style={({ pressed }) => [styles.btn, (busy || pressed) && styles.pressed]}
            disabled={busy}
            onPress={doOAuth}
            accessibilityRole="button"
            accessibilityState={{ busy }}
          >
            {busy ? (
              <ActivityIndicator color={theme.c["signal-foreground"]} />
            ) : (
              <Text style={styles.btnText}>{t("signIn")}</Text>
            )}
          </Pressable>
          {error ? (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
          {!showPaste && (
            <Pressable onPress={() => setShowPaste(true)} hitSlop={10} accessibilityRole="button" style={styles.linkHit}>
              <Text style={styles.link}>{t("pasteTokenLink")}</Text>
            </Pressable>
          )}
        </>
      ) : (
        <Text style={styles.body}>{t("pasteTokenBody")}</Text>
      )}

      {(showPaste || !canOAuth) && (
        <>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder="sprint_pat_…"
            placeholderTextColor={theme.c["subtle-foreground"]}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("token")}
          />
          <Pressable
            style={[styles.btnQuiet, !valid && { opacity: 0.5 }]}
            disabled={!valid}
            onPress={() => onSubmit(value.trim())}
            accessibilityRole="button"
          >
            <Text style={styles.btnQuietText}>{t("connect")}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function errorKey(code: string): StringKey {
  switch (code) {
    case "not_a_qa_member":
      return "signInNotMember";
    case "widget_disabled":
      return "reportingOff";
    case "not_authenticated":
      return "signInIncomplete";
    case "network":
      return "networkError";
    default:
      return "signInFailed";
  }
}

function makeStyles(t: Theme) {
  const btn = {
    minHeight: 48,
    borderRadius: t.radius.md,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  return {
    wrap: { gap: 12, paddingTop: 4 },
    title: { color: t.c.foreground, fontSize: 20, fontWeight: "600" as const, letterSpacing: -0.2 },
    body: { color: t.c["muted-foreground"], fontSize: 15, lineHeight: 21 },
    input: {
      backgroundColor: t.c.input,
      borderWidth: 1,
      borderColor: t.c.border,
      borderRadius: t.radius.md,
      color: t.c.foreground,
      fontSize: 15,
      padding: 12,
      fontFamily: "monospace",
    },
    btn: { ...btn, backgroundColor: t.c.signal },
    btnText: { color: t.c["signal-foreground"], fontWeight: "600" as const, fontSize: 16 },
    btnQuiet: { ...btn, borderWidth: 1, borderColor: t.c.border },
    btnQuietText: { color: t.c.foreground, fontWeight: "600" as const, fontSize: 15 },
    pressed: { opacity: 0.85 },
    error: { color: t.c.destructive, fontSize: 14, lineHeight: 20 },
    linkHit: { alignSelf: "center" as const, minHeight: 36, justifyContent: "center" as const },
    link: { color: t.c["muted-foreground"], fontSize: 14, textDecorationLine: "underline" as const },
  };
}
