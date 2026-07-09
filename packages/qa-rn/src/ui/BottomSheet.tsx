/**
 * Lightweight bottom sheet — slide-up from bottom, pan-down-to-close, dimmed
 * backdrop. Modeled on glowit's sheet UX but built directly on reanimated +
 * gesture-handler (already peer deps) instead of pulling in @gorhom/bottom-sheet.
 */

import React, { useEffect } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
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
  const startY = useSharedValue(0);

  useEffect(() => {
    ty.value = withTiming(visible ? 0 : sheetH, { duration: 180 });
  }, [visible, sheetH]);

  function close() {
    ty.value = withTiming(sheetH, { duration: 160 }, () => {
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

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={close} />
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.sheet, { height: sheetH }, sheetStyle]}>
            <View style={styles.handle} />
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
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
