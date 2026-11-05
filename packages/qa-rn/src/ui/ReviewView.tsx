import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { ExpoVideo } from "../optional-deps";
import { buildContext, type HostContext } from "../context";
import type { SprintQaClient } from "../client";
import type { CaptureProfile, Severity } from "../contract";
import type { AudioRecorder } from "../audio";
import { uploadDemoVideo, type VideoPart } from "../video";
import { uploadCapture, type CapturePayload } from "../capture";
import { Annotator, type AnnotatorHandle, type Crop } from "./Annotator";
import { VoiceNotes, fmtDuration, voiceAvailable, type VoiceNote } from "./VoiceNotes";
import { useSafeAreaInsetsMaybe } from "./insets";
import { severityColor, useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";
import { SEV_KEY } from "./QueueView";

export type ReviewPayload =
  | { kind: "screenshot"; uri: string; imageW: number; imageH: number; crop: Crop }
  | { kind: "video"; video: VideoPart; capture: CapturePayload | null }
  | { kind: "text" };

const SEVERITIES: Severity[] = ["low", "medium", "high", "blocker"];

/**
 * The full-screen review a capture opens into, as on the web: the media on
 * top (marked up, or played back and trimmed), then title, severity, details,
 * the screen it came from and voice notes. Sending files the report first,
 * then every file; a retry after a failed upload never files it twice.
 */
export function ReviewView({
  payload,
  client,
  reportOnly,
  captureProfile,
  getContext,
  legacyRecorder,
  onDiscard,
  onSent,
}: {
  payload: ReviewPayload;
  client: SprintQaClient;
  reportOnly: boolean;
  captureProfile: CaptureProfile;
  getContext?: () => HostContext | undefined;
  legacyRecorder?: AudioRecorder | null;
  onDiscard: () => void;
  /** `held` is true for a reporter's ticket waiting on review. */
  onSent: (taskId: number, held: boolean) => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const insets = useSafeAreaInsetsMaybe();
  const { width, height } = useWindowDimensions();
  const annotator = useRef<AnnotatorHandle>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [notes, setNotes] = useState<VoiceNote[]>([]);
  const [includeFull, setIncludeFull] = useState(false);
  const [trim, setTrim] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reportedId = useRef<number | null>(null);
  const held = useRef(false);
  const route = getContext?.()?.route;

  const isCrop =
    payload.kind === "screenshot" &&
    (payload.crop.x > 0 || payload.crop.y > 0 || payload.crop.w < payload.imageW || payload.crop.h < payload.imageH);

  async function submit() {
    if (!title.trim()) {
      setError(t("summaryRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let taskId = reportedId.current;
      if (taskId === null) {
        const shot = payload.kind === "screenshot" ? await annotator.current?.flatten() : null;
        const body = buildContext(
          { title: title.trim(), description: description.trim() || undefined, severity },
          getContext?.(),
          captureProfile
        );
        let res;
        try {
          res = await client.report(body);
        } catch (e) {
          const status = (e as { status?: number }).status;
          setError(
            status === 403 ? t("reportForbidden") : status === 429 ? t("reportRateLimited") : status === 422 ? t("reportNeedsTitle") : t("reportFailed")
          );
          return;
        }
        taskId = res.bugTaskId;
        reportedId.current = taskId;
        held.current = !!res.held;
        const bestEffort: Promise<unknown>[] = [];
        if (payload.kind === "screenshot") {
          if (shot) bestEffort.push(client.uploadAnnotatedScreenshot(taskId, shot));
          if (!shot || (isCrop && includeFull)) {
            bestEffort.push(client.uploadScreenshot(taskId, { uri: payload.uri, name: "screenshot.png", type: "image/png" }));
          }
        }
        for (const n of notes) bestEffort.push(client.uploadAudioNote(taskId, n));
        await Promise.all(bestEffort.map((p) => p.catch(() => null)));
      }
      // The video is awaited, not best-effort: a failed upload must be
      // visible and retryable, and the report is already filed.
      if (payload.kind === "video") {
        try {
          const rec = await uploadDemoVideo(
            client,
            taskId,
            payload.video,
            trim ? { trimStart: round1(trim.start), trimEnd: round1(trim.end) } : undefined
          );
          if (payload.capture) await uploadCapture(client, taskId, rec.id, payload.capture).catch(() => null);
        } catch (e) {
          setError(`${e instanceof Error ? e.message : t("videoUploadFailedShort")} ${t("videoRetryHint")}`);
          return;
        }
      }
      onSent(taskId, held.current);
    } finally {
      setBusy(false);
    }
  }

  const mediaW = width - 32;
  const placeholder = theme.c["subtle-foreground"];
  return (
    <View style={[StyleSheet.absoluteFill, styles.root]}>
      <View style={[styles.head, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={onDiscard} hitSlop={12} accessibilityRole="button" style={styles.headBtn}>
          <Text style={styles.discard}>{t("discard")}</Text>
        </Pressable>
        <Text style={styles.headTitle} accessibilityRole="header">
          {payload.kind === "video" ? t("reviewVideo") : payload.kind === "screenshot" ? t("reviewScreenshot") : t("tabReport")}
        </Text>
        <View style={styles.headBtn} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          {payload.kind === "text" ? null : payload.kind === "screenshot" ? (
            <>
              <Annotator
                ref={annotator}
                uri={payload.uri}
                imageW={payload.imageW}
                imageH={payload.imageH}
                crop={payload.crop}
                maxW={mediaW}
                maxH={height * 0.5}
              />
              {isCrop ? (
                <Check checked={includeFull} onToggle={() => setIncludeFull((v) => !v)} label={t("includeFullScreenshot")} />
              ) : null}
            </>
          ) : (
            <VideoReview video={payload.video} width={mediaW} onTrim={setTrim} />
          )}

          <Text style={styles.label} nativeID="sq-rtitle">
            {t("titleField")}
          </Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder={t("titlePlaceholder")}
            placeholderTextColor={placeholder}
            maxLength={500}
            accessibilityLabelledBy="sq-rtitle"
          />

          {!reportOnly ? (
            <>
              <Text style={styles.label}>{t("severityLabel")}</Text>
              <View style={styles.segment} accessibilityRole="radiogroup">
                {SEVERITIES.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setSeverity(s)}
                    style={[styles.segItem, s === severity && styles.segItemOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: s === severity }}
                  >
                    <View style={[styles.sevDot, { backgroundColor: severityColor(theme, s) }]} />
                    <Text style={[styles.segText, s === severity && styles.segTextOn]}>{t(SEV_KEY[s])}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.label} nativeID="sq-rdesc">
            {t("detailsLabel")} <Text style={styles.optional}>{t("optional")}</Text>
          </Text>
          <TextInput
            style={[styles.input, styles.area]}
            value={description}
            onChangeText={setDescription}
            placeholder={t("detailsPlaceholder")}
            placeholderTextColor={placeholder}
            multiline
            maxLength={50000}
            accessibilityLabelledBy="sq-rdesc"
          />

          {route ? (
            <Text style={styles.page}>
              {t("pageLabel")} <Text style={styles.mono}>{route}</Text>
            </Text>
          ) : null}

          {voiceAvailable(legacyRecorder) ? (
            <VoiceNotes notes={notes} onChange={setNotes} legacy={legacyRecorder} onError={setError} />
          ) : null}

          {error ? (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}

          <Pressable
            style={({ pressed }) => [styles.submit, (busy || pressed) && styles.pressed]}
            onPress={() => void submit()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ busy }}
          >
            {busy ? <ActivityIndicator color={theme.c["signal-foreground"]} /> : <Text style={styles.submitText}>{t("submit")}</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function Check({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable style={styles.checkRow} onPress={onToggle} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[styles.checkbox, checked && styles.checkboxOn]}>{checked ? <Text style={styles.checkMark}>✓</Text> : null}</View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

/** Playback (when expo-video is installed) and the trim handles under it. */
function VideoReview({
  video,
  width,
  onTrim,
}: {
  video: VideoPart;
  width: number;
  onTrim: (trim: { start: number; end: number } | null) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const duration = Math.max(1, video.durationSec ?? 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null);
  return (
    <View style={{ gap: 10 }}>
      {ExpoVideo ? (
        <Player uri={video.uri} width={width} onPlayer={(p) => (playerRef.current = p)} />
      ) : (
        <View style={[styles.videoStub, { width }]}>
          <Text style={styles.videoStubText}>{fmtDuration(duration)}</Text>
        </View>
      )}
      <TrimTrack
        duration={duration}
        width={width}
        onChange={(start, end) => {
          onTrim(start <= 0.05 && end >= duration - 0.05 ? null : { start, end });
          try {
            if (playerRef.current) playerRef.current.currentTime = start;
          } catch {
            // Seeking is a nicety.
          }
        }}
      />
    </View>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Player({ uri, width, onPlayer }: { uri: string; width: number; onPlayer: (p: any) => void }) {
  const V = ExpoVideo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const player = V.useVideoPlayer(uri, (p: any) => {
    p.loop = false;
  });
  onPlayer(player);
  return <V.VideoView player={player} style={{ width, height: Math.round(width * 1.2), borderRadius: 10 }} contentFit="contain" nativeControls />;
}

const HANDLE = 22;

/** Two handles over the clip; the server player clamps to them, nothing is cut. */
function TrimTrack({ duration, width, onChange }: { duration: number; width: number; onChange: (s: number, e: number) => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  const track = width - HANDLE * 2;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(duration);
  const from = useRef(0);
  const minGap = Math.min(1, duration / 2);
  const toX = (sec: number) => (sec / duration) * track;
  const toSec = (x: number) => Math.max(0, Math.min(duration, (x / track) * duration));

  const leftPan = Gesture.Pan()
    .runOnJS(true)
    .onBegin(() => (from.current = toX(start)))
    .onUpdate((e) => {
      const s = Math.min(toSec(from.current + e.translationX), end - minGap);
      setStart(s);
      onChange(s, end);
    });
  const rightPan = Gesture.Pan()
    .runOnJS(true)
    .onBegin(() => (from.current = toX(end)))
    .onUpdate((e) => {
      const v = Math.max(toSec(from.current + e.translationX), start + minGap);
      setEnd(v);
      onChange(start, v);
    });

  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.trackWrap, { width }]}>
        <View style={[styles.track, { left: HANDLE, width: track }]} />
        <View style={[styles.range, { left: HANDLE + toX(start), width: toX(end) - toX(start) }]} />
        <GestureDetector gesture={leftPan}>
          <View
            style={[styles.handle, { left: toX(start) }]}
            accessibilityRole="adjustable"
            accessibilityLabel={t("trimStart")}
            accessibilityValue={{ text: fmtDuration(start) }}
          />
        </GestureDetector>
        <GestureDetector gesture={rightPan}>
          <View
            style={[styles.handle, { left: HANDLE + toX(end) }]}
            accessibilityRole="adjustable"
            accessibilityLabel={t("trimEnd")}
            accessibilityValue={{ text: fmtDuration(end) }}
          />
        </GestureDetector>
      </View>
      <Text style={styles.trimLabel}>
        {t("trimLabel", { start: fmtDuration(start), end: fmtDuration(end) })}
      </Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return {
    root: { backgroundColor: t.c.background, zIndex: 10001, elevation: 10001 },
    head: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingHorizontal: 16,
      paddingBottom: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.c.border,
    },
    headBtn: { minWidth: 72, minHeight: 40, justifyContent: "center" as const },
    discard: { color: t.c.destructive, fontSize: 16, fontWeight: "500" as const },
    headTitle: { flex: 1, textAlign: "center" as const, color: t.c.foreground, fontSize: 17, fontWeight: "600" as const },
    body: { padding: 16, gap: 6 },
    label: { color: t.c["muted-foreground"], fontSize: 13, fontWeight: "500" as const, marginTop: 12 },
    optional: { color: t.c["subtle-foreground"], fontWeight: "400" as const },
    input: {
      backgroundColor: t.c.input,
      borderWidth: 1,
      borderColor: t.c.border,
      borderRadius: t.radius.md,
      color: t.c.foreground,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    area: { minHeight: 96, textAlignVertical: "top" as const },
    segment: {
      flexDirection: "row" as const,
      padding: 2,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.c.border,
      backgroundColor: t.c["bg-elev-1"],
    },
    segItem: {
      flex: 1,
      minHeight: 36,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 6,
      borderRadius: t.radius.sm,
    },
    segItemOn: { backgroundColor: t.c["bg-hover"] },
    segText: { color: t.c["muted-foreground"], fontSize: 13, fontWeight: "500" as const },
    segTextOn: { color: t.c.foreground },
    sevDot: { width: 7, height: 7, borderRadius: 4 },
    page: { color: t.c["muted-foreground"], fontSize: 13, marginTop: 10 },
    mono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", color: t.c.foreground },
    checkRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: 44 },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: t.radius.sm,
      borderWidth: 1.5,
      borderColor: t.c["border-strong"],
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    checkboxOn: { backgroundColor: t.c.signal, borderColor: t.c.signal },
    checkMark: { color: t.c["signal-foreground"], fontSize: 13, fontWeight: "700" as const },
    checkLabel: { color: t.c.foreground, fontSize: 15 },
    videoStub: {
      height: 160,
      borderRadius: 10,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: t.c["bg-elev-2"],
    },
    videoStubText: { color: t.c.foreground, fontSize: 28, fontWeight: "600" as const, fontVariant: ["tabular-nums" as const] },
    trackWrap: { height: 36, justifyContent: "center" as const },
    track: { position: "absolute" as const, height: 6, borderRadius: 3, backgroundColor: t.c["bg-elev-2"] },
    range: { position: "absolute" as const, height: 6, borderRadius: 3, backgroundColor: t.c.signal },
    handle: {
      position: "absolute" as const,
      width: HANDLE,
      height: 32,
      borderRadius: 6,
      backgroundColor: t.c.foreground,
      borderWidth: 2,
      borderColor: t.c.signal,
    },
    trimLabel: { color: t.c["muted-foreground"], fontSize: 13, fontVariant: ["tabular-nums" as const] },
    error: { color: t.c.destructive, fontSize: 14, lineHeight: 20, marginTop: 8 },
    submit: {
      minHeight: 50,
      marginTop: 16,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: t.c.signal,
    },
    submitText: { color: t.c["signal-foreground"], fontSize: 16, fontWeight: "600" as const },
    pressed: { opacity: 0.85 },
  };
}
