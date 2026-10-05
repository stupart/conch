import Foundation

/// A dictation into the Mac composer while it is still being spoken: what the input bar shows, and how the words join
/// the draft when they land. The app's `ComposerDraftStore` and `ComposerView` are the other half; these are their
/// decisions, tested here (ComposerDictationTests).
///
/// 2026-10-05, Tyler: "make the transcript accumulate in the input bar with whatever text is already there instead of
/// just showing like the last few words". The field showed `live.partial` alone, in place of the draft. The daemon
/// transcribes a dictation in segments, one per breath, and `partial` is only the segment being heard now; everything
/// said before it is in `transcriptPrefix`, which the composer never read (a 2,555-character dictation was there in
/// full while the field showed its last few words). The draft vanished behind it as well.
///
/// Now the field shows the draft, then the words conch has settled on, then the words it is still revising, dimmer, all
/// of them, growing as they arrive. None of it is written into the draft until the finished dictation lands, through the
/// same join the preview uses, so what lands is what was shown (less any last correction), once.
public enum ComposerDictation {
    // MARK: The join

    /// Spoken words added to a draft: the draft exactly as typed, a space only if it does not already end in one (a line
    /// break counts), then the words. A draft of nothing but whitespace gives way to the words.
    ///
    /// The ONE rule, used by the preview and by the landing (`ComposerDraftStore.appendDictation`), so the preview cannot
    /// promise one text and the draft receive another. It used to trim the draft first, which also ate a line break typed
    /// just before dictating and any leading indent.
    public static func appending(_ spoken: String, to draft: String) -> String {
        let words = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return draft }
        let kept = kept(draft)
        return kept + joiner(after: kept) + words
    }

    /// The draft as it stays: itself, or nothing when it holds no words at all.
    static func kept(_ draft: String) -> String {
        draft.contains { !$0.isWhitespace } ? draft : ""
    }

    /// What goes between the draft and the words: nothing after nothing, nothing after whitespace, else one space.
    static func joiner(after kept: String) -> String {
        guard let last = kept.last else { return "" }
        return last.isWhitespace ? "" : " "
    }

    // MARK: What the field shows

    /// The words of a dictation still being spoken.
    public struct Transcript: Equatable, Sendable {
        /// Words conch has settled on: the segments it has already transcribed and kept.
        public let settled: String
        /// Words still being revised: the segment being heard, and any just-finished segment not settled yet.
        public let pending: String

        public init(settled: String, pending: String) {
            self.settled = settled.trimmingCharacters(in: .whitespacesAndNewlines)
            self.pending = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        public var isEmpty: Bool { settled.isEmpty && pending.isEmpty }

        /// All of it, as one string: what will land if nothing is corrected.
        public var text: String { ComposerDictation.join(settled, pending) }
    }

    /// The input bar mid-dictation, in the order it reads. `text` is exactly `appending(transcript.text, to: draft)`.
    public struct Preview: Equatable, Sendable {
        /// The draft as typed (`kept`), untouched.
        public let draft: String
        /// A space between the draft and the words, or nothing.
        public let joiner: String
        /// Settled words, drawn as plain text.
        public let settled: String
        /// Words still changing, drawn a little dimmer, with the space that separates them from the settled ones.
        public let pending: String
        /// The words will land in the draft. False for a voice turn, whose words go to the session itself: they are
        /// shown alone, and `draft` is empty.
        public let joinsDraft: Bool

        public var text: String { draft + joiner + settled + pending }
        /// The part drawn plain: the draft, the join and the settled words.
        public var plain: String { draft + joiner + settled }
    }

    /// The field for `draft` while `transcript` is being spoken, or nil when nothing has been heard yet (the field is
    /// the draft, as ever). Words that are not going into the draft (`Follower.composing` false) are shown alone.
    public static func preview(draft: String, transcript: Transcript, joining: Bool = true) -> Preview? {
        guard !transcript.isEmpty else { return nil }
        let kept = joining ? kept(draft) : ""
        let pending = transcript.settled.isEmpty || transcript.pending.isEmpty
            ? transcript.pending
            : " " + transcript.pending
        return Preview(draft: kept, joiner: joiner(after: kept), settled: transcript.settled, pending: pending, joinsDraft: joining)
    }

    // MARK: Typing while it fills the field

    /// Would this key type into the field? While a dictation fills it the field is read-only, and a key that would type
    /// is turned away (and the composer says why) rather than landing somewhere the field is not showing. Moving keys
    /// (arrows, Page Up and Down, Home, End: AppKit's private-use block), Escape and shortcuts held with Command or
    /// Control are not typing and go on as ever. Return, Tab and Delete are: Return would have sent the draft without the
    /// words still being spoken.
    public static func types(_ characters: String?, command: Bool, control: Bool) -> Bool {
        guard !command, !control, let scalar = characters?.unicodeScalars.first else { return false }
        if (0xF700...0xF8FF).contains(scalar.value) { return false }
        return scalar.value != 0x1B
    }

    static func join(_ first: String, _ second: String) -> String {
        first.isEmpty ? second : second.isEmpty ? first : first + " " + second
    }

    // MARK: Following the daemon

    /// What the daemon published about the microphone, for one frame.
    public struct Live: Equatable, Sendable {
        /// A finished dictation handed back for a composer (`live.dictated`): sticky on the daemon's side, one at a time.
        public struct Landed: Equatable, Sendable {
            public let id: Int
            public let session: String

            public init(id: Int, session: String) {
                self.id = id
                self.session = session
            }
        }

        /// The session the voice is on, or nil.
        public let session: String?
        /// `live.state`.
        public let state: String
        /// `live.transcriptPrefix`: the segments the daemon has kept so far.
        public let prefix: String
        /// `live.partial`: the segment being heard now.
        public let partial: String
        public let landed: Landed?

        public init(session: String?, state: String, prefix: String = "", partial: String = "", landed: Landed? = nil) {
            self.session = session
            self.state = state
            self.prefix = prefix
            self.partial = partial
            self.landed = landed
        }

        /// The microphone is taking words: open, hearing, or turning the last of them into text.
        public var isTaking: Bool {
            state == "listening" || state == "recording" || state == "transcribing"
        }
    }

    /// One session's dictation, followed frame by frame, for its composer.
    ///
    /// A frame alone cannot say all of it, for two reasons found in the daemon (src/listen.ts, src/voice-loop.ts):
    ///
    ///     a segment ends    the recorder re-arms before the segment is transcribed, and arming clears `partial`. The
    ///                       segment reaches `transcriptPrefix` only at the daemon's next event, which while you pause
    ///                       is the next time you speak. Read frame by frame, the sentence you just said vanished every
    ///                       time you paused. Its words are held, dimmed, until the prefix moves.
    ///     words land        `dictated` is published while the state still says transcribing, and the prefix is never
    ///                       cleared after: draft plus prefix would show every word twice until the state went idle.
    ///                       Once the words are in the draft, the preview is over.
    ///
    /// Any frame that is not this session taking words resets it, so a cancelled or failed dictation leaves nothing
    /// behind, and another session's dictation shows nothing here.
    ///
    /// Not every capture on a session is a dictation into its composer. The voice loop opens the mic to hear a reply
    /// after a turn is read aloud, and the window's Space and the menu bar talk to the session directly: those words go
    /// to the agent, never into the draft, so showing them joined to the draft would promise a message that is not
    /// coming. Only a capture the composer's own mic asked for (`requested`) is `composing`; any other shows its words
    /// alone, in place of the draft, as the field always has.
    public struct Follower: Equatable, Sendable {
        /// The frame's words when this capture's dictation landed in the draft: the preview is over while they stand.
        private struct Words: Equatable, Sendable {
            let prefix: String
            let partial: String
        }

        private var started = false
        /// This capture was asked for by the composer's mic: its words are going into the draft. Settled when the capture
        /// is first seen.
        public private(set) var composing = false
        /// The dictation the draft store had already appended when this capture was first seen. It is not this
        /// capture's: `live.dictated` is sticky, so the last one is still there when the next one starts.
        private var baseline: Int?
        private var landedAt: Words?
        /// The segment last heard, and the prefix it was heard beside.
        private var lastPartial = ""
        private var lastPartialPrefix = ""
        /// Words of segments that have ended but are not in the prefix yet, and the prefix they wait on.
        private var held = ""
        private var heldPrefix = ""

        public init() {}

        /// A capture of this session's is being followed: the composer's request for one has been answered.
        public var isFollowing: Bool { started }

        /// This frame's words for `session`'s composer, or nil when it should show its draft alone.
        ///
        /// `applied` is the id of the dictation the draft store last appended (`ComposerDraftStore.apply`). A landing
        /// ends the preview only once it is in the draft, so the field never shows the draft without the words in
        /// between; ids are only compared for equality, whatever scheme the daemon numbers them by.
        public mutating func follow(_ live: Live, session: String, applied: Int?, requested: Bool = false) -> Transcript? {
            guard live.session == session, live.isTaking else {
                self = Follower()
                return nil
            }
            if !started {
                started = true
                baseline = applied
                composing = requested
            }
            let words = Words(prefix: live.prefix, partial: live.partial)
            if let landedAt {
                // The landed dictation's words are in the draft. Only a fresh start can show more: the daemon begins
                // every dictation by emptying the prefix (`listenHooks`), so new words over an empty prefix are the
                // next one, heard without an idle frame between. A prefix that is not empty is still the landed one's,
                // and showing it would show those words twice.
                guard live.prefix.isEmpty, words != landedAt else { return nil }
                self = Follower()
                started = true
                baseline = applied
                composing = requested
            } else if let landed = live.landed, landed.session == session, landed.id == applied, landed.id != baseline {
                landedAt = words
                return nil
            }

            // The prefix moved: whatever was held is in it now, or was thrown away by the daemon on purpose.
            if live.prefix != heldPrefix { held = "" }
            // A segment just ended, its words not in the prefix yet: hold them. Not when the prefix moved in the same
            // frame, which is the daemon taking them in, and holding them too would show them twice.
            if live.partial.isEmpty, !lastPartial.isEmpty, live.prefix == lastPartialPrefix {
                held = ComposerDictation.join(held, lastPartial.trimmingCharacters(in: .whitespacesAndNewlines))
                heldPrefix = live.prefix
            }
            lastPartial = live.partial
            lastPartialPrefix = live.prefix

            let transcript = Transcript(
                settled: live.prefix,
                pending: ComposerDictation.join(held, live.partial.trimmingCharacters(in: .whitespacesAndNewlines))
            )
            return transcript.isEmpty ? nil : transcript
        }
    }
}
