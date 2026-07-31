import Foundation

/// Severity band. Mirrors the server's `severity` enum.
public enum Severity: String, Codable, Sendable {
    case low, medium, high, blocker
}

/// A single breadcrumb — one thing that happened before an error.
///
/// Mirrors the server's `BreadcrumbSchema` (lib/signals/context.ts) BY HAND:
/// this package has no dependency on the Sprint monorepo, so the wire shape is
/// duplicated, not imported. Keep the SDKs (web/rn/node/firebase/apple) in
/// lock-step — a category the server's zod enum rejects drops the whole event.
public struct Breadcrumb: Codable, Sendable {
    public enum Category: String, Codable, Sendable {
        case console, click, navigation, fetch, xhr
    }

    public enum Level: String, Codable, Sendable {
        case debug, info, warning, error
    }

    public var category: Category
    public var type: String?
    public var level: Level?
    public var message: String?
    /// ms epoch — advisory ordering only.
    public var timestamp: Int?
    public var data: [String: WireValue]?

    public init(
        category: Category,
        message: String? = nil,
        level: Level? = nil,
        type: String? = nil,
        timestamp: Int? = Int(Date().timeIntervalSince1970 * 1000),
        data: [String: WireValue]? = nil
    ) {
        self.category = category
        self.message = message
        self.level = level
        self.type = type
        self.timestamp = timestamp
        self.data = data
    }
}

/// The failing HTTP request context. NO headers/body/cookies — by contract.
public struct HttpContext: Codable, Sendable {
    public var method: String?
    public var url: String?
    public var status: Int?
    public var durationMs: Int?

    public init(method: String? = nil, url: String? = nil, status: Int? = nil, durationMs: Int? = nil) {
        self.method = method
        self.url = url
        self.status = status
        self.durationMs = durationMs
    }
}

/// Non-error signal types (Signals v2). `error` is implicit — an event with no
/// `signalType` parses as the error member server-side.
public enum SignalType: String, Codable, Sendable {
    case httpError = "http_error"
    case slowOperation = "slow_operation"
    case perf
    case custom
    case meta
    case deadClick = "dead_click"
    case rageClick = "rage_click"
}

/// Evidence attached to a non-error signal.
public struct SignalEvidence: Codable, Sendable {
    public struct Http: Codable, Sendable {
        public var method: String
        public var path: String
        public var status: Int

        public init(method: String, path: String, status: Int) {
            self.method = method
            self.path = path
            self.status = status
        }
    }

    public var http: Http?
    public var op: String?
    public var valueMs: Int?
    public var threshold: Int?
    public var reason: String?

    public init(
        http: Http? = nil,
        op: String? = nil,
        valueMs: Int? = nil,
        threshold: Int? = nil,
        reason: String? = nil
    ) {
        self.http = http
        self.op = op
        self.valueMs = valueMs
        self.threshold = threshold
        self.reason = reason
    }
}

/// A JSON-encodable scalar. The wire's `context` and breadcrumb `data` maps
/// accept string|number|boolean|null only — this models exactly that, so an
/// unencodable value is a compile error rather than a silently dropped field.
public enum WireValue: Codable, Sendable, ExpressibleByStringLiteral,
    ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByFloatLiteral, ExpressibleByNilLiteral
{
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null

    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(nilLiteral: ()) { self = .null }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Int.self) { self = .int(v); return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        self = .string(try c.decode(String.self))
    }
}

/// Diagnostic context. Mirrors the server's `DiagnosticContextSchema`, which is
/// `.strict()` — an unknown key fails validation and drops the event. Only add
/// fields here that exist in that schema.
public struct DiagnosticContext: Codable, Sendable {
    public var platform: String?
    public var osName: String?
    public var osVersion: String?
    public var appVersion: String?
    public var deviceModel: String?
    public var timezone: String?
    public var utcOffset: Int?
    public var locale: String?
    public var screen: Dimensions?
    public var viewport: Dimensions?
    public var networkType: String?
    public var handled: Bool?
    public var errorType: String?
    public var runtimeVersion: String?

    public struct Dimensions: Codable, Sendable {
        public var w: Int
        public var h: Int

        public init(w: Int, h: Int) {
            self.w = w
            self.h = h
        }
    }

    public init() {}
}

/// Per-capture context. `userToken` must be pseudonymous — an opaque id you
/// control, NEVER an email/phone/IP (D6). A Firebase uid is a good choice.
public struct CaptureContext: Sendable {
    public var userToken: String?
    public var route: String?
    public var severity: Severity?
    public var breadcrumbs: [Breadcrumb]?
    public var httpContext: HttpContext?

    public init(
        userToken: String? = nil,
        route: String? = nil,
        severity: Severity? = nil,
        breadcrumbs: [Breadcrumb]? = nil,
        httpContext: HttpContext? = nil
    ) {
        self.userToken = userToken
        self.route = route
        self.severity = severity
        self.breadcrumbs = breadcrumbs
        self.httpContext = httpContext
    }
}

/// SDK configuration.
public struct SignalsConfig: Sendable {
    /// Project ingest key, `sk_sig_…`.
    public var key: String
    /// Sprint origin. Defaults to production Sprint.
    public var origin: String
    /// Optional release/version tag attached to every event.
    public var release: String?
    /// Install the native crash handler (signal + Mach exception). Default
    /// false — crash reports arrive UNSYMBOLICATED until Sprint's dSYM
    /// pipeline exists, so this ships dark and is opt-in.
    public var enableCrashHandler: Bool
    /// Auto-collect breadcrumbs (URLSession + lifecycle). Default true.
    public var captureBreadcrumbs: Bool
    /// Capture non-2xx URLSession responses as `http_error` signals. Default true.
    public var captureHttpErrors: Bool
    /// Called (best-effort, off the main thread) if a capture POST fails.
    public var onError: (@Sendable (Error) -> Void)?

    public init(
        key: String,
        origin: String = "https://sprint.hortensia-agency.com",
        release: String? = nil,
        enableCrashHandler: Bool = false,
        captureBreadcrumbs: Bool = true,
        captureHttpErrors: Bool = true,
        onError: (@Sendable (Error) -> Void)? = nil
    ) {
        self.key = key
        // Trailing slashes would produce `//api/signals/ingest`.
        self.origin = origin.hasSuffix("/")
            ? String(origin.reversed().drop(while: { $0 == "/" }).reversed())
            : origin
        self.release = release
        self.enableCrashHandler = enableCrashHandler
        self.captureBreadcrumbs = captureBreadcrumbs
        self.captureHttpErrors = captureHttpErrors
        self.onError = onError
    }
}
