// swift-tools-version: 6.0
import PackageDescription

// Kept out of the main package so the shipping targets stay unchanged: this is
// a diagnostic, not a product. It links LYKNAgentCore/LYKNWebKit by path.
let package = Package(
    name: "ParityDump",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../LYKNAgent")],
    targets: [
        .executableTarget(
            name: "ParityDump",
            dependencies: [
                .product(name: "LYKNAgentCore", package: "LYKNAgent"),
                .product(name: "LYKNWebKit", package: "LYKNAgent"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
