/**
 * The movable bubble, the native twin of the web widget's. It rests against
 * the left or right edge. A drag follows the finger 1:1 and rubber-bands past
 * the screen; release projects the flick's momentum, picks the edge nearest
 * that projection and springs there from where the bubble is, carrying the
 * release velocity. Grabbing it mid-flight starts a new drag from there.
 */

import React, { useEffect } from "react";
import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTheme, useThemedStyles, type Theme } from "./theme";
import { appleSpring, project, rubberband, FAB_RESPONSE, MAX_FLICK } from "./motion";
import { loadFabPos, saveFabPos } from "../storage";

const EDGE_GAP = 20;
const BOTTOM_GAP = 96; // clear of a host tab bar on first launch
const TAP_SLOP = 10;
const MIN_TARGET = 44;

export type BubbleIcon = "bug" | "chat" | "help" | "logo";

export function Fab({
  onPress,
  size = 48,
  side = "right",
  icon = "bug",
  logoUrl,
  label,
  accessibilityLabel,
}: {
  onPress: () => void;
  size?: number;
  side?: "left" | "right";
  icon?: BubbleIcon;
  logoUrl?: string | null;
  label?: string | null;
  accessibilityLabel: string;
}) {
  const { width, height } = useWindowDimensions();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const reduceMotion = useReducedMotion();

  const minX = EDGE_GAP;
  const maxX = width - size - EDGE_GAP;
  const minY = EDGE_GAP * 2;
  const maxY = height - size - BOTTOM_GAP;

  const tx = useSharedValue(side === "left" ? minX : maxX);
  const ty = useSharedValue(maxY);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const press = useSharedValue(1);
  const labelW = useSharedValue(0);

  useEffect(() => {
    let alive = true;
    loadFabPos().then((p) => {
      if (!alive || !p) return;
      tx.value = p.x + size / 2 < width / 2 ? minX : maxX;
      ty.value = clamp(p.y, minY, maxY);
    });
    return () => {
      alive = false;
    };
  }, [width, height, size]);

  function persist(x: number, y: number) {
    void saveFabPos({ x, y });
  }

  // Feedback on touch-down, before either gesture has won.
  const pressIn = () => {
    "worklet";
    press.value = withTiming(0.96, { duration: 100 });
  };
  const pressOut = () => {
    "worklet";
    press.value = withTiming(1, { duration: 100 });
  };

  const tap = Gesture.Tap()
    .maxDistance(TAP_SLOP)
    .onBegin(pressIn)
    .onFinalize(pressOut)
    .onEnd(() => {
      runOnJS(onPress)();
    });

  const pan = Gesture.Pan()
    .minDistance(TAP_SLOP)
    .onBegin(pressIn)
    .onFinalize(pressOut)
    .onStart(() => {
      // From where the bubble is now, even mid-spring.
      startX.value = tx.value;
      startY.value = ty.value;
    })
    .onUpdate((e) => {
      const x = startX.value + e.translationX;
      const y = startY.value + e.translationY;
      tx.value = x < minX ? minX + rubberband(x - minX, size) : x > maxX ? maxX + rubberband(x - maxX, size) : x;
      ty.value = y < minY ? minY + rubberband(y - minY, size) : y > maxY ? maxY + rubberband(y - maxY, size) : y;
    })
    .onEnd((e) => {
      const vx = clamp(e.velocityX, -MAX_FLICK, MAX_FLICK);
      const vy = clamp(e.velocityY, -MAX_FLICK, MAX_FLICK);
      const landX = tx.value + project(vx) + size / 2 < width / 2 ? minX : maxX;
      const landY = clamp(ty.value + project(vy), minY, maxY);
      if (reduceMotion) {
        tx.value = withTiming(landX, { duration: 200 });
        ty.value = withTiming(landY, { duration: 200 });
      } else {
        // A flick may overshoot a little; a plain drop settles without it.
        const flicked = Math.hypot(vx, vy) > 500;
        const damping = flicked ? 0.8 : 1;
        tx.value = withSpring(landX, appleSpring(damping, FAB_RESPONSE, vx));
        ty.value = withSpring(landY, appleSpring(damping, FAB_RESPONSE, vy));
      }
      runOnJS(persist)(landX, landY);
    });

  const gesture = Gesture.Race(pan, tap);

  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: press.value }],
  }));

  // The label sits beside the bubble on whichever side has room.
  const labelStyle = useAnimatedStyle(() => {
    const onLeft = tx.value + size / 2 < width / 2;
    return {
      transform: [
        { translateX: onLeft ? tx.value + size + 8 : tx.value - 8 - labelW.value },
        { translateY: ty.value + size / 2 - 15 },
      ],
      opacity: labelW.value > 0 ? 1 : 0,
    };
  });

  const glyph = theme.accented ? theme.c["signal-foreground"] : theme.c["primary-foreground"];
  const hit = Math.max(0, (MIN_TARGET - size) / 2);

  return (
    <>
      {label ? (
        <Animated.View
          style={[styles.label, labelStyle]}
          onLayout={(e) => {
            labelW.value = e.nativeEvent.layout.width;
          }}
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.labelText} numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={[styles.fab, { width: size, height: size }, bubbleStyle]}
          hitSlop={{ top: hit, bottom: hit, left: hit, right: hit }}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onAccessibilityTap={onPress}
        >
          <View
            style={[
              styles.inner,
              { borderRadius: size / 2, backgroundColor: theme.accented ? theme.c.signal : theme.c.primary },
            ]}
          >
            {icon === "logo" && logoUrl ? (
              <Image source={{ uri: logoUrl }} style={{ width: size * 0.6, height: size * 0.6, borderRadius: size }} />
            ) : icon === "chat" ? (
              <ChatGlyph color={glyph} size={size} />
            ) : icon === "help" ? (
              <Text style={[styles.help, { color: glyph, fontSize: size * 0.42 }]}>?</Text>
            ) : (
              <BugGlyph color={glyph} />
            )}
          </View>
        </Animated.View>
      </GestureDetector>
    </>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  "worklet";
  return Math.min(Math.max(v, lo), hi);
}

/** A speech bubble drawn from Views: no icon or SVG dependency in the SDK. */
function ChatGlyph({ color, size }: { color: string; size: number }) {
  const w = size * 0.42;
  return (
    <View style={{ width: w, height: w * 0.9 }}>
      <View style={{ width: w, height: w * 0.72, borderRadius: w * 0.2, borderWidth: 2, borderColor: color }} />
      <View
        style={{
          position: "absolute",
          left: w * 0.18,
          bottom: 0,
          width: w * 0.24,
          height: w * 0.24,
          borderLeftWidth: 2,
          borderBottomWidth: 2,
          borderColor: color,
          transform: [{ skewY: "-30deg" }],
        }}
      />
    </View>
  );
}

/** A bug drawn from Views: shell, head, antennae and three pairs of legs. */
function BugGlyph({ color }: { color: string }) {
  const part = { backgroundColor: color };
  return (
    <View style={bug.box}>
      <View style={[bug.antenna, part, { left: 9, transform: [{ rotate: "-35deg" }] }]} />
      <View style={[bug.antenna, part, { right: 9, transform: [{ rotate: "35deg" }] }]} />
      <View style={[bug.leg, part, { top: 9, left: 1, transform: [{ rotate: "35deg" }] }]} />
      <View style={[bug.leg, part, { top: 9, right: 1, transform: [{ rotate: "-35deg" }] }]} />
      <View style={[bug.leg, part, { top: 14, left: 0 }]} />
      <View style={[bug.leg, part, { top: 14, right: 0 }]} />
      <View style={[bug.leg, part, { top: 19, left: 1, transform: [{ rotate: "-35deg" }] }]} />
      <View style={[bug.leg, part, { top: 19, right: 1, transform: [{ rotate: "35deg" }] }]} />
      <View style={[bug.head, part]} />
      <View style={[bug.shell, part]} />
    </View>
  );
}

const bug = StyleSheet.create({
  box: { width: 24, height: 26, alignItems: "center" },
  head: { position: "absolute", top: 4, width: 8, height: 6, borderRadius: 4 },
  shell: { position: "absolute", top: 9, width: 14, height: 15, borderRadius: 7 },
  antenna: { position: "absolute", top: 0, width: 1.5, height: 5, borderRadius: 1 },
  leg: { position: "absolute", width: 5, height: 1.5, borderRadius: 1 },
});

function makeStyles(t: Theme) {
  return {
    fab: { position: "absolute" as const, left: 0, top: 0, zIndex: 9999 },
    inner: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      shadowColor: "#000",
      shadowOpacity: t.dark ? 0.45 : 0.16,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    help: { fontWeight: "700" as const },
    label: {
      position: "absolute" as const,
      left: 0,
      top: 0,
      height: 30,
      justifyContent: "center" as const,
      paddingHorizontal: 10,
      borderRadius: t.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.c.border,
      backgroundColor: t.c["bg-elev-1"],
      zIndex: 9998,
      shadowColor: "#000",
      shadowOpacity: t.dark ? 0.4 : 0.08,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
    labelText: { color: t.c.foreground, fontSize: 13, fontWeight: "600" as const },
  };
}
