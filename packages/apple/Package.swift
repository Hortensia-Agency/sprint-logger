// swift-tools-version: 5.9
import PackageDescription

// Sprint Signals SDK for Apple platforms (iOS/iPadOS/macOS/tvOS/watchOS).
//
// Two targets, deliberately split:
//   SprintSignals      — pure Swift. Config, transport, context, breadcrumbs,
//                        capture API, offline spool. Safe, testable, no C.
//   SprintSignalsCrash — C target holding the signal/Mach handlers. Isolated
//                        because crash handling must be async-signal-safe: no
//                        Swift runtime, no allocation, no ObjC messaging inside
//                        a handler. Keeping it in C makes that constraint
//                        enforceable rather than aspirational.
//
// A host that only wants handled-error capture depends on SprintSignals alone
// and never links the crash target.
let package = Package(
    name: "SprintSignals",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15),
        .tvOS(.v13),
        .watchOS(.v6),
    ],
    products: [
        .library(name: "SprintSignals", targets: ["SprintSignals"]),
    ],
    targets: [
        .target(
            name: "SprintSignalsCrash",
            path: "Sources/SprintSignalsCrash"
        ),
        .target(
            name: "SprintSignals",
            dependencies: ["SprintSignalsCrash"],
            path: "Sources/SprintSignals"
        ),
        .testTarget(
            name: "SprintSignalsTests",
            dependencies: ["SprintSignals"],
            path: "Tests/SprintSignalsTests"
        ),
    ]
)
