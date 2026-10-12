import XCTest
@testable import ConchDesign

/// Settings as a page of conch's window (`SettingsPageState`, 2026-10-11): the ways in open it where it was left or at the
/// section they name, ⌘, goes back only from a window in front, Esc goes back only while it shows, and a section runs to
/// a readable width whatever the window's.
final class SettingsPageTests: XCTestCase {
    // MARK: Sections

    /// The seven the window had, in its order, and Browser (2026-10-11): conch's browser profiles, and Chrome's sign-ins
    /// copied into them.
    func testTheSectionsAreTheWindowsSevenAndBrowserInTheirOrder() {
        XCTAssertEqual(SettingsSection.allCases.map(\.title),
                       ["Providers", "Environments", "Plugins & MCP", "Browser", "General", "Phone app", "Permissions", "Setup"])
        // The raw values are what the separate window remembered, so the section left there is the one the page opens on.
        XCTAssertEqual(SettingsSection.allCases.map(\.rawValue),
                       ["providers", "environments", "tools", "browser", "general", "phone", "permissions", "setup"])
        XCTAssertEqual(SettingsSection.storageKey, "conch.settings.section")
        XCTAssertEqual(Set(SettingsSection.allCases.map(\.symbol)).count, SettingsSection.allCases.count, "a mark each")
    }

    func testARememberedSectionIsReadBackAndAnythingElseIsTheFirst() {
        XCTAssertEqual(SettingsSection(stored: "phone"), .phone)
        XCTAssertEqual(SettingsSection(stored: "tools"), .tools)
        XCTAssertEqual(SettingsSection(stored: "browser"), .browser)
        XCTAssertEqual(SettingsSection(stored: nil), .providers, "never viewed")
        XCTAssertEqual(SettingsSection(stored: "accounts"), .providers, "a section this build doesn't have")
        XCTAssertEqual(SettingsSection(stored: ""), .providers)
    }

    // MARK: Ways in

    func testAWayInOpensWhereItWasLeftOrAtTheSectionItNames() {
        var page = SettingsPageState(section: .permissions)
        XCTAssertFalse(page.isShown, "the sessions until something asks")
        page.open()
        XCTAssertTrue(page.isShown)
        XCTAssertEqual(page.section, .permissions, "the gear and the menu bar menu: where it was left")
        page.open(.providers)
        XCTAssertEqual(page.section, .providers, "Manage… beside an account")
        XCTAssertTrue(page.isShown, "asking again while it shows never closes it")
        page.close()
        page.open(.general)
        XCTAssertEqual(page, SettingsPageState(section: .general, isShown: true), "the voices' Why?")
    }

    func testCommandCommaGoesBackOnlyFromTheWindowInFront() {
        var page = SettingsPageState(section: .phone)
        page.toggle(windowInFront: true)
        XCTAssertTrue(page.isShown, "⌘, opens it")
        XCTAssertEqual(page.section, .phone)
        page.toggle(windowInFront: false)
        XCTAssertTrue(page.isShown, "shown in a window behind another, or a closed one: it comes forward, not away")
        page.toggle(windowInFront: true)
        XCTAssertFalse(page.isShown, "⌘, again: back to the sessions")
        XCTAssertEqual(page.section, .phone, "the section is kept for next time")
        page.toggle(windowInFront: true)
        XCTAssertEqual(page, SettingsPageState(section: .phone, isShown: true))
    }

    func testEscGoesBackWhileThePageShowsAndIsLeftAloneOtherwise() {
        var page = SettingsPageState(section: .general, isShown: true)
        XCTAssertTrue(page.escape(), "Esc on the page: back to the sessions")
        XCTAssertFalse(page.isShown)
        XCTAssertFalse(page.escape(), "Esc on the sessions is theirs: a stage back, or the selection let go")
        XCTAssertFalse(page.isShown)
        XCTAssertEqual(page.section, .general)
    }

    func testPickingASectionChangesOnlyTheSection() {
        var page = SettingsPageState(section: .providers, isShown: true)
        page.select(.setup)
        XCTAssertEqual(page, SettingsPageState(section: .setup, isShown: true))
        page.close()
        page.select(.tools)
        XCTAssertFalse(page.isShown, "picking never opens or closes it")
    }

    // MARK: Layout

    /// The section stops at the column; whatever the window has beyond it is left on the right, inside the scroll view, so
    /// its scroller stays at the window's edge.
    func testASectionRunsToTheColumnWhateverTheWindow() {
        XCTAssertEqual(SettingsLayout.column, 720)
        XCTAssertEqual(SettingsLayout.listWidth, 220)
        XCTAssertEqual(SettingsLayout.inset, ConchSpace.x6)
        XCTAssertEqual(SettingsLayout.headerGap, ConchSpace.x5, "one gap under every section's title, on the scale")
        XCTAssertTrue(ConchSpace.scale.contains(SettingsLayout.headerGap))
        // 1440 and 1024 wide windows, less the list and its hairline.
        XCTAssertEqual(SettingsLayout.trailingMargin(width: 1440 - 221), 499)
        XCTAssertEqual(SettingsLayout.trailingMargin(width: 1024 - 221), 83)
        XCTAssertEqual(SettingsLayout.trailingMargin(width: 720), 0)
        XCTAssertEqual(SettingsLayout.trailingMargin(width: 640 - 221), 0, "the smallest window: the section takes it all")
        XCTAssertEqual(SettingsLayout.trailingMargin(width: 900.6), 180, "whole points, so the column's edge is crisp")
    }
}
