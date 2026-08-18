// swift-tools-version: 6.0
import PackageDescription

// macOS 14 floor: WKWebsiteDataStore(forIdentifier:) — the multi-profile
// substitute for Electron's `persist:` partitions — is 14.0+/iOS 17+.
// See docs/WKWEBVIEW_ACTUATION_MIGRATION.md §4.
let package = Package(
    name: "LYKNAgent",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LYKNAgentCore", targets: ["LYKNAgentCore"]),
        .library(name: "LYKNWebKit", targets: ["LYKNWebKit"]),
        .executable(name: "LYKNAgentApp", targets: ["LYKNAgentApp"]),
        .executable(name: "LYKNBench", targets: ["LYKNBench"]),
        .executable(name: "LYKNActuate", targets: ["LYKNActuate"]),
    ],
    targets: [
        // The brain: planner, executor, verifier, task state, memory, vision
        // policy. Talks to the browser only through the BrowserController
        // protocol, so the actuation substrate is swappable.
        .target(
            name: "LYKNAgentCore",
            resources: [.copy("Resources/agent")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The browser: WKWebView tabs, injected runtime, actuation backends.
        .target(
            name: "LYKNWebKit",
            dependencies: ["LYKNAgentCore"],
            resources: [
                .copy("Resources/lykn-runtime.js"),
                .copy("Resources/lykn-page-shim.js"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "LYKNAgentApp",
            dependencies: ["LYKNAgentCore", "LYKNWebKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // WKWebView side of the engine benchmark; the Electron side lives in
        // native/bench/. See native/bench/README.md.
        .executableTarget(
            name: "LYKNBench",
            dependencies: ["LYKNWebKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Drives the real controller against live sites — the actuation paths
        // unit tests cannot reach. See native/bench/README.md.
        .executableTarget(
            name: "LYKNActuate",
            dependencies: ["LYKNAgentCore", "LYKNWebKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "LYKNAgentCoreTests",
            dependencies: ["LYKNAgentCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "LYKNWebKitTests",
            dependencies: ["LYKNWebKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
