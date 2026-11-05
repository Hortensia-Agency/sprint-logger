import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, useReducedMotion } from "react-native-reanimated";
import { Svg } from "../optional-deps";
import { useSafeAreaInsetsMaybe } from "./insets";
import { ANNO_COLORS, MarkShape, type Mark } from "./Annotator";
import { fmtDuration } from "./VoiceNotes";
import { useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";

/** 3, 2, 1 over a dimmed app, then hands over to the recording. */
export function Countdown({ withMic, onDone, onCancel }: { withMic: boolean; onDone: () => void; onCancel: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const reduceMotion = useReducedMotion();
  const [n, setN] = useState(3);
  useEffect(() => {
    if (n === 0) {
      onDone();
      return;
    }
    const id = setTimeout(() => setN((x) => x - 1), 1000);
    return () => clearTimeout(id);
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={[StyleSheet.absoluteFill, styles.scrim]}>
      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text style={styles.countTitle}>{t("countdownTitle")}</Text>
        <Animated.Text key={n} entering={reduceMotion ? undefined : FadeIn.duration(150)} style={styles.countNum}>
          {Math.max(n, 1)}
        </Animated.Text>
        <Text style={styles.countSub}>{withMic ? t("countdownMic") : t("countdownMuted")}</Text>
        <Pressable onPress={onCancel} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelText}>{t("cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The bar while the screen records: elapsed time, draw on screen, stop. It is
 * part of the recording, as the web widget's bar is.
 */
export function RecordBar({ startedAt, onStop }: { startedAt: number; onStop: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const insets = useSafeAreaInsetsMaybe();
  const reduceMotion = useReducedMotion();
  const [now, setNow] = useState(Date.now());
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const seconds = (now - startedAt) / 1000;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {drawing ? <DrawLayer onClose={() => setDrawing(false)} /> : null}
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(180)}
        exiting={reduceMotion ? undefined : FadeOut.duration(150)}
        style={[styles.bar, { top: insets.top + 8 }]}
      >
        <View style={styles.recDot} />
        <Text style={styles.time} accessibilityRole="timer">
          {fmtDuration(seconds)}
        </Text>
        {Svg ? (
          <Pressable
            onPress={() => setDrawing((d) => !d)}
            style={[styles.barBtn, drawing && styles.barBtnOn]}
            accessibilityRole="button"
            accessibilityLabel={t("annotate")}
            accessibilityState={{ selected: drawing }}
          >
            <Text style={[styles.barBtnText, drawing && styles.barBtnTextOn]}>✎</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onStop} style={styles.stop} accessibilityRole="button" accessibilityLabel={t("stopShort")}>
          <View style={styles.stopSquare} />
          <Text style={styles.stopText}>{t("stopShort")}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** Draw over the app while it records; leaving draw mode wipes the strokes. */
function DrawLayer({ onClose }: { onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const insets = useSafeAreaInsetsMaybe();
  const [marks, setMarks] = useState<Mark[]>([]);
  const [cur, setCur] = useState<Mark | null>(null);
  const [color, setColor] = useState(ANNO_COLORS[0]);
  const S = Svg;

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => setCur({ t: "pen", color, w: 4, pts: [{ x: e.absoluteX, y: e.absoluteY }] }))
    .onUpdate((e) => setCur((m) => (m && m.t === "pen" ? { ...m, pts: [...m.pts, { x: e.absoluteX, y: e.absoluteY }] } : m)))
    .onFinalize(() =>
      setCur((m) => {
        if (m && m.t === "pen" && m.pts.length > 1) setMarks((all) => [...all, m]);
        return null;
      })
    );

  return (
    <View style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill}>
          {S ? (
            <S.Svg style={StyleSheet.absoluteFill}>
              {marks.map((m, i) => (
                <MarkShape key={i} m={m} />
              ))}
              {cur ? <MarkShape m={cur} /> : null}
            </S.Svg>
          ) : null}
        </View>
      </GestureDetector>
      <View style={[styles.palette, { bottom: insets.bottom + 20 }]}>
        {ANNO_COLORS.map((c) => (
          <Pressable
            key={c}
            onPress={() => setColor(c)}
            style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchOn]}
            accessibilityRole="button"
            accessibilityLabel={t("color")}
          />
        ))}
        <Pressable onPress={() => setMarks([])} style={styles.palBtn} accessibilityRole="button">
          <Text style={styles.palBtnText}>{t("clear")}</Text>
        </Pressable>
        <Pressable onPress={onClose} style={styles.palBtn} accessibilityRole="button">
          <Text style={styles.palBtnText}>{t("done")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return {
    scrim: { backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center" as const, justifyContent: "center" as const },
    card: {
      width: 260,
      padding: 20,
      gap: 6,
      alignItems: "center" as const,
      borderRadius: t.radius.lg + 4,
      backgroundColor: t.c["bg-elev-1"],
    },
    countTitle: { color: t.c.foreground, fontSize: 16, fontWeight: "600" as const },
    countNum: { color: t.c.signal, fontSize: 72, fontWeight: "700" as const, lineHeight: 84, fontVariant: ["tabular-nums" as const] },
    countSub: { color: t.c["muted-foreground"], fontSize: 13, textAlign: "center" as const, lineHeight: 18 },
    cancel: { marginTop: 8, minHeight: 40, paddingHorizontal: 16, justifyContent: "center" as const },
    cancelText: { color: t.c["muted-foreground"], fontSize: 15, fontWeight: "500" as const },
    bar: {
      position: "absolute" as const,
      alignSelf: "center" as const,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingLeft: 14,
      paddingRight: 6,
      height: 48,
      borderRadius: 24,
      backgroundColor: "rgba(17,24,39,0.92)",
    },
    recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#ef4444" },
    time: { color: "#fff", fontSize: 15, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const], minWidth: 44 },
    barBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center" as const, justifyContent: "center" as const },
    barBtnOn: { backgroundColor: "#ffffff" },
    barBtnText: { color: "#fff", fontSize: 17 },
    barBtnTextOn: { color: "#111827" },
    stop: {
      height: 36,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 14,
      borderRadius: 18,
      backgroundColor: "#ef4444",
    },
    stopSquare: { width: 10, height: 10, borderRadius: 2, backgroundColor: "#fff" },
    stopText: { color: "#fff", fontSize: 14, fontWeight: "600" as const },
    palette: {
      position: "absolute" as const,
      alignSelf: "center" as const,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      justifyContent: "center" as const,
      gap: 8,
      maxWidth: 360,
      padding: 10,
      borderRadius: 20,
      backgroundColor: "rgba(17,24,39,0.92)",
    },
    swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: "#ffffff66" },
    swatchOn: { borderWidth: 3, borderColor: "#fff" },
    palBtn: { minHeight: 32, paddingHorizontal: 10, justifyContent: "center" as const },
    palBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" as const },
  };
}
