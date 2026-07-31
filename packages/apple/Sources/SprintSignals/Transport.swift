import Foundation

/// The ingest wire body. Every field is optional except what the chosen
/// signal member requires, matching the server's discriminated union: a body
/// with no `signalType` parses as the `error` member (its `signalType` has
/// `.default("error")`), which is how the error path stays v1-compatible.
struct SignalPayload: Codable, Sendable {
    var signalType: String?
    var message: String?
    var stack: String?
    var type: String?
    var title: String?
    var fingerprint: String?
    var evidence: SignalEvidence?
    var severity: Severity?
    var context: [String: WireValue]?
    var userToken: String?
    var route: String?
    var release: String?
    var breadcrumbs: [Breadcrumb]?
    var httpContext: HttpContext?
    var occurredAt: String?
    var env: DiagnosticContext?
}

/// POSTs payloads to `/api/signals/ingest` and spools to disk on failure.
///
/// Capture must NEVER throw into the host app's hot path, so every method here
/// swallows its errors and reports them through `onError` only.
final class Transport: @unchecked Sendable {
    private let config: SignalsConfig
    private let session: URLSession
    private let spool: Spool
    private let encoder: JSONEncoder

    init(config: SignalsConfig, spool: Spool) {
        self.config = config
        self.spool = spool

        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.timeoutIntervalForRequest = 15
        sessionConfig.timeoutIntervalForResource = 30
        // Telemetry must never compete with the host app's own traffic, and must
        // never keep the radio alive on its own account.
        sessionConfig.networkServiceType = .background
        sessionConfig.waitsForConnectivity = false
        // A dedicated session, NOT URLSession.shared — the URLSession breadcrumb
        // instrumentation swizzles the shared session's delegate path, and using
        // it here would make the SDK observe (and re-report) its own requests.
        self.session = URLSession(configuration: sessionConfig)

        let enc = JSONEncoder()
        // Deterministic key order keeps the on-disk spool diffable in tests.
        enc.outputFormatting = [.sortedKeys]
        self.encoder = enc
    }

    /// Send one payload. On any failure — offline, 5xx, timeout — the payload
    /// is spooled to disk and retried on the next launch or foreground.
    ///
    /// 4xx responses are NOT retried: 402 (unentitled), 404 (bad/disabled key)
    /// and 422 (schema mismatch) are permanent for this build, so retrying them
    /// forever would just burn battery. 429 IS spooled — it's transient.
    func send(_ payload: SignalPayload) async {
        guard let body = try? encoder.encode(payload) else { return }
        await sendRaw(body)
    }

    private func sendRaw(_ body: Data) async {
        guard let url = URL(string: "\(config.origin)/api/signals/ingest") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(config.key, forHTTPHeaderField: "X-Signal-Key")
        req.httpBody = body

        do {
            let (_, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return }

            if (200...299).contains(http.statusCode) { return }

            if http.statusCode == 429 || http.statusCode >= 500 {
                spool.write(body)
                return
            }

            // 4xx other than 429 — permanent. Surface, drop, don't retry.
            config.onError?(SignalsError.ingestRejected(status: http.statusCode))
        } catch {
            // Offline / timeout / DNS — retry later.
            spool.write(body)
            config.onError?(error)
        }
    }

    /// Drain everything the spool holds. Called on init and on foreground.
    /// Sequential rather than concurrent: a device coming back online after a
    /// long offline stretch could hold many events, and the ingest endpoint
    /// rate-limits per key at 60/min — a burst would just earn 429s.
    func drainSpool() async {
        for body in spool.drain() {
            await sendRaw(body)
        }
    }
}

public enum SignalsError: Error, Sendable {
    case ingestRejected(status: Int)
    case notInitialized
}

/// On-disk queue of pending payloads.
///
/// Mobile-specific: a phone is frequently offline exactly when something fails,
/// and a crash report by definition cannot be sent from the crashed process.
/// Files live in Application Support (NOT Caches, which the OS may evict under
/// pressure, and NOT Documents, which is user-visible and iCloud-backed).
final class Spool: @unchecked Sendable {
    private let dir: URL
    private let lock = NSLock()
    private let maxFiles: Int
    private let fm = FileManager.default

    init(subdirectory: String = "SprintSignals", maxFiles: Int = 100) {
        self.maxFiles = maxFiles
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        self.dir = base.appendingPathComponent(subdirectory, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        // Telemetry is not user data — never back it up to iCloud/iTunes.
        var mutableDir = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutableDir.setResourceValues(values)
    }

    /// Directory holding spooled payloads — the crash handler writes here too.
    var directory: URL { dir }

    func write(_ body: Data) {
        lock.lock()
        defer { lock.unlock() }

        // Bound the queue. A host that is offline for a week with a tight error
        // loop must not fill the user's disk; oldest events are dropped first.
        let existing = (try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.creationDateKey]
        )) ?? []
        let payloads = existing.filter { $0.pathExtension == "json" }
        if payloads.count >= maxFiles {
            let sorted = payloads.sorted {
                let a = (try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
                let b = (try? $1.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
                return a < b
            }
            for url in sorted.prefix(payloads.count - maxFiles + 1) {
                try? fm.removeItem(at: url)
            }
        }

        let name = "\(Date().timeIntervalSince1970)-\(UUID().uuidString).json"
        try? body.write(to: dir.appendingPathComponent(name), options: .atomic)
    }

    /// Read and REMOVE every spooled payload. Removal happens up front: a
    /// payload that fails to send is re-spooled by the transport, so a crash
    /// mid-drain loses at most the in-flight event instead of replaying the
    /// whole queue forever.
    func drain() -> [Data] {
        lock.lock()
        defer { lock.unlock() }

        let urls = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        var out: [Data] = []
        for url in urls where url.pathExtension == "json" {
            if let data = try? Data(contentsOf: url) {
                out.append(data)
            }
            try? fm.removeItem(at: url)
        }
        return out
    }
}
