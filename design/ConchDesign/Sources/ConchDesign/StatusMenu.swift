import Foundation

/// The menu bar menu (M2) as words and what each one does. The Mac's `ConchStatusItem` builds its NSMenu from these
/// rows and the gallery draws them, so every name is decided here, once.
///
/// Items are title case, like the app's own menus. The floating surfaces are named for what they are, with a tick
/// ("Conversation Panel", "Control Bar", "Reply Line"), not "Show conversation": Show is the screen recording's word. A
/// state keeps the one name it has everywhere, so the section is "Ready for you".
public enum StatusMenu {
    /// What choosing an item does.
    public enum Command: Equatable, Sendable {
        case talk, quiet, stop, controlBar, conversation, replyLine, draw, openConch
        /// A ready session's next item, opened the way the Ready pill opens one.
        case openItem(session: String)
        /// conch's window on a session: a working one, or a ready one with ⌥ held.
        case openSession(String)
    }

    /// A toggle's tick. `mixed` is on but not showing: the conversation panel folded to its handle, which ticked read
    /// as showing while nothing was.
    public enum Mark: Equatable, Sendable { case off, on, mixed }

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
        public var controlBar: Bool
        public var conversation: Bool
        public var collapsed: Bool
        public var replyLine: Bool
        public var drawing: Bool
        public var ready: [Session]
        public var working: [Session]

        public init(
            voice: VoiceState, quiet: Bool, exchangeActive: Bool, controlBar: Bool, conversation: Bool, collapsed: Bool,
            replyLine: Bool, drawing: Bool, ready: [Session], working: [Session]
        ) {
            self.voice = voice
            self.quiet = quiet
            self.exchangeActive = exchangeActive
            self.controlBar = controlBar
            self.conversation = conversation
            self.collapsed = collapsed
            self.replyLine = replyLine
            self.drawing = drawing
            self.ready = ready
            self.working = working
        }
    }

    public static func rows(_ input: Input) -> [Row] {
        var rows: [Row] = [.header, .separator]
        rows.append(.item(Item(title: "Talk", command: .talk, mark: input.quiet ? .off : .on)))
        rows.append(.item(Item(title: "Quiet", command: .quiet, mark: input.quiet ? .on : .off)))
        rows.append(.separator)
        // Space is the conch window's stop key.
        rows.append(.item(Item(title: input.voice == .listening ? "Stop Listening" : "Stop Speaking", command: .stop, key: " ", enabled: input.exchangeActive)))
        rows.append(.separator)
        rows.append(.item(Item(title: "Control Bar", command: .controlBar, mark: input.controlBar ? .on : .off)))
        rows.append(.item(Item(title: "Conversation Panel", command: .conversation, mark: conversationMark(on: input.conversation, collapsed: input.collapsed))))
        rows.append(.item(Item(title: "Reply Line", command: .replyLine, mark: input.replyLine ? .on : .off)))
        // The pen, with its hotkey (`CanvasHotKey`).
        rows.append(.item(Item(title: "Draw on Screen", command: .draw, mark: input.drawing ? .on : .off, key: "p", modifiers: [.control, .option, .command])))
        if !input.ready.isEmpty || !input.working.isEmpty { rows.append(.separator) }
        if !input.ready.isEmpty {
            rows.append(.section("Ready for you"))
            for session in input.ready {
                // The item itself, as the pill opens it; with ⌥, conch's window on the session.
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
        return rows
    }

    /// Folded to its handle, the panel is on but nothing of it shows.
    public static func conversationMark(on: Bool, collapsed: Bool) -> Mark {
        on ? (collapsed ? .mixed : .on) : .off
    }

    /// What choosing Conversation Panel does. Off, it comes on open, not as its handle; folded, it opens, where a ticked
    /// item used to hide a panel nobody could see; open, it goes.
    public static func conversationToggle(on: Bool, collapsed: Bool) -> (on: Bool, collapsed: Bool) {
        on && !collapsed ? (false, false) : (true, false)
    }
}
