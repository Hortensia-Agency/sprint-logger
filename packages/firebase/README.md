# @sprint-logger/firebase

Sprint Signals error logger for **Firebase Cloud Functions v2**.

Re-exports the entire `@sprint-logger/node` surface (`captureException`,
`captureSignal`, `startSpan`, `addBreadcrumb`, `trackNPlusOne`, `trackEvent`, …)
and adds trigger-aware wrappers that capture what process-level handlers can't.

```sh
pnpm add @sprint-logger/firebase
```

## Why a wrapper

In Functions v2 a throw out of a Firestore trigger is caught by the runtime
(which retries it), so `uncaughtException` never fires and the error is
invisible to Signals. These wrappers capture at the handler boundary — the only
place the error is observable — and re-throw the original error so Firebase's
retry and dead-lettering behaviour is completely unchanged.

They also **await** the capture before re-throwing. A Cloud Functions container
can be frozen the instant a handler's promise settles, which kills an in-flight
POST — so fire-and-forget capture silently drops events under low traffic.

## Setup

```js
const { init } = require("@sprint-logger/firebase");

init({
  key: process.env.SPRINT_SIGNALS_KEY,
  release: process.env.K_REVISION,     // Cloud Run revision — free release tag
  captureBreadcrumbs: true,
});
```

Store the key in Secret Manager via `defineSecret`, not in source.

> **Note on `captureConsoleErrors`:** the underlying node SDK captures
> `console.error` by default. If your handlers log heavily inside `try/catch`,
> the first deploy will surface those existing logs as signals. Set it to
> `false` in `init()` if you want errors only.

## Wrappers

Wrap the **handler**, then pass it to the trigger builder — not the other way
round. Wrapping the built function replaces the trigger definition object
Firebase needs at deploy time, and the function silently fails to deploy.

```js
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { wrapEvent, wrapCallable, wrapScheduled, wrapHttp } =
  require("@sprint-logger/firebase");

exports.userCreated = onDocumentCreated(
  "users/{id}",
  wrapEvent("userCreated", async (event) => { /* ... */ })
);

exports.acceptLesson = onCall(
  wrapCallable("acceptLesson", async (request) => { /* ... */ })
);

exports.notifyOnlinePros = onSchedule(
  "every 5 minutes",
  wrapScheduled("notifyOnlinePros", async () => { /* ... */ })
);

exports.stripeWebhook = onRequest(
  wrapHttp("stripeWebhook", async (req, res) => { /* ... */ })
);
```

| Wrapper | Trigger | Default severity | Extra behaviour |
|---|---|---|---|
| `wrapEvent` | Firestore / Storage / PubSub | `high` | infers `userToken` from a single path wildcard |
| `wrapCallable` | `onCall` | `high` | infers `userToken` from `request.auth.uid` |
| `wrapHttp` | `onRequest` | `high` | also captures a **non-throwing 5xx** as `http_error` |
| `wrapScheduled` | `onSchedule` | `blocker` | cron jobs fail silently — nobody is watching |

### Options

```js
wrapEvent("processUpload", handler, {
  severity: "blocker",
  slowAfterMs: 10_000,                       // emit slow_operation past this
  userToken: (event) => event.data?.get("user-id"),   // opaque id ONLY
});
```

`userToken` must be pseudonymous — a uid, never an email/phone/IP.

## Manual capture

Everything from `@sprint-logger/node` is available from this package directly:

```js
const { captureException, captureSignal, startSpan } =
  require("@sprint-logger/firebase");

// A violated business invariant the SDK can't infer:
captureSignal({
  type: "payment.orphaned",
  title: "Charge succeeded but no purchase record written",
  severity: "blocker",
});

const span = startSpan("firestore.batchWrite", 2000);
try { await batch.commit(); } finally { span.finish(); }
```

Inside a Cloud Function always **`await`** a manual capture, for the freeze
reason above.

## License

MIT
