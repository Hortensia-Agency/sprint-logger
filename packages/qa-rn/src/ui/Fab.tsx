/**
 * Movable FAB — the RN port of the web widget's Messenger-bubble drag/snap.
 *
 * Web parity:
 *   - drag the bubble; a ~5px threshold separates a drag from a tap
 *   - position persists per-device (web localStorage → RN AsyncStorage)
 *   - clamps to the screen on release
 *
 * Built on react-native-gesture-handler + reanimated (already peer deps), so
 * no extra dependency vs the glowit gorhom sheet.
 */

import React, { useEffect } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { theme } from "./theme";
import { loadFabPos, saveFabPos } from "../storage";

const SIZE = 56;
const MARGIN = 16;
const TAP_THRESHOLD = 5; // px — same as the web drag/tap split

export function Fab({ onPress }: { onPress: () => void }) {
  const { width, height } = useWindowDimensions();
  // Default: bottom-right, mirroring the web FAB's initial corner.
  const tx = useSharedValue(width - SIZE - MARGIN);
  const ty = useSharedValue(height - SIZE - MARGIN * 4);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  useEffect(() => {
    let alive = true;
    loadFabPos().then((p) => {
      if (alive && p) {
        tx.value = clamp(p.x, MARGIN, width - SIZE - MARGIN);
        ty.value = clamp(p.y, MARGIN, height - SIZE - MARGIN);
      }
    });
    return () => {
      alive = false;
    };
  }, [width, height]);

  function persist(x: number, y: number) {
    void saveFabPos({ x, y });
  }

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = tx.value;
      startY.value = ty.value;
    })
    .onUpdate((e: { translationX: number; translationY: number }) => {
      tx.value = startX.value + e.translationX;
      ty.value = startY.value + e.translationY;
    })
    .onEnd((e: { translationX: number; translationY: number }) => {
      const cx = clamp(tx.value, MARGIN, width - SIZE - MARGIN);
      const cy = clamp(ty.value, MARGIN, height - SIZE - MARGIN);
      tx.value = withSpring(cx, { damping: 18, stiffness: 180 });
      ty.value = withSpring(cy, { damping: 18, stiffness: 180 });
      const moved =
        Math.abs(e.translationX) > TAP_THRESHOLD ||
        Math.abs(e.translationY) > TAP_THRESHOLD;
      if (!moved) {
        runOnJS(onPress)();
      } else {
        runOnJS(persist)(cx, cy);
      }
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.fab, style]}>
        <View style={styles.inner}>
          <Text style={styles.glyph}>QA</Text>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  "worklet";
  return Math.min(Math.max(v, lo), hi);
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    width: SIZE,
    height: SIZE,
    zIndex: 9999,
  },
  inner: {
    flex: 1,
    borderRadius: SIZE / 2,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  glyph: {
    color: theme.primaryFg,
    fontWeight: "700",
    fontSize: 16,
  },
});
