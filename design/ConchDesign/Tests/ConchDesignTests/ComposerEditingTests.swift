import XCTest
@testable import ConchDesign

/// The Mac composer's field, as rules (`ComposerEditing`). Tyler, 2026-10-04: "something is weird about the input bar in
/// the conch app and the spellcheck like deletes / changes what im typing sometimes and all the text goes invisible". The
/// AppKit half is driven in a real window by test/composer-editor-render.test.ts; these are its decisions.
final class ComposerEditingTests: XCTestCase {
    // MARK: Return

    /// Return sends; Shift- or Option-Return breaks the line, as the conversation panel's own line does.
    func testReturnSendsAndShiftOrOptionBreaksTheLine() {
        XCTAssertEqual(ComposerEditing.returnKey(shift: false, option: false, composing: false), .send)
        XCTAssertEqual(ComposerEditing.returnKey(shift: true, option: false, composing: false), .newline)
        XCTAssertEqual(ComposerEditing.returnKey(shift: false, option: true, composing: false), .newline)
        XCTAssertEqual(ComposerEditing.returnKey(shift: true, option: true, composing: false), .newline)
        // The panel's rule and this one cannot drift apart on the keys they share.
        for shift in [false, true] {
            for option in [false, true] {
                let panel = FogReply.key(returnKey: true, shift: shift, option: option)
                let composer = ComposerEditing.returnKey(shift: shift, option: option, composing: false)
                XCTAssertEqual(panel == .send, composer == .send, "shift \(shift) option \(option)")
            }
        }
    }

    /// While the input method is composing, Return is the composition's: it commits, whatever the modifiers. The SwiftUI
    /// editor's `.onKeyPress(.return)` ran before the input method, so committing a Japanese word sent the message.
    func testReturnWhileComposingCommitsAndNeverSends() {
        for shift in [false, true] {
            for option in [false, true] {
                XCTAssertEqual(ComposerEditing.returnKey(shift: shift, option: option, composing: true), .commit)
            }
        }
    }

    // MARK: Height

    /// Measured off TextKit 1 at the reading font with 4 pt of leading: one line lays out 18 pt, two 40, so n lines are
    /// 22n once the last line's leading is put back, the lab's line box, and the field holds one to eight of them.
    func testTheFieldIsOneToEightLabLines() {
        let spacing: CGFloat = 4
        XCTAssertEqual(ComposerEditing.height(used: 0, lineSpacing: spacing), 22, "empty is still one line")
        XCTAssertEqual(ComposerEditing.height(used: 18, lineSpacing: spacing), 22)
        XCTAssertEqual(ComposerEditing.height(used: 40, lineSpacing: spacing), 44)
        XCTAssertEqual(ComposerEditing.height(used: 22 * 7 + 18, lineSpacing: spacing), 176, "eight lines, the most")
        XCTAssertEqual(ComposerEditing.height(used: 22 * 8 + 18, lineSpacing: spacing), 176, "nine scroll inside eight")
        XCTAssertEqual(ComposerEditing.height(used: 5_000, lineSpacing: spacing), 176)
        // A fraction rounds up, never down: a line cut by a hair is a line you cannot read.
        XCTAssertEqual(ComposerEditing.height(used: 40.2, lineSpacing: spacing), 45)
        XCTAssertEqual(ComposerEditing.lineHeight * CGFloat(ComposerEditing.maxLines), 176)
    }

    // MARK: The one edit between two drafts

    func testTheEditIsWhatChangedAndNothingElse() {
        XCTAssertEqual(ComposerEditing.edit(from: "hello", to: "hello world"), .init(range: NSRange(location: 5, length: 0), replacement: " world"))
        XCTAssertEqual(ComposerEditing.edit(from: "hello world", to: "world"), .init(range: NSRange(location: 0, length: 6), replacement: ""))
        XCTAssertEqual(ComposerEditing.edit(from: "abc", to: "abc"), .init(range: NSRange(location: 3, length: 0), replacement: ""))
        XCTAssertEqual(ComposerEditing.edit(from: "", to: "new"), .init(range: NSRange(location: 0, length: 0), replacement: "new"))
        XCTAssertEqual(ComposerEditing.edit(from: "old", to: ""), .init(range: NSRange(location: 0, length: 3), replacement: ""))
        XCTAssertEqual(ComposerEditing.edit(from: "aXb", to: "aYb"), .init(range: NSRange(location: 1, length: 1), replacement: "Y"))
    }

    /// An emoji is two UTF-16 units that share their first: the edit takes the whole character, never half of one.
    func testTheEditNeverSplitsACharacter() {
        let edit = ComposerEditing.edit(from: "😀 hi", to: "😃 hi")
        XCTAssertEqual(edit, .init(range: NSRange(location: 0, length: 2), replacement: "😃"))
        // An accent added by a combining mark joins the letter it sits on.
        let accent = ComposerEditing.edit(from: "cafe", to: "cafe\u{301}")
        XCTAssertEqual(accent.range, NSRange(location: 3, length: 1))
        XCTAssertEqual(accent.replacement, "e\u{301}")
        // And applying it gives exactly the new text, every time.
        for (old, new) in [("😀 hi", "😃 hi"), ("cafe", "cafe\u{301}"), ("👍🏽", "👍🏿"), ("a🇦🇺b", "a🇳🇿b"), ("", "🙂"), ("🙂", "")] {
            let edit = ComposerEditing.edit(from: old, to: new)
            XCTAssertEqual((old as NSString).replacingCharacters(in: edit.range, with: edit.replacement), new, "\(old) -> \(new)")
        }
    }

    // MARK: Where the caret goes

    /// A dictation lands at the end: a caret at the end goes after it, ready for the next word; a caret in the middle of
    /// what was typed stays on the word it was on.
    func testADictationLeavesTheCaretAfterItOrWhereItWas() {
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 5, length: 0), from: "hello", to: "hello world"), NSRange(location: 11, length: 0))
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 2, length: 0), from: "hello", to: "hello world"), NSRange(location: 2, length: 0))
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 1, length: 3), from: "hello", to: "hello world"), NSRange(location: 1, length: 3))
    }

    /// A delivered send takes back exactly what it sent: the caret in what was typed since moves back with those words.
    func testASendTakingItsWordsBackMovesTheCaretWithTheRest() {
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 14, length: 0), from: "sent message more", to: " more"), NSRange(location: 2, length: 0))
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 12, length: 0), from: "sent message", to: ""), NSRange(location: 0, length: 0))
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 0, length: 12), from: "sent message", to: ""), NSRange(location: 0, length: 0))
    }

    /// Another session's draft replaces the whole text: the caret goes to its end.
    func testAWholeNewDraftPutsTheCaretAtItsEnd() {
        XCTAssertEqual(ComposerEditing.selection(NSRange(location: 3, length: 0), from: "alpha", to: "beta draft"), NSRange(location: 10, length: 0))
    }

    // MARK: Two writers at once

    /// A dictation lands while the person is composing at the end (the accent menu up on an "e"): the composition ends
    /// as "é", and the dictated words still follow it.
    func testADictationDuringACompositionIsKeptAfterIt() {
        let merged = ComposerEditing.merge(base: "caf" + "e", theirs: "cafe and more", ours: "café", composing: NSRange(location: 3, length: 1))
        XCTAssertEqual(merged, "café and more")
    }

    /// A send delivered mid-composition takes back what it sent, before the composition, and keeps what is being typed.
    func testASendDeliveredDuringACompositionTakesOnlyWhatItSent() {
        let merged = ComposerEditing.merge(base: "sent か", theirs: " か", ours: "sent 漢字", composing: NSRange(location: 5, length: 1))
        XCTAssertEqual(merged, " 漢字")
    }

    /// The composition cancelled (Esc in the input method): conch's edit lands on what is left.
    func testACancelledCompositionStillGetsTheOutsideEdit() {
        let merged = ComposerEditing.merge(base: "abcか", theirs: "abcか dictated", ours: "abc", composing: NSRange(location: 3, length: 1))
        XCTAssertEqual(merged, "abc dictated")
    }

    /// Both touching the same words: the person's text stands. So does anything that isn't the composition changing.
    func testWhenBothTouchTheSameWordsThePersonsTextStands() {
        XCTAssertEqual(ComposerEditing.merge(base: "aか", theirs: "", ours: "a漢", composing: NSRange(location: 1, length: 1)), "a漢")
        XCTAssertEqual(ComposerEditing.merge(base: "abcか", theirs: "abcか!", ours: "zzz漢", composing: NSRange(location: 3, length: 1)), "zzz漢")
        XCTAssertEqual(ComposerEditing.merge(base: "abc", theirs: "abcd", ours: "abc", composing: NSRange(location: 9, length: 1)), "abc")
        // Nothing changed outside: nothing to carry.
        XCTAssertEqual(ComposerEditing.merge(base: "abcか", theirs: "abcか", ours: "abc漢", composing: NSRange(location: 3, length: 1)), "abc漢")
    }
}
