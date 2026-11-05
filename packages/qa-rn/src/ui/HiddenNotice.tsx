/**
 * Shown for a few seconds after the bubble is dropped on Hide: says where to
 * turn it back on, with Undo. Rises from the bottom, where the bubble went.
 */

import React, { useEffect } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";
import { useSafeAreaInsetsMaybe } from "./insets";

const SHOWN_MS = 5000;

export function HiddenNotice({ onUndo, onDone }: { onUndo: () => void; onDone: () => void }) {
  const t = useStrings();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsetsMaybe();
  const shown = useSharedValue(0);

  useEffect(() => {
    shown.value = withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) });
    AccessibilityInfo.announceForAccessibility(t("hiddenNotice"));
    const timer = setTimeout(() => {
      shown.value = withTiming(0, { duration: 150, easing: Easing.in(Easing.cubic) }, (done) => {
        if (done) runOnJS(onDone)();
      });
    }, SHOWN_MS);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * 12 }],
  }));

  return (
    <Animated.View
      style={[styles.wrap, { bottom: insets.bottom + 16 }, style]}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text}>{t("hiddenNotice")}</Text>
      <Pressable
        onPress={onUndo}
        accessibilityRole="button"
        hitSlop={10}
        style={({ pressed }) => [styles.undo, pressed && { opacity: 0.6 }]}
      >
        <Text style={[styles.undoText, { color: theme.accented ? theme.c.signal : theme.c.foreground }]}>
          {t("undo")}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

function makeStyles(t: Theme) {
  return {
    wrap: {
      position: "absolute" as const,
      left: 16,
      right: 16,
      zIndex: 9999,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingVertical: 12,
      paddingLeft: 16,
      paddingRight: 8,
      borderRadius: t.radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.c.border,
      backgroundColor: t.c["bg-elev-1"],
      shadowColor: "#000",
      shadowOpacity: t.dark ? 0.45 : 0.14,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    text: { flex: 1, color: t.c.foreground, fontSize: 15, lineHeight: 20 },
    undo: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: "center" as const, justifyContent: "center" as const },
    undoText: { fontSize: 15, fontWeight: "600" as const },
  };
}
