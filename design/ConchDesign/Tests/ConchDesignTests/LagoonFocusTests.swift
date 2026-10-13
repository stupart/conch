import XCTest
@testable import ConchDesign

/// The lagoon and the sidebar, one selection (LagoonFocus.swift): the page's pick moves the sidebar, the sidebar's moves
/// the camera, and neither is sent back to where it came from.
final class LagoonFocusTests: XCTestCase {
    func testThePagesPickMovesTheSelectionAndIsNotSentBack() {
        var focus = LagoonFocus()
        // The panel opened on s1 while the window viewed s0: select s1, and the selection landing there sends nothing back.
        XCTAssertTrue(focus.pageFocused("s1", viewing: "s0"))
        XCTAssertFalse(focus.selectionChanged(to: "s1"))
        // The panel moved to s2: the same again.
        XCTAssertTrue(focus.pageFocused("s2", viewing: "s1"))
        XCTAssertFalse(focus.selectionChanged(to: "s2"))
    }

    func testAPickThatIsAlreadyTheSelectionMovesNothing() {
        var focus = LagoonFocus()
        XCTAssertFalse(focus.pageFocused("s1", viewing: "s1"))
        // …and is still the page's: if the selection comes round to it, it isn't sent back.
        XCTAssertFalse(focus.selectionChanged(to: "s1"))
    }

    func testTheSidebarsPickMovesTheCamera() {
        var focus = LagoonFocus()
        XCTAssertTrue(focus.selectionChanged(to: "s1"))
        XCTAssertTrue(focus.selectionChanged(to: "s2"))
        // Letting go of the selection sends the camera nowhere.
        XCTAssertFalse(focus.selectionChanged(to: nil))
    }

    func testThePagesPickIsForgottenOnceTheSelectionLeavesIt() {
        var focus = LagoonFocus()
        XCTAssertTrue(focus.pageFocused("s1", viewing: nil))
        XCTAssertFalse(focus.selectionChanged(to: "s1"))
        // The sidebar picks s2, then s1 again: the camera goes to each, s1 included.
        XCTAssertTrue(focus.selectionChanged(to: "s2"))
        XCTAssertTrue(focus.selectionChanged(to: "s1"))
        // Let go and picked again from the sidebar: the camera goes there too.
        XCTAssertTrue(focus.pageFocused("s3", viewing: "s1"))
        XCTAssertFalse(focus.selectionChanged(to: "s3"))
        XCTAssertFalse(focus.selectionChanged(to: nil))
        XCTAssertTrue(focus.selectionChanged(to: "s3"))
    }

    /// Two picks from the page before the window's selection is read: only the last counts, and it isn't sent back.
    func testOnlyThePagesLastPickIsItsOwn() {
        var focus = LagoonFocus()
        XCTAssertTrue(focus.pageFocused("s1", viewing: "s0"))
        XCTAssertTrue(focus.pageFocused("s2", viewing: "s1"))
        XCTAssertFalse(focus.selectionChanged(to: "s2"))
    }
}
