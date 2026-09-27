import Foundation

// The Mac's tour (conch-design/onboarding/README.md §2 "5 · Try it", decisions 3 and 4): five beats on the real surfaces,
// the second and third of them the practice turn itself. Each beat moves on when the person does the thing; its button
// is the fallback, and Skip tour is there at every beat. As data and a rule, like setup's own (`OnboardingProgress`):
// the Mac app's TourCoach feeds this what happened and draws what it returns.

/// One beat of the tour, in order.
public enum TourBeat: Int, CaseIterable, Codable, Sendable, Comparable {
    /// The pill: who's talking and what's ready. Moves on once conch has read the practice turn.
    case pill = 1
    /// Answer out loud: moves on when words reach the practice session.
    case answer
    /// Green means ready: moves on when the welcome card is opened.
    case ready
    /// The panel: moves on when the panel is dragged, filled, folded or opened.
    case panel
    /// Draw on anything: moves on when ⌃⌥⌘P is pressed and a mark is drawn.
    case canvas

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// What the card hangs from.
public enum TourAnchor: Equatable, Sendable {
    /// The pill (the control bar) at the top of the screen: the card below it.
    case controlBar
    /// The conversation panel: the card beside it.
    case panel
    /// The canvas's tools: the card beside them.
    case canvasPill
}

/// Everything that moves the tour.
public enum TourEvent: Equatable, Sendable {
    /// conch has read the practice turn aloud, and the mic has opened.
    case spoken
    /// Words reached the practice session: heard by the mic, or typed in its line. Answer out loud stays up to show them
    /// with Sent, until `settle`.
    case heard(String)
    /// A moment after the words were shown (`TourProgress.shownFor`): on to the next beat.
    case settle
    /// The practice's mic window closed with nothing heard.
    case silent
    /// The practice couldn't go, in the daemon's words (another session being read, the phone taking the audio); nil once
    /// it's going again.
    case problem(String?)
    /// The welcome card was opened: the Ready pill, the card's Open it, the menu.
    case readyOpened
    /// The conversation panel was dragged, filled the screen, folded or opened by the person.
    case panelMoved
    /// ⌃⌥⌘P was pressed.
    case hotKey
    /// A mark was drawn on the canvas.
    case stroke
    /// The card's button, when the thing itself didn't happen.
    case next
    /// Skip tour.
    case skip
    /// The practice turn went away (the daemon stopped, or ended it) while a beat still needed it.
    case practiceEnded
}

/// Where the tour is. Pure: `applying` returns the tour after an event.
public struct TourProgress: Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        /// Through the last beat.
        case finished
        /// Skip tour.
        case skipped
        /// The practice turn went away under it.
        case ended
    }

    /// The beat on screen; nil once the tour is over.
    public private(set) var beat: TourBeat?
    /// Beats already done, including ones done before their turn came (the Ready pill clicked early).
    public private(set) var done: Set<TourBeat>
    /// What reached the practice session last: the card's "Sent" line.
    public private(set) var heard: String?
    /// The practice's last mic window heard nothing.
    public private(set) var silent: Bool
    /// Why the practice couldn't go, while the beats that stand on it wait.
    public private(set) var problem: String?
    /// ⌃⌥⌘P was pressed during the canvas beat: its keycaps light.
    public private(set) var chordLit: Bool
    /// A mark drawn during the canvas beat.
    public private(set) var drew: Bool
    public private(set) var outcome: Outcome?

    public init() {
        beat = .pill
        done = []
        heard = nil
        silent = false
        problem = nil
        chordLit = false
        drew = false
        outcome = nil
    }

    public var isOver: Bool { outcome != nil }

    /// How long Answer out loud shows what was sent before it moves on: long enough to read, as the iPhone step holds
    /// "All set on your iPhone".
    public static let shownFor: Double = 1.4

    /// Answer out loud is showing words it has sent, and waits only for `settle`.
    public var showingSent: Bool { beat == .answer && done.contains(.answer) }

    /// The tour after `event`.
    public func applying(_ event: TourEvent) -> TourProgress {
        var next = self
        guard let beat = next.beat else { return next }
        switch event {
        case .spoken:
            next.problem = nil
            next.complete(.pill)
        case let .heard(words):
            next.heard = words
            next.silent = false
            next.problem = nil
            // Words can only reach it once conch has spoken, whatever was seen of that.
            next.complete(.pill)
            next.complete(.answer)
            // The card shows what was sent before it moves on (the design's "✓ Sent"); `settle` moves it.
            if beat <= .answer {
                next.beat = .answer
                return next
            }
        case .settle:
            break
        case .silent:
            if next.heard == nil { next.silent = true }
        case let .problem(words):
            // Only the beats that wait on the practice turn say so; past them, it's nothing to do with the tour.
            next.problem = beat <= .answer && !next.done.contains(.answer) ? words : nil
        case .readyOpened:
            // Remembered when it comes early: the beat is passed over when its turn comes.
            next.complete(.ready)
        case .panelMoved:
            // Only while it's the panel's beat: opening the card from the pill brings the panel out by itself.
            if beat == .panel { next.complete(.panel) }
        case .hotKey:
            if beat == .canvas {
                next.chordLit = true
                if next.drew { next.complete(.canvas) }
            }
        case .stroke:
            if beat == .canvas {
                next.drew = true
                if next.chordLit { next.complete(.canvas) }
            }
        case .next:
            next.complete(beat)
        case .skip:
            next.end(.skipped)
            return next
        case .practiceEnded:
            // The beats that stand on the practice turn can't go on without it; the panel and the canvas can.
            if beat <= .ready { next.end(.ended) }
            return next
        }
        next.moveOn()
        return next
    }

    private mutating func complete(_ beat: TourBeat) {
        done.insert(beat)
    }

    /// From a beat that's done to the first after it that isn't; past the last, finished.
    private mutating func moveOn() {
        guard let current = beat, done.contains(current) else { return }
        if let following = TourBeat.allCases.first(where: { $0 > current && !done.contains($0) }) {
            beat = following
        } else {
            end(.finished)
        }
    }

    private mutating func end(_ how: Outcome) {
        beat = nil
        outcome = how
    }

    /// The card for the beat on screen.
    public var card: TourCard? {
        beat.map { TourCard($0, heard: heard, silent: silent, problem: problem, chordLit: chordLit) }
    }
}

/// One beat's card: the words, where it hangs, and its one button. The copy is the design's (`onb-mac-07-tour`).
public struct TourCard: Equatable, Sendable {
    public let beat: TourBeat
    public let title: String
    public let text: String
    /// The keys it teaches, drawn as keycaps.
    public let chord: String?
    public let chordLit: Bool
    /// What reached the practice session, with Sent.
    public let heard: String?
    /// A plain word when something didn't happen: nothing heard yet, or why the practice couldn't go.
    public let note: String?
    /// A second, quieter button for the note: listen again, or try again.
    public let retry: String?
    public let pointer: CoachCard.Pointer
    public let anchor: TourAnchor
    public let primary: String

    public static let count = TourBeat.allCases.count

    public init(_ beat: TourBeat, heard: String? = nil, silent: Bool = false, problem: String? = nil, chordLit: Bool = false) {
        self.beat = beat
        self.heard = beat == .answer ? heard : nil
        let nothingYet = beat == .answer && heard == nil && silent
        let stuck = beat <= .answer && self.heard == nil ? problem : nil
        note = stuck ?? (nothingYet ? "conch didn't catch anything. Say something, then pause." : nil)
        retry = stuck != nil ? "Try again" : nothingYet ? "Listen again" : nil
        self.chordLit = beat == .canvas && chordLit
        switch beat {
        case .pill:
            title = "This is the pill"
            text = "It sits at the top of your screen and says who's talking and what's ready. Talk reads each finished turn aloud; Quiet holds them until you ask."
            chord = nil
            pointer = .up
            anchor = .controlBar
            primary = "Next"
        case .answer:
            title = "Answer out loud"
            text = "conch read the practice turn, then opened the mic. Say anything, then pause. Your words go to whoever just spoke."
            chord = nil
            pointer = .up
            anchor = .controlBar
            primary = "Next"
        case .ready:
            title = "Green means ready"
            text = "An agent finished something for you. Click the pill and conch opens it where it lives: the page, the app, the file."
            chord = nil
            pointer = .up
            anchor = .controlBar
            primary = "Open it"
        case .panel:
            title = "The panel"
            text = "The conversation, and a line to answer in. Drag it to any corner. ⌘↩ fills the screen, and ⌘. folds it away."
            chord = "⌘↩"
            pointer = .left
            anchor = .panel
            primary = "Next"
        case .canvas:
            title = "Draw on anything"
            text = "Mark up whatever's on screen and Send it to the agent. With the pen down, ⇧R records a Show instead. Agents draw too; theirs are violet."
            chord = "⌃⌥⌘P"
            pointer = .left
            anchor = .canvasPill
            primary = "Finish"
        }
    }

    /// What VoiceOver says as the beat arrives: where it is, what it's called, and what to do.
    public var announcement: String {
        "Tour, \(beat.rawValue) of \(Self.count). \(title). \(text)"
    }
}

/// The one tip left behind when the tour closes (research.md §21: "one appearance"): it stays by the pill until the pill
/// is first used, or it's closed, and never comes back.
public enum PillTip {
    public static let text = "When the pill turns green, click it: conch opens what's ready."

    public enum State: String, Codable, Sendable {
        /// The tour never closed here: no tip.
        case none
        /// The tour closed: the tip shows until it's used.
        case pending
        /// Used, or closed: never again.
        case done
    }

    /// After `event`, from `state`: the tour closing leaves it pending (once); the pill used or the tip closed ends it.
    public static func after(_ state: State, tourClosed: Bool = false, pillUsed: Bool = false, dismissed: Bool = false) -> State {
        if state == .done { return .done }
        if pillUsed || dismissed { return state == .pending ? .done : state }
        if tourClosed { return .pending }
        return state
    }
}
