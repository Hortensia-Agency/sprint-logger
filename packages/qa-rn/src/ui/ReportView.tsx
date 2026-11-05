import React, { useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useTheme, useThemedStyles, type Theme } from "./theme";
import { useStrings } from "./strings";
import { fmtDuration } from "./VoiceNotes";
import type { VideoPart } from "../video";

/**
 * The Report tab: a launcher, as on the web. Pick how to show the problem and
 * a full-screen review collects the rest. "Write it down" covers a host with
 * no capture tools installed.
 */
export function ReportLauncher({
  route,
  canScreenshot,
  canRecord,
  canPickPhoto,
  canPickVideo,
  withMic,
  onWithMic,
  onScreenshot,
  onRecord,
  onPickPhoto,
  onPickVideo,
  onWrite,
  message,
}: {
  route?: string;
  canScreenshot: boolean;
  canRecord: boolean;
  canPickPhoto: boolean;
  canPickVideo: boolean;
  withMic: boolean;
  onWithMic: (v: boolean) => void;
  onScreenshot: () => void;
  onRecord: () => void;
  onPickPhoto: () => void;
  onPickVideo: () => void;
  onWrite: () => void;
  message: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const t = useStrings();
  const { width, height } = useWindowDimensions();
  return (
    <View style={styles.wrap}>
      {t.own("intro") ? <Text style={styles.intro}>{t.own("intro")}</Text> : null}
      <View style={styles.ctx} accessibilityLabel={t("pageLabel")}>
        <Text style={styles.ctxText} numberOfLines={1}>
          {route || "/"}
        </Text>
        <Text style={styles.ctxText}>
          {Math.round(width)} × {Math.round(height)}
        </Text>
      </View>

      {canScreenshot ? <Launch glyph="◫" title={t("takeScreenshot")} sub={t("takeScreenshotSub")} onPress={onScreenshot} /> : null}
      {canRecord ? (
        <>
          <Launch glyph="●" title={t("recordVideo")} sub={t("recordVideoSub")} onPress={onRecord} />
          <View style={styles.micRow}>
            <Text style={styles.micText}>{t("narrateWithMic")}</Text>
            <Switch
              value={withMic}
              onValueChange={onWithMic}
              trackColor={{ true: theme.c.signal, false: theme.c["bg-elev-2"] }}
              accessibilityLabel={t("narrateWithMic")}
            />
          </View>
        </>
      ) : null}
      {canPickPhoto ? <Launch glyph="▣" title={t("choosePhoto")} sub={t("choosePhotoSub")} onPress={onPickPhoto} /> : null}
      {canPickVideo ? <Launch glyph="▶" title={t("chooseVideo")} sub={t("chooseVideoSub")} onPress={onPickVideo} /> : null}
      {!canScreenshot && !canRecord && !canPickPhoto ? (
        <Launch glyph="✎" title={t("tabReport")} sub={t("detailsPlaceholder")} onPress={onWrite} />
      ) : null}

      {message ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
    </View>
  );
}

function Launch({ glyph, title, sub, onPress }: { glyph: string; title: string; sub: string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      style={({ pressed }) => [styles.launch, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}`}
    >
      <View style={styles.glyph}>
        <Text style={styles.glyphText}>{glyph}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.launchTitle}>{title}</Text>
        <Text style={styles.launchSub}>{sub}</Text>
      </View>
    </Pressable>
  );
}

/** What a widget reporter sees once the ticket is in. */
export function SentView({ held, onDone }: { held: boolean; onDone: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const t = useStrings();
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <Text style={styles.sentText}>{held ? t("sentHeld") : t.own("thanks") ?? t("thanks")}</Text>
      <Pressable style={({ pressed }) => [styles.submit, pressed && styles.pressed]} onPress={onDone} accessibilityRole="button">
        <Text style={styles.submitText}>{t("done")}</Text>
      </Pressable>
    </View>
  );
}

export interface DemoDraft {
  title: string;
  description: string;
  video: VideoPart | null;
}

/**
 * The Demo tab (team members only): a walkthrough for the project's demo
 * library, not bug evidence. The draft lives in the widget, so leaving to
 * record and coming back keeps what was typed.
 */
export function DemoView({
  draft,
  onDraft,
  canRecord,
  withMic,
  onWithMic,
  onRecord,
  onPublish,
}: {
  draft: DemoDraft;
  onDraft: (d: DemoDraft) => void;
  canRecord: boolean;
  withMic: boolean;
  onWithMic: (v: boolean) => void;
  onRecord: () => void;
  onPublish: () => Promise<string | null>;
}) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const t = useStrings();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const placeholder = theme.c["subtle-foreground"];

  const publish = async () => {
    if (!draft.title.trim()) {
      setMsg({ text: t("demoNeedsTitle"), ok: false });
      return;
    }
    setBusy(true);
    setMsg(null);
    const error = await onPublish();
    setBusy(false);
    setMsg(error ? { text: error, ok: false } : { text: t("demoPublished"), ok: true });
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.intro}>{t("demoIntro")}</Text>
      <Text style={styles.label}>{t("demoTitle")}</Text>
      <TextInput
        style={styles.input}
        value={draft.title}
        onChangeText={(title) => onDraft({ ...draft, title })}
        placeholder={t("demoTitlePlaceholder")}
        placeholderTextColor={placeholder}
        maxLength={200}
      />
      <Text style={styles.label}>{t("demoDescription")}</Text>
      <TextInput
        style={[styles.input, styles.area]}
        value={draft.description}
        onChangeText={(description) => onDraft({ ...draft, description })}
        placeholder={t("demoDescriptionPlaceholder")}
        placeholderTextColor={placeholder}
        multiline
      />
      {draft.video ? (
        <View style={styles.chip}>
          <Text style={styles.chipText}>{t("demoRecordingReady", { time: fmtDuration(draft.video.durationSec ?? 0) })}</Text>
          <Pressable onPress={() => onDraft({ ...draft, video: null })} hitSlop={10} accessibilityRole="button">
            <Text style={styles.chipRemove}>{t("remove")}</Text>
          </Pressable>
        </View>
      ) : canRecord ? (
        <>
          <Launch glyph="●" title={t("recordVideo")} sub={t("demoIntro")} onPress={onRecord} />
          <View style={styles.micRow}>
            <Text style={styles.micText}>{t("narrateWithMic")}</Text>
            <Switch
              value={withMic}
              onValueChange={onWithMic}
              trackColor={{ true: theme.c.signal, false: theme.c["bg-elev-2"] }}
              accessibilityLabel={t("narrateWithMic")}
            />
          </View>
        </>
      ) : null}
      {msg ? <Text style={msg.ok ? styles.ok : styles.error}>{msg.text}</Text> : null}
      <Pressable
        style={({ pressed }) => [styles.submit, (!draft.video || busy) && styles.disabled, pressed && styles.pressed]}
        onPress={() => void publish()}
        disabled={!draft.video || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !draft.video, busy }}
      >
        {busy ? <ActivityIndicator color={theme.c["signal-foreground"]} /> : <Text style={styles.submitText}>{t("publishDemo")}</Text>}
      </Pressable>
    </View>
  );
}

function makeStyles(t: Theme) {
  return {
    wrap: { gap: 8, paddingBottom: 8 },
    intro: { color: t.c["muted-foreground"], fontSize: 14, lineHeight: 20 },
    ctx: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: t.radius.md,
      backgroundColor: t.c["bg-elev-2"],
    },
    ctxText: { color: t.c["muted-foreground"], fontSize: 12, flexShrink: 1, fontVariant: ["tabular-nums" as const] },
    launch: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      minHeight: 64,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: t.radius.lg,
      borderWidth: 1,
      borderColor: t.c.border,
      backgroundColor: t.c["bg-elev-1"],
    },
    glyph: {
      width: 40,
      height: 40,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: t.c["signal-soft"],
    },
    glyphText: { color: t.c.signal, fontSize: 18, fontWeight: "700" as const },
    launchTitle: { color: t.c.foreground, fontSize: 16, fontWeight: "600" as const },
    launchSub: { color: t.c["muted-foreground"], fontSize: 13, lineHeight: 18 },
    micRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      minHeight: 44,
      paddingHorizontal: 4,
    },
    micText: { color: t.c.foreground, fontSize: 15 },
    label: { color: t.c["muted-foreground"], fontSize: 13, fontWeight: "500" as const, marginTop: 6 },
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
    area: { minHeight: 80, textAlignVertical: "top" as const },
    chip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 12,
      borderRadius: t.radius.md,
      backgroundColor: t.c["bg-elev-2"],
    },
    chipText: { flex: 1, color: t.c.foreground, fontSize: 14, fontVariant: ["tabular-nums" as const] },
    chipRemove: { color: t.c.destructive, fontSize: 14, fontWeight: "500" as const },
    error: { color: t.c.destructive, fontSize: 14, lineHeight: 20, marginTop: 4 },
    ok: { color: t.c.success, fontSize: 14, lineHeight: 20, marginTop: 4 },
    sentText: { color: t.c.foreground, fontSize: 17, lineHeight: 24, marginTop: 8 },
    submit: {
      minHeight: 48,
      backgroundColor: t.c.signal,
      borderRadius: t.radius.md,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginTop: 10,
    },
    submitText: { color: t.c["signal-foreground"], fontWeight: "600" as const, fontSize: 16 },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.85 },
  };
}
