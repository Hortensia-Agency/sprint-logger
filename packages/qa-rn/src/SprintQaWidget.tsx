/**
 * <SprintQaWidget> — the single component a host RN app mounts (once, near the
 * app root, inside a GestureHandlerRootView). It owns the full guard chain and
 * the FAB → bottom-sheet → views flow.
 *
 * TWO INDEPENDENT HOST CONTROLS:
 *
 *   1. Build-time bundle gate (L0) — the host's OWN env, baked into the binary
 *      at EAS build time. Decides whether the widget is even mounted. Cannot
 *      change without a rebuild. This is the dev's "ship it or not" switch.
 *
 *        {process.env.EXPO_PUBLIC_ENABLE_SPRINT_QA === "true" && <SprintQaWidget … />}
 *
 *   2. Runtime config from the HOST'S OWN BACKEND — the no-rebuild kill switch.
 *      The host fetches { widgetKey, enabled } from its own API at launch (and
 *      optionally re-polls). Pass a `fetchConfig` thunk wired to that backend.
 *      When the host backend flips enabled→false, drops the key, or the app is
 *      repointed to a backend env without those vars, the widget DISAPPEARS on
 *      the next fetch — no rebuild, OTA-style.
 *
 *        <SprintQaWidget
 *          host="my-app-staging"
 *          fetchConfig={async () => {
 *            const r = await fetch(MY_BACKEND + "/mobile-config").then(x => x.json());
 *            return { widgetKey: r.sprintQaKey, enabled: r.sprintQaEnabled };
 *          }}
 *          refreshIntervalMs={60000}
 *        />
 *
 * Static usage (key known at build time) is still supported via `widgetKey`.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { Fab } from "./ui/Fab";
import { BottomSheet } from "./ui/BottomSheet";
import { ReportView } from "./ui/ReportView";
import { makeAudioRecorder, type AudioRecorder } from "./audio";
import { QueueView } from "./ui/QueueView";
import { DetailView } from "./ui/DetailView";
import { PatGate } from "./ui/PatGate";
import type { OAuthDeps } from "./oauth";
import { SprintQaClient } from "./client";
import { hostMatches, passesL0, isPatShape, resolveHostKey } from "./config";
import { loadPat, savePat } from "./storage";
import type { HostContext } from "./context";
import type { WidgetConfig } from "./contract";

type Screen = "report" | "queue" | "detail";

/** What the host's backend hands the widget at runtime. */
export interface HostRuntimeConfig {
  /** Sprint widget key (pk_qa_…). Absent/empty → widget hidden. */
  widgetKey?: string | null;
  /** Host-side enable flag. false/absent → widget hidden. */
  enabled?: boolean;
}

export interface SprintQaWidgetProps {
  /** Host identifier matched against the project's qa_urls (L2). */
  host: string;
  origin?: string;
  enabledByHost?: boolean;
  /**
   * Deep-link URI Sprint redirects back to after OAuth sign-in (e.g.
   * "stellify://sprint-qa"). Required to enable the "Sign in with Sprint"
   * button; omit and the gate falls back to manual PAT paste only. Must be an
   * app scheme allowlisted server-side.
   */
  redirectUri?: string;
  /**
   * Host-resolved OAuth native modules: `{ WebBrowser, ExpoCrypto }`. Pass these
   * when the SDK can't resolve `expo-web-browser` / `expo-crypto` itself — under
   * strict pnpm the SDK's own require may miss host peers even though the host
   * resolves them fine. Injected deps win over the SDK's internal require.
   * Omit if the SDK resolves them on its own.
   */
  oauthDeps?: OAuthDeps;
  /**
   * Static widget key, when known at build time. Prefer `fetchConfig` for the
   * runtime/no-rebuild kill switch. If both are given, `fetchConfig` wins.
   */
  widgetKey?: string;
  /**
   * Runtime config thunk, wired to the HOST's own backend. Returning
   * { enabled:false } or a null/empty widgetKey hides the widget. A throw or
   * null return is treated as "off" (fail-safe). Re-invoked on mount, on app
   * foreground, and every `refreshIntervalMs` if set.
   */
  fetchConfig?: () => Promise<HostRuntimeConfig | null>;
  /** Re-poll the host backend this often (ms). Omit to fetch only on mount + foreground. */
  refreshIntervalMs?: number;
  /** Optional S4 screenshot capture — returns a RN file part or null. */
  captureScreenshot?: () => Promise<{ uri: string; name: string; type: string } | null>;
  /**
   * Optional voice-note recorder. Defaults to an expo-av-backed recorder when
   * `expo-av` is installed; pass your own to override, or `null` to disable
   * the control even when expo-av is present.
   */
  audioRecorder?: AudioRecorder | null;
  /**
   * Optional host-context thunk, read at report time. The SDK can't see the
   * host's current route on its own — pass it here (typically from React
   * Navigation / Expo Router) so each report carries the screen it was filed
   * from. Viewport + OS/device are captured automatically without this.
   */
  getContext?: () => HostContext | undefined;
}

export function SprintQaWidget(props: SprintQaWidgetProps) {
  // Voice-note recorder: host override wins; `null` disables; otherwise fall
  // back to the expo-av recorder (itself null when expo-av isn't installed).
  // Stable across renders so an in-progress recording survives re-renders.
  const recorderRef = useRef<AudioRecorder | null | undefined>(undefined);
  if (recorderRef.current === undefined) {
    recorderRef.current =
      props.audioRecorder !== undefined
        ? props.audioRecorder
        : makeAudioRecorder();
  }

  // L0 — build-time bundle gate (host's own baked-in env). Cannot change at
  // runtime; if false the widget is fully inert.
  const l0 = passesL0({
    widgetKey: props.widgetKey ?? "",
    host: props.host,
    pat: null,
    enabledByHost: props.enabledByHost,
  });

  // The Sprint client is rebuilt whenever the resolved widget key changes (the
  // host backend can hand us a different key, or none). Keyed by the active key.
  const [activeKey, setActiveKey] = useState<string | null>(props.widgetKey ?? null);
  const clientRef = useRef<{ key: string; client: SprintQaClient } | null>(null);
  if (activeKey && clientRef.current?.key !== activeKey) {
    clientRef.current = {
      key: activeKey,
      client: new SprintQaClient({
        widgetKey: activeKey,
        host: props.host,
        origin: props.origin,
        pat: null,
      }),
    };
  }
  const client = activeKey ? clientRef.current!.client : null;

  const [remoteConfig, setRemoteConfig] = useState<WidgetConfig | null>(null);
  const [hostOff, setHostOff] = useState(false); // host backend says off / no key
  const [gated, setGated] = useState(false); // Sprint L1/L2 failed
  const [hasPat, setHasPat] = useState(false);
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>("report");
  const [taskId, setTaskId] = useState<number | null>(null);

  // ── Runtime evaluation: host backend → key → Sprint L1/L2 ──────────────
  // Re-runnable so the host backend flipping enabled/key (or repointing the
  // app at a backend without those vars) hides/shows the widget WITHOUT a
  // rebuild. Fail-safe: any error or missing value → off.
  const evaluate = useCallback(async () => {
    if (!l0) return;
    // 1. Resolve host runtime config (from the host's OWN backend).
    let key = props.widgetKey?.trim() || null;
    if (props.fetchConfig) {
      let hc: HostRuntimeConfig | null = null;
      try {
        hc = await props.fetchConfig();
      } catch {
        hc = null; // host backend unreachable / no vars → off (fail-safe)
      }
      key = resolveHostKey(hc);
    }
    if (!key) {
      setHostOff(true);
      setRemoteConfig(null);
      return;
    }
    setHostOff(false);
    setActiveKey(key);

    // 2. Sprint-side L1 (enabled) + L2 (host in qa_urls), via the client bound
    //    to the resolved key. clientRef is updated synchronously above when
    //    activeKey changes; read it directly to avoid a render-lag race.
    const c =
      clientRef.current?.key === key
        ? clientRef.current.client
        : new SprintQaClient({
            widgetKey: key,
            host: props.host,
            origin: props.origin,
            pat: null,
          });
    try {
      const rc = await c.config();
      if (!rc.enabled || !hostMatches(props.host, rc.qaUrls)) {
        setGated(true);
        setRemoteConfig(null);
        return;
      }
      setGated(false);
      setRemoteConfig(rc);
    } catch {
      setGated(true); // 404 / no-oracle → silent no-render
      setRemoteConfig(null);
    }
  }, [l0, props.widgetKey, props.fetchConfig, props.host, props.origin]);

  // Evaluate on mount + whenever evaluate's deps change.
  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  // Re-evaluate when the app returns to the foreground (catches a host-backend
  // flip that happened while backgrounded) — the cheap OTA-style refresh.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s: string) => {
      if (s === "active") void evaluate();
    });
    return () => sub.remove();
  }, [evaluate]);

  // Optional polling cadence for hosts that want sub-foreground responsiveness.
  useEffect(() => {
    if (!props.refreshIntervalMs) return;
    const id = setInterval(() => void evaluate(), props.refreshIntervalMs);
    return () => clearInterval(id);
  }, [evaluate, props.refreshIntervalMs]);

  // L3 — load any stored PAT once a client exists.
  useEffect(() => {
    if (!client) return;
    let alive = true;
    loadPat().then((p) => {
      if (!alive) return;
      if (isPatShape(p)) {
        client.setPat(p);
        setHasPat(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [client]);

  function onPatSubmit(pat: string) {
    client?.setPat(pat);
    void savePat(pat);
    setHasPat(true);
  }

  if (!l0 || hostOff || gated || !remoteConfig || !client) return null;
  const activeClient = client; // narrowed past the guard above

  const openSheet = () => {
    setScreen("report");
    setTaskId(null);
    setOpen(true);
  };

  const renderBody = () => {
    if (!hasPat)
      return (
        <PatGate
          onSubmit={onPatSubmit}
          origin={props.origin}
          widgetKey={activeKey ?? ""}
          redirectUri={props.redirectUri}
          oauthDeps={props.oauthDeps}
        />
      );
    if (screen === "detail" && taskId != null) {
      return (
        <DetailView
          client={activeClient}
          taskId={taskId}
          onBack={() => setScreen("queue")}
        />
      );
    }
    if (screen === "queue") {
      return (
        <QueueView
          client={activeClient}
          onOpenTask={(id) => {
            setTaskId(id);
            setScreen("detail");
          }}
        />
      );
    }
    return (
      <>
        <Tabs screen={screen} onChange={setScreen} />
        <ReportView
          client={activeClient}
          captureScreenshot={props.captureScreenshot}
          audioRecorder={recorderRef.current}
          getContext={props.getContext}
          onReported={() => setOpen(false)}
        />
      </>
    );
  };

  return (
    <>
      <Fab onPress={openSheet} />
      <BottomSheet visible={open} onClose={() => setOpen(false)}>
        <View>{renderBody()}</View>
      </BottomSheet>
    </>
  );
}

function Tabs({
  screen,
  onChange,
}: {
  screen: Screen;
  onChange: (s: Screen) => void;
}) {
  return (
    <View style={tabStyles.row}>
      <Pressable
        style={[tabStyles.tab, screen === "report" && tabStyles.active]}
        onPress={() => onChange("report")}
      >
        <Text style={tabStyles.text}>Report</Text>
      </Pressable>
      <Pressable
        style={[tabStyles.tab, screen === "queue" && tabStyles.active]}
        onPress={() => onChange("queue")}
      >
        <Text style={tabStyles.text}>Queue</Text>
      </Pressable>
    </View>
  );
}

const tabStyles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, marginBottom: 12 },
  tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 },
  active: { backgroundColor: "#6d5cff" },
  text: { color: "#ececf2", fontWeight: "600" },
});
