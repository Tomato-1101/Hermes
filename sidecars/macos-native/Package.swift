// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HermesNative",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "hermes-native", targets: ["HermesNative"])
    ],
    targets: [
        .executableTarget(
            name: "HermesNative",
            path: "Sources/HermesNative"
        )
    ]
)
