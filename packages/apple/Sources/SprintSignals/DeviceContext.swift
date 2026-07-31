import Foundation

#if canImport(UIKit)
import UIKit
#endif

/// Builds the `DiagnosticContext` for this device/app.
///
/// Everything here is non-identifying by construction: model identifier (not
/// device name — "Arbi's iPhone" is PII), OS version, app version, locale,
/// timezone, screen size. No IDFA, no IDFV, no vendor id, no device name.
enum DeviceContext {
    /// Values that cannot change during a process lifetime — computed once.
    /// A crash handler must never do this work (it allocates); it reads the
    /// cached copy instead.
    static let staticContext: DiagnosticContext = build()

    private static func build() -> DiagnosticContext {
        var ctx = DiagnosticContext()
        ctx.platform = platformName
        ctx.osName = osName
        ctx.osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        ctx.deviceModel = modelIdentifier
        ctx.appVersion = appVersion
        ctx.locale = Locale.current.identifier
        ctx.timezone = TimeZone.current.identifier
        // The wire wants minutes EAST of UTC. Foundation already returns
        // seconds east (unlike JS getTimezoneOffset, which is inverted — the
        // other SDKs normalize; we must not double-invert here).
        ctx.utcOffset = TimeZone.current.secondsFromGMT() / 60
        ctx.runtimeVersion = "swift"

        #if canImport(UIKit)
        if let screen = mainScreenSize() {
            ctx.screen = screen
        }
        #endif

        return ctx
    }

    private static var platformName: String {
        #if os(iOS)
        // iPadOS reports as iOS; the server enum has no "ipados" member.
        return "ios"
        #elseif os(tvOS)
        return "ios"
        #elseif os(watchOS)
        return "ios"
        #else
        // macOS has no dedicated enum member server-side. "node" is wrong and
        // "web" is misleading, so send nothing rather than lie — the field is
        // optional and the server derives what it can from osName.
        return ""
        #endif
    }

    private static var osName: String {
        #if os(iOS)
        return "iOS"
        #elseif os(tvOS)
        return "tvOS"
        #elseif os(watchOS)
        return "watchOS"
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }

    /// Hardware identifier, e.g. "iPhone16,2". NOT `UIDevice.name`, which is
    /// user-assigned and routinely contains a real name.
    private static var modelIdentifier: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let mirror = Mirror(reflecting: systemInfo.machine)
        let id = mirror.children.reduce(into: "") { acc, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            acc.append(Character(UnicodeScalar(UInt8(bitPattern: value))))
        }
        return id.isEmpty ? "unknown" : id
    }

    private static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    #if canImport(UIKit)
    private static func mainScreenSize() -> DiagnosticContext.Dimensions? {
        // UIScreen.main is main-thread-only on some OS versions. Reading it off
        // the main thread has tripped the main-thread checker in host apps, so
        // hop when needed rather than assuming the caller's queue.
        if Thread.isMainThread {
            let b = UIScreen.main.bounds
            return .init(w: Int(b.width), h: Int(b.height))
        }
        return DispatchQueue.main.sync {
            let b = UIScreen.main.bounds
            return .init(w: Int(b.width), h: Int(b.height))
        }
    }
    #endif

    /// Per-capture dynamic bits merged over the static snapshot.
    static func current(handled: Bool, errorType: String? = nil) -> DiagnosticContext {
        var ctx = staticContext
        ctx.handled = handled
        ctx.errorType = errorType
        return ctx
    }
}
