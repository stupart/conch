import CoreGraphics
import ImageIO
import SwiftUI
import XCTest
@testable import ConchDesign

/// Annotate's tray, note field and pin, drawn offscreen light and dark and read back: Send in Tyler's ink, the field as
/// wide as its column allows, a pin's badge in his ink. `CONCH_ANNOTATE_RENDERS=<dir>` also writes each as a PNG. The
/// field's text box is AppKit's, which ImageRenderer draws as a placeholder; scripts/annotate-e2e.ts photographs it in
/// the app.
@MainActor
final class AnnotateRenderTests: XCTestCase {
    private func render(_ view: some View, dark: Bool, name: String) throws -> CGImage {
        let content = view
            .padding(24)
            .background(dark ? ConchColor.ground.dark.color : ConchColor.ground.light.color)
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        if let directory = ProcessInfo.processInfo.environment["CONCH_ANNOTATE_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        return image
    }

    /// How many pixels are Tyler's orange (`CanvasInk.you`, #FF6A3D), give or take.
    private func inkPixels(_ image: CGImage) -> Int {
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var count = 0
        for offset in stride(from: 0, to: bytes.count, by: 4) where abs(Int(bytes[offset]) - 0xFF) < 12 && abs(Int(bytes[offset + 1]) - 0x6A) < 16 && abs(Int(bytes[offset + 2]) - 0x3D) < 16 {
            count += 1
        }
        return count
    }

    private var rows: [AnnotationTray.Row] {
        [
            .init(id: "1", number: 1, name: "a.cta.primary", words: "Make this the biggest thing above the fold"),
            .init(id: "2", number: 2, name: "“Tidewater turns every standup…”", words: "Too long. Five words at most."),
            .init(id: "3", number: 3, name: "div.card:nth-of-type(2)", words: "Highlight this plan", missing: true),
        ]
    }

    func testTheTraySendsInTylersInkLightAndDark() throws {
        for dark in [false, true] {
            let tray = AnnotationTray(rows: rows, annotating: true, hint: "", route: AnnotationRoute(session: "s", label: "landing page"),
                                      listOpen: .constant(true), onSend: {}, onClear: {}, onDone: {})
            let image = try render(tray, dark: dark, name: "tray")
            // The Send button is a solid block of the ink; the three pins in the list add a little more.
            XCTAssertGreaterThan(inkPixels(image), 4_000, dark ? "dark" : "light")
            XCTAssertGreaterThanOrEqual(image.width, Int(AnnotationTray.listWidth) * 2)
        }
    }

    func testWithNoNotesTheTraySaysWhatPointingDoesAndHasNoSend() throws {
        let tray = AnnotationTray(rows: [], annotating: true, hint: "Click anything to pin a note to it, or select words",
                                  route: AnnotationRoute(session: "s", label: "landing page"), listOpen: .constant(false), onSend: {}, onClear: {}, onDone: {})
        let image = try render(tray, dark: false, name: "tray-empty")
        XCTAssertLessThan(inkPixels(image), 50)
    }

    func testANoticeCanStandAloneWithItsButtons() throws {
        for dark in [false, true] {
            let tray = AnnotationTray(rows: [], annotating: false, hint: "", route: nil, notice: .orphaned("landing page", notes: 2),
                                      listOpen: .constant(false), onSend: {}, onClear: {}, onDone: {})
            let image = try render(tray, dark: dark, name: "tray-orphaned")
            XCTAssertGreaterThan(image.height, 60)
        }
    }

    func testTheNoteFieldIsAsWideAsItsColumnAllows() throws {
        XCTAssertEqual(AnnotationEditor.width(in: 900), AnnotationEditor.width)
        XCTAssertEqual(AnnotationEditor.width(in: 280), 260)
        XCTAssertEqual(AnnotationEditor.width(in: 150), AnnotationEditor.narrowest)
        for dark in [false, true] {
            let field = AnnotationEditor(number: 1, name: "a.cta.primary", text: .constant("Make this the biggest thing above the fold"), isNew: false,
                                         width: AnnotationEditor.width(in: 280), onSave: {}, onCancel: {}, onDelete: {})
            let image = try render(field, dark: dark, name: "editor")
            XCTAssertEqual(image.width, (260 + 48) * 2)
            XCTAssertGreaterThan(inkPixels(image), 500)
        }
    }

    func testAPinIsTheCanvassBadgeInTylersInk() throws {
        let image = try render(AnnotationPin(number: 3, lifted: true), dark: false, name: "pin")
        XCTAssertEqual(image.width, Int((CanvasInk.pinSide + 48) * 2))
        XCTAssertGreaterThan(inkPixels(image), 1_000)
    }
}
