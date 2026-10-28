import CoreGraphics

/// Settings, as a page of conch's window (2026-10-11). It was a window of its own, SwiftUI's `Settings` scene, at most 840 by
/// 620 beside the window it set up. Tyler: "why is the settings thing so small and a seperate window?" It takes the whole
/// window now, in place of the sessions, and gives it back with its own back control, Esc, and ⌘, again.
///
/// This file is the page without a window, so it can be tested: which sections there are, which one shows, whether the page
/// shows at all, and how wide a section runs. The Mac's `SettingsRouter` holds the one state for the app, and every way in
/// (the header's gear, ⌘, and conch › Settings…, the menu bar menu, Manage… beside an account, the voices' Why?) goes
/// through it.
///
/// Skills and Benchmarks (2026-10-28) sit beside Plugins & MCP: every skill across the accounts, the public indexes' to
/// add and try, and the benchmark catalog (SkillsLibrary.swift). The header's sparkles opens Skills.
public enum SettingsSection: String, CaseIterable, Identifiable, Sendable {
    case providers, environments, tools, skills, benchmarks, browser, logins, general, phone, permissions, setup
    /// What went wrong, as tickets, and Fix (2026-10-28, FailureTickets.swift). Last: it is where conch looks after
    /// itself, after Setup, which is where it was set up.
    case failures

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .providers: "Providers"
        case .environments: "Environments"
        case .tools: "Plugins & MCP"
        case .skills: "Skills"
        case .benchmarks: "Benchmarks"
        case .browser: "Browser"
        case .logins: "Logins"
        case .general: "General"
        case .phone: "Phone app"
        case .permissions: "Permissions"
        case .setup: "Setup"
        case .failures: "Failures"
        }
    }

    /// Its mark in the section list.
    public var symbol: String {
        switch self {
        case .providers: "person.crop.circle"
        case .environments: "desktopcomputer"
        case .tools: "puzzlepiece.extension"
        case .skills: "sparkles"
        case .benchmarks: "chart.bar.xaxis"
        case .browser: "globe"
        case .logins: "person.badge.key"
        case .general: "slider.horizontal.3"
        case .phone: "iphone"
        case .permissions: "hand.raised"
        case .setup: "checklist"
        case .failures: "ladybug"
        }
    }

    /// The section runs the whole width beside the list, a reader of its own at its right (Skills, Benchmarks), rather than
    /// stopping at `SettingsLayout.column`: the column's margin would squeeze its list and every scroll view in its reader.
    public var runsFullWidth: Bool {
        self == .skills || self == .benchmarks
    }

    /// The section viewed last, kept in UserDefaults under the key the separate window used, so the one you had open there
    /// is the one the page opens on.
    public static let storageKey = "conch.settings.section"

    /// A remembered section read back. None, or one this build doesn't have, is the first.
    public init(stored: String?) {
        self = stored.flatMap(Self.init(rawValue:)) ?? .providers
    }
}

/// Whether Settings shows in place of the sessions, and which section it shows.
public struct SettingsPageState: Equatable, Sendable {
    public private(set) var isShown: Bool
    public private(set) var section: SettingsSection

    public init(section: SettingsSection = .providers, isShown: Bool = false) {
        self.section = section
        self.isShown = isShown
    }

    /// A way in: the gear, the menu bar menu's Settings…, Manage… beside an account, the voices' Why?. With a section, that
    /// one; without, the one left last. It never closes the page: asking for Settings while it shows is still asking for it.
    public mutating func open(_ section: SettingsSection? = nil) {
        if let section { self.section = section }
        isShown = true
    }

    /// ⌘, and conch › Settings…: the page, or back to the sessions when it already shows in the window in front. Showing in
    /// a window behind another, or in one that is closed, it comes forward instead of going away.
    public mutating func toggle(windowInFront: Bool) {
        if isShown, windowInFront { close() } else { open() }
    }

    /// The back control, Esc and ⌘, again: the sessions, as they were left. The section is kept for next time.
    public mutating func close() {
        isShown = false
    }

    /// Esc, once nothing is being read aloud: back to the sessions while the page shows. False when it doesn't, so Esc goes
    /// on to the sessions' own use of it (stepping back a stage, letting go of the selection).
    public mutating func escape() -> Bool {
        guard isShown else { return false }
        close()
        return true
    }

    /// A section picked in the list.
    public mutating func select(_ section: SettingsSection) {
        self.section = section
    }
}

/// How the page lays out in a window of any size: the section list down the side at a fixed width, and the section beside it
/// running to a readable width from its left edge, whatever room is left over to its right.
public enum SettingsLayout {
    /// The section list.
    public static let listWidth: CGFloat = 220
    /// The longest a section runs, its own 24-point inset either side included: Plugins & MCP's measure, which it kept when
    /// Settings was a window. Words wrap well inside it and a row's control stays within reach of its label.
    public static let column: CGFloat = 720
    /// A section's inset from its column's edges (`ConchSpace.x6`).
    public static let inset: CGFloat = ConchSpace.x6
    /// From a section's title and the line under it to what follows (`ConchSpace.x5`), in every section.
    public static let headerGap: CGFloat = ConchSpace.x5
    /// How much lower the section list's "Settings" starts than a section's title, so the two sit on one baseline across
    /// the rule: the title's 22 points set its baseline 21.3 into a 26-point line, the list heading's 15 points 15.2 into
    /// 19, and the 6.1 between them rounds to 6. They shared a top, and the list's baseline sat 6 points above the title's.
    public static let listHeadingDrop: CGFloat = 6

    /// What a section's scroll view leaves empty on its right in a content area `width` wide, so the section stops at `column`
    /// while the scroll view, and its scroller, still reach the window's edge.
    public static func trailingMargin(width: CGFloat) -> CGFloat {
        max(0, (width - column).rounded(.down))
    }
}
