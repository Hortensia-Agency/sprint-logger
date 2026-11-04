/**
 * The report sheet. It springs open and closed from wherever it is, follows a
 * drag 1:1 (rubber-banding upward), and on release decides by where the flick
 * would land, not where the finger let go. The scrim dims with the sheet's
 * position, so a half-dragged sheet shows a half-dimmed screen.
 *
 * Rendered as an absolute full-screen overlay INSIDE the widget's own tree
 * (which sits under the host's GestureHandlerRootView), deliberately NOT an RN
 * Modal: a Modal mounts in a separate native view tree outside the host GHRV,
 * where gesture-handler has no root and the sheet silently fails to appear on
 * iOS.
 */

import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";
import { appleSpring, project, rubberband, SHEET_RESPONSE } from "./motion";

export function BottomSheet({
  visible,
  onClose,
  header,
  children,
  heightRatio = 0.86,
}: {
  visible: boolean;
  onClose: () => void;
  /** Drawn in the drag area, so the sheet can be pulled down by its title too. */
  header?: React.ReactNode;
  children: React.ReactNode;
  heightRatio?: number;
}) {
  const { height } = useWindowDimensions();
  const styles = useThemedStyles(makeStyles);
  const { rtl } = useTheme();
  const t = useStrings();
  const reduceMotion = useReducedMotion();
  const sheetH = Math.round(height * heightRatio);
  const ty = useSharedValue(sheetH);
  const startY = useSharedValue(0);
  // Stays mounted through the closing animation.
  const [mounted, setMounted] = useState(visible);

  const settle = (to: number, velocity: number, done?: () => void) => {
    "worklet";
    const finish = (finished?: boolean) => {
      "worklet";
      if (finished && done) runOnJS(done)();
    };
    ty.value = reduceMotion
      ? withTiming(to, { duration: 200 }, finish)
      : withSpring(to, appleSpring(1, SHEET_RESPONSE, velocity), finish);
  };

  useEffect(() => {
    if (visible) {
      setMounted(true);
      settle(0, 0);
    } else if (mounted) {
      settle(sheetH, 0, () => setMounted(false));
    }
  }, [visible, sheetH]);

  const pan = Gesture.Pan()
    .onStart(() => {
      startY.value = ty.value;
    })
    .onUpdate((e) => {
      const y = startY.value + e.translationY;
      ty.value = y < 0 ? rubberband(y, sheetH) : y;
    })
    .onEnd((e) => {
      const landing = ty.value + project(e.velocityY);
      if (landing > sheetH / 2) settle(sheetH, e.velocityY, onClose);
      else settle(0, e.velocityY);
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(ty.value, [0, sheetH], [1, 0], "clamp"),
  }));

  if (!mounted) return null;

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("close")}
        />
      </Animated.View>
      <Animated.View
        style={[styles.sheet, { height: sheetH, direction: rtl ? "rtl" : "ltr" }, sheetStyle]}
        accessibilityViewIsModal
      >
        <GestureDetector gesture={pan}>
          <View>
            <View style={styles.grabArea}>
              <View style={styles.grabber} />
            </View>
            {header}
          </View>
        </GestureDetector>
        {children}
      </Animated.View>
    </View>
  );
}

const FILL = { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 };

function makeStyles(t: Theme) {
  return {
    root: {
      ...FILL,
      justifyContent: "flex-end" as const,
      zIndex: 10000,
      elevation: 10000,
    },
    scrim: { ...FILL, backgroundColor: t.c.scrim },
    sheet: {
      backgroundColor: t.c["bg-elev-1"],
      borderTopLeftRadius: t.radius.lg + 4,
      borderTopRightRadius: t.radius.lg + 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: t.c.border,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOpacity: t.dark ? 0.55 : 0.16,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: -6 },
      elevation: 12,
    },
    grabArea: { alignItems: "center" as const, paddingTop: 8, paddingBottom: 10 },
    grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: t.c["border-strong"] },
  };
}
