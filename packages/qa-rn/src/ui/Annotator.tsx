import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Svg, captureRef } from "../optional-deps";
import { useThemedStyles, type Theme } from "./theme";
import { useStrings, type StringKey } from "./strings";

/** The web widget's palette, so a marked-up shot reads the same from either. */
export const ANNO_COLORS = ["#ef4444", "#f59e0b", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#ffffff", "#111827"];

type Tool = "pen" | "rect" | "ellipse" | "arrow" | "line" | "text" | "hide";
const TOOLS: { tool: Tool; glyph: string; label: StringKey }[] = [
  { tool: "pen", glyph: "✎", label: "toolDraw" },
  { tool: "rect", glyph: "▢", label: "toolRectangle" },
  { tool: "ellipse", glyph: "◯", label: "toolEllipse" },
  { tool: "arrow", glyph: "↗", label: "toolArrow" },
  { tool: "line", glyph: "╱", label: "toolLine" },
  { tool: "text", glyph: "T", label: "toolText" },
  { tool: "hide", glyph: "▮", label: "toolHide" },
];

export type Mark =
  | { t: "pen"; color: string; w: number; pts: { x: number; y: number }[] }
  | { t: "rect" | "ellipse" | "arrow" | "line" | "hide"; color: string; w: number; x: number; y: number; x2: number; y2: number }
  | { t: "text"; color: string; x: number; y: number; text: string };

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotatorHandle {
  /** The crop with every mark burnt in, as a PNG file part; null without view-shot. */
  flatten(): Promise<{ uri: string; name: string; type: string } | null>;
}

/** Draws one mark; shared with the draw-while-recording layer. */
export function MarkShape({ m }: { m: Mark }) {
  const S = Svg;
  if (!S) return null;
  if (m.t === "pen") {
    const d = m.pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    return <S.Path d={d} stroke={m.color} strokeWidth={m.w} strokeLinecap="round" strokeLinejoin="round" fill="none" />;
  }
  if (m.t === "text") {
    return (
      <S.Text x={m.x} y={m.y} fill={m.color} fontSize={18} fontWeight="600" stroke={m.color === "#ffffff" ? "#111827" : "#ffffff"} strokeWidth={0.6}>
        {m.text}
      </S.Text>
    );
  }
  const x = Math.min(m.x, m.x2);
  const y = Math.min(m.y, m.y2);
  const w = Math.abs(m.x2 - m.x);
  const h = Math.abs(m.y2 - m.y);
  if (m.t === "hide") return <S.Rect x={x} y={y} width={w} height={h} fill="#111827" />;
  if (m.t === "rect") return <S.Rect x={x} y={y} width={w} height={h} rx={3} stroke={m.color} strokeWidth={m.w} fill="none" />;
  if (m.t === "ellipse") return <S.Ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} stroke={m.color} strokeWidth={m.w} fill="none" />;
  const line = <S.Line x1={m.x} y1={m.y} x2={m.x2} y2={m.y2} stroke={m.color} strokeWidth={m.w} strokeLinecap="round" />;
  if (m.t === "line") return line;
  const a = Math.atan2(m.y2 - m.y, m.x2 - m.x);
  const head = 10 + m.w * 2;
  const p1 = `${m.x2 - head * Math.cos(a - 0.45)},${m.y2 - head * Math.sin(a - 0.45)}`;
  const p2 = `${m.x2 - head * Math.cos(a + 0.45)},${m.y2 - head * Math.sin(a + 0.45)}`;
  return (
    <S.G>
      {line}
      <S.Polygon points={`${m.x2},${m.y2} ${p1} ${p2}`} fill={m.color} />
    </S.G>
  );
}

/** True for a mark too small to mean anything: a tap with a shape tool. */
function trivial(m: Mark): boolean {
  if (m.t === "pen") return m.pts.length < 2;
  if (m.t === "text") return !m.text.trim();
  return Math.abs(m.x2 - m.x) < 4 && Math.abs(m.y2 - m.y) < 4;
}

/**
 * A screenshot (or the chosen part of it) to mark up before it is sent. Marks
 * live in on-screen points over the shown image; flatten() snapshots exactly
 * what is on screen, so the file matches what the person saw.
 */
export const Annotator = forwardRef<
  AnnotatorHandle,
  { uri: string; imageW: number; imageH: number; crop: Crop; maxW: number; maxH: number }
>(function Annotator({ uri, imageW, imageH, crop, maxW, maxH }, ref) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const scale = Math.min(maxW / crop.w, maxH / crop.h);
  const viewW = Math.round(crop.w * scale);
  const viewH = Math.round(crop.h * scale);
  const canvasRef = useRef<View>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [redo, setRedo] = useState<Mark[]>([]);
  const [cur, setCur] = useState<Mark | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(ANNO_COLORS[0]);
  const [typing, setTyping] = useState<{ x: number; y: number; text: string } | null>(null);
  const width = 3;

  const commit = (m: Mark) => {
    if (trivial(m)) return;
    setMarks((all) => [...all, m]);
    setRedo([]);
  };

  const commitText = () => {
    if (typing) commit({ t: "text", color, x: typing.x, y: typing.y, text: typing.text });
    setTyping(null);
  };

  useImperativeHandle(ref, () => ({
    async flatten() {
      if (!captureRef || !canvasRef.current) return null;
      try {
        const out: string = await captureRef(canvasRef, { format: "png", quality: 1, result: "tmpfile" });
        return { uri: out, name: "annotated-screenshot.png", type: "image/png" };
      } catch {
        return null;
      }
    },
  }));

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => {
      if (tool === "text") return;
      const p = { x: e.x, y: e.y };
      setCur(tool === "pen" ? { t: "pen", color, w: width, pts: [p] } : { t: tool, color, w: width, x: p.x, y: p.y, x2: p.x, y2: p.y });
    })
    .onUpdate((e) => {
      setCur((m) => {
        if (!m) return m;
        if (m.t === "pen") return { ...m, pts: [...m.pts, { x: e.x, y: e.y }] };
        if (m.t === "text") return m;
        return { ...m, x2: e.x, y2: e.y };
      });
    })
    .onFinalize((e) => {
      if (tool === "text") {
        if (typing) commitText();
        else setTyping({ x: e.x, y: e.y, text: "" });
        return;
      }
      setCur((m) => {
        if (m) commit(m);
        return null;
      });
    });

  const S = Svg;
  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={pan}>
        <View ref={canvasRef} collapsable={false} style={[styles.canvas, { width: viewW, height: viewH }]}>
          <Image
            source={{ uri }}
            style={{ position: "absolute", left: -crop.x * scale, top: -crop.y * scale, width: imageW * scale, height: imageH * scale }}
            accessibilityIgnoresInvertColors
          />
          {S ? (
            <S.Svg width={viewW} height={viewH} style={{ position: "absolute", left: 0, top: 0 }}>
              {marks.map((m, i) => (
                <MarkShape key={i} m={m} />
              ))}
              {cur ? <MarkShape m={cur} /> : null}
            </S.Svg>
          ) : null}
          {typing ? (
            <TextInput
              autoFocus
              value={typing.text}
              onChangeText={(text) => setTyping((v) => (v ? { ...v, text } : v))}
              onSubmitEditing={commitText}
              onBlur={commitText}
              placeholder={t("typeText")}
              placeholderTextColor="#ffffffaa"
              style={[styles.textInput, { left: typing.x, top: typing.y - 22, color }]}
            />
          ) : null}
        </View>
      </GestureDetector>

      {S ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bar} keyboardShouldPersistTaps="handled">
          {TOOLS.map((x) => (
            <Pressable
              key={x.tool}
              onPress={() => setTool(x.tool)}
              style={[styles.tool, tool === x.tool && styles.toolOn]}
              accessibilityRole="button"
              accessibilityLabel={t(x.label)}
              accessibilityState={{ selected: tool === x.tool }}
            >
              <Text style={[styles.toolText, tool === x.tool && styles.toolTextOn]}>{x.glyph}</Text>
            </Pressable>
          ))}
          <View style={styles.sep} />
          {ANNO_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor(c)}
              style={[styles.swatch, { backgroundColor: c }, color === c && styles.swatchOn]}
              accessibilityRole="button"
              accessibilityLabel={t("color")}
              accessibilityState={{ selected: color === c }}
            />
          ))}
          <View style={styles.sep} />
          <Pressable
            onPress={() => {
              const last = marks[marks.length - 1];
              if (!last) return;
              setMarks(marks.slice(0, -1));
              setRedo([...redo, last]);
            }}
            disabled={!marks.length}
            style={[styles.tool, !marks.length && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel={t("undo")}
          >
            <Text style={styles.toolText}>↶</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              const last = redo[redo.length - 1];
              if (!last) return;
              setRedo(redo.slice(0, -1));
              setMarks([...marks, last]);
            }}
            disabled={!redo.length}
            style={[styles.tool, !redo.length && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel={t("redo")}
          >
            <Text style={styles.toolText}>↷</Text>
          </Pressable>
        </ScrollView>
      ) : null}
    </View>
  );
});

function makeStyles(t: Theme) {
  return {
    wrap: { alignItems: "center" as const, gap: 10 },
    canvas: { overflow: "hidden" as const, borderRadius: t.radius.md, backgroundColor: t.c["bg-elev-2"] },
    textInput: {
      position: "absolute" as const,
      minWidth: 120,
      fontSize: 18,
      fontWeight: "600" as const,
      padding: 2,
      backgroundColor: "#00000055",
      borderRadius: 4,
    },
    bar: { alignItems: "center" as const, gap: 6, paddingHorizontal: 4 },
    tool: {
      width: 40,
      height: 40,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: t.c["bg-elev-2"],
    },
    toolOn: { backgroundColor: t.c.signal },
    toolText: { color: t.c.foreground, fontSize: 17, fontWeight: "600" as const },
    toolTextOn: { color: t.c["signal-foreground"] },
    swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: t.c["border-strong"] },
    swatchOn: { borderWidth: 3, borderColor: t.c.foreground },
    sep: { width: 1, height: 24, backgroundColor: t.c.border, marginHorizontal: 2 },
    disabled: { opacity: 0.4 },
  };
}
