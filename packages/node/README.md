# @sprint-logger/node

Sprint Signals error logger for **Node services**. Captures uncaught exceptions + unhandled rejections, plus manual capture around boundaries.

```sh
npm i @sprint-logger/node
```

```ts
import { init, captureException } from "@sprint-logger/node";

// once, at process boot
init({ key: process.env.SPRINT_SIGNALS_KEY!, release: process.env.GIT_SHA });

try { await chargeCard(order); }
catch (e) {
  captureException(e, { route: "/api/checkout", severity: "high" });
  throw e; // observe, don't swallow
}
```

## API

- `init({ key, release?, origin?, installGlobalHandlers?, onError? })` — call once. Invalid key = silent no-op; never throws into boot.
- `captureException(error, { route?, severity?, userToken?, breadcrumbs? })`
- `captureMessage(message, ctx?)`

## Privacy

Pseudonymous only — message, normalized stack, opaque `userToken` (never PII), route/release, and non-identifying env (platform `node`, OS, runtime version, server timezone/locale). Never reads `os.hostname`. The server rejects PII.

MIT
