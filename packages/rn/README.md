# @sprint-logger/rn

Sprint Signals error logger for **React Native / Expo**. Hooks the global error handler and captures native JS crashes with iOS/Android device context.

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

- `init({ key, release?, origin?, installGlobalHandler?, onError?, deadTap? })` — call once. `deadTap` is the v2 dead-tap detector (see below).
- `captureException(error, ctx?)` / `captureMessage(message, ctx?)`

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
