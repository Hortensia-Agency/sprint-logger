import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings, type StringKey } from "./strings";
import { resolveOrigin } from "../config";
import { getDeviceId, markResume, takeResume } from "../storage";
import { isOAuthAvailable, signInWithSprint, type OAuthDeps } from "../oauth";

/**
 * L3 gate, shown when this device has no token yet. The one way in is Sprint's
 * own sign-in page: GitHub or Google, or email and password for an account an
 * admin created. Sprint mints a per-device token behind the scenes; nobody
 * pastes a token.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasDeps = isOAuthAvailable(oauthDeps);
  const canSignIn = hasDeps && Boolean(redirectUri);

  useEffect(() => {
    if (canSignIn) return;
    // For the app's developers: the person only sees that sign-in isn't set up.
    console.warn(
      `[SprintQa] sign-in is unavailable: ${!redirectUri ? "pass redirectUri (e.g. \"myapp://sprint-qa\")" : ""}${
        !redirectUri && !hasDeps ? " and " : ""
      }${!hasDeps ? "install expo-web-browser and expo-crypto (or pass oauthDeps), then rebuild the app" : ""}.`
    );
  }, [canSignIn, hasDeps, redirectUri]);

  async function signIn() {
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
      {canSignIn ? (
        <>
          <Text style={styles.body}>{t("signInBody")}</Text>
          <Pressable
            style={({ pressed }) => [styles.btn, (busy || pressed) && styles.pressed]}
            disabled={busy}
            onPress={signIn}
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
        </>
      ) : (
        <Text style={styles.body}>{t("signInUnavailable")}</Text>
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
  return {
    wrap: { gap: 12, paddingTop: 4 },
    title: { color: t.c.foreground, fontSize: 20, fontWeight: "600" as const, letterSpacing: -0.2 },
    body: { color: t.c["muted-foreground"], fontSize: 15, lineHeight: 21 },
    btn: {
      minHeight: 48,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: t.c.signal,
    },
    btnText: { color: t.c["signal-foreground"], fontWeight: "600" as const, fontSize: 16 },
    pressed: { opacity: 0.85 },
    error: { color: t.c.destructive, fontSize: 14, lineHeight: 20 },
  };
}
