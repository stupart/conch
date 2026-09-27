import SwiftUI

/// Whether conch reads a session aloud. A session conch won't read is QUIET, not paused: it keeps working.
///
/// Per-session manual (P with a session selected) was drawn as a pause glyph in place of the row's status, so a
/// session still at work read as stopped, and Tyler couldn't tell what he had done or how to undo it: "I just paused
/// a session somehow — how do I resume?" Then: "it's not paused like not working — it's still working — it's just
/// not speaking aloud." So the status mark always says what the session is doing, and a separate small mark says
/// conch won't read it aloud. Clicking that mark (or P on the selected row) undoes it.
///
/// Three daemon facts decide it, and nothing else does:
/// - `sessionQuiet`, the row's `paused`: quieted by name (`pausedSessionIds`).
/// - `exempt`, the row's `pauseExempt`: let speak by name while everything is quiet (`resumedSessionIds`).
/// - `everythingQuiet`, `mode.paused`: every session quiet (Manual in the window, Quiet on the menu bar and the
///   control bar).
///
/// Everything quiet subsumes one quiet session: while it is on, no row carries its own quiet mark, since every row
/// would. Tyler: "if I switch all to manual then that one individual one shouldn't say paused anymore right?" The
/// daemon still remembers the one quieted by name, so switching everything back to auto leaves it quiet, with its mark
/// back to say so. Only a session let speak through the global quiet is marked then, because it is the exception.
public struct SessionVoice: Equatable, Sendable {
    public var sessionQuiet: Bool
    public var exempt: Bool
    public var everythingQuiet: Bool

    public init(sessionQuiet: Bool, exempt: Bool, everythingQuiet: Bool) {
        self.sessionQuiet = sessionQuiet
        self.exempt = exempt
        self.everythingQuiet = everythingQuiet
    }

    /// Not read aloud. The daemon's own gate, in its order: quieted by name first, then let speak by name, then
    /// everything quiet (`gateTurnForControls`).
    public var isQuiet: Bool {
        sessionQuiet || (everythingQuiet && !exempt)
    }

    /// What a press asks the daemon for: quiet it (a scoped `pause`) when it speaks, let it speak (a scoped `resume`)
    /// when it doesn't. Out of a global quiet, the resume exempts just this one.
    public var togglesToQuiet: Bool {
        !isQuiet
    }

    /// The mark beside the row's age, or nothing.
    public enum Mark: Equatable, Sendable, CaseIterable {
        /// conch won't read this one aloud.
        case quiet
        /// conch reads this one aloud while every other session is quiet.
        case speaks
    }

    public var mark: Mark? {
        if everythingQuiet { return exempt ? .speaks : nil }
        return sessionQuiet ? .quiet : nil
    }

    /// Where the words are read: the Mac has P and a pointer, the phone a finger.
    public enum Device: Sendable {
        case mac
        case phone
    }

    /// The toast after P (or the header button) changes one session, so a stray key is never silent. Read from the
    /// state BEFORE the press.
    public func toggledToast(label: String) -> String {
        if togglesToQuiet { return "\(label) is quiet: P to undo" }
        if everythingQuiet { return "\(label) speaks; the rest stay quiet: P to undo" }
        return "\(label) speaks again: P to undo"
    }

    /// The toast after P with nothing selected changes every session. `stillQuiet`: sessions quieted by name, which
    /// switching everything back to auto leaves quiet.
    public static func toggledAllToast(nowQuiet: Bool, stillQuiet: Int) -> String {
        if nowQuiet { return "Every session is quiet: P to undo" }
        switch stillQuiet {
        case 0: return "Every session speaks again: P to undo"
        case 1: return "Sessions speak again, except the one you made quiet: P to undo"
        default: return "Sessions speak again, except the \(stillQuiet) you made quiet: P to undo"
        }
    }

    /// The Manual/Auto button's tooltip with this session selected: what it does to THIS session, and how to reach
    /// all of them.
    public func modeHelp(label: String) -> String {
        let all = " To switch every session, select All sessions."
        if everythingQuiet, exempt {
            return "\(label) speaks while every other session is quiet. Click to make it quiet again." + all
        }
        if everythingQuiet {
            return "Manual: every session is quiet. Click to let just \(label) speak; the rest stay quiet." + all
        }
        if sessionQuiet {
            return "\(label) is quiet: conch won't read it aloud. Click to let it speak." + all
        }
        return "Auto for \(label): its finished turns are read aloud. Click to make just this session quiet; the rest keep speaking." + all
    }

    /// The Manual/Auto button's tooltip (VoiceOver's label on the phone) with nothing selected: every session.
    public static func modeHelp(everythingQuiet: Bool, on device: Device) -> String {
        switch (everythingQuiet, device) {
        case (true, .mac):
            return "Manual: every session is quiet; finished turns wait for you. Click to switch every session to auto."
        case (false, .mac):
            return "Auto: conch reads finished turns aloud and opens the mic itself. Click to switch every session to manual. To quiet just one, select it and press P."
        case (true, .phone):
            return "Manual: every session is quiet; finished turns wait for you. Switch every session to auto."
        case (false, .phone):
            return "Auto: conch reads finished turns aloud and opens the mic itself. Switch every session to manual."
        }
    }
}

extension SessionVoice.Mark {
    /// A speaker, never a pause: nothing has stopped, conch just isn't reading it.
    public var symbol: String {
        switch self {
        case .quiet: "speaker.slash.fill"
        case .speaks: "speaker.wave.2.fill"
        }
    }

    /// The legend's line.
    public var meaning: String {
        switch self {
        case .quiet: "Quiet — won't be read aloud"
        case .speaks: "Speaks — read aloud while the rest are quiet"
        }
    }

    /// The tooltip and VoiceOver's label: what it means, and the way back.
    public func help(on device: SessionVoice.Device) -> String {
        switch (self, device) {
        case (.quiet, .mac): "Quiet: conch won't read this one aloud. Press P or click to let it speak."
        case (.quiet, .phone): "Quiet: conch won't read this one aloud. Tap to let it speak."
        case (.speaks, .mac): "Speaks: conch reads this one aloud while the rest are quiet. Press P or click to make it quiet."
        case (.speaks, .phone): "Speaks: conch reads this one aloud while the rest are quiet. Tap to make it quiet."
        }
    }
}

/// The mark itself, one drawing for the Mac's sidebar, the phone's list and the gallery. Secondary ink, as the row's
/// other small marks: it answers "why is this one silent?", so it has to clear 3:1, which tertiary does not.
public struct SessionVoiceGlyph: View {
    let mark: SessionVoice.Mark
    let pointSize: CGFloat

    public init(_ mark: SessionVoice.Mark, pointSize: CGFloat) {
        self.mark = mark
        self.pointSize = pointSize
    }

    public var body: some View {
        Image(systemName: mark.symbol)
            .font(.system(size: pointSize, weight: .medium))
            .foregroundStyle(ConchColor.textSecondary)
    }
}
