# @sprint-logger/web

Sprint Signals error logger for **bundled browser apps** (Next.js, Vite, CRA, Astro). Import and `init()` once — no `<script>` tag.

```sh
npm i @sprint-logger/web
```

```ts
import { init, capture, captureMessage } from "@sprint-logger/web";

// once, at app start (e.g. Next.js instrumentation-client.ts)
init("sk_sig_xxx", { release: "1.2.3" });

// uncaught errors + unhandled rejections are captured automatically.
// for handled errors:
try { await save(); }
catch (e) { capture(e, { route: "/editor", severity: "high" }); }
```

## API

- `init(key, { release?, origin?, installGlobalHandlers?, onError? })` — call once. A missing/invalid key is a silent no-op. SSR-safe.
- `capture(error, { route?, severity?, userToken?, breadcrumbs? })` — manual capture (`handled: true`).
- `captureMessage(message, ctx?)` — capture a string.

## Privacy

Pseudonymous only. Sends message, normalized stack, an opaque per-browser `userToken` (never an email/name/IP), route/release, and non-identifying env (platform, OS, browser, device, timezone, locale, viewport, network, `handled`, error type). The server rejects PII.

The `sk_sig_…` key is a project selector, not a secret — mint it in your Sprint project's Signals settings.

MIT
