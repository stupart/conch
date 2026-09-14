// swift-tools-version: 5.9
import PackageDescription

// conch's design system: tokens and components shared by the Mac and iPhone apps.
// Both Xcode projects link the ConchDesign library as a local package. The gallery
// renders every token and component to PNGs so the design can be checked by picture:
//   swift run conch-design-gallery <outdir>
let package = Package(
    name: "ConchDesign",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "ConchDesign", targets: ["ConchDesign"]),
    ],
    targets: [
        .target(name: "ConchDesign"),
        .executableTarget(name: "conch-design-gallery", dependencies: ["ConchDesign"]),
        .testTarget(name: "ConchDesignTests", dependencies: ["ConchDesign"]),
    ]
)
