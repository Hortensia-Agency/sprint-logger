# @sprint-logger/rn

Sprint Signals error logger for **React Native / Expo**. Captures JS crashes, Reanimated worklet errors, and unhandled promise rejections, with iOS/Android device context.

```sh
npm i @sprint-logger/rn
```

```ts
import { init, captureException } from "@sprint-logger/rn";

// once, before first render (e.g. App.tsx)
await init({ key: "sk_sig_xxx", release: "1.4.0" });

try { await sync(); }
catch (e) { captureException(e, { route: "OrdersScreen" }); }
```

## API

- `init({ key, release?, origin?, installGlobalHandler?, onError?, deadTap?, ... })` — call once. `deadTap` is the v2 dead-tap detector (see below).
- `captureException(error, ctx?)` / `captureMessage(message, ctx?)`

## Crash coverage (0.2.0)

0.1.x hooked only `ErrorUtils.setGlobalHandler`, which sees the **main JS runtime** and nothing else. Three classes of real crash were invisible; all three are captured now, each with its own opt-out.

| Option | Default | What it covers |
|---|---|---|
| `captureWorkletErrors` | `true` | Errors thrown inside **Reanimated worklets**, which run in a *separate* JS runtime on the UI thread. `ErrorUtils` cannot observe these at all — an infinite-recursion scroll handler would kill the app silently. No-op when Reanimated isn't installed. |
| `captureUnhandledRejections` | `true` | Unhandled promise rejections. RN routes these through its own tracking hook, not `ErrorUtils`. |
| `persistCrashes` | `true` | Writes an **uncaught** error to storage *before* sending, and flushes it at the next `init()`. A crash that tears down the runtime mid-request is reported on the following launch instead of being lost. Recovered reports carry `context.deliveredOnNextLaunch`. |
| `captureConsoleErrors` | `false` | Treats every `console.error(...)` as a signal, not just a breadcrumb. **Off by default** (the web SDK defaults it on): enabling it changes reported volume for an existing app and double-reports any `catch { console.error(e); throw e }`. Opt in deliberately. |

### Delivery failures are loud

`onError` is now optional in a meaningful way: **omit it and the SDK logs one console warning per distinct failure** (bad key, `402` un-entitled, `404` unknown project, `422` rejected payload, network error). Previously a missing handler — or the common `onError: () => {}` — made every failure indistinguishable from success.

```ts
await init({ key: "sk_sig_xxx" });                 // failures are visible
await init({ key: "sk_sig_xxx", onError: () => {} }); // explicit opt-out
await init({ key: "sk_sig_xxx", onError: (e) => Sentry.captureException(e) });
```

### Known limit

This release is **pure JS with no native module**. A hard native crash — an OOM kill, a segfault in a native library, or a JSI/C++ abort that terminates the process in the same tick — can still outrun the JS that would report it, because even the storage write is asynchronous. `persistCrashes` closes the common case (a fatal JS error that unwinds over several ticks), not the instant-abort case. True parity there requires a native crash handler; that is tracked separately.

## Capture more than errors (v2)

Signals now catches bugs that never throw — dead taps, violated invariants, slow ops — through the same pipeline (group → inbox → triage → task → QA closes it). v1 above is unchanged; v2 is additive.

**Dead-tap detector** — pass your touch primitives once at `init`; they're auto-patched (zero per-button work) and report a tap on a touchable with no usable `onPress`. A patch failure degrades to no-op, never a crash.

```ts
import { Pressable, TouchableOpacity } from "react-native";

await init({
  key: "sk_sig_xxx",
  deadTap: { components: { Pressable, TouchableOpacity }, enabled: true },
});
```

- `deadTap: { components, enabled? }` — `enabled` is a runtime kill switch: wire it to a fetched config flag to disable WITHOUT an EAS rebuild. (The detector is compiled into the binary; a behaviour change needs a version bump + rebuild — `enabled`/revoking is the fast mitigation.)

**Assert / time / route:**

```ts
import { captureSignal, startSpan, setRoute } from "@sprint-logger/rn";

await captureSignal({ type: "sync.stuck", title: "Sync stuck > 30s", severity: "high" });

const span = startSpan("orders.load", 1500); // emits `slow_operation` ONLY if over thresholdMs (default 1000)
await load();
span.finish();

setRoute("OrdersScreen"); // RN has no location.pathname — feed the current screen so evidence carries it
```

- `captureSignal({ type, title, severity?, fingerprint?, context?, route?, userToken? })` — `type` is the stable low-cardinality fingerprint seed.
- `startSpan(op, thresholdMs?)` → `{ finish(extra?) }`.
- `setRoute(route)` — `navigationBreadcrumb()` also calls this automatically.

## Dependencies

- `expo-device` and `@react-native-async-storage/async-storage` are **real dependencies** (installed automatically) — they must be statically importable so Metro resolves them. `expo-device` adds `deviceModel`; async-storage persists the pseudonymous `userToken` across launches.
- `react-native` stays a peer.

## Privacy

Pseudonymous only — message, stack, opaque `userToken` (never PII), and non-identifying env (platform `ios`/`android`, OS version, device model, timezone, locale). The server rejects PII.

MIT
