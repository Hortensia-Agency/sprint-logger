import React, { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsetsMaybe } from "./insets";
import { useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";
import type { Crop } from "./Annotator";

/**
 * Pick the part of the screen the report is about. The screen was captured
 * the moment this opened, so dragging here selects on that still frame; the
 * web widget selects on the live page, the effect is the same.
 */
export function AreaSelect({
  uri,
  imageW,
  imageH,
  onCancel,
  onPick,
}: {
  uri: string;
  imageW: number;
  imageH: number;
  onCancel: () => void;
  onPick: (crop: Crop) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsetsMaybe();
  const [sel, setSel] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => setSel({ x: e.x, y: e.y, x2: e.x, y2: e.y }))
    .onUpdate((e) => setSel((s) => (s ? { ...s, x2: e.x, y2: e.y } : s)));

  const box = sel
    ? { left: Math.min(sel.x, sel.x2), top: Math.min(sel.y, sel.y2), w: Math.abs(sel.x2 - sel.x), h: Math.abs(sel.y2 - sel.y) }
    : null;
  const usable = !!box && box.w > 12 && box.h > 12;
  const rx = imageW / width;
  const ry = imageH / height;

  return (
    <View style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill}>
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="stretch" accessibilityIgnoresInvertColors />
          <View style={[StyleSheet.absoluteFill, styles.dim]} pointerEvents="none" />
          {box ? (
            <View
              pointerEvents="none"
              style={[styles.sel, { left: box.left, top: box.top, width: box.w, height: box.h }]}
            >
              <Image
                source={{ uri }}
                style={{ position: "absolute", left: -box.left, top: -box.top, width, height }}
                resizeMode="stretch"
              />
            </View>
          ) : null}
        </View>
      </GestureDetector>

      {!box ? (
        <View pointerEvents="none" style={[styles.hintWrap, { top: insets.top + 24 }]}>
          <Text style={styles.hint}>{t("selectAreaHint")}</Text>
        </View>
      ) : null}

      <View style={[styles.bar, { bottom: insets.bottom + 20 }]}>
        <Pressable style={styles.btn} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.btnText}>{t("cancel")}</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => onPick({ x: 0, y: 0, w: imageW, h: imageH })} accessibilityRole="button">
          <Text style={styles.btnText}>{t("fullPage")}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.primary, !usable && styles.disabled]}
          disabled={!usable}
          onPress={() =>
            box &&
            onPick({
              x: Math.round(box.left * rx),
              y: Math.round(box.top * ry),
              w: Math.round(box.w * rx),
              h: Math.round(box.h * ry),
            })
          }
          accessibilityRole="button"
          accessibilityState={{ disabled: !usable }}
        >
          <Text style={[styles.btnText, styles.primaryText]}>{t("useSelection")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return {
    dim: { backgroundColor: "rgba(0,0,0,0.45)" },
    sel: { position: "absolute" as const, overflow: "hidden" as const, borderWidth: 2, borderColor: t.c.signal },
    hintWrap: { position: "absolute" as const, left: 16, right: 16, alignItems: "center" as const },
    hint: {
      color: "#fff",
      fontSize: 15,
      fontWeight: "500" as const,
      backgroundColor: "rgba(0,0,0,0.6)",
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      overflow: "hidden" as const,
    },
    bar: { position: "absolute" as const, left: 16, right: 16, flexDirection: "row" as const, gap: 8 },
    btn: {
      flex: 1,
      minHeight: 48,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: t.c["bg-elev-1"],
      borderWidth: 1,
      borderColor: t.c.border,
    },
    btnText: { color: t.c.foreground, fontSize: 15, fontWeight: "600" as const },
    primary: { backgroundColor: t.c.signal, borderColor: t.c.signal },
    primaryText: { color: t.c["signal-foreground"] },
    disabled: { opacity: 0.5 },
  };
}
