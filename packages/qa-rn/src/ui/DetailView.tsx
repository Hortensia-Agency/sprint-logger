import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { stateColor, useTheme, useThemedStyles, type Theme } from "./theme";
import { stateLabel } from "./QueueView";
import { useStrings, type StringKey, type Translate } from "./strings";
import type { SprintQaClient } from "../client";
import { ExpoAudio, ExpoAudioModern } from "../optional-deps";
import { SprintQaError } from "../client";
import { Lightbox, type LightboxItem } from "./Lightbox";
import {
  pickDemoVideo,
  uploadDemoVideo,
  videoAttachAvailable,
} from "../video";

interface Transcript {
  state: "transcribing" | "done" | "failed" | "parked" | "canceled";
  text: string | null;
  parkReason: "disabled" | "over_cap" | "provider_auth" | null;
  failedReason: "too_long" | "error" | null;
}

interface AudioNote {
  id: number;
  filename: string;
  mimeType: string;
  url: string;
  /** Absent on servers older than transcription. */
  transcript?: Transcript | null;
}

const PARKED: Record<NonNullable<Transcript["parkReason"]>, StringKey> = {
  disabled: "transcriptOff",
  over_cap: "transcriptOverCap",
  provider_auth: "transcriptProviderAuth",
};

function transcriptLine(tr: Transcript, t: Translate): string {
  if (tr.state === "done") return tr.text || t("transcriptEmpty");
  if (tr.state === "transcribing") return t("transcribing");
  if (tr.state === "parked") return t(PARKED[tr.parkReason ?? "disabled"]);
  return tr.failedReason === "too_long" ? t("transcriptTooLong") : t("transcriptFailed");
}

interface TaskDetail {
  task: { id: number; title: string; state: string; description: string | null };
  activeVerifiedCount: number;
  audioNotes?: AudioNote[];
  demoVideos?: { id: number; filename: string; url?: string }[];
  screenshots?: { id: number; filename: string; url: string }[];
  fixer?: { name: string } | null;
  reproContext?: { reproUrl: string | null; staleEnvRetest?: boolean; staleEnvRetestReason?: string | null };
}

export function DetailView({
  client,
  taskId,
  onBack,
  onRecordDemo,
  notice,
}: {
  client: SprintQaClient;
  taskId: number;
  onBack: () => void;
  /** Record the screen and attach it to this task; absent without a recorder. */
  onRecordDemo?: () => void;
  /** A line from the widget about this task, such as a demo uploading. */
  notice?: React.ReactNode;
}) {
  const theme = useTheme();
  const t = useStrings();
  const styles = useThemedStyles(makeStyles);
  const [data, setData] = useState<TaskDetail | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [videoMsg, setVideoMsg] = useState<string | null>(null);
  const [videoBusy, setVideoBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [shown, setShown] = useState<number | null>(null);

  function load() {
    setData(null);
    client
      .taskDetail(taskId)
      .then((d) => setData(d as TaskDetail))
      .catch(() => setError(true));
  }
  useEffect(load, [taskId]);

  function statusOf(e: unknown): number {
    return e instanceof SprintQaError ? e.status : 0;
  }

  async function take() {
    setBusy(true);
    setActionMsg(null);
    try {
      await client.take(taskId);
      load();
    } catch (e) {
      setActionMsg(statusOf(e) === 409 ? t("taskChanged") : t("reviewStartFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function verify(verdict: "verified" | "bug_found") {
    setBusy(true);
    setActionMsg(null);
    try {
      await client.verify(taskId, { verdict, notes: notes.trim() || undefined });
      setNotes("");
      load();
    } catch (e) {
      const status = statusOf(e);
      setActionMsg(
        status === 409 ? t("alreadyVerified") : status === 403 ? t("verifyForbidden") : status === 0 ? t("verdictOffline") : t("verdictFailed")
      );
    } finally {
      setBusy(false);
    }
  }

  async function attachVideo() {
    setVideoMsg(null);
    setVideoBusy(true);
    try {
      const part = await pickDemoVideo();
      if (part) {
        setVideoMsg(t("uploadingVideo"));
        await uploadDemoVideo(client, taskId, part);
        setVideoMsg(null);
        load();
      }
    } catch (e) {
      setVideoMsg(e instanceof Error ? e.message : t("videoUploadFailedShort"));
    } finally {
      setVideoBusy(false);
    }
  }

  if (error) return <Text style={styles.empty}>{t("taskLoadFailed")}</Text>;
  if (!data) {
    return (
      <View style={{ gap: 10, marginTop: 8 }} accessibilityLabel={t("loadingTask")}>
        <View style={[styles.skeleton, { height: 12, width: 60 }]} />
        <View style={[styles.skeleton, { height: 18, width: "80%" }]} />
        <View style={[styles.skeleton, { height: 12, width: "40%" }]} />
        <View style={[styles.skeleton, { height: 64 }]} />
      </View>
    );
  }

  const gallery: LightboxItem[] = [
    ...(data.screenshots ?? []).map((s) => ({ kind: "image" as const, url: s.url, name: s.filename })),
    ...(data.demoVideos ?? []).filter((v) => v.url).map((v) => ({ kind: "video" as const, url: v.url!, name: v.filename })),
  ];

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" style={styles.backHit}>
        <Text style={styles.back}>‹ {t("backToQueue")}</Text>
      </Pressable>
      <Text style={styles.title}>{data.task.title}</Text>
      <View style={styles.stateRow}>
        <View style={[styles.ring, { borderColor: stateColor(theme, data.task.state) }]} />
        <Text style={styles.state}>
          {t("verifiedCount", { state: stateLabel(data.task.state, t), count: data.activeVerifiedCount })}
        </Text>
      </View>
      {data.fixer ? <Text style={styles.meta}>{t("fixedBy", { name: data.fixer.name })}</Text> : null}
      {data.reproContext?.staleEnvRetest ? (
        <Text style={styles.stale}>{data.reproContext.staleEnvRetestReason || t("staleEnv")}</Text>
      ) : null}
      {data.task.description ? (
        <Text style={styles.desc}>{data.task.description}</Text>
      ) : null}

      {gallery.length > 0 && (
        <View style={styles.audioWrap}>
          <Text style={styles.audioHeading}>{t("screenshots")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {gallery.map((g, i) =>
              g.kind === "image" ? (
                <Pressable key={g.url} onPress={() => setShown(i)} accessibilityRole="imagebutton" accessibilityLabel={g.name}>
                  <Image source={{ uri: g.url }} style={styles.thumb} />
                </Pressable>
              ) : null
            )}
          </ScrollView>
        </View>
      )}

      {data.audioNotes && data.audioNotes.length > 0 && (
        <View style={styles.audioWrap}>
          <Text style={styles.audioHeading}>{t("voiceNotes")}</Text>
          {data.audioNotes.map((a) => (
            <View key={a.id}>
              <AudioNotePlayer url={a.url} />
              {a.transcript && a.transcript.state !== "canceled" ? (
                <Text
                  style={a.transcript.state === "done" ? styles.transcript : styles.transcriptMuted}
                  selectable={a.transcript.state === "done"}
                >
                  {transcriptLine(a.transcript, t)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}

      {(videoAttachAvailable() || onRecordDemo || (data.demoVideos && data.demoVideos.length > 0)) && (
        <View style={styles.audioWrap}>
          <Text style={styles.audioHeading}>{t("demoVideos")}</Text>
          {data.demoVideos?.map((v) => {
            const i = gallery.findIndex((g) => g.kind === "video" && g.name === v.filename && g.url === v.url);
            return (
              <Pressable key={v.id} onPress={() => i >= 0 && setShown(i)} disabled={i < 0} accessibilityRole="button">
                <Text style={[styles.videoRow, i >= 0 && styles.videoLink]} numberOfLines={1}>
                  ▶ {v.filename}
                </Text>
              </Pressable>
            );
          })}
          {onRecordDemo && (
            <Pressable style={styles.audioBtn} onPress={onRecordDemo} accessibilityRole="button">
              <Text style={styles.audioBtnText}>{t("recordDemo")}</Text>
            </Pressable>
          )}
          {notice ? <Text style={styles.meta}>{notice}</Text> : null}
          {videoAttachAvailable() && (
            <Pressable
              style={[styles.audioBtn, videoBusy && { opacity: 0.5 }]}
              onPress={() => void attachVideo()}
              disabled={videoBusy}
              accessibilityRole="button"
            >
              <Text style={styles.audioBtnText}>
                {videoBusy ? t("uploading") : t("attachDemoVideo")}
              </Text>
            </Pressable>
          )}
          {videoMsg && <Text style={styles.videoMsg}>{videoMsg}</Text>}
        </View>
      )}

      <TextInput
        style={styles.input}
        value={notes}
        onChangeText={setNotes}
        placeholder={t("notesPlaceholder")}
        placeholderTextColor={theme.c["subtle-foreground"]}
        multiline
      />

      {actionMsg ? (
        <Text style={styles.videoMsg} accessibilityLiveRegion="polite">
          {actionMsg}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.btnGhost]} onPress={take} disabled={busy} accessibilityRole="button">
          <Text style={styles.btnGhostText}>{t("take")}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnDanger]}
          onPress={() => verify("bug_found")}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.btnDangerText}>{t("bugFound")}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnSignal]}
          onPress={() => verify("verified")}
          disabled={busy}
          accessibilityRole="button"
        >
          <Text style={styles.btnSignalText}>{t("verify")}</Text>
        </Pressable>
      </View>
      <Lightbox items={gallery} index={shown} onIndex={setShown} onClose={() => setShown(null)} />
    </ScrollView>
  );
}

/**
 * Tap-to-play voice-note player backed by expo-av's Audio.Sound. When expo-av
 * isn't installed the row renders disabled: playback needs the same peer the
 * recorder uses.
 */
function AudioNotePlayer({ url }: { url: string }) {
  const theme = useTheme();
  const t = useStrings();
  const styles = useThemedStyles(makeStyles);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const soundRef = useRef<any>(null);

  useEffect(
    () => () => {
      void soundRef.current?.unloadAsync?.();
      soundRef.current?.remove?.();
    },
    []
  );

  async function toggle() {
    if (ExpoAudioModern) {
      if (!soundRef.current) {
        soundRef.current = ExpoAudioModern.createAudioPlayer(url);
        soundRef.current.addListener?.("playbackStatusUpdate", (s: { playing?: boolean; didJustFinish?: boolean }) => {
          setPlaying(!!s.playing && !s.didJustFinish);
          if (s.didJustFinish) soundRef.current?.seekTo?.(0);
        });
      }
      if (playing) soundRef.current.pause();
      else soundRef.current.play();
      return;
    }
    if (!ExpoAudio) return;
    try {
      if (soundRef.current) {
        if (playing) {
          await soundRef.current.pauseAsync();
          setPlaying(false);
        } else {
          await soundRef.current.playAsync();
          setPlaying(true);
        }
        return;
      }
      setLoading(true);
      await ExpoAudio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound } = await ExpoAudio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true }
      );
      soundRef.current = sound;
      setPlaying(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sound.setOnPlaybackStatusUpdate((s: any) => {
        if (s?.didJustFinish) setPlaying(false);
      });
    } catch {
      /* playback best-effort */
    } finally {
      setLoading(false);
    }
  }

  const disabled = !ExpoAudio && !ExpoAudioModern;
  return (
    <Pressable
      style={[styles.audioBtn, disabled && { opacity: 0.5 }]}
      onPress={toggle}
      disabled={disabled}
      accessibilityRole="button"
    >
      {loading ? (
        <ActivityIndicator color={theme.c["muted-foreground"]} />
      ) : (
        <Text style={styles.audioBtnText}>
          {disabled ? t("voiceNoteNoPlayer") : playing ? t("pauseVoiceNote") : t("playVoiceNote")}
        </Text>
      )}
    </Pressable>
  );
}

function makeStyles(t: Theme) {
  const btn = {
    flex: 1,
    minHeight: 44,
    borderRadius: t.radius.md,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  return {
    empty: { color: t.c["muted-foreground"], textAlign: "center" as const, marginTop: 32, fontSize: 15 },
    skeleton: { backgroundColor: t.c["bg-elev-2"], borderRadius: t.radius.sm },
    backHit: { alignSelf: "flex-start" as const, minHeight: 32, justifyContent: "center" as const, marginBottom: 8 },
    back: { color: t.c["muted-foreground"], fontSize: 15, fontWeight: "500" as const },
    title: { color: t.c.foreground, fontSize: 20, fontWeight: "600" as const, letterSpacing: -0.2 },
    stateRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, marginTop: 6 },
    ring: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
    state: { color: t.c["muted-foreground"], fontSize: 13 },
    desc: { color: t.c.foreground, fontSize: 15, marginTop: 14, lineHeight: 22 },
    audioWrap: { marginTop: 18, gap: 8 },
    audioHeading: { color: t.c["muted-foreground"], fontSize: 13, fontWeight: "600" as const },
    transcript: { color: t.c.foreground, fontSize: 15, lineHeight: 21, marginTop: 4, marginBottom: 8 },
    transcriptMuted: { color: t.c["muted-foreground"], fontSize: 14, marginTop: 4, marginBottom: 8 },
    audioBtn: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: t.c.border,
      borderRadius: t.radius.md,
      paddingHorizontal: 12,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    audioBtnText: { color: t.c.foreground, fontSize: 14, fontWeight: "500" as const },
    videoRow: { color: t.c.foreground, fontSize: 14, minHeight: 32, textAlignVertical: "center" as const },
    videoLink: { color: t.c.signal, fontWeight: "500" as const },
    thumb: { width: 96, height: 160, borderRadius: t.radius.md, backgroundColor: t.c["bg-elev-2"] },
    meta: { color: t.c["muted-foreground"], fontSize: 13, marginTop: 8 },
    stale: {
      color: t.c.warning,
      backgroundColor: t.c["warning-soft"],
      fontSize: 13,
      lineHeight: 18,
      padding: 10,
      borderRadius: t.radius.md,
      marginTop: 10,
      overflow: "hidden" as const,
    },
    videoMsg: { color: t.c.destructive, fontSize: 13 },
    input: {
      backgroundColor: t.c.input,
      borderWidth: 1,
      borderColor: t.c.border,
      borderRadius: t.radius.md,
      color: t.c.foreground,
      fontSize: 16,
      padding: 12,
      marginTop: 18,
      minHeight: 72,
      textAlignVertical: "top" as const,
    },
    actions: { flexDirection: "row" as const, gap: 8, marginTop: 14 },
    btn,
    btnGhost: { borderWidth: 1, borderColor: t.c.border },
    btnGhostText: { color: t.c.foreground, fontWeight: "600" as const, fontSize: 15 },
    btnDanger: { backgroundColor: t.c["destructive-soft"] },
    btnDangerText: { color: t.c.destructive, fontWeight: "600" as const, fontSize: 15 },
    btnSignal: { backgroundColor: t.c.signal },
    btnSignalText: { color: t.c["signal-foreground"], fontWeight: "600" as const, fontSize: 15 },
  };
}
