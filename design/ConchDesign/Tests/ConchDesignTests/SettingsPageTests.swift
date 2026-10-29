#if os(macOS)
import AppKit
import SwiftUI
#endif
import XCTest
@testable import ConchDesign

/// Settings as a page of conch's window (`SettingsPageState`, 2026-10-11): the ways in open it where it was left or at the
/// section they name, ⌘, goes back only from a window in front, Esc goes back only while it shows, and a section runs to
/// a readable width whatever the window's.
final class SettingsPageTests: XCTestCase {
    // MARK: Sections

    /// The seven the window had, in its order, and Browser (2026-10-11): conch's browser profiles, and Chrome's sign-ins
    /// copied into them. Then Logins (2026-10-14) beside it: which CLIs, agents, MCP servers, plugins and browser profiles
    /// are signed in, as whom. Skills and Benchmarks (2026-10-28) after Plugins & MCP, the tools they sit beside.
    /// And Failures (2026-10-28) last, after Setup: failure tickets and their Fix.
    func testTheSectionsAreTheWindowsSevenThenBrowserAndLoginsInTheirOrder() {
        XCTAssertEqual(SettingsSection.allCases.map(\.title),
                       ["Providers", "Environments", "Plugins & MCP", "Skills", "Benchmarks", "Browser", "Logins", "General", "Phone app", "Permissions", "Setup", "Failures"])
        // The raw values are what the separate window remembered, so the section left there is the one the page opens on.
        XCTAssertEqual(SettingsSection.allCases.map(\.rawValue),
                       ["providers", "environments", "tools", "skills", "benchmarks", "browser", "logins", "general", "phone", "permissions", "setup", "failures"])
        XCTAssertEqual(SettingsSection.storageKey, "conch.settings.section")
        XCTAssertEqual(Set(SettingsSection.allCases.map(\.symbol)).count, SettingsSection.allCases.count, "a mark each")
    }

    /// Skills and Benchmarks lay out a list and a reader across the whole width; every other section stops at the column.
    func testOnlyTheSectionsWithAReaderRunTheWholeWidth() {
        XCTAssertEqual(SettingsSection.allCases.filter(\.runsFullWidth), [.skills, .benchmarks])
    }

    func testARememberedSectionIsReadBackAndAnythingElseIsTheFirst() {
        XCTAssertEqual(SettingsSection(stored: "phone"), .phone)
        XCTAssertEqual(SettingsSection(stored: "tools"), .tools)
        XCTAssertEqual(SettingsSection(stored: "browser"), .browser)
        XCTAssertEqual(SettingsSection(stored: "logins"), .logins)
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

    #if os(macOS)
    /// The list's "Settings" (15 pt, `ConchType.heading`) and a section's title (22 pt, `ConchType.title`) sit on one baseline
    /// across the rule: the drop is how much lower SF sets the title's baseline in its line than the heading's in its own,
    /// each line as SwiftUI lays the text out (19 and 26 points).
    @MainActor
    func testListHeadingSitsOnTheTitlesBaseline() {
        func baseline(_ font: Font, size: CGFloat) -> CGFloat {
            let line = NSHostingView(rootView: Text("Settings").font(font)).fittingSize.height
            let metrics = NSFont.systemFont(ofSize: size)
            return (line - (metrics.ascender - metrics.descender)) / 2 + metrics.ascender
        }
        let drop = baseline(ConchType.title, size: 22) - baseline(ConchType.heading, size: 15)
        XCTAssertEqual(drop, SettingsLayout.listHeadingDrop, accuracy: 0.5, "measured 6.1")
        XCTAssertEqual(SettingsLayout.listHeadingDrop, SettingsLayout.listHeadingDrop.rounded(), "a whole point, so the heading stays crisp")
    }
    #endif
}
