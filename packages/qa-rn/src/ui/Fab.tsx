/**
 * The movable bubble, the native twin of the web widget's. It rests against
 * the left or right edge. A drag follows the finger 1:1 and rubber-bands past
 * the screen; release projects the flick's momentum, picks the edge nearest
 * that projection and springs there from where the bubble is, carrying the
 * release velocity. Grabbing it mid-flight starts a new drag from there.
 *
 * With onHide, a Hide target rises at the bottom while it is dragged. Near the
 * target the bubble is pulled into it; let go there and it shrinks away into
 * the target and onHide runs.
 */

import React, { useEffect } from "react";
import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
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
import { useSafeAreaInsetsMaybe } from "./insets";
import { useStrings } from "./strings";

const EDGE_GAP = 20;
const BOTTOM_GAP = 96; // clear of a host tab bar on first launch
const TAP_SLOP = 10;
const MIN_TARGET = 44;
const HIDE_SIZE = 56; // the Hide target's circle
const HIDE_GAP = 28; // from the bottom safe edge to the circle
const HIDE_PULL = 64; // bubble center within this of the target's: it's pulled in

export type BubbleIcon = "bug" | "chat" | "help" | "logo";

export function Fab({
  onPress,
  size = 48,
  side = "right",
  icon = "bug",
  logoUrl,
  label,
  accessibilityLabel,
  onHide,
}: {
  onPress: () => void;
  /** Set to offer drag-to-hide. Runs once the bubble has gone into the target. */
  onHide?: () => void;
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
  const insets = useSafeAreaInsetsMaybe();
  const t = useStrings();

  const minX = EDGE_GAP;
  const maxX = width - size - EDGE_GAP;
  const minY = EDGE_GAP * 2;
  const maxY = height - size - BOTTOM_GAP;
  // Free to go lower while dragging when the Hide target sits down there.
  const dragMaxY = onHide ? height - size - insets.bottom - 8 : maxY;
  const hideCx = width / 2;
  const hideCy = height - insets.bottom - HIDE_GAP - HIDE_SIZE / 2;
  const pullX = hideCx - size / 2;
  const pullY = hideCy - size / 2;

  const tx = useSharedValue(side === "left" ? minX : maxX);
  const ty = useSharedValue(maxY);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const press = useSharedValue(1);
  const labelW = useSharedValue(0);
  const hideShown = useSharedValue(0); // the target, 0 gone to 1 up
  const over = useSharedValue(0); // bubble over the target, 0 or 1 (a flag)
  const pull = useSharedValue(0); // how far the bubble is pulled into it
  const gone = useSharedValue(0); // the bubble shrinking away after a drop

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
      over.value = 0;
      pull.value = 0;
      if (onHide) hideShown.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.cubic) });
    })
    .onUpdate((e) => {
      const x = startX.value + e.translationX;
      const y = startY.value + e.translationY;
      tx.value = x < minX ? minX + rubberband(x - minX, size) : x > maxX ? maxX + rubberband(x - maxX, size) : x;
      ty.value = y < minY ? minY + rubberband(y - minY, size) : y > dragMaxY ? dragMaxY + rubberband(y - dragMaxY, size) : y;
      if (!onHide) return;
      const near = Math.hypot(tx.value + size / 2 - hideCx, ty.value + size / 2 - hideCy) < HIDE_PULL ? 1 : 0;
      if (near !== over.value) {
        over.value = near;
        pull.value = reduceMotion ? near : withSpring(near, appleSpring(1, 0.25));
      }
    })
    .onEnd((e) => {
      if (onHide) hideShown.value = withTiming(0, { duration: 140, easing: Easing.in(Easing.cubic) });
      if (onHide && over.value === 1) {
        // Into the target from where it shows now, then gone.
        tx.value = pullX;
        ty.value = pullY;
        pull.value = 0;
        over.value = 0;
        gone.value = withTiming(1, { duration: 180, easing: Easing.in(Easing.cubic) }, (done) => {
          if (done) runOnJS(onHide)();
        });
        return;
      }
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

  // Pulled toward the target's center by `pull`, so the finger still owns it.
  const bubbleStyle = useAnimatedStyle(() => ({
    opacity: 1 - gone.value,
    transform: [
      { translateX: tx.value + (pullX - tx.value) * pull.value },
      { translateY: ty.value + (pullY - ty.value) * pull.value },
      { scale: press.value * (1 - 0.4 * gone.value) },
    ],
  }));

  const hideStyle = useAnimatedStyle(() => ({
    opacity: hideShown.value,
    transform: [
      { translateY: interpolate(hideShown.value, [0, 1], [16, 0]) },
      { scale: interpolate(hideShown.value, [0, 1], [0.9, 1]) * (1 + 0.15 * pull.value) },
    ],
  }));
  const hideFillStyle = useAnimatedStyle(() => ({ opacity: pull.value }));

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
      {onHide ? (
        <Animated.View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.hide,
            { left: hideCx - 80, top: hideCy - HIDE_SIZE / 2 - 34, width: 160 },
            hideStyle,
          ]}
        >
          <View style={styles.hideLabel}>
            <Text style={styles.hideLabelText} numberOfLines={1}>
              {t("hideTarget")}
            </Text>
          </View>
          <View style={styles.hideCircle}>
            <XGlyph color={theme.c["muted-foreground"]} />
            <Animated.View style={[StyleSheet.absoluteFill, styles.hideRing, hideFillStyle]} />
          </View>
        </Animated.View>
      ) : null}
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
          accessibilityActions={
            onHide ? [{ name: "activate" }, { name: "hide", label: t("hideAction") }] : undefined
          }
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "hide") onHide?.();
            else onPress();
          }}
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

/** The Hide target's cross, two bars: no icon dependency in the SDK. */
function XGlyph({ color }: { color: string }) {
  const bar = { position: "absolute" as const, width: 18, height: 2, borderRadius: 1, backgroundColor: color };
  return (
    <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
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
    hide: { position: "absolute" as const, alignItems: "center" as const, zIndex: 9997 },
    hideLabel: {
      height: 26,
      marginBottom: 8,
      justifyContent: "center" as const,
      paddingHorizontal: 10,
      borderRadius: t.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.c.border,
      backgroundColor: t.c["bg-elev-1"],
    },
    hideLabelText: { color: t.c.foreground, fontSize: 13, fontWeight: "600" as const },
    hideCircle: {
      width: HIDE_SIZE,
      height: HIDE_SIZE,
      borderRadius: HIDE_SIZE / 2,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      overflow: "hidden" as const,
      borderWidth: 1,
      borderColor: t.c["border-strong"],
      backgroundColor: t.c["bg-elev-1"],
      shadowColor: "#000",
      shadowOpacity: t.dark ? 0.4 : 0.12,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    // Over the target: a ring in the text color, so the bubble reads against it in both themes.
    hideRing: { borderRadius: HIDE_SIZE / 2, borderWidth: 2, borderColor: t.c.foreground },
  };
}
