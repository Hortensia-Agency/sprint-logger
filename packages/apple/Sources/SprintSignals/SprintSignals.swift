import Foundation
import SprintSignalsCrash

#if canImport(UIKit)
import UIKit
#endif

/// Sprint Signals SDK for Apple platforms.
///
///     import SprintSignals
///
///     SprintSignals.start(.init(key: "sk_sig_…", release: "1.0.4"))
///
///     do { try await pay() }
///     catch { SprintSignals.captureException(error, .init(route: "RequestLesson")) }
///
/// The ingest endpoint resolves tenant+project FROM THE KEY — this SDK never
/// sends a tenant/project id. Context is pseudonymous only: pass an opaque
/// `userToken` you control, never an email/phone/IP.
///
/// Capture is fire-and-forget and MUST NOT throw into the host app's hot path.
/// Every public method here swallows its own failures.
public enum SprintSignals {
    // Single mutable box guarded by a lock, rather than several independent
    // statics — start()/stop() can race with a capture from another thread.
    private static let stateLock = NSLock()
    nonisolated(unsafe) private static var state: State?

    private struct State {
        let config: SignalsConfig
        let transport: Transport
        let breadcrumbs: BreadcrumbStore
        let spool: Spool
    }

    private static func currentState() -> State? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return state
    }

    // MARK: - Lifecycle

    /// Initialize the SDK. Call once, as early as possible — typically in
    /// `application(_:didFinishLaunchingWithOptions:)` or your `App.init()`.
    ///
    /// Calling twice replaces the configuration (the second call wins) rather
    /// than stacking handlers.
    public static func start(_ config: SignalsConfig) {
        guard !config.key.isEmpty else {
            config.onError?(SignalsError.notInitialized)
            return
        }

        let spool = Spool()
        let newState = State(
            config: config,
            transport: Transport(config: config, spool: spool),
            breadcrumbs: BreadcrumbStore(),
            spool: spool
        )

        stateLock.lock()
        state = newState
        stateLock.unlock()

        // A crash report from the PREVIOUS launch is the whole point of the
        // crash handler — read it before arming this launch's handler, or the
        // fresh install truncates the file we are about to read.
        Task.detached(priority: .utility) {
            await uploadPendingCrashReport(state: newState)
            await newState.transport.drainSpool()
        }

        if config.enableCrashHandler {
            installCrashHandler(spool: spool)
        }

        if config.captureBreadcrumbs {
            installLifecycleObservers()
        }
    }

    /// Tear down: uninstall handlers and drop config. Mainly for tests and for
    /// a host that wants a runtime kill switch.
    public static func stop() {
        sprint_crash_uninstall()
        stateLock.lock()
        state = nil
        stateLock.unlock()
    }

    /// True once `start()` has been called with a non-empty key.
    public static var isStarted: Bool { currentState() != nil }

    // MARK: - Capture (errors)

    /// Capture an error. Fire-and-forget — returns immediately; the POST
    /// happens on a detached task and never surfaces a failure to the caller.
    public static func captureException(
        _ error: Error,
        _ context: CaptureContext = .init()
    ) {
        guard let s = currentState() else { return }
        let ns = error as NSError
        // `localizedDescription` on a bare Swift error yields a useless
        // "The operation couldn't be completed" string, so prefer the concrete
        // type + domain/code, which actually fingerprints distinctly.
        let message = "\(ns.domain) \(ns.code): \(error.localizedDescription)"
        emitError(
            state: s,
            message: message,
            stack: Thread.callStackSymbols.joined(separator: "\n"),
            errorType: String(describing: type(of: error)),
            handled: true,
            context: context
        )
    }

    /// Capture a plain message with no Error object.
    public static func captureMessage(
        _ message: String,
        _ context: CaptureContext = .init()
    ) {
        guard let s = currentState() else { return }
        emitError(
            state: s,
            message: message,
            stack: nil,
            errorType: nil,
            handled: true,
            context: context
        )
    }

    private static func emitError(
        state s: State,
        message: String,
        stack: String?,
        errorType: String?,
        handled: Bool,
        context: CaptureContext
    ) {
        var payload = SignalPayload()
        payload.message = String(message.prefix(2000))
        payload.stack = stack.map { String($0.prefix(20000)) }
        payload.userToken = context.userToken
        payload.route = context.route
        payload.severity = context.severity
        payload.release = s.config.release
        payload.breadcrumbs = context.breadcrumbs ?? nonEmpty(s.breadcrumbs.all())
        payload.httpContext = context.httpContext
        payload.occurredAt = iso8601Now()
        payload.env = DeviceContext.current(handled: handled, errorType: errorType)

        send(payload, using: s)
    }

    // MARK: - Capture (Signals v2 — non-error)

    /// Assert an app-level problem the SDK cannot infer — a violated business
    /// invariant. Emits a `custom` signal; fingerprint seeded by `type`.
    ///
    /// Keep `type` low-cardinality: it is the fingerprint seed, so embedding an
    /// id in it creates one group per id instead of one group per problem.
    public static func captureSignal(
        type: String,
        title: String,
        severity: Severity? = nil,
        fingerprint: String? = nil,
        context: [String: WireValue]? = nil,
        route: String? = nil,
        userToken: String? = nil
    ) {
        guard let s = currentState(), !type.isEmpty, !title.isEmpty else { return }

        var payload = SignalPayload()
        payload.signalType = SignalType.custom.rawValue
        payload.type = String(type.prefix(200))
        payload.title = String(title.prefix(500))
        payload.fingerprint = fingerprint.map { String($0.prefix(200)) }
        payload.severity = severity
        payload.context = context
        payload.route = route
        payload.userToken = userToken
        payload.release = s.config.release
        payload.breadcrumbs = nonEmpty(s.breadcrumbs.all())
        payload.occurredAt = iso8601Now()
        payload.env = DeviceContext.current(handled: true)

        send(payload, using: s)
    }

    /// Report a failed HTTP call as an `http_error` signal. Called
    /// automatically by `track(response:)`; also available directly.
    public static func captureHttpError(
        method: String,
        path: String,
        status: Int,
        route: String? = nil
    ) {
        guard let s = currentState() else { return }

        var payload = SignalPayload()
        payload.signalType = SignalType.httpError.rawValue
        payload.title = "\(method) \(path) → \(status)"
        payload.evidence = SignalEvidence(
            http: .init(method: method, path: path, status: status)
        )
        payload.severity = status >= 500 ? .high : .medium
        payload.route = route
        payload.release = s.config.release
        payload.breadcrumbs = nonEmpty(s.breadcrumbs.all())
        payload.occurredAt = iso8601Now()
        payload.env = DeviceContext.current(handled: true)

        send(payload, using: s)
    }

    /// Time an operation; emit a `slow_operation` signal if it exceeds
    /// `thresholdMs`. Under threshold, nothing is emitted.
    ///
    ///     let span = SprintSignals.startSpan("uploadSwing", thresholdMs: 5000)
    ///     defer { span.finish() }
    public static func startSpan(
        _ op: String,
        thresholdMs: Int = 1000
    ) -> Span {
        Span(op: op, thresholdMs: thresholdMs)
    }

    /// A running timer. `finish()` is idempotent and safe to call from a
    /// `defer` block.
    public final class Span: @unchecked Sendable {
        private let op: String
        private let thresholdMs: Int
        private let started: DispatchTime
        private let lock = NSLock()
        private var finished = false

        init(op: String, thresholdMs: Int) {
            self.op = op
            self.thresholdMs = thresholdMs
            self.started = .now()
        }

        public func finish(_ extra: [String: WireValue]? = nil) {
            lock.lock()
            if finished { lock.unlock(); return }
            finished = true
            lock.unlock()

            guard let s = SprintSignals.currentState() else { return }
            let elapsedMs = Int(
                (DispatchTime.now().uptimeNanoseconds &- started.uptimeNanoseconds) / 1_000_000
            )
            guard elapsedMs >= thresholdMs else { return }

            var payload = SignalPayload()
            payload.signalType = SignalType.slowOperation.rawValue
            payload.title = "\(op) took \(elapsedMs)ms"
            payload.type = "slow:\(op)"
            payload.evidence = SignalEvidence(
                op: op, valueMs: elapsedMs, threshold: thresholdMs
            )
            payload.severity = .medium
            payload.context = extra
            payload.release = s.config.release
            payload.occurredAt = SprintSignals.iso8601Now()
            payload.env = DeviceContext.current(handled: true)

            SprintSignals.send(payload, using: s)
        }
    }

    // MARK: - Breadcrumbs

    /// Add a breadcrumb manually. Bounded to the last 50.
    public static func addBreadcrumb(_ crumb: Breadcrumb) {
        currentState()?.breadcrumbs.add(crumb)
    }

    /// Convenience: record a screen/route change. The mobile analogue of the
    /// web SDK's navigation crumb.
    public static func addNavigationBreadcrumb(_ screen: String) {
        addBreadcrumb(.init(category: .navigation, message: screen, level: .info))
    }

    /// Record a completed URLSession call as a breadcrumb, and — when the
    /// status is >= 400 and `captureHttpErrors` is on — as an `http_error`
    /// signal. Call from your networking layer:
    ///
    ///     let (data, response) = try await URLSession.shared.data(for: req)
    ///     SprintSignals.track(response: response, method: req.httpMethod)
    ///
    /// This is explicit rather than swizzled: swizzling URLSession in a library
    /// silently changes the host app's networking behaviour, and Tap Inn's
    /// Firebase/Stripe SDKs already install their own interceptors.
    public static func track(
        response: URLResponse?,
        method: String? = nil,
        route: String? = nil
    ) {
        guard let http = response as? HTTPURLResponse else { return }
        let path = scrubURL(http.url) ?? "unknown"
        let verb = method ?? "GET"

        addBreadcrumb(.init(
            category: .fetch,
            message: "\(verb) \(path) → \(http.statusCode)",
            level: http.statusCode >= 400 ? .error : .info
        ))

        guard let s = currentState(), s.config.captureHttpErrors else { return }
        if http.statusCode >= 400 {
            captureHttpError(
                method: verb,
                path: path,
                status: http.statusCode,
                route: route
            )
        }
    }

    // MARK: - Crash handling

    private static func installCrashHandler(spool: Spool) {
        let path = spool.directory
            .appendingPathComponent("crash.pending")
            .path
        _ = path.withCString { sprint_crash_install($0) }
    }

    /// Read a crash record left by the previous launch, convert it to a normal
    /// error payload, and send it. Runs from a healthy process — none of the
    /// async-signal-safety constraints apply here.
    private static func uploadPendingCrashReport(state s: State) async {
        let url = s.spool.directory.appendingPathComponent("crash.pending")
        guard let data = try? Data(contentsOf: url) else { return }
        // Remove first: a malformed record must not be retried forever.
        try? FileManager.default.removeItem(at: url)

        guard
            let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let signo = raw["signal"] as? Int
        else { return }

        let frames = (raw["frames"] as? [String]) ?? []
        let images = (raw["images"] as? [[String: Any]]) ?? []
        let name = signalName(signo)

        var payload = SignalPayload()
        payload.message = "Fatal signal \(name) (\(signo))"
        // Emitted in the server's native-stack format: each frame is
        // `#N  <imageName>  <runtimeAddress>`, followed by a Binary Images
        // section carrying (base, size, uuid) per image. The server needs those
        // to undo ASLR — a runtime address alone is unresolvable.
        payload.stack = frames.isEmpty ? nil : nativeStack(frames: frames, images: images)
        payload.severity = .blocker
        payload.release = s.config.release
        payload.occurredAt = (raw["at"] as? Double).map {
            ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: $0))
        } ?? iso8601Now()

        payload.env = DeviceContext.current(handled: false, errorType: name)
        payload.context = [
            "crash": true,
            "symbolicated": false,
            "signal": .string(name),
        ]
        // Address is useful for EXC_BAD_ACCESS triage even unsymbolicated.
        if let addr = raw["address"] as? Double, addr > 0 {
            payload.context?["faultAddress"] = .string(
                "0x" + String(UInt64(addr), radix: 16)
            )
        }

        await s.transport.send(payload)
    }

    /// Render frames + images in the Apple crash-report shape the server's
    /// native symbolicator parses. Deliberately close to the real `.crash`
    /// format so it is readable as-is when symbolication is unavailable.
    ///
    ///     #0  MyApp  0x0000000102f4c1a8
    ///     #1  MyApp  0x0000000102f4b0c4
    ///
    ///     Binary Images:
    ///     0x102f44000 - 0x102f8bfff MyApp <a1b2…>
    private static func nativeStack(frames: [String], images: [[String: Any]]) -> String {
        var lines: [String] = []

        for (i, addr) in frames.enumerated() {
            let value = UInt64(addr.dropFirst(2), radix: 16) ?? 0
            let owner = images.first { img in
                guard
                    let base = (img["base"] as? NSNumber)?.uint64Value,
                    let size = (img["size"] as? NSNumber)?.uint64Value,
                    size > 0
                else { return false }
                return value >= base && value < base &+ size
            }
            let name = (owner?["name"] as? String) ?? "???"
            lines.append("#\(i)\t\(name)\t\(addr)")
        }

        guard !images.isEmpty else { return lines.joined(separator: "\n") }

        lines.append("")
        lines.append("Binary Images:")
        for img in images {
            guard
                let base = (img["base"] as? NSNumber)?.uint64Value,
                let name = img["name"] as? String
            else { continue }
            let size = (img["size"] as? NSNumber)?.uint64Value ?? 0
            let uuid = (img["uuid"] as? String) ?? ""
            let end = size > 0 ? base &+ size &- 1 : base
            lines.append(
                "0x\(String(base, radix: 16)) - 0x\(String(end, radix: 16)) \(name) <\(uuid)>"
            )
        }
        return lines.joined(separator: "\n")
    }

    private static func signalName(_ signo: Int) -> String {
        switch signo {
        case Int(SIGABRT): return "SIGABRT"
        case Int(SIGBUS): return "SIGBUS"
        case Int(SIGFPE): return "SIGFPE"
        case Int(SIGILL): return "SIGILL"
        case Int(SIGSEGV): return "SIGSEGV"
        case Int(SIGSYS): return "SIGSYS"
        case Int(SIGTRAP): return "SIGTRAP"
        default: return "SIG\(signo)"
        }
    }

    // MARK: - Lifecycle observers

    private static func installLifecycleObservers() {
        #if canImport(UIKit)
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: nil
        ) { _ in
            addBreadcrumb(.init(category: .navigation, message: "app.foreground", level: .info))
            // Coming back online is the moment a spooled event can finally go
            // out — the single highest-value retry trigger on mobile.
            if let s = currentState() {
                Task.detached(priority: .utility) { await s.transport.drainSpool() }
            }
        }

        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: nil
        ) { _ in
            addBreadcrumb(.init(category: .navigation, message: "app.background", level: .info))
        }

        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: nil
        ) { _ in
            addBreadcrumb(.init(category: .console, message: "memory.warning", level: .warning))
        }
        #endif
    }

    // MARK: - Helpers

    private static func send(_ payload: SignalPayload, using s: State) {
        Task.detached(priority: .utility) {
            await s.transport.send(payload)
        }
    }

    private static func nonEmpty(_ crumbs: [Breadcrumb]) -> [Breadcrumb]? {
        crumbs.isEmpty ? nil : crumbs
    }

    fileprivate static func iso8601Now() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
