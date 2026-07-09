/**
 * Lightweight bottom sheet — slide-up from bottom, pan-down-to-close, dimmed
 * backdrop. Built directly on reanimated + gesture-handler (already peer deps)
 * instead of pulling in @gorhom/bottom-sheet.
 *
 * Rendered as an absolute full-screen overlay INSIDE the widget's own tree
 * (which sits under the host's GestureHandlerRootView) — deliberately NOT an RN
 * Modal. A Modal mounts in a separate native view tree outside the host GHRV,
 * where gesture-handler has no root and the sheet silently fails to appear on
 * iOS. Staying in-tree keeps the GestureDetector working and the sheet visible.
 */

import React, { useEffect } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { theme } from "./theme";

const CLOSE_VELOCITY = 800;

export function BottomSheet({
  visible,
  onClose,
  children,
  heightRatio = 0.8,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  heightRatio?: number;
}) {
  const { height } = useWindowDimensions();
  const sheetH = Math.round(height * heightRatio);
  const ty = useSharedValue(sheetH);
  const backdrop = useSharedValue(0);
  const startY = useSharedValue(0);

  useEffect(() => {
    ty.value = withTiming(visible ? 0 : sheetH, { duration: 200 });
    backdrop.value = withTiming(visible ? 1 : 0, { duration: 200 });
  }, [visible, sheetH]);

  function close() {
    ty.value = withTiming(sheetH, { duration: 160 });
    backdrop.value = withTiming(0, { duration: 160 }, () => {
      runOnJS(onClose)();
    });
  }

  const pan = Gesture.Pan()
    .onStart(() => {
      startY.value = ty.value;
    })
    .onUpdate((e: { translationY: number }) => {
      ty.value = Math.max(0, startY.value + e.translationY);
    })
    .onEnd((e: { translationY: number; velocityY: number }) => {
      if (e.translationY > sheetH * 0.3 || e.velocityY > CLOSE_VELOCITY) {
        runOnJS(close)();
      } else {
        ty.value = withTiming(0, { duration: 140 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ty.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));

  if (!visible) return null;

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.sheet, { height: sheetH }, sheetStyle]}>
          <View style={styles.handle} />
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "flex-end",
    zIndex: 10000,
    elevation: 10000,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    backgroundColor: theme.card,
    borderTopLeftRadius: theme.radius + 4,
    borderTopRightRadius: theme.radius + 4,
    borderTopWidth: 1,
    borderColor: theme.borderSolid,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.muted,
    marginBottom: 12,
  },
});
