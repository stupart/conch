import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The selection through real views, in a window off every screen: SwiftUI's own layout of a bubble and a markdown reply
/// turned into geometry, the pointer's surface taking presses on text and nowhere else, a drag made of mouse events, and
/// a selection that outlives rows the history region lets go of.
///
/// `CONCH_SELECTION_RENDERS=<dir>` writes the lit conversation, light and dark, as PNGs.
@MainActor
final class ConversationSelectionHostTests: XCTestCase {
    static let first = "Why does the build fail?"
    static let reply = """
    The linker can't find **libfoo**: see [the notes](https://example.com/notes).

    Two fixes:

    - pin the old version
    - vendor it

    ```
    swift build -c release
    ```
    """
    static let second = "Thanks, pinning it."

    struct Exchange: View {
        let controller: ConversationSelectionController

        var body: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    bubble("u1", ConversationSelectionHostTests.first)
                    MarkdownView(text: ConversationSelectionHostTests.reply)
                        .lineSpacing(ConchType.readingLineSpacing)
                        .foregroundStyle(ConchColor.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .conversationSelectionRow("a1", in: controller)
                    bubble("u2", ConversationSelectionHostTests.second)
                }
                .padding(.horizontal, 18)
                .padding(.top, 14)
                .frame(maxWidth: 700, alignment: .leading)
                .conversationSelectionSurface(controller)
                .frame(maxWidth: .infinity)
            }
            .background(ConchColor.surface)
        }

        /// The Mac's own bubble, as ConversationStackView draws it.
        private func bubble(_ id: String, _ text: String) -> some View {
            HStack {
                Spacer(minLength: 48)
                Text(ConversationFog.inlineMarkdown(text))
                    .conversationSelectable(row: id, segment: 0)
                    .font(ConchType.readingBody)
                    .lineSpacing(ConchType.readingLineSpacing)
                    .foregroundStyle(ConchColor.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
            }
            .conversationSelectionRow(id, in: controller)
        }
    }

    static func texts(_ ids: [String]) -> [String: SelectableRowText] {
        var texts: [String: SelectableRowText] = [:]
        for id in ids {
            switch id {
            case "u1": texts[id] = SelectableRowText(id: id, speaker: .you, segments: [SelectableSegment(ConversationFog.inlineMarkdown(first))])
            case "a1": texts[id] = SelectableRowText(id: id, speaker: .agent("Claude"), segments: MarkdownView.selectableSegments(reply))
            case "u2": texts[id] = SelectableRowText(id: id, speaker: .you, segments: [SelectableSegment(ConversationFog.inlineMarkdown(second))])
            default: break
            }
        }
        return texts
    }

    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    /// A borderless window far off every screen, never key and never in front of anything: the scroll benchmark's.
    private func host<Content: View>(_ content: Content, dark: Bool = false, size: CGSize = CGSize(width: 760, height: 640)) -> (NSWindow, NSView) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let view = NSHostingView(rootView: content.environment(\.colorScheme, dark ? .dark : .light))
        window.contentView = view
        window.orderFrontRegardless()
        windows.append(window)
        return (window, view)
    }

    private func settle(_ view: NSView, until done: () -> Bool = { false }) {
        for _ in 0..<60 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            if done() { return }
        }
    }

    private func surface(in view: NSView) -> ConversationSelectionSurfaceView? {
        if let found = view as? ConversationSelectionSurfaceView { return found }
        for sub in view.subviews { if let found = surface(in: sub) { return found } }
        return nil
    }

    private func scrollView(in view: NSView) -> NSScrollView? {
        if let found = view as? NSScrollView { return found }
        for sub in view.subviews { if let found = scrollView(in: sub) { return found } }
        return nil
    }

    /// Where the caret before `offset` of row `id`'s text `segment` stands, halfway down its line.
    private func caret(_ controller: ConversationSelectionController, _ id: String, _ segment: Int, _ offset: Int) -> CGPoint {
        guard let geometry = controller.geometry(of: segment, in: id), let frame = controller.frame(of: id),
              let line = geometry.lines.first(where: { $0.start <= offset && offset <= $0.end }) else {
            XCTFail("no geometry for \(id)#\(segment)")
            return .zero
        }
        // The geometry is the row's own; the pointer is in the stack.
        return CGPoint(x: frame.minX + line.x(of: offset), y: frame.minY + (line.top + line.bottom) / 2)
    }

    private func mouse(_ type: NSEvent.EventType, _ point: CGPoint, on surface: NSView, clicks: Int = 1, flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.mouseEvent(
            with: type, location: surface.convert(point, to: nil), modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: surface.window?.windowNumber ?? 0,
            context: nil, eventNumber: 0, clickCount: clicks, pressure: 1
        )!
    }

    /// The pointer moved over each of `ids`: what arms a row to read its layout.
    private func hover(_ ids: [String], _ controller: ConversationSelectionController, _ surface: ConversationSelectionSurfaceView, _ view: NSView) {
        for id in ids {
            guard let frame = controller.frame(of: id) else { return XCTFail("\(id) never placed") }
            surface.mouseMoved(with: mouse(.mouseMoved, CGPoint(x: frame.midX, y: frame.midY), on: surface))
        }
        settle(view) { ids.allSatisfy { controller.geometry(of: 0, in: $0) != nil } }
    }

    private func exchange(dark: Bool = false, armed: Bool = true) -> (ConversationSelectionController, NSWindow, NSView, ConversationSelectionSurfaceView) {
        let controller = ConversationSelectionController()
        controller.source = .init(rowIDs: { ["u1", "a1", "u2"] }, rowTexts: Self.texts)
        let (window, view) = host(Exchange(controller: controller), dark: dark)
        settle(view) { ["u1", "a1", "u2"].allSatisfy { controller.frame(of: $0) != nil } }
        guard let surface = surface(in: view) else {
            XCTFail("no surface")
            return (controller, window, view, ConversationSelectionSurfaceView())
        }
        if armed { hover(["u1", "a1", "u2"], controller, surface, view) }
        return (controller, window, view, surface)
    }

    // MARK: - Arming

    /// A row reads SwiftUI's layout of its texts only once armed: rows brought into view by scrolling read nothing.
    func testARowReadsItsLayoutOnlyOnceThePointerHasBeenOnIt() {
        let (controller, window, view, surface) = exchange(armed: false)
        XCTAssertNotNil(controller.frame(of: "a1"), "placed")
        XCTAssertNil(controller.geometry(of: 0, in: "a1"), "but reading nothing")
        guard let frameView = window.contentView?.superview, let a1 = controller.frame(of: "a1") else { return XCTFail("no frame") }
        let point = CGPoint(x: a1.minX + 30, y: a1.minY + 10)
        // A press on a row not armed yet is its texts' own, as it always was; it arms the row.
        NSApp.postEvent(mouse(.leftMouseDown, point, on: surface), atStart: true)
        _ = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 1), inMode: .default, dequeue: true)
        XCTAssertFalse(frameView.hitTest(surface.convert(point, to: nil)) === surface)
        settle(view) { controller.geometry(of: 0, in: "a1") != nil }
        XCTAssertNotNil(controller.geometry(of: 0, in: "a1"), "armed by that press")
        XCTAssertNil(controller.geometry(of: 0, in: "u2"), "and only that row")
        NSApp.postEvent(mouse(.leftMouseDown, point, on: surface), atStart: true)
        _ = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 1), inMode: .default, dequeue: true)
        XCTAssertTrue(frameView.hitTest(surface.convert(point, to: nil)) === surface, "the next press is the selection's")
        // The pointer moving onto a row arms it as well.
        hover(["u2"], controller, surface, view)
        XCTAssertNotNil(controller.geometry(of: 0, in: "u2"))
    }

    // MARK: - SwiftUI's layout, as geometry

    func testEveryTaggedTextIsLaidOutEndToEnd() {
        let (controller, _, _, _) = exchange()
        XCTAssertEqual(Set(controller.registeredRows), ["u1", "a1", "u2"])
        let segments = Self.texts(["a1"])["a1"]!.segments
        XCTAssertEqual(segments.count, 4, "the prose, two items, the code")
        for (index, segment) in segments.enumerated() {
            guard let geometry = controller.geometry(of: index, in: "a1") else { return XCTFail("a1#\(index) not laid out") }
            XCTAssertEqual(geometry.length, segment.length)
            XCTAssertEqual(geometry.lines.last?.end, segment.length, "a1#\(index): its last line ends at its end")
            XCTAssertEqual(geometry.lines.first?.start, 0)
        }
        // The prose is two paragraphs in one text, a short blank line between: three lines, the middle one empty.
        let prose = controller.geometry(of: 0, in: "a1")!
        XCTAssertTrue(prose.lines.contains { $0.start == $0.end }, "the blank line between the paragraphs")
        let bubble = controller.geometry(of: 0, in: "u1")!
        XCTAssertGreaterThan(bubble.bounds.minX, 300, "your bubble is on the right")
        XCTAssertLessThan(controller.frame(of: "u1")!.minY + bubble.bounds.maxY, controller.frame(of: "a1")!.minY + prose.bounds.minY, "and above the reply")
    }

    // MARK: - The pointer

    func testADragOfMouseEventsAcrossThreeMessagesSelectsAndCopiesThem() {
        let (controller, window, _, surface) = exchange()
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("conch.selection.test.\(UUID().uuidString)"))
        surface.pasteboard = pasteboard
        defer { pasteboard.releaseGlobally() }

        surface.mouseDown(with: mouse(.leftMouseDown, caret(controller, "u1", 0, 4), on: surface))
        XCTAssertTrue(window.firstResponder === surface, "a press makes the conversation the keyboard's, for Copy")
        surface.mouseDragged(with: mouse(.leftMouseDragged, caret(controller, "a1", 1, 3), on: surface))
        surface.mouseDragged(with: mouse(.leftMouseDragged, caret(controller, "u2", 0, 6), on: surface))
        surface.mouseUp(with: mouse(.leftMouseUp, caret(controller, "u2", 0, 6), on: surface))

        let copy = NSMenuItem(title: "Copy", action: #selector(ConversationSelectionSurfaceView.copy(_:)), keyEquivalent: "c")
        XCTAssertTrue(surface.validateMenuItem(copy))
        surface.copy(nil)
        XCTAssertEqual(pasteboard.string(forType: .string), """
        You: does the build fail?

        Claude: The linker can't find libfoo: see the notes.

        Two fixes:

        • pin the old version
        • vendor it

        swift build -c release

        You: Thanks
        """)
        for id in ["u1", "a1", "u2"] { XCTAssertFalse(controller.highlightRects(for: id).isEmpty, "\(id) is lit") }

        // A click with no drag clears it, and Copy has nothing.
        surface.mouseDown(with: mouse(.leftMouseDown, caret(controller, "a1", 0, 6), on: surface))
        surface.mouseUp(with: mouse(.leftMouseUp, caret(controller, "a1", 0, 6), on: surface))
        XCTAssertFalse(surface.validateMenuItem(copy))
        XCTAssertTrue(controller.highlightRects(for: "a1").isEmpty)
    }

    func testDoubleAndTripleClicksAndShiftClickThroughTheSurface() {
        let (controller, _, _, surface) = exchange()
        let word = caret(controller, "a1", 0, 6)
        surface.mouseDown(with: mouse(.leftMouseDown, CGPoint(x: word.x + 3, y: word.y), on: surface, clicks: 2))
        surface.mouseUp(with: mouse(.leftMouseUp, word, on: surface, clicks: 2))
        XCTAssertEqual(controller.copiedText(), "linker")
        surface.mouseDown(with: mouse(.leftMouseDown, word, on: surface, clicks: 3))
        surface.mouseUp(with: mouse(.leftMouseUp, word, on: surface, clicks: 3))
        XCTAssertEqual(controller.copiedText(), "The linker can't find libfoo: see the notes.")
        surface.mouseDown(with: mouse(.leftMouseDown, caret(controller, "a1", 2, 6), on: surface, flags: .shift))
        surface.mouseUp(with: mouse(.leftMouseUp, caret(controller, "a1", 2, 6), on: surface, flags: .shift))
        XCTAssertEqual(controller.copiedText(), "The linker can't find libfoo: see the notes.\n\nTwo fixes:\n\n• pin the old version\n• vendor it", "after a triple-click, Shift extends by paragraphs")
        surface.selectAll(nil)
        XCTAssertEqual(controller.copiedText()?.hasPrefix("You: Why does the build fail?\n\nClaude: The linker"), true)
        XCTAssertEqual(controller.copiedText()?.hasSuffix("You: Thanks, pinning it."), true)
    }

    /// The surface takes a press only on selectable text: on a link, between rows, or for a scroll, the view under it
    /// does, exactly as before.
    func testTheSurfaceTakesPressesOnTextAndNothingElse() {
        let (controller, window, _, surface) = exchange()
        guard let frame = window.contentView?.superview else { return XCTFail("no frame view") }
        func hit(_ type: NSEvent.EventType, _ point: CGPoint) -> NSView? {
            let event = mouse(type, point, on: surface)
            NSApp.postEvent(event, atStart: true)
            // The event being handled is what the surface asks about: make it the current one.
            _ = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 1), inMode: .default, dequeue: true)
            return frame.hitTest(surface.convert(point, to: nil))
        }
        XCTAssertTrue(hit(.leftMouseDown, caret(controller, "u1", 0, 5)) === surface, "your words")
        XCTAssertTrue(hit(.leftMouseDown, caret(controller, "a1", 3, 3)) === surface, "the code block")
        let segments = Self.texts(["a1"])["a1"]!.segments
        let link = segments[0].links.first!
        XCTAssertFalse(hit(.leftMouseDown, caret(controller, "a1", 0, link.lowerBound + 2)) === surface, "the link is the link's")
        XCTAssertFalse(hit(.mouseMoved, caret(controller, "a1", 0, 2)) === surface, "the pointer's shape stays the texts' own")
        XCTAssertFalse(hit(.rightMouseDown, caret(controller, "a1", 0, 2)) === surface, "a secondary click off the selection is theirs too")
        let gapY = ((controller.frame(of: "u1")?.maxY ?? 0) + (controller.frame(of: "a1")?.minY ?? 0)) / 2
        XCTAssertFalse(hit(.leftMouseDown, CGPoint(x: 200, y: gapY)) === surface, "between rows")
    }

    /// VoiceOver still reaches the words: the surface over them is no accessibility element, and a hit test for
    /// accessibility at a word does not stop on it. (Whether SwiftUI then reads the text needs VoiceOver itself:
    /// SwiftUI builds its accessibility tree only for a client, so offscreen it is an empty group.)
    func testTheSurfaceIsNothingToVoiceOver() {
        let (controller, window, view, surface) = exchange()
        XCTAssertFalse(surface.isAccessibilityElement())
        let point = caret(controller, "a1", 0, 6)
        let element = view.accessibilityHitTest(window.convertPoint(toScreen: surface.convert(point, to: nil)))
        XCTAssertFalse((element as AnyObject?) === surface)
    }

    // MARK: - Rows the history region lets go of

    struct Region: View {
        @ObservedObject var model: HistoryRegionModel
        let controller: ConversationSelectionController
        let ids: [String]

        var body: some View {
            ScrollView {
                HistoryRegion(
                    model: model,
                    edge: HistoryEdge(mark: .none),
                    entries: ids.map { HistoryEntry(id: $0, estimate: 90, payload: $0) },
                    gap: 22,
                    edgeFont: .system(size: 11)
                ) { id in
                    Text(ConversationSelectionHostTests.message(id))
                        .conversationSelectable(row: id, segment: 0)
                        .font(ConchType.readingBody)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .conversationSelectionRow(id, in: controller)
                }
                .padding(.horizontal, 18)
                .conversationSelectionSurface(controller)
            }
        }
    }

    static func message(_ id: String) -> String {
        "Message \(id): the record store pages backwards and every cursor it hands out stays good for its epoch."
    }

    func testASelectionOutlivesRowsTheRegionLetsGoOfAndLightsThemWhenTheyReturn() {
        let ids = (0..<120).map { String(format: "m%03d", $0) }
        var held = Set(ids)
        let controller = ConversationSelectionController()
        controller.source = .init(rowIDs: { ids }, rowTexts: { wanted in
            Dictionary(uniqueKeysWithValues: wanted.filter(held.contains).map {
                ($0, SelectableRowText(id: $0, speaker: .agent("Claude"), segments: [SelectableSegment(text: Self.message($0))]))
            })
        })
        let model = HistoryRegionModel(overscan: 1, cap: 40)
        let (_, view) = host(Region(model: model, controller: controller, ids: ids), size: CGSize(width: 760, height: 500))
        settle(view) { controller.frame(of: "m003") != nil }
        guard let surface = surface(in: view), let scroller = scrollView(in: view) else { return XCTFail("no surface or scroll view") }
        hover(["m001", "m002", "m003"], controller, surface, view)
        XCTAssertNil(controller.geometry(of: 0, in: "m005"), "a row the pointer never crossed reads nothing")

        // Select from the second message into the fourth, by the pointer.
        surface.mouseDown(with: mouse(.leftMouseDown, caret(controller, "m001", 0, 8), on: surface))
        surface.mouseDragged(with: mouse(.leftMouseDragged, caret(controller, "m003", 0, 12), on: surface))
        surface.mouseUp(with: mouse(.leftMouseUp, caret(controller, "m003", 0, 12), on: surface))
        let selected = controller.copiedText()
        XCTAssertEqual(selected?.hasPrefix("Claude: m001: the record"), true, "one voice: labelled once")
        XCTAssertEqual(selected?.hasSuffix("\n\nMessage m003"), true)

        // Scrolled to the far end: those rows stop being views, and the record lets go of their text.
        func scroll(to y: CGFloat) {
            let clip = scroller.contentView
            clip.scroll(to: NSPoint(x: 0, y: y))
            scroller.reflectScrolledClipView(clip)
            settle(view)
        }
        scroll(to: (scroller.documentView?.bounds.height ?? 0) - 500)
        XCTAssertFalse(controller.registeredRows.contains("m002"), "let go of")
        held.subtract(["m001", "m002", "m003"])
        XCTAssertEqual(controller.copiedText(), selected, "still copied, whole")

        // And back: lit again from the model.
        held = Set(ids)
        scroll(to: 0)
        settle(view) { !controller.highlightRects(for: "m002").isEmpty }
        XCTAssertFalse(controller.highlightRects(for: "m002").isEmpty, "a selected row comes back armed, and lit")
        XCTAssertEqual(controller.copiedText(), selected)
    }

    // MARK: - A send that did not land

    /// Where the Dismiss button was drawn, in the stack's coordinates.
    final class Spot { var frame: CGRect? }

    /// The Mac's `PendingMessage` (ConversationStackView), drawn as it draws it: your bubble, and beneath it when it
    /// sent and why it did not land, with Dismiss. `wholeRow`: the selection row put round the bubble AND that line,
    /// as it was until 2026-10-05; otherwise round the bubble only, as it is now.
    struct Pending: View {
        let controller: ConversationSelectionController
        let wholeRow: Bool
        let dismiss: Spot
        let onDismiss: () -> Void

        var body: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if wholeRow {
                        VStack(alignment: .trailing, spacing: 3) { bubble; status }
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .conversationSelectionRow("p1", in: controller)
                    } else {
                        VStack(alignment: .trailing, spacing: 3) {
                            bubble.conversationSelectionRow("p1", in: controller)
                            status
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 14)
                .frame(maxWidth: 700, alignment: .leading)
                .conversationSelectionSurface(controller)
                .frame(maxWidth: .infinity)
            }
            .background(ConchColor.surface)
        }

        private var bubble: some View {
            HStack {
                Spacer(minLength: 48)
                Text(ConversationFog.inlineMarkdown(ConversationSelectionHostTests.second))
                    .conversationSelectable(row: "p1", segment: 0)
                    .font(ConchType.readingBody)
                    .lineSpacing(ConchType.readingLineSpacing)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
            }
        }

        private var status: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("9:41 AM · Not delivered — conch couldn't confirm it reached the session.")
                    .font(.system(size: 11))
                    .multilineTextAlignment(.trailing)
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .medium))
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(ConversationSelectionSpace.name)) } action: { frame in
                        dismiss.frame = frame
                    }
            }
            .contextMenu { Button("Dismiss", action: onDismiss) }
        }
    }

    /// Whether a press on Dismiss is taken by the surface as a press on the message's text, and whether a click on it
    /// reached the button.
    private func dismissIsPressable(wholeRow: Bool) -> (taken: Bool, dismissed: Bool) {
        let controller = ConversationSelectionController()
        controller.source = .init(rowIDs: { ["p1"] }, rowTexts: { _ in
            ["p1": SelectableRowText(id: "p1", speaker: .you, segments: [SelectableSegment(ConversationFog.inlineMarkdown(Self.second))])]
        })
        let spot = Spot()
        var dismissed = false
        let (window, view) = host(Pending(controller: controller, wholeRow: wholeRow, dismiss: spot, onDismiss: { dismissed = true }))
        settle(view) { controller.frame(of: "p1") != nil && spot.frame != nil }
        guard let surface = surface(in: view), let frameView = window.contentView?.superview, let button = spot.frame else {
            XCTFail("not laid out")
            return (true, false)
        }
        // The pointer has crossed the bubble on its way down to Dismiss: the row is armed, as it always is by then.
        hover(["p1"], controller, surface, view)
        let point = CGPoint(x: button.midX, y: button.midY)
        surface.mouseMoved(with: mouse(.mouseMoved, point, on: surface))
        NSApp.postEvent(mouse(.leftMouseDown, point, on: surface), atStart: true)
        _ = NSApp.nextEvent(matching: .any, until: Date(timeIntervalSinceNow: 1), inMode: .default, dequeue: true)
        let taken = frameView.hitTest(surface.convert(point, to: nil)) === surface
        // And clicked, through the window, the way a click is delivered.
        window.sendEvent(mouse(.leftMouseDown, point, on: surface))
        window.sendEvent(mouse(.leftMouseUp, point, on: surface))
        settle(view) { dismissed }
        return (taken, dismissed)
    }

    /// Tyler, 2026-10-02 and again 2026-10-05: "Dismiss button doesn't work". The selection took the row whole, and the
    /// row was the bubble AND the line under it, so a press on Dismiss was a press on the message: it put the caret
    /// down and the button never heard it. The bubble went only when the transcript's own copy retired it ("Oh its gone
    /// now"). The selection now takes the bubble alone.
    func testAPressOnDismissUnderAFailedSendIsTheButtonsNotTheSelections() {
        let before = dismissIsPressable(wholeRow: true)
        XCTAssertTrue(before.taken, "the shape before: the surface took the press")
        XCTAssertFalse(before.dismissed, "and the button never heard the click")
        let now = dismissIsPressable(wholeRow: false)
        XCTAssertFalse(now.taken, "Dismiss is the button's")
        XCTAssertTrue(now.dismissed, "and a click on it dismisses")
    }

    // MARK: - Pictures

    func testRenderTheLitConversation() throws {
        guard let directory = ProcessInfo.processInfo.environment["CONCH_SELECTION_RENDERS"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        for dark in [false, true] {
            let (controller, _, view, surface) = exchange(dark: dark)
            surface.mouseDown(with: mouse(.leftMouseDown, caret(controller, "u1", 0, 4), on: surface))
            surface.mouseDragged(with: mouse(.leftMouseDragged, caret(controller, "u2", 0, 6), on: surface))
            surface.mouseUp(with: mouse(.leftMouseUp, caret(controller, "u2", 0, 6), on: surface))
            for emphasized in [true, false] {
                controller.setEmphasized(emphasized)
                settle(view)
                guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return XCTFail("no bitmap") }
                view.cacheDisplay(in: view.bounds, to: rep)
                let name = "conversation-selection-\(dark ? "dark" : "light")\(emphasized ? "" : "-unfocused").png"
                try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
            }
        }
    }
}
