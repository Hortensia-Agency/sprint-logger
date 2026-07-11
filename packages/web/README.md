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

- `init(key, { release?, origin?, installGlobalHandlers?, onError?, detectDeadClicks?, captureHttpErrors?, capturePerf?, captureConsoleErrors? })` — call once. A missing/invalid key is a silent no-op. SSR-safe. The four `capture*`/`detect*` flags are v2 auto-detectors, all default `true`.
- `capture(error, { route?, severity?, userToken?, breadcrumbs? })` — manual capture (`handled: true`).
- `captureMessage(message, ctx?)` — capture a string.

## Capture more than errors (v2)

Signals now catches bugs that never throw — dead/rage clicks, silent HTTP failures, slow ops — through the same pipeline (group → inbox → triage → task → QA closes it). v1 above is unchanged; v2 is additive.

**Auto-detectors** — on by default via `init` flags, set `false` to disable:

- `detectDeadClicks` — absence-of-effect detector (dead + rage clicks).
- `captureHttpErrors` — emits an `http_error` signal on a handled 4xx/5xx (+404).
- `capturePerf` — emits a `perf` signal when long-task/LCP/INP/CLS exceeds its Core-Web-Vitals "good" threshold.
- `captureConsoleErrors` — auto-captures every `console.error` as a low-severity error signal (retroactively covers caught-and-logged errors, zero edits). May surface existing logs on first upgrade → set `false` or mute the group if noisy.

**Assert an app-level problem the SDK can't infer:**

```ts
import { captureSignal, startSpan } from "@sprint-logger/web";

// business-invariant violation
captureSignal({ type: "cart.empty-after-add", title: "Cart empty after add", severity: "high" });

// time an op — emits `slow_operation` ONLY if it exceeds thresholdMs (default 1000)
const span = startSpan("checkout.submit", 1500);
await submit();
span.finish({ items: cart.length });
```

- `captureSignal({ type, title, severity?, fingerprint?, context?, route?, userToken? })` — `type` is the stable low-cardinality fingerprint seed.
- `startSpan(op, thresholdMs?)` → `{ finish(extra?) }`.

**React 19 boundary bridge** — boundary-caught render errors never reach `window.onerror`, so wire once:

```ts
import { signalsReactErrorHandler } from "@sprint-logger/web";
createRoot(el, { onCaughtError: signalsReactErrorHandler(), onUncaughtError: signalsReactErrorHandler() });
```

## Privacy

Pseudonymous only. Sends message, normalized stack, an opaque per-browser `userToken` (never an email/name/IP), route/release, and non-identifying env (platform, OS, browser, device, timezone, locale, viewport, network, `handled`, error type). The server rejects PII.

The `sk_sig_…` key is a project selector, not a secret — mint it in your Sprint project's Signals settings.

MIT
