import XCTest
@testable import ConchDesign

/// A dictation into the Mac composer while it is still being spoken (`ComposerDictation`). 2026-10-05, Tyler: "make the
/// transcript accumulate in the input bar with whatever text is already there instead of just showing like the last few
/// words". The frames below are the daemon's, in the order src/listen.ts and src/voice-loop.ts publish them.
final class ComposerDictationTests: XCTestCase {
    private typealias Live = ComposerDictation.Live
    private typealias Transcript = ComposerDictation.Transcript

    private let mine = "session-mine"
    private let other = "session-other"

    private func frame(
        _ state: String,
        prefix: String = "",
        partial: String = "",
        on session: String? = "session-mine",
        landed: Live.Landed? = nil
    ) -> Live {
        Live(session: session, state: state, prefix: prefix, partial: partial, landed: landed)
    }

    // MARK: The join

    /// The draft exactly as typed, one space only where one is needed, then the words.
    func testSpokenWordsJoinTheDraftWithOneSpaceWhereNeeded() {
        XCTAssertEqual(ComposerDictation.appending("hello world", to: "Fix the bug"), "Fix the bug hello world")
        XCTAssertEqual(ComposerDictation.appending("hello world", to: ""), "hello world")
        XCTAssertEqual(ComposerDictation.appending("hello world", to: "Fix the bug "), "Fix the bug hello world",
                       "a space already there is the space")
        XCTAssertEqual(ComposerDictation.appending("hello world", to: "Line one\n"), "Line one\nhello world",
                       "a line break typed before dictating is kept, not trimmed into a space")
        XCTAssertEqual(ComposerDictation.appending("hello world", to: "  indented"), "  indented hello world")
        XCTAssertEqual(ComposerDictation.appending("hello world", to: " \n "), "hello world",
                       "a draft of only whitespace gives way to the words")
        XCTAssertEqual(ComposerDictation.appending("  hello world \n", to: "Fix"), "Fix hello world")
        XCTAssertEqual(ComposerDictation.appending(" \n", to: "Fix the bug"), "Fix the bug", "no words, no change")
        XCTAssertEqual(ComposerDictation.appending("", to: ""), "")
    }

    // MARK: What the field shows

    /// The whole transcript after the whole draft: the draft and the settled words plain, the changing words after them.
    func testThePreviewIsTheDraftThenEverySettledWordThenTheChangingOnes() throws {
        let settled = "First I want the sidebar narrower. Then move the search into the toolbar."
        let preview = try XCTUnwrap(ComposerDictation.preview(
            draft: "Two things on the dashboard:",
            transcript: Transcript(settled: settled, pending: "and make the badges")
        ))
        XCTAssertEqual(preview.draft, "Two things on the dashboard:")
        XCTAssertEqual(preview.joiner, " ")
        XCTAssertEqual(preview.settled, settled)
        XCTAssertEqual(preview.pending, " and make the badges")
        XCTAssertEqual(preview.plain, "Two things on the dashboard: " + settled)
        XCTAssertEqual(preview.text, "Two things on the dashboard: \(settled) and make the badges")
    }

    func testWhitespaceAtEveryJoinIsOneSpace() throws {
        let messy = try XCTUnwrap(ComposerDictation.preview(
            draft: "Draft",
            transcript: Transcript(settled: "  settled words \n", pending: "\n changing ")
        ))
        XCTAssertEqual(messy.text, "Draft settled words changing")

        let onlyChanging = try XCTUnwrap(ComposerDictation.preview(draft: "", transcript: Transcript(settled: "", pending: " just started ")))
        XCTAssertEqual(onlyChanging.text, "just started")
        XCTAssertEqual(onlyChanging.plain, "", "nothing settled yet: all of it is the dimmer part")
        XCTAssertEqual(onlyChanging.pending, "just started", "no space before the first word")

        let onlySettled = try XCTUnwrap(ComposerDictation.preview(draft: "Draft\n", transcript: Transcript(settled: "said", pending: "")))
        XCTAssertEqual(onlySettled.text, "Draft\nsaid")
        XCTAssertEqual(onlySettled.pending, "", "no trailing space when nothing is changing")

        XCTAssertNil(ComposerDictation.preview(draft: "Draft", transcript: Transcript(settled: " ", pending: "\n")),
                     "nothing heard yet: the field is the draft")
    }

    /// The preview and the landing are one join, so what lands is what was shown.
    func testWhatLandsIsWhatThePreviewShowed() throws {
        let drafts = ["", "Fix the bug", "Fix the bug ", "List:\n", "   ", "emoji 👋🏽"]
        let transcripts = [
            Transcript(settled: "one two", pending: "three"),
            Transcript(settled: "", pending: "only changing"),
            Transcript(settled: "only settled", pending: ""),
            Transcript(settled: " spaced ", pending: " out "),
        ]
        for draft in drafts {
            for transcript in transcripts {
                let preview = try XCTUnwrap(ComposerDictation.preview(draft: draft, transcript: transcript))
                XCTAssertEqual(ComposerDictation.appending(transcript.text, to: draft), preview.text, "\(draft.debugDescription) + \(transcript)")
            }
        }
    }

    // MARK: Typing while it fills the field

    /// Read-only while dictating: what would type is turned away (and the field says why); moving and shortcuts are not.
    func testOnlyKeysThatWouldTypeAreTurnedAway() {
        for typing in ["a", "Z", "é", " ", "\r", "\t", "\u{7F}", "👋"] {
            XCTAssertTrue(ComposerDictation.types(typing, command: false, control: false), typing.debugDescription)
        }
        XCTAssertFalse(ComposerDictation.types("\u{F700}", command: false, control: false), "up arrow")
        XCTAssertFalse(ComposerDictation.types("\u{F703}", command: false, control: false), "right arrow")
        XCTAssertFalse(ComposerDictation.types("\u{F72C}", command: false, control: false), "page up")
        XCTAssertFalse(ComposerDictation.types("\u{1B}", command: false, control: false), "escape")
        XCTAssertFalse(ComposerDictation.types("c", command: true, control: false), "copy")
        XCTAssertFalse(ComposerDictation.types("a", command: false, control: true), "an Emacs binding moves, it does not type")
        XCTAssertFalse(ComposerDictation.types("", command: false, control: false))
        XCTAssertFalse(ComposerDictation.types(nil, command: false, control: false))
    }

    // MARK: Following a dictation

    /// Segment by segment, the field keeps everything said: the sentence just finished stays while it is transcribed and
    /// while you pause, and the daemon's prefix takes it over without a word shown twice.
    func testEverySegmentAccumulatesAndNothingVanishesBetweenThem() {
        var follower = ComposerDictation.Follower()
        let applied = 4
        func follow(_ live: Live) -> Transcript? { follower.follow(live, session: mine, applied: applied) }

        XCTAssertNil(follow(frame("listening")), "the mic is open, nothing heard: the field is the draft")
        XCTAssertNil(follow(frame("recording")))
        XCTAssertEqual(follow(frame("recording", partial: "First I want")), Transcript(settled: "", pending: "First I want"))
        XCTAssertEqual(follow(frame("recording", partial: "First I want the sidebar narrower")),
                       Transcript(settled: "", pending: "First I want the sidebar narrower"))
        // The segment ends. The recorder re-arms (partial cleared) before the segment is transcribed.
        XCTAssertEqual(follow(frame("listening")), Transcript(settled: "", pending: "First I want the sidebar narrower"),
                       "the sentence just said must not vanish while it is transcribed")
        XCTAssertEqual(follow(frame("transcribing")), Transcript(settled: "", pending: "First I want the sidebar narrower"))
        // A pause: the daemon publishes nothing new until the next words.
        XCTAssertEqual(follow(frame("transcribing")), Transcript(settled: "", pending: "First I want the sidebar narrower"))
        // Speaking again: the prefix now holds the first sentence, and the held words give way to it.
        XCTAssertEqual(follow(frame("recording", prefix: "First I want the sidebar narrower.")),
                       Transcript(settled: "First I want the sidebar narrower.", pending: ""))
        XCTAssertEqual(follow(frame("recording", prefix: "First I want the sidebar narrower.", partial: "Then move search")),
                       Transcript(settled: "First I want the sidebar narrower.", pending: "Then move search"))
        XCTAssertEqual(follow(frame("transcribing", prefix: "First I want the sidebar narrower.")),
                       Transcript(settled: "First I want the sidebar narrower.", pending: "Then move search"))
        XCTAssertEqual(follow(frame("recording", prefix: "First I want the sidebar narrower. Then move search into the toolbar.",
                                    partial: "and")),
                       Transcript(settled: "First I want the sidebar narrower. Then move search into the toolbar.", pending: "and"))
    }

    /// The prefix taking the words in, in the very frame the partial clears (two frames coalesced): held as well, they
    /// would show twice.
    func testWordsTheDaemonTakesInAtOnceAreNotHeldToo() {
        var follower = ComposerDictation.Follower()
        _ = follower.follow(frame("recording", partial: "hello world"), session: mine, applied: nil)
        XCTAssertEqual(follower.follow(frame("transcribing", prefix: "Hello world."), session: mine, applied: nil),
                       Transcript(settled: "Hello world.", pending: ""))
    }

    /// Two segments ended before the prefix moved: both are held, in order.
    func testSegmentsWaitingOnTheDaemonAreHeldInOrder() {
        var follower = ComposerDictation.Follower()
        let frames = [
            frame("recording", prefix: "One.", partial: "two"),
            frame("transcribing", prefix: "One."),
            frame("recording", prefix: "One.", partial: "three"),
            frame("transcribing", prefix: "One."),
        ]
        var last: Transcript?
        for live in frames { last = follower.follow(live, session: mine, applied: nil) }
        XCTAssertEqual(last, Transcript(settled: "One.", pending: "two three"))
        XCTAssertEqual(follower.follow(frame("recording", prefix: "One. Two. Three."), session: mine, applied: nil),
                       Transcript(settled: "One. Two. Three.", pending: ""))
    }

    /// The daemon republishes the same frame several times a second; the field's body may read one twice.
    func testReadingTheSameFrameTwiceChangesNothing() {
        var follower = ComposerDictation.Follower()
        _ = follower.follow(frame("recording", partial: "hello"), session: mine, applied: nil)
        let once = follower.follow(frame("transcribing"), session: mine, applied: nil)
        let twice = follower.follow(frame("transcribing"), session: mine, applied: nil)
        XCTAssertEqual(once, Transcript(settled: "", pending: "hello"))
        XCTAssertEqual(twice, once)
    }

    // MARK: Landing

    /// `dictated` arrives while the state still says transcribing and the prefix still holds every word. The preview
    /// stays until the draft has the words, then goes, and draft plus prefix never shows them twice.
    func testTheFinishedDictationLandsOnceAndThePreviewGoes() throws {
        var follower = ComposerDictation.Follower()
        var applied = 7
        var draft = "Two things:"
        let prefix = "Make the sidebar narrower. Move search into the toolbar."

        XCTAssertNotNil(follower.follow(frame("recording", partial: "Make the sidebar"), session: mine, applied: applied))
        let shown = try XCTUnwrap(follower.follow(frame("transcribing", prefix: prefix), session: mine, applied: applied))
        let preview = try XCTUnwrap(ComposerDictation.preview(draft: draft, transcript: shown))

        // Published; not in the draft yet. The preview holds, so the field never shows the draft without the words.
        let landed = Live.Landed(id: 8, session: mine)
        XCTAssertEqual(follower.follow(frame("transcribing", prefix: prefix, landed: landed), session: mine, applied: applied), shown)

        // ComposerDraftStore.apply: once, by id.
        draft = ComposerDictation.appending(prefix, to: draft)
        applied = 8
        XCTAssertNil(follower.follow(frame("transcribing", prefix: prefix, landed: landed), session: mine, applied: applied),
                     "the words are in the draft: showing the prefix too would show them twice")
        XCTAssertEqual(draft, preview.text, "what landed is what was shown")
        XCTAssertEqual(draft, "Two things: Make the sidebar narrower. Move search into the toolbar.")
        // The daemon keeps republishing that frame until it goes idle.
        for _ in 0..<5 {
            XCTAssertNil(follower.follow(frame("transcribing", prefix: prefix, landed: landed), session: mine, applied: applied))
            XCTAssertNil(follower.follow(frame("listening", prefix: prefix, landed: landed), session: mine, applied: applied))
        }
        XCTAssertNil(follower.follow(frame("idle", prefix: prefix, landed: landed), session: mine, applied: applied))
    }

    /// A correction in the final transcript: the draft takes the final words, not the preview's.
    func testTheFinalTranscriptWinsOverThePreview() throws {
        var follower = ComposerDictation.Follower()
        let shown = try XCTUnwrap(follower.follow(frame("transcribing", prefix: "Their going home"), session: mine, applied: 1))
        XCTAssertEqual(ComposerDictation.preview(draft: "Note:", transcript: shown)?.text, "Note: Their going home")
        let landed = Live.Landed(id: 2, session: mine)
        XCTAssertNil(follower.follow(frame("transcribing", prefix: "Their going home", landed: landed), session: mine, applied: 2))
        XCTAssertEqual(ComposerDictation.appending("They're going home.", to: "Note:"), "Note: They're going home.")
    }

    /// `live.dictated` is sticky: the last dictation is still published when the next one starts. It is not this one's.
    func testTheLastDictationStillPublishedDoesNotEndTheNextOne() {
        var follower = ComposerDictation.Follower()
        let old = Live.Landed(id: 7, session: mine)
        XCTAssertEqual(follower.follow(frame("recording", partial: "next thought", landed: old), session: mine, applied: 7),
                       Transcript(settled: "", pending: "next thought"))
    }

    /// The failed-dictation recovery hands the words back through the same `dictated`, sometimes mid-capture. It ends the
    /// preview the same way, and lands once.
    func testRecoveredWordsLandOnceThroughTheSameDoor() {
        var follower = ComposerDictation.Follower()
        var draft = "Draft"
        _ = follower.follow(frame("recording", partial: "words that failed to send"), session: mine, applied: 3)
        let recovered = Live.Landed(id: 4, session: mine)
        draft = ComposerDictation.appending("Words that failed to send.", to: draft)
        XCTAssertNil(follower.follow(frame("recording", partial: "words that failed to send", landed: recovered), session: mine, applied: 4))
        XCTAssertEqual(draft, "Draft Words that failed to send.")
    }

    /// Another session's landing is not this one's, even mid-dictation.
    func testAnotherSessionsLandingDoesNotEndThisPreview() {
        var follower = ComposerDictation.Follower()
        _ = follower.follow(frame("recording", partial: "still talking"), session: mine, applied: 1)
        let theirs = Live.Landed(id: 2, session: other)
        XCTAssertEqual(follower.follow(frame("recording", partial: "still talking here", landed: theirs), session: mine, applied: 2),
                       Transcript(settled: "", pending: "still talking here"))
    }

    /// The next dictation can start with no idle frame seen in between. The daemon empties the prefix to start one.
    func testTheNextDictationShowsEvenWithoutAnIdleFrameBetween() {
        var follower = ComposerDictation.Follower()
        let landed = Live.Landed(id: 9, session: mine)
        _ = follower.follow(frame("recording", partial: "first"), session: mine, applied: 8)
        XCTAssertNil(follower.follow(frame("transcribing", prefix: "First.", landed: landed), session: mine, applied: 9))
        // The landed dictation's prefix refreshed late, still not empty: still its words, never shown again.
        XCTAssertNil(follower.follow(frame("recording", prefix: "First. And", landed: landed), session: mine, applied: 9))
        // The next dictation: a fresh reducer, an empty prefix, new words.
        XCTAssertNil(follower.follow(frame("listening", landed: landed), session: mine, applied: 9))
        XCTAssertEqual(follower.follow(frame("recording", partial: "second", landed: landed), session: mine, applied: 9),
                       Transcript(settled: "", pending: "second"))
    }

    // MARK: Into the draft, or to the session

    /// Only a capture the composer's own mic asked for is a dictation into the draft. The voice loop's reply, the
    /// window's Space and the menu bar send their words to the session itself: shown joined to the draft, they would
    /// promise a message that is not coming, so they show alone, in place of the draft, as the field always did.
    func testOnlyTheComposersOwnDictationJoinsTheDraft() throws {
        var asked = ComposerDictation.Follower()
        XCTAssertFalse(asked.isFollowing)
        let first = try XCTUnwrap(asked.follow(frame("recording", partial: "add a test"), session: mine, applied: 1, requested: true))
        XCTAssertTrue(asked.isFollowing, "the request is answered: the store can forget it")
        XCTAssertTrue(asked.composing)
        // The store has spent the request; the capture it asked for is still the composer's.
        XCTAssertNotNil(asked.follow(frame("recording", prefix: "Add a test.", partial: "for it"), session: mine, applied: 1, requested: false))
        XCTAssertTrue(asked.composing)
        let joined = try XCTUnwrap(ComposerDictation.preview(draft: "Fix the bug", transcript: first, joining: asked.composing))
        XCTAssertEqual(joined.text, "Fix the bug add a test")
        XCTAssertTrue(joined.joinsDraft)

        var voiceTurn = ComposerDictation.Follower()
        let reply = try XCTUnwrap(voiceTurn.follow(frame("recording", partial: "yes ship it"), session: mine, applied: 1))
        XCTAssertFalse(voiceTurn.composing)
        let alone = try XCTUnwrap(ComposerDictation.preview(draft: "Fix the bug", transcript: reply, joining: voiceTurn.composing))
        XCTAssertEqual(alone.text, "yes ship it", "the draft is not what these words are joining")
        XCTAssertEqual(alone.draft, "")
        XCTAssertEqual(alone.joiner, "")
        XCTAssertFalse(alone.joinsDraft)

        // The capture ends: the next one is a voice turn unless the composer asks again.
        XCTAssertNil(asked.follow(frame("idle"), session: mine, applied: 1, requested: false))
        XCTAssertFalse(asked.composing)
        XCTAssertFalse(asked.isFollowing)
        _ = asked.follow(frame("recording", partial: "hello"), session: mine, applied: 1, requested: false)
        XCTAssertFalse(asked.composing)
    }

    // MARK: Cancelled, failed, elsewhere

    /// A cancelled or failed dictation: the preview goes, and nothing of it is left to show next time. The draft was
    /// never written, so it is exactly what it was.
    func testCancellingLeavesTheDraftAsItWasAndNothingBehind() throws {
        var follower = ComposerDictation.Follower()
        let draft = "Exactly this draft"
        _ = follower.follow(frame("recording", prefix: "Some words.", partial: "and more"), session: mine, applied: 1)
        let mid = try XCTUnwrap(follower.follow(frame("transcribing", prefix: "Some words."), session: mine, applied: 1))
        XCTAssertEqual(ComposerDictation.preview(draft: draft, transcript: mid)?.text, "Exactly this draft Some words. and more")

        for ended in ["idle", "paused", "speaking", "muted"] {
            var copy = follower
            XCTAssertNil(copy.follow(frame(ended, prefix: "Some words."), session: mine, applied: 1), ended)
            // Nothing held over into the next one: it starts from its own (empty) prefix.
            XCTAssertNil(copy.follow(frame("listening"), session: mine, applied: 1), ended)
            XCTAssertEqual(copy.follow(frame("recording", partial: "fresh"), session: mine, applied: 1),
                           Transcript(settled: "", pending: "fresh"), ended)
        }
        XCTAssertEqual(draft, "Exactly this draft")
    }

    /// Another session's dictation never shows in this composer, and the voice moving away ends this one's preview.
    func testAnotherSessionsDictationNeverShowsHere() {
        var follower = ComposerDictation.Follower()
        XCTAssertNil(follower.follow(frame("recording", prefix: "For the other one.", partial: "words", on: other), session: mine, applied: nil))
        XCTAssertNil(follower.follow(frame("recording", prefix: "For nobody.", partial: "words", on: nil), session: mine, applied: nil))

        XCTAssertNotNil(follower.follow(frame("recording", partial: "mine"), session: mine, applied: nil))
        XCTAssertNil(follower.follow(frame("recording", partial: "mine then theirs", on: other), session: mine, applied: nil))
        // And when the voice comes back, it is a new dictation: nothing held from before.
        XCTAssertNil(follower.follow(frame("listening"), session: mine, applied: nil))
    }
}
