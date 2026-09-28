import Combine
import CoreGraphics
import XCTest
@testable import ConchDesign

/// The selection's controller over made-up rows: a press, a drag, a click, double and triple clicks, Shift, Select All,
/// links, and a selection outliving the views it was made over.
@MainActor
final class ConversationSelectionControllerTests: XCTestCase {
    /// Ten points a character on one 20 pt line: easy to aim at.
    private func line(x: CGFloat, y: CGFloat) -> ConversationSelectionController.RegisteredSegment.Builder {
        { SegmentGeometry(
            lines: [SelectionLayoutLine(top: 0, bottom: 20, glyphs: (0..<$0.utf16.count).map { ($0, CGFloat($0) * 10, CGFloat($0 + 1) * 10) })],
            text: $0,
            origin: CGPoint(x: x, y: y)
        ) }
    }

    private var texts: [String: SelectableRowText] = [:]
    private var ids = ["u1", "tool", "a1", "u2"]
    private let tokens = (0..<8).map { _ in UUID() }

    /// You, a tool row with nothing to select, the agent (a sentence, a list item, a line with a link), you again.
    private func make() -> ConversationSelectionController {
        texts = [
            "u1": SelectableRowText(id: "u1", speaker: .you, segments: [SelectableSegment(text: "Why does the build fail?")]),
            "a1": SelectableRowText(id: "a1", speaker: .agent("Claude"), segments: [
                SelectableSegment(text: "The linker can't find it."),
                SelectableSegment(text: "pin it", kind: .listItem(marker: "•", depth: 0)),
                SelectableSegment(text: "see docs now", links: [4..<8]),
            ]),
            "u2": SelectableRowText(id: "u2", speaker: .you, segments: [SelectableSegment(text: "Thanks, pinning it.")]),
        ]
        let controller = ConversationSelectionController()
        controller.source = .init(
            rowIDs: { [unowned self] in ids },
            rowTexts: { [unowned self] wanted in texts.filter { wanted.contains($0.key) } }
        )
        registerAll(controller)
        return controller
    }

    /// Each row's texts are placed within the row; the points the tests press at are the stack's. The reply's texts sit
    /// at 60, 94 and 124 in the stack, 2, 36 and 66 into their row.
    private func registerAll(_ controller: ConversationSelectionController) {
        controller.register(row: "u1", token: tokens[0], frame: CGRect(x: 0, y: 0, width: 700, height: 36), wholeRow: true, segments: [
            .init(index: 0, geometry: line(x: 400, y: 8)),
        ])
        controller.register(row: "a1", token: tokens[1], frame: CGRect(x: 0, y: 58, width: 700, height: 90), wholeRow: true, segments: [
            .init(index: 0, geometry: line(x: 0, y: 2)),
            .init(index: 1, geometry: line(x: 20, y: 36)),
            .init(index: 2, geometry: line(x: 0, y: 66)),
        ])
        controller.register(row: "u2", token: tokens[2], frame: CGRect(x: 0, y: 170, width: 700, height: 36), wholeRow: true, segments: [
            .init(index: 0, geometry: line(x: 500, y: 8)),
        ])
    }

    /// Where the caret before `offset` of a one-line segment is, at mid-line.
    private func at(_ x: CGFloat, _ y: CGFloat, _ offset: Int) -> CGPoint { CGPoint(x: x + CGFloat(offset) * 10, y: y + 10) }

    func testADragFromOneMessageToAnotherSelectsEverythingBetweenAndCopiesItLabelled() {
        let controller = make()
        controller.press(at: at(400, 8, 4), clickCount: 1, extending: false)
        controller.drag(to: at(500, 178, 6))
        controller.release()
        XCTAssertEqual(controller.copiedText(), """
        You: does the build fail?

        Claude: The linker can't find it.

        • pin it

        see docs now

        You: Thanks
        """)
        for id in ["u1", "a1", "u2"] { XCTAssertFalse(controller.highlightRects(for: id).isEmpty, "\(id) is lit") }
        XCTAssertEqual(controller.highlightRects(for: "u1").first?.minX, 440, "from the fifth character of the bubble")
    }

    func testTheSelectionOutlivesTheViewsItWasMadeOverAndLightsThemAgainWhenTheyReturn() {
        let controller = make()
        controller.press(at: at(400, 8, 0), clickCount: 1, extending: false)
        controller.drag(to: at(500, 178, 19))
        controller.release()
        let whole = controller.copiedText()
        XCTAssertEqual(whole?.hasPrefix("You: Why does"), true)
        XCTAssertEqual(whole?.hasSuffix("You: Thanks, pinning it."), true)
        let held = texts

        // Scrolled far away: the rows are let go of as views, and the record lets go of the reply's text too.
        controller.unregister(row: "a1", token: tokens[1])
        controller.unregister(row: "u1", token: tokens[0])
        texts["a1"] = nil
        texts["u1"] = nil
        XCTAssertFalse(controller.registeredRows.contains("a1"))
        XCTAssertEqual(controller.copiedText(), whole, "copied from what was selected, not from what is held now")
        XCTAssertNotNil(controller.slice(for: "a1"), "still selected, in the model")

        // Back on screen: lit again from the model alone.
        texts = held
        registerAll(controller)
        XCTAssertFalse(controller.highlightRects(for: "a1").isEmpty)
    }

    func testAClickWithoutADragClearsTheSelection() {
        let controller = make()
        controller.press(at: at(400, 8, 2), clickCount: 1, extending: false)
        controller.drag(to: at(400, 8, 9))
        controller.release()
        XCTAssertTrue(controller.hasSelection)
        controller.press(at: at(0, 60, 3), clickCount: 1, extending: false)
        controller.release()
        XCTAssertFalse(controller.hasSelection)
        XCTAssertNil(controller.copiedText())
    }

    /// A click puts the caret down, and a Shift-click selects from it, as in a document.
    func testAShiftClickAfterAClickSelectsFromTheClick() {
        let controller = make()
        controller.press(at: at(400, 8, 13), clickCount: 1, extending: false)
        controller.release()
        XCTAssertFalse(controller.hasSelection, "a caret selects nothing")
        controller.press(at: at(500, 178, 6), clickCount: 1, extending: true)
        controller.release()
        XCTAssertEqual(controller.copiedText(), "You: build fail?\n\nClaude: The linker can't find it.\n\n• pin it\n\nsee docs now\n\nYou: Thanks")
    }

    /// A selected row's text is kept when its view goes, and let go of when the selection leaves it. A row that is a
    /// view is read as it is now, so nothing is kept for it.
    func testTextIsKeptForSelectedRowsThatGoAndLetGoWhenTheSelectionLeaves() {
        let controller = make()
        controller.press(at: at(400, 8, 4), clickCount: 1, extending: false)
        controller.drag(to: at(500, 178, 6))
        XCTAssertTrue(controller.captured.isEmpty, "every row is still a view")
        controller.unregister(row: "a1", token: tokens[1])
        XCTAssertEqual(Set(controller.captured.keys), ["a1"])
        controller.drag(to: at(400, 8, 9))
        XCTAssertTrue(controller.captured.isEmpty, "the selection left it")
        controller.release()
    }

    /// A row wholly inside the selection is lit from its line boxes alone: no character's place is worked out, and its
    /// text is not read.
    func testARowWhollySelectedIsLitFromItsLineBoxesAlone() {
        let controller = make()
        controller.register(row: "a1", token: tokens[1], frame: CGRect(x: 0, y: 58, width: 700, height: 90), wholeRow: true, segments: [
            .init(index: 0, geometry: { _ in XCTFail("worked out a wholly selected row's characters"); return SegmentGeometry(lines: [], length: 0) },
                  lines: { [CGRect(x: 0, y: 2, width: 250, height: 20), CGRect(x: 0, y: 28, width: 120, height: 20)] }),
        ])
        controller.press(at: at(400, 8, 2), clickCount: 1, extending: false)
        controller.drag(to: at(500, 178, 6))
        XCTAssertEqual(controller.highlightRects(for: "a1"), [
            CGRect(x: 0, y: 2, width: 250, height: 26), // down to the next line
            CGRect(x: 0, y: 28, width: 250, height: 20), // to the widest edge
        ])
    }

    /// A row that is a view is copied as it is now: a reply that went on streaming after it was selected copies whole.
    func testARowThatIsAViewIsCopiedAsItIsNow() {
        let controller = make()
        controller.selectAll()
        texts["u2"] = SelectableRowText(id: "u2", speaker: .you, segments: [SelectableSegment(text: "Thanks, pinning it now.")])
        XCTAssertEqual(controller.copiedText()?.hasSuffix("You: Thanks, pinning it now."), true)
    }

    func testADoubleClickSelectsAWordAndATripleClickItsParagraph() {
        let controller = make()
        controller.press(at: at(0, 60, 6), clickCount: 2, extending: false)
        controller.release()
        XCTAssertEqual(controller.copiedText(), "linker")
        controller.press(at: at(0, 60, 6), clickCount: 3, extending: false)
        controller.release()
        XCTAssertEqual(controller.copiedText(), "The linker can't find it.")
    }

    /// Dragging after a double-click extends a word at a time.
    func testADragAfterADoubleClickExtendsByWholeWords() {
        let controller = make()
        controller.press(at: at(0, 60, 6), clickCount: 2, extending: false)
        controller.drag(to: at(0, 60, 13))
        controller.release()
        XCTAssertEqual(controller.copiedText(), "linker can't")
    }

    func testShiftClickExtendsTheSelectionFromWhereItStarted() {
        let controller = make()
        controller.press(at: at(400, 8, 4), clickCount: 1, extending: false)
        controller.drag(to: at(400, 8, 8))
        controller.release()
        XCTAssertEqual(controller.copiedText(), "does")
        XCTAssertTrue(controller.accepts(pressAt: at(0, 124, 5), extending: true), "even on a link, Shift extends")
        controller.press(at: at(0, 60, 3), clickCount: 1, extending: true)
        controller.release()
        XCTAssertEqual(controller.copiedText(), "You: does the build fail?\n\nClaude: The")
    }

    func testAPressOnALinkIsTheLinksAndAPressBesideTextInAMessageIsTheSelections() {
        let controller = make()
        XCTAssertFalse(controller.accepts(pressAt: at(0, 124, 5), extending: false), "the link opens, as it always did")
        XCTAssertTrue(controller.accepts(pressAt: at(0, 124, 1), extending: false))
        XCTAssertTrue(controller.accepts(pressAt: CGPoint(x: 20, y: 18), extending: false), "left of your bubble, still your message")
        XCTAssertFalse(controller.accepts(pressAt: CGPoint(x: 20, y: 50), extending: false), "between rows: whatever is there")
    }

    /// A row that is more than text — a tool row with its output open — takes a press only on the text: its header
    /// keeps its buttons.
    func testARowThatIsNotAllTextTakesPressesOnlyOnItsText() {
        let controller = make()
        texts["tool"] = SelectableRowText(id: "tool", speaker: .output("Bash"), segments: [SelectableSegment(text: "ok 1 passes", kind: .code)])
        controller.register(row: "tool", token: tokens[3], frame: CGRect(x: 0, y: 40, width: 700, height: 16), wholeRow: false, segments: [
            .init(index: 0, geometry: { SegmentGeometry(lines: [SelectionLayoutLine(top: 0, bottom: 8, glyphs: (0..<$0.utf16.count).map { ($0, CGFloat($0) * 5, CGFloat($0 + 1) * 5) })], text: $0, origin: CGPoint(x: 30, y: 6)) }),
        ])
        XCTAssertFalse(controller.accepts(pressAt: CGPoint(x: 600, y: 42), extending: false), "the header's chevron")
        XCTAssertTrue(controller.accepts(pressAt: CGPoint(x: 40, y: 50), extending: false))
    }

    func testSelectAllTakesTheWholeLoadedConversation() {
        let controller = make()
        controller.selectAll()
        XCTAssertEqual(controller.copiedText(), """
        You: Why does the build fail?

        Claude: The linker can't find it.

        • pin it

        see docs now

        You: Thanks, pinning it.
        """)
    }

    func testADragPastTheLastRowRunsToItsEndAndOneInAGapLandsBetweenRows() {
        let controller = make()
        controller.press(at: at(500, 178, 8), clickCount: 1, extending: false)
        controller.drag(to: CGPoint(x: 10, y: 900))
        controller.release()
        XCTAssertEqual(controller.copiedText(), "pinning it.")
        controller.press(at: at(0, 60, 22), clickCount: 1, extending: false)
        controller.drag(to: CGPoint(x: 300, y: 160))
        controller.release()
        XCTAssertEqual(controller.copiedText(), "it.\n\n• pin it\n\nsee docs now", "a drag into the gap between two rows lands between them")
    }

    /// Only the rows whose lit part changed are told to draw again.
    func testADragRedrawsOnlyTheRowsItChanges() {
        let controller = make()
        var told: [String: Int] = [:]
        var bag: [AnyCancellable] = []
        for id in ["u1", "a1", "u2"] {
            bag.append(controller.box(for: id).objectWillChange.sink { told[id, default: 0] += 1 })
        }
        controller.press(at: at(400, 8, 2), clickCount: 1, extending: false)
        controller.drag(to: at(400, 8, 6))
        controller.drag(to: at(400, 8, 9))
        XCTAssertEqual(told["u1"], 2)
        XCTAssertNil(told["a1"])
        controller.drag(to: at(0, 60, 3))
        XCTAssertEqual(told["a1"], 1)
        XCTAssertNil(told["u2"])
        _ = bag
    }

    /// A live row that ages out of the snapshot comes back as a recorded row under another name: the selection moves to
    /// it rather than pointing at nothing.
    func testASelectionOnARowThatIsRenamedFollowsIt() {
        let controller = make()
        controller.press(at: at(400, 8, 4), clickCount: 1, extending: false)
        controller.drag(to: at(0, 60, 3))
        controller.release()
        ids = ["rec-u1", "tool", "a1", "u2"]
        texts["rec-u1"] = SelectableRowText(id: "rec-u1", speaker: .you, segments: texts["u1"]!.segments)
        controller.source = .init(
            rowIDs: { [unowned self] in ids },
            rowTexts: { [unowned self] wanted in texts.filter { wanted.contains($0.key) } },
            alias: { $0 == "u1" ? "rec-u1" : nil }
        )
        XCTAssertEqual(controller.copiedText(), "You: does the build fail?\n\nClaude: The")
        XCTAssertEqual(controller.selection?.anchor.start.row, "rec-u1")
        ids = ["tool", "a1", "u2"]
        controller.source = .init(rowIDs: { [unowned self] in ids }, rowTexts: { _ in [:] })
        XCTAssertNil(controller.copiedText(), "gone with no new name: let go of")
    }

    /// A row's view replaced by a new one of the same row: the old one going must not unregister the new.
    func testAnOldViewGoingDoesNotUnregisterItsReplacement() {
        let controller = make()
        let fresh = UUID()
        controller.register(row: "u2", token: fresh, frame: CGRect(x: 0, y: 170, width: 700, height: 36), wholeRow: true, segments: [
            .init(index: 0, geometry: line(x: 500, y: 178)),
        ])
        controller.unregister(row: "u2", token: tokens[2])
        XCTAssertTrue(controller.registeredRows.contains("u2"))
        controller.unregister(row: "u2", token: fresh)
        XCTAssertFalse(controller.registeredRows.contains("u2"))
    }

    func testFocusDecidesTheSelectionsColourAndTellsOnlyLitRows() {
        let controller = make()
        controller.press(at: at(400, 8, 2), clickCount: 1, extending: false)
        controller.drag(to: at(400, 8, 6))
        var told: [String] = []
        let bag = ["u1", "a1"].map { id in controller.box(for: id).objectWillChange.sink { told.append(id) } }
        controller.setEmphasized(true)
        XCTAssertTrue(controller.isEmphasized)
        XCTAssertEqual(told, ["u1"])
        _ = bag
    }
}

extension ConversationSelectionController.RegisteredSegment {
    typealias Builder = (String) -> SegmentGeometry
}
