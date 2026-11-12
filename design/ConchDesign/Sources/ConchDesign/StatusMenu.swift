import Foundation

/// The menu bar menu (M2) as words and what each one does. The Mac's `ConchStatusItem` builds its NSMenu from these
/// rows and the gallery draws them, so every name is decided here, once.
///
/// Items are title case, like the app's own menus. A state keeps the one name it has everywhere, so the section is
/// "Ready for you".
public enum StatusMenu {
    /// What choosing an item does.
    public enum Command: Equatable, Sendable {
        case talk, quiet, stop, openConch
        /// Read replies aloud on or off (settings `speak`).
        case readAloud
        /// A ready session's next item, opened by the one opening rule (`ConchStatusItem.open`).
        case openItem(session: String)
        /// conch's window on a session: a working one, or a ready one with ⌥ held.
        case openSession(String)
        /// Setup's window, where it was left.
        case finishSetup
        /// conch's window on its Settings page, where it was left (`SettingsPageState.open`).
        case settings
    }

    /// A toggle's tick.
    public enum Mark: Equatable, Sendable { case off, on }

    /// The dot before a session, both filled: ready's green, or working's blue. Working was a hollow ring, which the
    /// sidebar now draws for a paused sub-agent.
    public enum Dot: Equatable, Sendable {
        case ready, working

        public var symbol: String { "circle.fill" }
        public var colour: ConchColorToken { self == .ready ? ConchColor.ready : ConchColor.active }
    }

    public struct Item: Equatable, Sendable {
        public let title: String
        public let command: Command
        public var mark: Mark = .off
        /// Its key equivalent, and the modifiers with it: shown at the item's end.
        public var key: String = ""
        public var modifiers: [Modifier] = []
        public var enabled = true
        /// Shown in place of the item before it while ⌥ is held.
        public var alternate = false
        public var dot: Dot?
        /// Under the item before it, a step in: a setting that belongs to it.
        public var indent = 0
        /// A second line under the title.
        public var detail: String?
    }

    public enum Modifier: String, Equatable, Sendable { case control = "⌃", option = "⌥", command = "⌘" }

    public enum Row: Equatable, Sendable {
        /// The voice's state and what it is about, drawn by the host.
        case header
        case separator
        case section(String)
        case item(Item)
    }

    /// A session as the menu lists it.
    public struct Session: Equatable, Sendable {
        public let id: String
        public let label: String

        public init(id: String, label: String) {
            self.id = id
            self.label = label
        }
    }

    /// What the menu reads when it opens.
    public struct Input: Equatable, Sendable {
        public var voice: VoiceState
        public var quiet: Bool
        /// Speech or listening is running, so Stop has something to stop.
        public var exchangeActive: Bool
        public var ready: [Session]
        public var working: [Session]
        /// Setup put away with steps still left, by name (`OnboardingProgress.remaining`); empty when there is nothing to
        /// finish.
        public var setupLeft: [String]
        /// Read replies aloud is on (settings `speak`; the daemon publishes `mode.speechOff` while it's off).
        public var readAloud: Bool

        public init(
            voice: VoiceState, quiet: Bool, exchangeActive: Bool, ready: [Session], working: [Session], setupLeft: [String] = [],
            readAloud: Bool = true
        ) {
            self.voice = voice
            self.quiet = quiet
            self.exchangeActive = exchangeActive
            self.ready = ready
            self.working = working
            self.setupLeft = setupLeft
            self.readAloud = readAloud
        }
    }

    public static func rows(_ input: Input) -> [Row] {
        var rows: [Row] = []
        // Setup put away part way: a quiet reminder at the top until it's done, never the window reopening by itself.
        if let setup = setupItem(left: input.setupLeft) { rows += [.item(setup), .separator] }
        rows += [.header, .separator]
        rows.append(.item(Item(title: "Talk", command: .talk, mark: input.quiet ? .off : .on)))
        rows.append(.item(Item(title: "Quiet", command: .quiet, mark: input.quiet ? .on : .off)))
        // The voice itself, one click from anywhere (2026-10-08, Tyler: "how do i just turn it off and have it stop
        // talking??"). Talk and Quiet are whether conch speaks up on its own; this is whether it speaks at all.
        rows.append(.item(Item(title: "Read Replies Aloud", command: .readAloud, mark: input.readAloud ? .on : .off)))
        rows.append(.separator)
        // Space is the conch window's stop key.
        rows.append(.item(Item(title: input.voice == .listening ? "Stop Listening" : "Stop Speaking", command: .stop, key: " ", enabled: input.exchangeActive)))
        if !input.ready.isEmpty || !input.working.isEmpty { rows.append(.separator) }
        if !input.ready.isEmpty {
            rows.append(.section("Ready for you"))
            for session in input.ready {
                // The item itself, by the one opening rule; with ⌥, conch's window on the session.
                rows.append(.item(Item(title: session.label, command: .openItem(session: session.id), dot: .ready)))
                rows.append(.item(Item(title: "Open \(session.label) in conch", command: .openSession(session.id), modifiers: [.option], alternate: true, dot: .ready)))
            }
        }
        if !input.working.isEmpty {
            rows.append(.section("Working"))
            for session in input.working {
                rows.append(.item(Item(title: session.label, command: .openSession(session.id), dot: .working)))
            }
        }
        rows.append(.separator)
        rows.append(.item(Item(title: "Open conch", command: .openConch)))
        // Settings is a page of conch's window (2026-10-11): this brings the window forward on it, as ⌘, does there.
        rows.append(.item(Item(title: "Settings…", command: .settings, key: ",", modifiers: [.command])))
        return rows
    }

    /// "Finish setting up conch", and what is left: "2 left: Permissions, iPhone". Nil with nothing left.
    public static func setupItem(left: [String]) -> Item? {
        guard !left.isEmpty else { return nil }
        return Item(title: "Finish setting up conch", command: .finishSetup, detail: "\(left.count) left: \(left.joined(separator: ", "))")
    }
}
