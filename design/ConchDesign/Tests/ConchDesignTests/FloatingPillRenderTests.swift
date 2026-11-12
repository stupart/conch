import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The floating pill drawn (2026-11-11), light and dark: nothing happening, it is a round nub the height of the pill;
/// expanded, its buttons are drawn exactly where a press finds them (`FloatingPill.actionFrames`), since the Mac's window
/// decides from those frames whether a press is a button's or the pill's own.
///
/// `CONCH_PILL_RENDERS=<dir>` writes each picture too, at 1x and 2x.
@MainActor
final class FloatingPillRenderTests: XCTestCase {
    private typealias S = FloatingPill.Session
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    private static let margin: CGFloat = 20

    /// The pill on the ground, `margin` in, in an offscreen window; its size, and its pixels at `scale`.
    private func picture(_ face: FloatingPill.Face, expanded: Bool, dark: Bool, scale: CGFloat = 2, name: String) throws -> (size: CGSize, rep: NSBitmapImageRep) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let pill = FloatingPillView(face: face, expanded: expanded)
            .environment(\.conchRendersStatically, true)
            .environment(\.colorScheme, dark ? .dark : .light)
        let size = NSHostingView(rootView: pill).fittingSize
        let scene = pill
            .padding(Self.margin)
            .frame(width: size.width + 2 * Self.margin, height: size.height + 2 * Self.margin, alignment: .topLeading)
            .background(ConchColor.ground)
            .environment(\.colorScheme, dark ? .dark : .light)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width + 2 * Self.margin, height: size.height + 2 * Self.margin),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let view = NSHostingView(rootView: scene)
        window.contentView = view
        window.orderFrontRegardless()
        windows.append(window)
        for _ in 0..<10 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        let pixels = NSSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
        let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(pixels.width), pixelsHigh: Int(pixels.height),
                                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        rep.size = view.bounds.size
        view.cacheDisplay(in: view.bounds, to: rep)
        if let directory = ProcessInfo.processInfo.environment["CONCH_PILL_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light")@\(Int(scale))x.png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        return (size, rep)
    }

    /// The colour at a point, in points from the picture's top left.
    private func colour(_ rep: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> NSColor {
        let scale = CGFloat(rep.pixelsWide) / rep.size.width
        return rep.colorAt(x: Int(x * scale), y: Int(y * scale))!.usingColorSpace(.deviceRGB)!
    }

    private func distance(_ a: NSColor, _ b: NSColor) -> CGFloat {
        abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent) + abs(a.blueComponent - b.blueComponent)
    }

    private let states: [(String, FloatingPill.Input)] = [
        ("idle", .init()),
        ("idle-manual", .init(manual: true)),
        ("working", .init(sessions: [S(id: "a", label: "site", working: true), S(id: "b", label: "api", working: true)])),
        ("speaking", .init(sessions: [S(id: "a", label: "conch-site"), S(id: "b", label: "api", working: true)], voice: .speaking,
                           voiceSession: "a", voiceLabel: "conch-site", exchangeActive: true)),
        ("listening", .init(sessions: [S(id: "a", label: "About page wireframe and its long tail"), S(id: "b", label: "api", need: .permission)],
                            voice: .listening, voiceSession: "a", voiceLabel: "About page wireframe and its long tail", exchangeActive: true)),
        ("permission", .init(sessions: [S(id: "b", label: "blueprint-api", need: .permission, detail: "Bash", at: 1),
                                        S(id: "c", label: "notes", need: .ready, at: 2), S(id: "d", label: "site", working: true)], manual: true)),
        ("ready", .init(sessions: [S(id: "c", label: "landing-page", need: .ready, detail: "Hero, version 3")])),
    ]

    func testNothingHappeningIsARoundNub() throws {
        for dark in [false, true] {
            let (size, _) = try picture(FloatingPill.face(.init()), expanded: false, dark: dark, name: "nub")
            XCTAssertEqual(size.width, FloatingPill.Metrics.height, accuracy: 0.5)
            XCTAssertEqual(size.height, FloatingPill.Metrics.height, accuracy: 0.5)
        }
    }

    func testEveryStateKeepsItsHeightAndALongNameStopsAtTheMeasure() throws {
        for (name, input) in states {
            for dark in [false, true] {
                let face = FloatingPill.face(input)
                let collapsed = try picture(face, expanded: false, dark: dark, name: name).size
                XCTAssertEqual(collapsed.height, FloatingPill.Metrics.height, accuracy: 0.5, name)
                let expanded = try picture(face, expanded: true, dark: dark, name: "\(name)-expanded").size
                XCTAssertEqual(expanded.height, FloatingPill.Metrics.expandedHeight, accuracy: 0.5, name)
                // A long name is cut short rather than stretching the pill across the screen.
                XCTAssertLessThan(collapsed.width, 280, name)
                XCTAssertLessThan(expanded.width, 420, name)
            }
        }
    }

    func testTheButtonsAreDrawnWhereAPressFindsThem() throws {
        let face = FloatingPill.face(.init(sessions: [S(id: "a", label: "conch-site")], voiceLabel: "conch-site"))
        for dark in [false, true] {
            let (size, rep) = try picture(face, expanded: true, dark: dark, name: "buttons")
            for entry in FloatingPill.actionFrames(in: size) {
                let frame = entry.frame.offsetBy(dx: Self.margin, dy: Self.margin)
                // Just inside each button's left end the button's fill; just outside it, the pill's glass.
                let inside = colour(rep, frame.minX + 3, frame.midY)
                let outside = colour(rep, frame.minX - 2, frame.midY)
                XCTAssertGreaterThan(distance(inside, outside), 0.03, "\(entry.action) starts where its frame does (\(dark ? "dark" : "light"))")
            }
        }
    }

    /// Every state at 1x and 2x, light and dark, for the eye.
    func testPictures() throws {
        guard ProcessInfo.processInfo.environment["CONCH_PILL_RENDERS"] != nil else { throw XCTSkip("CONCH_PILL_RENDERS unset") }
        for (name, input) in states {
            for dark in [false, true] {
                for scale in [CGFloat(1), 2] {
                    _ = try picture(FloatingPill.face(input), expanded: false, dark: dark, scale: scale, name: name)
                    _ = try picture(FloatingPill.face(input), expanded: true, dark: dark, scale: scale, name: "\(name)-expanded")
                }
            }
        }
    }
}
