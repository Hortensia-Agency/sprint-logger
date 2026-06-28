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

- `init({ key, release?, origin?, installGlobalHandler?, onError? })` — call once.
- `captureException(error, ctx?)` / `captureMessage(message, ctx?)`

## Optional peers

- `expo-device` → adds `deviceModel`.
- `@react-native-async-storage/async-storage` → persists the pseudonymous `userToken` across launches.

Both optional — absent → graceful degradation, never a crash.

## Privacy

Pseudonymous only — message, stack, opaque `userToken` (never PII), and non-identifying env (platform `ios`/`android`, OS version, device model, timezone, locale). The server rejects PII.

MIT
