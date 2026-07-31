import Foundation

/// Bounded ring buffer of what happened before an error.
///
/// Thread-safe: breadcrumbs are added from whatever queue the host happens to
/// be on (a URLSession delegate queue, the main thread, a background actor), so
/// every access is locked. Bounded to 50 to match the other SDKs and the
/// server's own cap.
final class BreadcrumbStore: @unchecked Sendable {
    private let lock = NSLock()
    private var crumbs: [Breadcrumb] = []
    private let maxCount: Int
    private let messageMax = 512

    init(maxCount: Int = 50) {
        self.maxCount = maxCount
    }

    func add(_ crumb: Breadcrumb) {
        var c = crumb
        if let m = c.message, m.count > messageMax {
            c.message = String(m.prefix(messageMax))
        }

        lock.lock()
        defer { lock.unlock() }
        crumbs.append(c)
        if crumbs.count > maxCount {
            crumbs.removeFirst(crumbs.count - maxCount)
        }
    }

    func all() -> [Breadcrumb] {
        lock.lock()
        defer { lock.unlock() }
        return crumbs
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        crumbs.removeAll()
    }
}

/// Strips the query string and any userinfo from a URL before it becomes a
/// breadcrumb. Query strings routinely carry tokens, emails, and ids; the
/// server re-scrubs, but sending less is better than scrubbing more.
func scrubURL(_ url: URL?) -> String? {
    guard let url else { return nil }
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
    comps?.query = nil
    comps?.fragment = nil
    comps?.user = nil
    comps?.password = nil
    return comps?.string ?? url.absoluteString
}
