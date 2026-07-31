import XCTest
@testable import SprintSignals

final class WireShapeTests: XCTestCase {
    /// The server's DiagnosticContextSchema is `.strict()` — an unknown key
    /// fails validation and drops the whole event. This asserts we emit only
    /// keys that schema declares.
    func testDiagnosticContextEmitsOnlyKnownKeys() throws {
        var ctx = DiagnosticContext()
        ctx.platform = "ios"
        ctx.osName = "iOS"
        ctx.handled = true

        let data = try JSONEncoder().encode(ctx)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        let allowed: Set<String> = [
            "platform", "osName", "osVersion", "appVersion", "deviceModel",
            "browserName", "browserVersion", "engine", "timezone", "utcOffset",
            "locale", "viewport", "screen", "networkType", "handled",
            "errorType", "runtimeVersion",
        ]
        for key in obj.keys {
            XCTAssertTrue(allowed.contains(key), "unknown wire key: \(key)")
        }
    }

    /// A body with no `signalType` must parse as the server's `error` member.
    /// Encoding `nil` as an explicit JSON null would break that default, so the
    /// key must be ABSENT, not null.
    func testErrorPayloadOmitsSignalType() throws {
        var payload = SignalPayload()
        payload.message = "boom"

        let data = try JSONEncoder().encode(payload)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertNil(obj["signalType"])
        XCTAssertEqual(obj["message"] as? String, "boom")
    }

    func testWireValueEncodesScalars() throws {
        let values: [String: WireValue] = [
            "s": "text", "i": 42, "b": true, "d": 1.5, "n": nil,
        ]
        let data = try JSONEncoder().encode(values)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(obj["s"] as? String, "text")
        XCTAssertEqual(obj["i"] as? Int, 42)
        XCTAssertEqual(obj["b"] as? Bool, true)
        XCTAssertEqual(obj["d"] as? Double, 1.5)
        XCTAssertTrue(obj["n"] is NSNull)
    }

    func testBreadcrumbCategoryMatchesServerEnum() throws {
        // The server's zod enum accepts exactly these five.
        let all: [Breadcrumb.Category] = [.console, .click, .navigation, .fetch, .xhr]
        for category in all {
            let data = try JSONEncoder().encode(Breadcrumb(category: category))
            let obj = try XCTUnwrap(
                JSONSerialization.jsonObject(with: data) as? [String: Any]
            )
            XCTAssertEqual(obj["category"] as? String, category.rawValue)
        }
    }
}

final class ConfigTests: XCTestCase {
    func testOriginTrailingSlashStripped() {
        let cfg = SignalsConfig(key: "sk_sig_x", origin: "https://example.com///")
        XCTAssertEqual(cfg.origin, "https://example.com")
    }

    func testCrashHandlerDefaultsOff() {
        // Ships dark: reports are unsymbolicated until Sprint has a dSYM
        // pipeline, so enabling it must be a deliberate host decision.
        XCTAssertFalse(SignalsConfig(key: "sk_sig_x").enableCrashHandler)
    }

    func testEmptyKeyDoesNotStart() {
        SprintSignals.stop()
        SprintSignals.start(.init(key: ""))
        XCTAssertFalse(SprintSignals.isStarted)
    }

    /// Capture before start() must be a silent no-op, never a crash — the
    /// single most important safety property of the whole SDK.
    func testCaptureBeforeStartIsNoop() {
        SprintSignals.stop()
        SprintSignals.captureException(NSError(domain: "t", code: 1))
        SprintSignals.captureMessage("hi")
        SprintSignals.captureSignal(type: "t", title: "t")
        SprintSignals.addBreadcrumb(.init(category: .console, message: "x"))
        SprintSignals.startSpan("op").finish()
        XCTAssertFalse(SprintSignals.isStarted)
    }
}

final class ScrubbingTests: XCTestCase {
    func testQueryStringStripped() {
        let url = URL(string: "https://api.example.com/v1/pay?token=secret&uid=123")
        XCTAssertEqual(scrubURL(url), "https://api.example.com/v1/pay")
    }

    func testCredentialsStripped() {
        let url = URL(string: "https://user:pass@example.com/path")
        let out = scrubURL(url)
        XCTAssertFalse(out?.contains("user") ?? true)
        XCTAssertFalse(out?.contains("pass") ?? true)
    }
}

final class BreadcrumbStoreTests: XCTestCase {
    func testBoundedToMaxCount() {
        let store = BreadcrumbStore(maxCount: 3)
        for i in 0..<10 {
            store.add(.init(category: .console, message: "m\(i)"))
        }
        let all = store.all()
        XCTAssertEqual(all.count, 3)
        // Oldest dropped, newest kept.
        XCTAssertEqual(all.last?.message, "m9")
        XCTAssertEqual(all.first?.message, "m7")
    }

    func testLongMessageTruncated() {
        let store = BreadcrumbStore()
        store.add(.init(category: .console, message: String(repeating: "x", count: 5000)))
        XCTAssertEqual(store.all().first?.message?.count, 512)
    }

    func testConcurrentAddsAreSafe() {
        let store = BreadcrumbStore(maxCount: 50)
        DispatchQueue.concurrentPerform(iterations: 500) { i in
            store.add(.init(category: .console, message: "m\(i)"))
        }
        XCTAssertEqual(store.all().count, 50)
    }
}

final class SpoolTests: XCTestCase {
    private func makeSpool(maxFiles: Int = 100) -> Spool {
        Spool(subdirectory: "SprintSignalsTests-\(UUID().uuidString)", maxFiles: maxFiles)
    }

    func testWriteThenDrainRoundTrips() {
        let spool = makeSpool()
        spool.write(Data(#"{"a":1}"#.utf8))
        let drained = spool.drain()
        XCTAssertEqual(drained.count, 1)
        XCTAssertEqual(String(data: drained[0], encoding: .utf8), #"{"a":1}"#)
    }

    func testDrainRemovesEntries() {
        let spool = makeSpool()
        spool.write(Data("x".utf8))
        _ = spool.drain()
        XCTAssertTrue(spool.drain().isEmpty)
    }

    func testBoundedByMaxFiles() {
        let spool = makeSpool(maxFiles: 5)
        for i in 0..<20 {
            spool.write(Data("payload-\(i)".utf8))
        }
        XCTAssertLessThanOrEqual(spool.drain().count, 5)
    }
}
