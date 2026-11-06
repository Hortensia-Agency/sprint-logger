# @sprint-logger/qa-rn

Sprint's QA widget for React Native / Expo host apps: in-context bug reporting
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
# optional, each one turns a feature on (the widget hides what's missing):
pnpm add react-native-view-shot              # screenshots
pnpm add react-native-svg                    # marking up screenshots, drawing while recording
pnpm add expo-audio                          # voice notes: recording and playback
pnpm add react-native-nitro-screen-recorder  # recording the screen
pnpm add expo-video                          # playing a recording back to trim it
pnpm add expo-image-picker expo-file-system  # picking a photo or video, uploading videos
pnpm add expo-web-browser expo-crypto        # Sign in with Sprint
```

Voice notes use `expo-audio`. Apps on older Expo SDKs that only have the
deprecated `expo-av` still get recording and playback through it; when both
are installed, `expo-audio` is used.

Mount once near the app root, inside a `GestureHandlerRootView`.

## Two host controls + the guard chain

Visibility is decided every launch (and on foreground / interval). The widget
renders **only** when the whole chain passes; otherwise it silently returns
nothing (no FAB, no network).

**Host controls (yours):**

- **Build-time bundle gate: `EXPO_PUBLIC_ENABLE_SPRINT_QA`.** Your own baked-in
  env, gating the mount. Decides whether the widget is even *shipped*. Changing
  it requires a rebuild. This is the dev's "include it or not" switch.
- **Runtime config from your OWN backend: `fetchConfig`.** The **no-rebuild
  kill switch.** Your app fetches `{ widgetKey, enabled }` from your backend at
  launch. Flip `enabled` to false in your backend, drop the key, or repoint the
  app at a backend env that lacks those vars → **the widget disappears on the
  next fetch. No rebuild, no store update.** A throw or null return is treated
  as off (fail-safe).

**Sprint-side guards (driven live by `/api/widget/config`):**

- **L1: `enabled`.** The project's `widget_enabled` toggle (a Sprint manager's
  per-project kill switch).
- **L2: host match.** `host` must be in the project's `qa_urls`.
- **L3: identity.** A valid `mobile_widget` PAT (paste prompt if absent).

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
          // runtime config from YOUR backend, the no-rebuild switch:
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
key), the widget hides on the next launch/foreground, or within
`refreshIntervalMs` if you set it. No app rebuild.

### Static key (known at build time)

If you don't have a backend config endpoint, pass `widgetKey` directly. You then
only have Sprint's `widget_enabled` toggle as the no-rebuild switch:

```tsx
<SprintQaWidget widgetKey="pk_qa_xxxxxxxx" host="my-app-staging" />
```

## Auto-captured repro context

Every report carries context so the dev has a repro starting point:

- **Captured by the SDK automatically:** viewport (`Dimensions`) and a
  device/OS string (`ReactNative/<os> <version>`). No wiring needed.
- **Supplied by you via `getContext`:** the SDK can't see your current screen
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
Sprint denies it on the next call. That's the only fast kill switch (see
below).

## The look, and each person's switch (v0.5.0+, drag to hide v0.7.0+)

The widget draws with Sprint's own tokens, in light and dark, following the
device unless the project picks one. Everything else about its look comes from
the project's **Appearance** settings in Sprint (QA settings): accent color,
corners, the bubble's icon, size, side and label, the pages it hides on, and
the panel's wording. It arrives with the config call, so it changes without a
rebuild.

Pass `route` so the project's hidden pages apply:

```tsx
<SprintQaWidget
  host="my-app"
  widgetKey={process.env.EXPO_PUBLIC_SPRINT_QA_KEY}
  route={currentRouteName}
/>
```

`visible={false}` hides the bubble and the sheet without remounting the
widget, for reasons of your app's own.

### Hiding the bubble, and bringing it back (v0.7.0+)

People hide the bubble themselves: while it is dragged, a **Drop to hide**
target rises at the bottom of the screen, and dropping the bubble on it hides
it, with a short notice that offers Undo. Screen reader users get the same as a
"Hide button" action on the bubble. The choice is stored on the device
(AsyncStorage, key `sprint-qa-hidden`), survives restarts, and never reaches
Sprint. Nothing draws until it has loaded, so a hidden bubble never flashes on
launch.

Your settings screen turns it back on. Give it a switch bound to the stored
value:

```tsx
import { Switch } from "react-native";
import { setSprintQaHidden, useSprintQaHidden } from "@sprint-logger/qa-rn";

function ReportButtonSetting() {
  const hidden = useSprintQaHidden(); // null while loading
  return (
    <Switch
      value={hidden === false}
      disabled={hidden === null}
      onValueChange={(on) => void setSprintQaHidden(!on)}
    />
  );
}
```

The switch follows a drop on the target at once, and the bubble comes back as
soon as the switch is turned on. `getSprintQaHidden()` reads the value outside
React.

### Setting the look and the text in code (v0.6.0+)

Anything you set in code wins over the project's Appearance settings, field by
field, so the widget can follow your app's own theme, brand and language:

```tsx
<SprintQaWidget
  host="my-app"
  widgetKey={process.env.EXPO_PUBLIC_SPRINT_QA_KEY}
  appearance={{
    accent: { light: "#0F766E" },
    radius: "round",
    bubble: { icon: "chat", side: "left" },
    colors: {
      light: { background: "#F4F7F6", "bg-elev-1": "#FFFFFF", foreground: "#111827" },
      dark: { "bg-elev-1": "#111315" },
    },
  }}
  strings={i18n.locale === "fr" ? { tabReport: "Signaler", submit: "Envoyer" } : undefined}
  dir={i18n.dir}   // "rtl" mirrors the sheet; defaults to I18nManager
/>
```

- **`appearance`** takes the same fields as the Appearance settings, plus
  `colors`: any token from `TokenName` as hex, per theme (`background`,
  `bg-elev-1` for the sheet, `foreground`, `muted-foreground`, `primary`,
  `border`, the `signal` accent family and the status colors). Sprint checks
  contrast on the result; if text would be unreadable it ignores your override,
  keeps the project's look and logs why with `console.warn`.
- **`strings`** replaces any text by key. `STRINGS` (exported) lists every key
  with its English default; keys you leave out stay English. `{slots}` such as
  `{time}` are filled in. `title` and `intro` set the sheet's title and a line
  above the form.
- **`dir`** mirrors the sheet for right to left languages. It follows the app's
  own direction (`I18nManager.isRTL`) when left out. The bubble keeps the side
  you or the project chose.

Changing any of these at runtime takes effect straight away; `appearance`
refetches the config.

## What auto-updates vs what needs a rebuild

The **data/auth contract** (endpoints, config, tenant resolution) updates live:
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

## Demo videos (v0.4.0+)

Testers can attach an OS-recorded screen clip (iOS Control Center recorder /
Android screen record) to a bug report or to a task they're verifying. Needs
both optional peers `expo-image-picker` (the library picker) and
`expo-file-system` (the upload); without them the control never renders.

- Upload is a presigned direct PUT to Sprint's storage, streamed **from disk**
  via `FileSystem.uploadAsync`. The clip never enters the JS heap, so a
  150 MB video can't OOM the host app. Never replace this path with
  `fetch(uri)` + blob.
- Caps: 150 MB per clip (server-enforced twice: at presign and by a
  size-verify after upload) plus a per-tenant demo-storage quota.
- **HEVC caveat**: iOS records HEVC/H.265 by default ("High Efficiency"), and
  some Android OEM recorders do too. Sprint stores the clip either way, but
  desktop browsers generally can't play HEVC. If a clip won't play on the
  task page, re-record with HEVC off (iOS: Settings → Camera → Formats →
  Most Compatible). There is no server-side transcoding.
