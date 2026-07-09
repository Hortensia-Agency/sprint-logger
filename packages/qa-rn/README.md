# @sprint-logger/qa-rn

Sprint's QA widget for React Native / Expo host apps — in-context bug reporting
and a QA work queue, embedded as a movable FAB + bottom sheet.

This is the native counterpart to Sprint's web QA widget (`qa-widget.js`). It
talks to the **same `/api/widget/*` contract**, but authenticates differently:
native can't use the web SDK's cross-origin cookie probe, so it uses a
**`mobile_widget` Personal Access Token** the tester pastes in once per device.

## Install

```sh
pnpm add @sprint-logger/qa-rn
# peer deps (most Expo apps already have the first three):
pnpm add react-native-gesture-handler react-native-reanimated \
  @react-native-async-storage/async-storage
# optional — only if you want screenshot capture:
pnpm add react-native-view-shot
```

Mount once near the app root, inside a `GestureHandlerRootView`.

## Two host controls + the guard chain

Visibility is decided every launch (and on foreground / interval). The widget
renders **only** when the whole chain passes — otherwise it silently returns
nothing (no FAB, no network).

**Host controls (yours):**

- **Build-time bundle gate — `EXPO_PUBLIC_ENABLE_SPRINT_QA`.** Your own baked-in
  env, gating the mount. Decides whether the widget is even *shipped*. Changing
  it requires a rebuild. This is the dev's "include it or not" switch.
- **Runtime config from your OWN backend — `fetchConfig`.** The **no-rebuild
  kill switch.** Your app fetches `{ widgetKey, enabled }` from your backend at
  launch. Flip `enabled` to false in your backend, drop the key, or repoint the
  app at a backend env that lacks those vars → **the widget disappears on the
  next fetch. No rebuild, no store update.** A throw or null return is treated
  as off (fail-safe).

**Sprint-side guards (driven live by `/api/widget/config`):**

- **L1 — `enabled`.** The project's `widget_enabled` toggle (a Sprint manager's
  per-project kill switch).
- **L2 — host match.** `host` must be in the project's `qa_urls`.
- **L3 — identity.** A valid `mobile_widget` PAT (paste prompt if absent).

### Recommended: runtime config from your backend (no-rebuild kill switch)

```tsx
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SprintQaWidget, makeScreenshotCapture } from "@sprint-logger/qa-rn";
import { useRef } from "react";

export default function App() {
  const rootRef = useRef(null);
  return (
    <GestureHandlerRootView style={{ flex: 1 }} ref={rootRef}>
      <YourApp />
      {/* build-time bundle gate */}
      {process.env.EXPO_PUBLIC_ENABLE_SPRINT_QA === "true" && (
        <SprintQaWidget
          host="my-app-staging"                 // must be in the project's qa_urls
          // runtime config from YOUR backend — the no-rebuild switch:
          fetchConfig={async () => {
            const r = await fetch(MY_BACKEND + "/mobile-config").then((x) => x.json());
            return { widgetKey: r.sprintQaKey, enabled: r.sprintQaEnabled };
          }}
          refreshIntervalMs={60_000}            // optional: re-check every minute
          captureScreenshot={makeScreenshotCapture(rootRef)}
          getContext={() => ({ route: currentRouteName() })}
        />
      )}
    </GestureHandlerRootView>
  );
}
```

When your backend stops returning `sprintQaEnabled:true` (or stops returning the
key), the widget hides on the next launch/foreground — or within
`refreshIntervalMs` if you set it. No app rebuild.

### Static key (known at build time)

If you don't have a backend config endpoint, pass `widgetKey` directly. You then
only have Sprint's `widget_enabled` toggle as the no-rebuild switch:

```tsx
<SprintQaWidget widgetKey="pk_qa_xxxxxxxx" host="my-app-staging" />
```

## Auto-captured repro context

Every report carries context so the dev has a repro starting point:

- **Captured by the SDK automatically** — viewport (`Dimensions`) and a
  device/OS string (`ReactNative/<os> <version>`). No wiring needed.
- **Supplied by you via `getContext`** — the SDK can't see your current screen
  (only your navigation library knows it), so pass it in. The thunk is read at
  report time, so the route is always current:

  ```tsx
  getContext={() => ({
    route: navigationRef.getCurrentRoute()?.name,   // → task repro link
    extra: { userId: session?.id, build: Constants.expoConfig?.version },
  })}
  ```

  `route` becomes the task's repro location; `extra` is folded into the
  auto-captured context comment. Both are optional.

## The PAT flow (per tester, per device)

1. In Sprint: **Settings → Personal access tokens → Mint → Type: "Mobile QA
   widget"**, pick the tenant, copy the `sprint_pat_…` token (shown once).
2. In the app: tap the QA FAB → paste the token in the "Connect" prompt. It
   persists per-device (AsyncStorage); you won't be asked again.

The token is **tenant-scoped and expires** (default 90 days). Revoking it in
Sprint denies it on the next call — that's the only fast kill switch (see
below).

## What auto-updates vs what needs a rebuild

The **data/auth contract** (endpoints, config, tenant resolution) updates live —
Sprint can change server behavior and your installed app picks it up. The
**UI is compiled into your binary at EAS build time**: there is no
`<script src>` to hot-load like the web widget. So a UI change in this package
means: bump the version → `eas build` → store review → user update.

**Security implication:** a fix to *client-side* widget code can't be hot-pushed
to devices. The fast mitigations are server-side and don't wait on a rebuild:
revoke the tester's PAT, or flip the project's `widget_enabled` off (L1). The
mandatory PAT expiry bounds the blast radius of a leaked-but-unrevoked token.

## Screenshot PII warning

A captured screenshot is visible to everyone on the project's QA roster (the
same tenant). Don't surface capture on screens showing other users' personal
data without a redaction step. Capture is always tester-initiated and optional
(omit `react-native-view-shot` to disable it entirely).
