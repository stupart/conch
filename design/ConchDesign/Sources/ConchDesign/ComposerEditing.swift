import CoreGraphics
import Foundation

/// The Mac composer's text field, as rules: what Return does, how tall the field is, and how a change made to the draft
/// from outside the field lands in text the person may still be typing. The app's `ComposerEditor` is the AppKit half;
/// these are its decisions, tested here (ComposerEditingTests).
///
/// Outside changes are real and frequent: a dictation lands in the draft, a send that was delivered takes back exactly
/// what it sent, another session's draft comes in when the input moves to it. Everything is in UTF-16 offsets, which is
/// what NSTextView's ranges count.
public enum ComposerEditing {
    // MARK: Return

    public enum Return: Equatable, Sendable {
        /// Send the message.
        case send
        /// A new line in it.
        case newline
        /// The input method's: it is composing, and Return only commits that.
        case commit
    }

    /// Return sends; Shift- or Option-Return starts a new line, as the conversation panel's own line does
    /// (`FogReply.key`). While the input method is composing (marked text: a Japanese reading, a dead key's accent, the
    /// press-and-hold accent menu), Return belongs to the composition. The SwiftUI editor sent there, mid-word.
    public static func returnKey(shift: Bool, option: Bool, composing: Bool) -> Return {
        if composing { return .commit }
        return shift || option ? .newline : .send
    }

    // MARK: Height

    /// `#ta{font:var(--read)/22px}`: one line of the reading font in its 22 pt line box.
    public static let lineHeight: CGFloat = 22
    /// `#ta{max-height:calc(22px * 8 + 12px)}`: eight lines, then it scrolls inside itself (the 12 is the field's insets).
    public static let maxLines = 8

    /// The field's height for text TextKit laid out `used` points tall, never shorter than one line or taller than eight.
    ///
    /// TextKit 1 hangs a paragraph's `lineSpacing` under every line but the last (measured: one line 18 pt, two 40), so it
    /// is added back once and n lines are n of the lab's 22 pt boxes. Measured from the editor's own layout, not guessed
    /// beside it: the SwiftUI composer measured the draft with `boundingRect` at a width it read off a GeometryReader while
    /// the editor laid it out at its own, and the two disagreed (2026-10-04, offscreen: six wrapped lines measured 128 pt
    /// in a field whose text took 108).
    public static func height(used: CGFloat, lineSpacing: CGFloat) -> CGFloat {
        min(lineHeight * CGFloat(maxLines), max(lineHeight, ceil(used + lineSpacing)))
    }

    // MARK: Outside changes

    /// One replacement: `range` of the old text gives way to `replacement`.
    public struct Edit: Equatable, Sendable {
        public var range: NSRange
        public var replacement: String

        public init(range: NSRange, replacement: String) {
            self.range = range
            self.replacement = replacement
        }
    }

    /// The one edit that turns `old` into `new`: what they share at the start and at the end is kept, and the edit never
    /// splits a character (an emoji is two UTF-16 units, and a change to one of them is a change to both).
    public static func edit(from old: String, to new: String) -> Edit {
        let a = old as NSString, b = new as NSString
        let shortest = min(a.length, b.length)
        var prefix = 0
        while prefix < shortest, a.character(at: prefix) == b.character(at: prefix) { prefix += 1 }
        prefix = min(characterStart(a, prefix), characterStart(b, prefix))
        var suffix = 0
        while suffix < shortest - prefix, a.character(at: a.length - 1 - suffix) == b.character(at: b.length - 1 - suffix) {
            suffix += 1
        }
        suffix = min(a.length - characterEnd(a, a.length - suffix), b.length - characterEnd(b, b.length - suffix))
        return Edit(
            range: NSRange(location: prefix, length: a.length - prefix - suffix),
            replacement: b.substring(with: NSRange(location: prefix, length: b.length - prefix - suffix))
        )
    }

    /// Where a selection in `old` belongs once the text is `new`. Before the edit it stays where it is; after it, it moves
    /// with the words; touching or inside it, it goes to the end of what came in, so a dictation landing at the caret
    /// leaves the caret after it, ready for the next word.
    public static func selection(_ selection: NSRange, from old: String, to new: String) -> NSRange {
        let edit = edit(from: old, to: new)
        let end = NSMaxRange(edit.range)
        let arrived = edit.range.location + (edit.replacement as NSString).length
        let delta = (new as NSString).length - (old as NSString).length
        func place(_ offset: Int) -> Int {
            if offset < edit.range.location { return offset }
            if offset > end { return offset + delta }
            return arrived
        }
        let start = place(selection.location)
        return NSRange(location: start, length: max(0, place(NSMaxRange(selection)) - start))
    }

    /// Two writers at once. conch changed the draft from `base` to `theirs` while the person was composing in `composing`
    /// (a range of `base`, the marked text), and the composition has since ended as `ours`. conch's edit is carried onto
    /// `ours`: before the composition it lands where it was, after it it moves along with the words. If the two touch the
    /// same words, or `ours` is not `base` changed only inside the composition, the person's text stands, because what
    /// they can see themselves typing is the one thing the field must never take away.
    public static func merge(base: String, theirs: String, ours: String, composing: NSRange) -> String {
        let b = Array(base.utf16), o = Array(ours.utf16)
        guard composing.location >= 0, NSMaxRange(composing) <= b.count else { return ours }
        let head = b[..<composing.location], tail = b[NSMaxRange(composing)...]
        guard o.count >= head.count + tail.count, o.prefix(head.count).elementsEqual(head), o.suffix(tail.count).elementsEqual(tail) else {
            return ours
        }
        let edit = edit(from: base, to: theirs)
        let landing: NSRange
        if NSMaxRange(edit.range) <= composing.location {
            landing = edit.range
        } else if edit.range.location >= NSMaxRange(composing) {
            landing = NSRange(location: edit.range.location + o.count - b.count, length: edit.range.length)
        } else {
            return ours
        }
        return (ours as NSString).replacingCharacters(in: landing, with: edit.replacement)
    }

    /// The start of the character `offset` falls in, or `offset` itself at a boundary.
    private static func characterStart(_ text: NSString, _ offset: Int) -> Int {
        guard offset > 0, offset < text.length else { return offset }
        return text.rangeOfComposedCharacterSequence(at: offset).location
    }

    /// The end of the character that `offset` falls inside, or `offset` itself at a boundary.
    private static func characterEnd(_ text: NSString, _ offset: Int) -> Int {
        guard offset > 0, offset < text.length else { return offset }
        let character = text.rangeOfComposedCharacterSequence(at: offset)
        return character.location == offset ? offset : NSMaxRange(character)
    }
}
