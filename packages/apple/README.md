# SprintSignals (Apple)

Sprint Signals error logger for **iOS / iPadOS / macOS / tvOS / watchOS**.
Native Swift, no JavaScript runtime, no third-party dependencies.

## Install

Swift Package Manager — in Xcode, **File → Add Package Dependencies**:

```
https://github.com/Hortensia-Agency/sprint-logger
```

Or in a `Package.swift`:

```swift
.package(url: "https://github.com/Hortensia-Agency/sprint-logger", from: "0.1.0")
```

Then add `SprintSignals` to your target.

## Setup

```swift
import SprintSignals

// AppDelegate.didFinishLaunchingWithOptions, or App.init()
SprintSignals.start(.init(
    key: "sk_sig_…",
    release: "1.0.4 (75)"
))
```

The ingest endpoint resolves tenant + project **from the key** — the SDK never
sends a tenant or project id. The key is public-ish (it ships in your binary);
it is a project selector, not a secret.

## Capture

```swift
// Errors
do { try await pay() }
catch {
    SprintSignals.captureException(error, .init(
        route: "RequestLesson",
        userToken: Auth.auth().currentUser?.uid   // opaque id ONLY
    ))
}

// A violated business invariant the SDK can't infer
SprintSignals.captureSignal(
    type: "stripe.mode_mismatch",
    title: "Live publishable key empty in Release build",
    severity: .blocker
)

// Slow operations
let span = SprintSignals.startSpan("uploadSwing", thresholdMs: 5000)
defer { span.finish() }

// HTTP — call from your networking layer
let (data, response) = try await URLSession.shared.data(for: request)
SprintSignals.track(response: response, method: request.httpMethod)

// Breadcrumbs
SprintSignals.addNavigationBreadcrumb("LessonDetail")
```

`userToken` must be pseudonymous — a Firebase uid is ideal. **Never** an email,
phone number, or IP.

### Why `track(response:)` is explicit, not swizzled

Swizzling `URLSession` in a library silently changes the host app's networking,
and apps that already embed Firebase and Stripe have their own interceptors in
that path. One call in your networking layer is cheaper than a class of
heisenbugs.

## Automatic capture

With `captureBreadcrumbs: true` (default) the SDK records app foreground,
background, and memory-warning breadcrumbs. With `captureHttpErrors: true`
(default) any response passed to `track(response:)` with status ≥ 400 becomes an
`http_error` signal.

Device context is attached to every event and is non-identifying by
construction: model identifier (`iPhone16,2` — **not** the user-assigned device
name), OS version, app version, locale, timezone, screen size. No IDFA, no
IDFV, no device name.

## Native crash capture

```swift
SprintSignals.start(.init(key: "sk_sig_…", enableCrashHandler: true))
```

Installs async-signal-safe `sigaction` handlers for `SIGABRT`/`SIGBUS`/`SIGFPE`/
`SIGILL`/`SIGSEGV`/`SIGSYS`/`SIGTRAP`. On crash the handler writes a fixed-size
record with `write(2)` — no malloc, no Swift runtime, no Objective-C — then
re-raises, so the OS crash log and any other reporter (Crashlytics) still see
the signal. The report uploads on the next launch.

The record carries the **binary images** (load address, size, UUID) alongside
the frame addresses. Without those, an address is meaningless: ASLR puts the
same code at a different address every launch.

**Defaults to `false`** — enable it deliberately, and upload your dSYMs (below)
or reports render as raw addresses.

### Uploading dSYMs

Symbolication happens server-side at view time, keyed by the Mach-O **UUID**.
Upload after each build:

```sh
curl -X POST \
  "https://sprint.hortensia-agency.com/api/signals/artifacts/native?name=MyApp&release=1.0.4%20(75)&arch=arm64" \
  -H "X-Signal-Key: sk_sig_…" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"MyApp.app.dSYM/Contents/Resources/DWARF/MyApp"
```

Sprint parses the UUID out of the uploaded binary itself rather than trusting a
parameter — a mismatched UUID would symbolicate against the wrong build and
produce confidently wrong line numbers.

In Xcode Cloud, add this to `ci_scripts/ci_post_xcodebuild.sh`; locally, a Run
Script build phase over `${DWARF_DSYM_FOLDER_PATH}` works.

### Limits

Line numbers come from the DWARF line table (v4 and v5); function names come
from the Mach-O symbol table. Swift names stay **mangled** (`$s…`) — they're
unique and groupable, but not pretty. Frames in Apple's own frameworks stay
unresolved, since those dSYMs aren't yours to upload.

## Offline behaviour

A phone is usually offline exactly when something fails. Events that can't be
sent are spooled to Application Support (excluded from iCloud backup, capped at
100 files, oldest dropped first) and drained on next launch and on every
foreground. `402`/`404`/`422` are permanent for a given build and are dropped
rather than retried; `429` and `5xx` are retried.

## Safety

Capture never throws into your app. Every public method is a no-op before
`start()` and swallows its own failures — a telemetry problem must never become
an application problem.

## License

MIT
