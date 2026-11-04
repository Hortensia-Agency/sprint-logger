import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { severityColor, useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";
import { SEV_KEY } from "./QueueView";
import { buildContext, type HostContext } from "../context";
import type { SprintQaClient } from "../client";
import type { CaptureProfile, Severity } from "../contract";
import type { AudioRecorder, AudioPart } from "../audio";
import {
  pickDemoVideo,
  uploadDemoVideo,
  videoAttachAvailable,
  type VideoPart,
} from "../video";

const SEVERITIES: Severity[] = ["low", "medium", "high", "blocker"];
const AUDIO_MAX_SECONDS = 120; // 2-minute soft cap

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

export function ReportView({
  client,
  onReported,
  captureScreenshot,
  audioRecorder,
  getContext,
  reportOnly = false,
  captureProfile = "standard",
}: {
  client: SprintQaClient;
  onReported: (taskId: number) => void;
  captureScreenshot?: () => Promise<{ uri: string; name: string; type: string } | null>;
  audioRecorder?: AudioRecorder | null;
  getContext?: () => HostContext | undefined;
  /** A widget reporter: no severity picker, and a held ticket gets a confirmation. */
  reportOnly?: boolean;
  captureProfile?: CaptureProfile;
}) {
  const theme = useTheme();
  const t = useStrings();
  const styles = useThemedStyles(makeStyles);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [withShot, setWithShot] = useState(!!captureScreenshot);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<"title" | "desc" | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [audio, setAudio] = useState<AudioPart | null>(null);
  const [video, setVideo] = useState<VideoPart | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recCap = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set once the report itself lands, so a retry after a failed video upload
  // never files the bug twice: it only re-attempts the video.
  const reportedId = useRef<number | null>(null);
  // Set once a widget reporter's ticket lands; the sheet stays open to say so.
  const [sent, setSent] = useState<{ id: number; held: boolean } | null>(null);
  const held = useRef(false);

  const clearRecTimers = () => {
    if (recTimer.current) clearInterval(recTimer.current);
    if (recCap.current) clearTimeout(recCap.current);
    recTimer.current = null;
    recCap.current = null;
  };

  const stopRecording = async (): Promise<AudioPart | null> => {
    if (!audioRecorder) return null;
    clearRecTimers();
    setRecording(false);
    try {
      const part = await audioRecorder.stop();
      if (part) setAudio(part);
      return part;
    } catch {
      setError(t("voiceSaveFailed"));
      return null;
    }
  };

  const startRecording = async () => {
    if (!audioRecorder) return;
    setError(null);
    try {
      await audioRecorder.start();
    } catch {
      setError(t("micOff"));
      return;
    }
    setAudio(null);
    setRecSeconds(0);
    setRecording(true);
    recTimer.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    recCap.current = setTimeout(() => void stopRecording(), AUDIO_MAX_SECONDS * 1000);
  };

  useEffect(() => () => clearRecTimers(), []);

  async function pickVideo() {
    setError(null);
    try {
      const part = await pickDemoVideo();
      if (part) setVideo(part);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("videoPickFailed"));
    }
  }

  async function submit() {
    if (!title.trim()) {
      setError(t("summaryRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let bugTaskId = reportedId.current;
      if (bugTaskId === null) {
        const body = buildContext(
          {
            title: title.trim(),
            description: description.trim() || undefined,
            severity,
          },
          getContext?.(),
          captureProfile
        );
        // Flush an in-progress recording before filing so it isn't lost.
        const voiceNote = recording ? await stopRecording() : audio;
        const res = await client.report(body);
        bugTaskId = res.bugTaskId;
        reportedId.current = bugTaskId;
        held.current = !!res.held;
        if (withShot && captureScreenshot) {
          const shot = await captureScreenshot();
          if (shot) {
            await client.uploadScreenshot(bugTaskId, shot).catch(() => {
              /* report already filed; screenshot is best-effort */
            });
          }
        }
        if (voiceNote) {
          await client.uploadAudioNote(bugTaskId, voiceNote).catch(() => {
            /* report already filed; voice note is best-effort */
          });
        }
      }
      // The demo video is awaited, not best-effort: a failed 150 MB upload
      // must be visible + retryable (Retry re-enters here and skips re-filing).
      if (video) {
        try {
          await uploadDemoVideo(client, bugTaskId, video);
        } catch (e) {
          setError(
            `${e instanceof Error ? e.message : t("videoUploadFailedShort")} ${t("videoRetryHint")}`
          );
          return;
        }
      }
      reportedId.current = null;
      // A member lands back on the app; a reporter gets a word that it arrived.
      if (held.current || reportOnly) setSent({ id: bugTaskId, held: held.current });
      else onReported(bugTaskId);
    } catch {
      setError(t("reportFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent !== null) {
    return (
      <View style={styles.wrap} accessibilityLiveRegion="polite">
        <Text style={styles.sentText}>
          {sent.held ? t("sentHeld") : t("thanks")}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.submit, pressed && styles.pressed]}
          onPress={() => onReported(sent.id)}
          accessibilityRole="button"
        >
          <Text style={styles.submitText}>{t("done")}</Text>
        </Pressable>
      </View>
    );
  }

  const placeholder = theme.c["subtle-foreground"];
  return (
    <View style={styles.wrap}>
      {t.own("intro") ? <Text style={styles.intro}>{t.own("intro")}</Text> : null}
      <Text style={styles.label} nativeID="sq-title">{t("titleField")}</Text>
      <TextInput
        style={[styles.input, focus === "title" && styles.inputFocus]}
        value={title}
        onChangeText={setTitle}
        onFocus={() => setFocus("title")}
        onBlur={() => setFocus(null)}
        placeholder={t("titlePlaceholder")}
        placeholderTextColor={placeholder}
        maxLength={500}
        accessibilityLabelledBy="sq-title"
      />

      <Text style={styles.label} nativeID="sq-desc">{t("detailsLabel")}</Text>
      <TextInput
        style={[styles.input, styles.multiline, focus === "desc" && styles.inputFocus]}
        value={description}
        onChangeText={setDescription}
        onFocus={() => setFocus("desc")}
        onBlur={() => setFocus(null)}
        placeholder={t("detailsPlaceholder")}
        placeholderTextColor={placeholder}
        multiline
        maxLength={50000}
        accessibilityLabelledBy="sq-desc"
      />

      {!reportOnly && (
        <>
          <Text style={styles.label}>{t("severityLabel")}</Text>
          <View style={styles.segment} accessibilityRole="radiogroup">
            {SEVERITIES.map((s) => {
              const active = s === severity;
              return (
                <Pressable
                  key={s}
                  onPress={() => setSeverity(s)}
                  style={[styles.segItem, active && styles.segItemOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                >
                  <View style={[styles.sevDot, { backgroundColor: severityColor(theme, s) }]} />
                  <Text style={[styles.segText, active && styles.segTextOn]}>{t(SEV_KEY[s])}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      {captureScreenshot && (
        <Pressable
          style={styles.checkRow}
          onPress={() => setWithShot((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: withShot }}
        >
          <View style={[styles.checkbox, withShot && styles.checkboxOn]}>
            {withShot ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
          <Text style={styles.checkLabel}>{t("attachScreenshot")}</Text>
        </Pressable>
      )}

      {(audioRecorder || videoAttachAvailable()) && (
        <View style={styles.attachRow}>
          {audioRecorder && (
            <Pressable
              style={({ pressed }) => [styles.ghost, recording && styles.ghostRec, pressed && styles.pressed]}
              onPress={() => (recording ? void stopRecording() : void startRecording())}
              accessibilityRole="button"
            >
              <Text style={[styles.ghostText, recording && styles.ghostTextRec]}>
                {recording ? t("stop", { time: fmtDuration(recSeconds) }) : audio ? t("recordAgain") : t("recordVoiceNote")}
              </Text>
            </Pressable>
          )}
          {videoAttachAvailable() && (
            <Pressable
              style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}
              onPress={() => void pickVideo()}
              accessibilityRole="button"
            >
              <Text style={styles.ghostText}>{video ? t("pickAnotherVideo") : t("attachVideo")}</Text>
            </Pressable>
          )}
        </View>
      )}
      {audio && !recording && (
        <Attached label={t("voiceNote")} onRemove={() => setAudio(null)} />
      )}
      {video && (
        <Attached
          label={`${video.name}, ${(video.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
          onRemove={() => setVideo(null)}
        />
      )}

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      <Pressable
        style={({ pressed }) => [styles.submit, (submitting || pressed) && styles.pressed]}
        onPress={submit}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityState={{ busy: submitting }}
      >
        {submitting ? (
          <ActivityIndicator color={theme.c["signal-foreground"]} />
        ) : (
          <Text style={styles.submitText}>{t("submit")}</Text>
        )}
      </Pressable>
    </View>
  );
}

function Attached({ label, onRemove }: { label: string; onRemove: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
      <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("removeItem", { item: label })}>
        <Text style={styles.chipRemove}>{t("remove")}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(t: Theme) {
  return {
    wrap: { gap: 6, paddingBottom: 8 },
    intro: { color: t.c["muted-foreground"], fontSize: 14, lineHeight: 20, marginBottom: 4 },
    label: { color: t.c["muted-foreground"], fontSize: 13, fontWeight: "500" as const, marginTop: 10 },
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
    inputFocus: { borderColor: t.c.ring, shadowColor: t.c.ring, shadowOpacity: 0.25, shadowRadius: 3 },
    multiline: { minHeight: 96, textAlignVertical: "top" as const },
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
    checkRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, minHeight: 44, marginTop: 4 },
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
    attachRow: { flexDirection: "row" as const, gap: 8 },
    ghost: {
      flex: 1,
      minHeight: 44,
      borderWidth: 1,
      borderColor: t.c.border,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 10,
    },
    ghostRec: { borderColor: t.c.destructive, backgroundColor: t.c["destructive-soft"] },
    ghostText: { color: t.c.foreground, fontSize: 14, fontWeight: "500" as const },
    ghostTextRec: { color: t.c.destructive },
    chip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: t.radius.md,
      backgroundColor: t.c["bg-elev-2"],
    },
    chipText: { flex: 1, color: t.c.foreground, fontSize: 14 },
    chipRemove: { color: t.c.destructive, fontSize: 14, fontWeight: "500" as const },
    error: { color: t.c.destructive, fontSize: 14, lineHeight: 20, marginTop: 6 },
    sentText: { color: t.c.foreground, fontSize: 17, lineHeight: 24, marginTop: 8 },
    submit: {
      minHeight: 48,
      backgroundColor: t.c.signal,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginTop: 14,
    },
    submitText: { color: t.c["signal-foreground"], fontWeight: "600" as const, fontSize: 16 },
    pressed: { opacity: 0.85 },
  };
}
