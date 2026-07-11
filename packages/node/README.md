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

## Capture more than errors (v2)

Signals now catches bugs that never throw — violated server invariants, slow endpoints/queries, N+1s — through the same pipeline (group → inbox → triage → task → QA closes it). v1 above is unchanged; v2 is additive.

```ts
import { captureSignal, startSpan, trackNPlusOne } from "@sprint-logger/node";

// violated server invariant the SDK can't infer
await captureSignal({ type: "invoice.total-mismatch", title: "Invoice total ≠ line items", severity: "high" });

// time an op → emits `slow_operation` ONLY if it exceeds thresholdMs (default 1000)
const span = startSpan("db.report", 2000);
await runReport();
span.finish();

// N+1 detector — call query() per DB call; finish() emits a `perf` signal if any shape ran > threshold (default 10) times
const nq = trackNPlusOne("/api/orders");
for (const o of orders) { nq.query("SELECT * FROM line_items WHERE order_id = $1"); /* ... */ }
nq.finish();
```

- `captureSignal({ type, title, severity?, fingerprint?, context?, route?, userToken? })` — `type` is the stable low-cardinality fingerprint seed.
- `startSpan(op, thresholdMs?)` → `{ finish(extra?) }`.
- `trackNPlusOne(route, threshold?)` → `{ query(shape), finish() }`.

**Next.js App Router server-error bridge** (Server Components / Route Handlers / middleware / Server Actions) — one line in `instrumentation.ts`:

```ts
export { captureRequestError as onRequestError } from "@sprint-logger/node";
```

## Privacy

Pseudonymous only — message, normalized stack, opaque `userToken` (never PII), route/release, and non-identifying env (platform `node`, OS, runtime version, server timezone/locale). Never reads `os.hostname`. The server rejects PII.

MIT
