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
import { StyleSheet, useWindowDimensions, View } from "react-native";
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

  // A pure tap barely moves the finger, so Pan alone often never activates on
  // iOS — the FAB would look tappable but do nothing. Use an explicit Tap for
  // the press and Pan for the drag, raced so whichever the user does wins.
  const tap = Gesture.Tap()
    .maxDistance(TAP_THRESHOLD * 2)
    .onEnd(() => {
      runOnJS(onPress)();
    });

  const pan = Gesture.Pan()
    .minDistance(TAP_THRESHOLD)
    .onStart(() => {
      startX.value = tx.value;
      startY.value = ty.value;
    })
    .onUpdate((e: { translationX: number; translationY: number }) => {
      tx.value = startX.value + e.translationX;
      ty.value = startY.value + e.translationY;
    })
    .onEnd(() => {
      // Snap to the nearer vertical edge (Messenger-bubble behavior); clamp Y.
      const leftX = MARGIN;
      const rightX = width - SIZE - MARGIN;
      const center = tx.value + SIZE / 2;
      const snapX = center < width / 2 ? leftX : rightX;
      const cy = clamp(ty.value, MARGIN, height - SIZE - MARGIN);
      tx.value = withSpring(snapX, { damping: 18, stiffness: 180 });
      ty.value = withSpring(cy, { damping: 18, stiffness: 180 });
      runOnJS(persist)(snapX, cy);
    });

  const gesture = Gesture.Race(pan, tap);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.fab, style]}>
        <View style={styles.inner}>
          <BugGlyph />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  "worklet";
  return Math.min(Math.max(v, lo), hi);
}

/**
 * A small ladybug-style bug drawn from Views — avoids an icon/SVG dependency.
 * Six legs angle out symmetrically, two antennae up top, an oval shell with a
 * center seam and a round head. Sized to sit centered in the 56px FAB.
 */
function BugGlyph() {
  const c = theme.primaryFg;
  return (
    <View style={styles.bug}>
      {/* antennae */}
      <View style={[styles.antenna, { left: 9, transform: [{ rotate: "-35deg" }] }]} />
      <View style={[styles.antenna, { right: 9, transform: [{ rotate: "35deg" }] }]} />
      {/* legs (three pairs) */}
      <View style={[styles.leg, { top: 9, left: 1, transform: [{ rotate: "35deg" }] }]} />
      <View style={[styles.leg, { top: 9, right: 1, transform: [{ rotate: "-35deg" }] }]} />
      <View style={[styles.leg, { top: 14, left: 0 }]} />
      <View style={[styles.leg, { top: 14, right: 0 }]} />
      <View style={[styles.leg, { top: 19, left: 1, transform: [{ rotate: "-35deg" }] }]} />
      <View style={[styles.leg, { top: 19, right: 1, transform: [{ rotate: "35deg" }] }]} />
      {/* head */}
      <View style={styles.head} />
      {/* shell */}
      <View style={styles.shell}>
        <View style={[styles.seam, { backgroundColor: theme.primary }]} />
      </View>
    </View>
  );
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
  bug: {
    width: 28,
    height: 28,
    alignItems: "center",
  },
  head: {
    position: "absolute",
    top: 4,
    width: 9,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.primaryFg,
  },
  shell: {
    position: "absolute",
    top: 9,
    width: 16,
    height: 17,
    borderRadius: 8,
    backgroundColor: theme.primaryFg,
    alignItems: "center",
    overflow: "hidden",
  },
  seam: {
    width: 1.5,
    height: "100%",
  },
  antenna: {
    position: "absolute",
    top: 0,
    width: 1.5,
    height: 5,
    borderRadius: 1,
    backgroundColor: theme.primaryFg,
  },
  leg: {
    position: "absolute",
    width: 6,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: theme.primaryFg,
  },
});
