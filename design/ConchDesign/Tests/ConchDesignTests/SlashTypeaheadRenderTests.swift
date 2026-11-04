import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The slash typeahead drawn as the Mac composer holds it (2026-11-04): a section of the composer's card above the field,
/// at the card's 580-point measure, light and dark. Each row is 28 tall, the list as tall as its rows up to seven, the
/// highlighted row filled edge to edge of the card's 6-point inset, and every row's line on the field's own
/// text column. A picker command's words, "in the terminal" with them, fit whole on the row.
///
/// `CONCH_TYPEAHEAD_RENDERS=<dir>` writes each picture too. Everything in them is the catalog's own.
@MainActor
final class SlashTypeaheadRenderTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    /// The composer's measure (`ConversationTextView.composerMeasure`).
    private static let width: CGFloat = 580
    private static let inset: CGFloat = 6

    private func matches(_ draft: String, backend: String? = nil) -> SlashTypeahead {
        var typeahead = SlashTypeahead(catalog: AgentCommands.all(for: backend, capabilities: nil))
        typeahead.update(draft: draft, caret: nil)
        return typeahead
    }

    private func picture(_ typeahead: SlashTypeahead, selected: Int, draft: String, surface: SlashTypeaheadList.Surface = .card, dark: Bool, name: String) throws -> (Shot, CGFloat) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let scene = CardScene(typeahead: typeahead, selected: selected, draft: draft, surface: surface)
        let height = NSHostingView(rootView: scene).fittingSize.height
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: Self.width + 40, height: height + 40), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let view = NSHostingView(rootView: scene
            .padding(20)
            .frame(width: Self.width + 40, height: height + 40, alignment: .topLeading)
            .background(ConchColor.ground)
            .environment(\.colorScheme, dark ? .dark : .light))
        window.contentView = view
        window.orderFrontRegardless()
        windows.append(window)
        for _ in 0..<10 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        if let directory = ProcessInfo.processInfo.environment["CONCH_TYPEAHEAD_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        return (Shot(rep: rep), height)
    }

    /// The highlighted row: 28 tall at its place in the list, filled from the card's inset to its inset, and its line
    /// starting on the field's text column.
    func testTheHighlightedRowSitsOnTheCardsInsetAndItsLineOnTheFieldsColumn() throws {
        let typeahead = matches("/c")
        XCTAssertEqual(typeahead.matches.map(\.line), ["/cost", "/clear", "/compact", "/context"])
        for dark in [false, true] {
            let (shot, _) = try picture(typeahead, selected: 1, draft: "/c", dark: dark, name: "rows")
            let card = shot.color(20 + Self.width / 2, 20 + 2)
            // Down a column clear of every row's words and of the rounded corners: the selected row's fill and nothing else.
            let fill = try XCTUnwrap(shot.verticalSpan(x: 20 + 400, y: 20, 20 + 4 * 28 + 12, notMatching: card, tolerance: 12))
            XCTAssertEqual(fill.lowerBound, 20 + Self.inset + 28, accuracy: 0.75, "the second row starts 28 below the first")
            XCTAssertEqual(fill.upperBound - fill.lowerBound, 28, accuracy: 0.75, "a row is 28 tall")
            // Across the row's middle: the fill runs from the card's inset to its inset.
            let middle = (fill.lowerBound + fill.upperBound) / 2
            let across = try XCTUnwrap(shot.span(x: 20, 20 + Self.width, y: middle, notMatching: card, tolerance: 12))
            XCTAssertEqual(across.lowerBound, 20 + Self.inset, accuracy: 0.75, "the fill starts at the card's inset")
            XCTAssertEqual(20 + Self.width - across.upperBound, Self.inset, accuracy: 0.75, "and ends at it")

            // The line's ink, and the field's under the list, start on one column.
            let rowFill = shot.color(20 + 12, middle)
            let line = try XCTUnwrap(shot.inkSpan(x: 20 + 8, 20 + 60, y: middle - 6, middle + 6, against: rowFill, threshold: 80))
            let fieldTop = 20 + CardScene.listHeight(rows: 4)
            let field = try XCTUnwrap(shot.inkSpan(x: 20 + 8, 20 + 60, y: fieldTop + 8, fieldTop + 26, against: card, threshold: 80))
            XCTAssertEqual(line.lowerBound, field.lowerBound, accuracy: 0.75, "the row's / over the field's /")
            XCTAssertEqual(line.lowerBound, 20 + Self.inset + SlashTypeaheadList.rowInsetX, accuracy: 1.5)
        }
    }

    /// On the floating input's glass, whose corners are 30: the rows step 3 further in, so the highlight clears the
    /// corner, and the line stays on the field's column.
    func testOnTheGlassTheRowsStepInAndTheLineStaysOnTheColumn() throws {
        let typeahead = matches("/c")
        for dark in [false, true] {
            let (shot, _) = try picture(typeahead, selected: 0, draft: "/c", surface: .glass, dark: dark, name: "glass")
            let card = shot.color(20 + Self.width / 2, 20 + 2)
            let fill = try XCTUnwrap(shot.verticalSpan(x: 20 + 400, y: 20, 20 + 2 * 28, notMatching: card, tolerance: 12))
            XCTAssertEqual(fill.lowerBound, 20 + Self.inset + 3, accuracy: 0.75, "3 further down than on the card")
            let middle = (fill.lowerBound + fill.upperBound) / 2
            // From inside the glass's own curve, which at this height is still a point in from its edge.
            let across = try XCTUnwrap(shot.span(x: 20 + 4, 20 + Self.width - 4, y: middle, notMatching: card, tolerance: 12))
            XCTAssertEqual(across.lowerBound, 20 + Self.inset + 3, accuracy: 0.75, "and 3 further in")
            XCTAssertEqual(20 + Self.width - across.upperBound, Self.inset + 3, accuracy: 0.75)
            let line = try XCTUnwrap(shot.inkSpan(x: 20 + 12, 20 + 60, y: middle - 6, middle + 6, against: shot.color(20 + 12, middle), threshold: 80))
            XCTAssertEqual(line.lowerBound, 20 + Self.inset + SlashTypeaheadList.rowInsetX, accuracy: 1.5, "on the field's column still")
        }
    }

    /// As tall as its rows, up to seven whole ones; the rest scroll, and the foot says how many there are.
    func testTheListIsAsTallAsItsRowsUpToSeven() throws {
        let few = matches("/c")
        let all = matches("/")
        XCTAssertGreaterThan(all.matches.count, 7)
        let (_, fewHeight) = try picture(few, selected: 0, draft: "/c", dark: false, name: "few")
        let (_, allHeight) = try picture(all, selected: 0, draft: "/", dark: false, name: "all")
        XCTAssertEqual(allHeight - fewHeight, (7 - 4) * 28, accuracy: 0.75)
        let codex = matches("/", backend: "codex")
        let (_, codexHeight) = try picture(codex, selected: 0, draft: "/", dark: true, name: "codex")
        XCTAssertEqual(codexHeight, allHeight, accuracy: 0.75)
    }

    /// A picker command's words fit whole on its row at the composer's measure, so "in the terminal" is never cut off,
    /// for either agent's commands. Measured in the row's own type: the line, the gap, the words, the gap before the
    /// hint, and the hint.
    func testAPickerCommandsWordsFitWholeOnItsRow() {
        let room = Self.width - 2 * Self.inset - 2 * SlashTypeaheadList.rowInsetX
        let title = NSFont.systemFont(ofSize: SlashTypeaheadList.titleSize)
        let small = NSFont.systemFont(ofSize: SlashTypeaheadList.detailSize)
        let hint = NSFont.systemFont(ofSize: SlashTypeaheadList.footerSize)
        func width(_ text: String, _ font: NSFont) -> CGFloat {
            ceil(NSAttributedString(string: text, attributes: [.font: font]).size().width)
        }
        for backend in [nil, "codex"] {
            for command in AgentCommands.slash(for: backend) where command.detail.contains("in the terminal") {
                let needed = width(command.line, title) + 9 + width(command.detail, small) + 8
                    + (command.argumentPlaceholder.map { width($0, hint) } ?? 0)
                XCTAssertLessThanOrEqual(needed, room, "\(command.line) at \(backend ?? "claude")")
            }
        }
    }
}

/// The composer's card as the window draws it, holding the list above a stand-in for the field: its surface, radius
/// and 6-point inset, the field's reading type at its own insets.
private struct CardScene: View {
    let typeahead: SlashTypeahead
    let selected: Int
    let draft: String
    var surface: SlashTypeaheadList.Surface = .card

    /// Rows, the keys line under them and the hairline: where the field begins inside the card.
    static func listHeight(rows: Int) -> CGFloat {
        6 + CGFloat(rows) * SlashTypeaheadList.rowHeight + footer
    }

    /// The keys line and the hairline under the rows, as laid out (measured once, here, rather than restated).
    static var footer: CGFloat {
        let rows = NSHostingView(rootView: SlashTypeaheadList(matches: [AgentCommand(line: "/x", detail: "")], selected: nil) { _ in }
            .frame(width: 568)).fittingSize.height
        return rows - SlashTypeaheadList.rowHeight
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SlashTypeaheadList(matches: typeahead.matches, selected: selected, surface: surface) { _ in }
            Text(draft)
                .font(ConchType.readingBody)
                .foregroundStyle(ConchColor.textPrimary)
                .frame(maxWidth: .infinity, minHeight: 22, alignment: .topLeading)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .padding(.horizontal, 10)
            Color.clear.frame(height: 34)
        }
        .padding(6)
        .frame(width: 580)
        .background(ConchColor.surface, in: RoundedRectangle(cornerRadius: surface == .glass ? ConchRadius.panel : ConchRadius.large, style: .continuous))
    }
}

private struct Shot {
    struct RGB: Equatable { let r, g, b: Int }

    let rep: NSBitmapImageRep
    var scale: CGFloat { CGFloat(rep.pixelsWide) / rep.size.width }

    func color(_ x: CGFloat, _ y: CGFloat) -> RGB { pixel(Int(x * scale), Int(y * scale)) }

    private func pixel(_ x: Int, _ y: Int) -> RGB {
        var values = [Int](repeating: 0, count: max(rep.samplesPerPixel, 4))
        values.withUnsafeMutableBufferPointer { rep.getPixel($0.baseAddress!, atX: x, y: y) }
        return RGB(r: values[0], g: values[1], b: values[2])
    }

    private func pixels(_ a: CGFloat, _ b: CGFloat) -> Range<Int> { Int(a * scale)..<Int(b * scale) }

    func inkSpan(x x0: CGFloat, _ x1: CGFloat, y y0: CGFloat, _ y1: CGFloat, against ground: RGB, threshold: Int) -> ClosedRange<CGFloat>? {
        let columns = pixels(x0, x1).filter { x in pixels(y0, y1).contains { diff(pixel(x, $0), ground) >= threshold } }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    func span(x x0: CGFloat, _ x1: CGFloat, y: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        let row = Int(y * scale)
        let columns = pixels(x0, x1).filter { diff(pixel($0, row), color) > tolerance }
        guard let first = columns.first, let last = columns.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    func verticalSpan(x: CGFloat, y y0: CGFloat, _ y1: CGFloat, notMatching color: RGB, tolerance: Int) -> ClosedRange<CGFloat>? {
        let column = Int(x * scale)
        let rows = pixels(y0, y1).filter { diff(pixel(column, $0), color) > tolerance }
        guard let first = rows.first, let last = rows.last else { return nil }
        return CGFloat(first) / scale...CGFloat(last + 1) / scale
    }

    private func diff(_ a: RGB, _ b: RGB) -> Int { max(abs(a.r - b.r), abs(a.g - b.g), abs(a.b - b.b)) }
}
