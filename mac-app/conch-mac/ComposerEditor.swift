import AppKit
import ConchDesign
import SwiftUI

/// The composer's text field: AppKit's text view, built and owned here.
///
/// It was SwiftUI's TextEditor, reached into from behind by an introspector that walked the view tree for "the editable
/// NSTextView" and set it up a runloop turn later. Tyler, 2026-10-04: "something is weird about the input bar in the conch
/// app and the spellcheck like deletes / changes what im typing sometimes and all the text goes invisible". Measured
/// offscreen that day against the old field (its own bridge code, extracted by line range):
///
///     autocorrect        SwiftUI's TextEditor turned correction ON in every update it made to the editor, and every
///                        keystroke is one. The re-apply meant to put the person's setting back never ran while typing:
///                        SwiftUI never called its update. Correction off in System Settings, it was on again from
///                        the second keystroke; on (the default, and Tyler's), it was simply on.
///     marked text        any SwiftUI update while a composition was open (an accent from press-and-hold, a dead key,
///                        Japanese input) put the binding's text back over it: "afterか" became "after". conch's state
///                        republishes several times a second while an agent works, ten while the mic hears you.
///     the reach          missed the editor outright in some launches (1 in 12, then 4 in 10): smart quotes and dashes
///                        left on, and no leading, insets or caret fix.
///     TextKit            the editor was laid out on TextKit 2 (its viewport views were up) and 92 ms later forced
///                        onto TextKit 1 by the reach reading `layoutManager`, under SwiftUI's adaptor.
///     leading            typed lines came out 18 pt apart, without the leading, while the field was measured with it:
///                        six wrapped lines measured 128 pt held text 108 tall.
///
/// Here nothing SwiftUI does touches the text view's settings: it is TextKit 1 from the start, its spelling is set once,
/// it is the draft's source of truth while you type, and an outside change to the draft waits for a composition to end.
struct ComposerEditor: NSViewRepresentable {
    @Binding var text: String
    /// The field has the keyboard. Setting it true gives it the keyboard; the field sets it back as focus comes and goes.
    @Binding var isFocused: Bool
    /// Whose draft this is. Another session's draft is a different document: it replaces the text outright, a
    /// composition and the undo history with it.
    let identity: String
    /// Return, unmodified (`ComposerEditing.returnKey`).
    let onSend: () -> Void

    /// The reading font, its leading and its ink, on every character: the field is plain text in one style. The lab's
    /// `#ta` uses the READING font — the composer answers the transcript, so it is set at the same size rather than a
    /// size smaller.
    static let font = NSFont.systemFont(ofSize: ConchType.readingBodySize)
    /// `#ta{font:var(--read)/22px}` — 22 pt between lines, which is 15 pt of type plus 4 pt of leading:
    /// `ConchType.readingLineSpacing`, the same number the transcript uses, so the composer and the messages it answers
    /// cannot drift apart.
    ///
    /// It must be lineSpacing, NOT min/maxLineHeight. CSS splits a line box's extra leading half above and half below;
    /// AppKit puts ALL of it above the baseline. So asking for a 22 pt line box pushed the first line down and grew the
    /// caret with it, which is how an earlier attempt at this made the gap worse:
    ///
    ///     no style          caret 18 pt, text ink at 4 pt
    ///     min/max 22        caret 22 pt, text ink at 8 pt   <- shipped, and wrong
    ///     lineSpacing 4     caret 18 pt, text ink at 4 pt
    static let paragraph: NSParagraphStyle = {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = ConchType.readingLineSpacing
        return paragraph
    }()
    /// The palette's own dynamic colour, resolved as it is drawn: light words in Dark mode, dark ones in Light, and across
    /// a switch between them with nothing to redo. SwiftUI resolved its foreground style to a fixed colour per update.
    static let ink = NSColor(ConchPalette.textPrimary)
    static var attributes: [NSAttributedString.Key: Any] {
        [.font: font, .foregroundColor: ink, .paragraphStyle: paragraph]
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        // TextKit 1 from creation. `NSTextView()` starts on TextKit 2, and the caret's seam (`ComposerCaretBaseline`) is a
        // layout manager's: asking an existing view for its layout manager switches it over after it has drawn.
        let view = ComposerTextView(usingTextLayoutManager: false)
        let coordinator = context.coordinator
        coordinator.textView = view
        view.delegate = coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.usesFindBar = true
        view.drawsBackground = false
        view.focusRingType = .none
        // No inset and no line-fragment padding: ComposerView's padding is the only one, and the placeholder, the
        // dictation line and the swoop's picture sit by that same padding.
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.minSize = .zero
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.font = Self.font
        view.textColor = Self.ink
        view.defaultParagraphStyle = Self.paragraph
        view.typingAttributes = Self.attributes

        // Spelling the way the rest of the Mac does it, set once: nothing else writes these now. Typos are underlined
        // and right-click still offers the fixes. Nothing is corrected as you type, whatever System Settings says: this
        // text lands in terminals and code, where a word replaced behind you is a command changed behind you, which is
        // also why smart quotes and dashes stay off. Text replacements are the person's own shortcuts, so they follow
        // their setting.
        view.isContinuousSpellCheckingEnabled = true
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isAutomaticTextReplacementEnabled = NSSpellChecker.isAutomaticTextReplacementEnabled
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false

        // The caret straddles the words instead of riding above them (`ComposerCaretBaseline`), installed before the
        // first layout, so a draft that is already here when the field is built sits where typed words do.
        view.layoutManager?.delegate = ComposerCaretBaseline.shared
        view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))
        view.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        coordinator.identity = identity
        coordinator.lastPushed = text

        view.onFocusChange = { [weak coordinator] focused in coordinator?.focusChanged(focused) }
        view.onMarkedTextChange = { [weak coordinator] in coordinator?.markedTextChanged() }
        view.updateDragTypeRegistration()

        let scroll = ComposerScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        // AppKit draws a text view's focus ring on its SCROLL VIEW (the panel's reply line learned this first).
        scroll.focusRingType = .none
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.documentView = view
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if coordinator.identity != identity {
            coordinator.identity = identity
            coordinator.replace(with: text)
        } else {
            coordinator.receive(text)
        }
        coordinator.focus(isFocused)
    }

    /// As tall as its text lays out at the width it is offered, one line to eight (`ComposerEditing.height`), measured
    /// with the field's own attributes and typesetter rather than a guess beside them.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        // Asked without a width (an ideal size), it answers for the width it has.
        let offered = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        guard let width = offered ?? (nsView.bounds.width > 0 ? nsView.bounds.width : nil) else { return nil }
        return CGSize(width: width, height: context.coordinator.height(at: width))
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerEditor
        weak var textView: ComposerTextView?
        var identity = ""
        /// What the field last wrote to the draft, or was last given.
        var lastPushed = ""
        /// The field is making a change of its own: not news to send back.
        private var applying = false
        /// An outside change that arrived while a composition was open, kept until it ends (`ComposerEditing.merge`).
        private var held: (base: String, theirs: String, composing: NSRange)?
        /// `isFocused` as last seen, so only a change to true asks for the keyboard.
        private var sawFocused = false
        /// The field's own history: the window's is shared with every other field in it.
        let undo = UndoManager()
        private let measure = Measure()

        init(_ parent: ComposerEditor) {
            self.parent = parent
        }

        // MARK: The field to the draft

        func textDidChange(_ notification: Notification) {
            guard !applying, let view = textView else { return }
            if !view.hasMarkedText() { settle() }
            // While an outside change waits on a composition the draft keeps it: writing the field back would lose it.
            if held == nil { push(view.string) }
        }

        /// A composition's text is the draft's too, or the placeholder sits over the first letter you compose. Setting
        /// marked text changes the text but posts no textDidChange (measured).
        func markedTextChanged() {
            guard !applying, let view = textView else { return }
            if view.hasMarkedText() {
                if held == nil { push(view.string) }
            } else if held != nil {
                // Committed or cancelled with nothing typed after: settle once whatever ended it has finished.
                DispatchQueue.main.async { [weak self] in self?.settleNow() }
            }
        }

        private func push(_ string: String) {
            lastPushed = string
            if parent.text != string { parent.text = string }
        }

        // MARK: The draft to the field

        /// The draft as SwiftUI has it now. The field is the source of truth while you type: this only lands when it is
        /// news (not the field's own write coming back), and never into an open composition.
        func receive(_ text: String) {
            guard let view = textView else { return }
            if view.hasMarkedText() {
                if let current = held {
                    held = (current.base, text, current.composing)
                } else if text != lastPushed {
                    held = (lastPushed, text, view.markedRange())
                }
                return
            }
            if held != nil {
                // The composition ended without a keystroke (the field lost focus). Not inside SwiftUI's update: settling
                // writes the merged draft back.
                DispatchQueue.main.async { [weak self] in self?.settleNow() }
                return
            }
            if text != view.string { apply(text) }
        }

        private func settleNow() {
            guard let view = textView, !view.hasMarkedText(), held != nil else { return }
            settle()
            push(view.string)
        }

        /// The composition is over: an outside change held through it lands now, on what was typed.
        private func settle() {
            guard let view = textView, !view.hasMarkedText(), let held else { return }
            self.held = nil
            let merged = ComposerEditing.merge(base: held.base, theirs: held.theirs, ours: view.string, composing: held.composing)
            if merged != view.string { apply(merged) }
        }

        /// An outside change, as the one edit it is, through the text view's own gate: its own undo step, so the undo
        /// history never holds ranges of text that has moved under it, and Cmd-Z takes back a dictation or brings back
        /// what a send cleared without taking the typing around it too. The caret goes where the edit leaves it
        /// (`ComposerEditing.selection`).
        private func apply(_ text: String) {
            guard let view = textView, let storage = view.textStorage else { return }
            let old = view.string
            let edit = ComposerEditing.edit(from: old, to: text)
            let selection = ComposerEditing.selection(view.selectedRange(), from: old, to: text)
            applying = true
            defer { applying = false }
            // Typing coalesces into one undo step until something breaks it: without the breaks, an outside change in
            // the middle of a run of typing would be undone together with it.
            view.breakUndoCoalescing()
            if view.shouldChangeText(in: edit.range, replacementString: edit.replacement) {
                storage.replaceCharacters(in: edit.range, with: NSAttributedString(string: edit.replacement, attributes: ComposerEditor.attributes))
                view.didChangeText()
                view.breakUndoCoalescing()
            } else {
                storage.setAttributedString(NSAttributedString(string: text, attributes: ComposerEditor.attributes))
                undo.removeAllActions()
            }
            // Emptied, a text view forgets its typing style; the next word would be 12 pt and black.
            view.typingAttributes = ComposerEditor.attributes
            view.setSelectedRange(selection)
            view.scrollRangeToVisible(selection)
            lastPushed = text
        }

        /// Another session's draft: the text, the caret at its end, no composition and no history from the last one.
        func replace(with text: String) {
            guard let view = textView, let storage = view.textStorage else { return }
            applying = true
            defer { applying = false }
            if view.hasMarkedText() {
                view.inputContext?.discardMarkedText()
                view.unmarkText()
            }
            held = nil
            storage.setAttributedString(NSAttributedString(string: text, attributes: ComposerEditor.attributes))
            undo.removeAllActions()
            view.typingAttributes = ComposerEditor.attributes
            let end = NSRange(location: (text as NSString).length, length: 0)
            view.setSelectedRange(end)
            view.scrollRangeToVisible(end)
            lastPushed = text
        }

        // MARK: Keys

        /// Return SENDS. Tyler kept "trying to send and making a new line accidentally instead", which is the wrong
        /// default for a chat composer: the common act should be the unmodified key. Shift- or Option-Return breaks the
        /// line. Asked here, after the input method has had the key, rather than before it as `.onKeyPress` was: a
        /// Return that commits a composition commits it and sends nothing.
        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            let event = (view as? ComposerTextView)?.keyEvent ?? NSApp.currentEvent
            guard Self.isReturn(selector, event: event) else { return false }
            let flags = event?.modifierFlags ?? []
            switch ComposerEditing.returnKey(shift: flags.contains(.shift), option: flags.contains(.option), composing: view.hasMarkedText()) {
            case .send:
                parent.onSend()
            case .newline:
                view.insertNewlineIgnoringFieldEditor(nil)
            case .commit:
                view.unmarkText()
                view.inputContext?.discardMarkedText()
            }
            return true
        }

        private static let returnCommands: Set<Selector> = [
            #selector(NSResponder.insertNewline(_:)),
            #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)),
            #selector(NSResponder.insertLineBreak(_:)),
        ]

        /// Return, with whatever it is held with. ⌘↩ reaches a text view as `noop:`; it sent before, and still does.
        static func isReturn(_ selector: Selector, event: NSEvent?) -> Bool {
            if returnCommands.contains(selector) { return true }
            return selector == NSSelectorFromString("noop:") && event?.type == .keyDown && (event?.keyCode == 36 || event?.keyCode == 76)
        }

        func undoManager(for view: NSTextView) -> UndoManager? { undo }

        // MARK: Focus

        /// Asked for after SwiftUI's update rather than inside it: taking the keyboard makes whatever had it let go, and
        /// that may be a SwiftUI field with focus state of its own.
        func focus(_ wanted: Bool) {
            defer { sawFocused = wanted }
            guard wanted, !sawFocused, let view = textView else { return }
            DispatchQueue.main.async { [weak view] in
                guard let view else { return }
                if let window = view.window {
                    if window.firstResponder !== view { window.makeFirstResponder(view) }
                } else {
                    view.wantsFocus = true
                }
            }
        }

        /// Reported after the change, not inside it: focus moves during SwiftUI's own updates too.
        func focusChanged(_ focused: Bool) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.parent.isFocused != focused else { return }
                self.sawFocused = focused
                self.parent.isFocused = focused
            }
        }

        // MARK: Height

        func height(at width: CGFloat) -> CGFloat {
            guard let storage = textView?.textStorage else { return ComposerEditing.lineHeight }
            return measure.height(of: storage, at: width)
        }
    }
}

/// The composer's text view: what it reports, and the drops it turns away.
final class ComposerTextView: NSTextView {
    var onFocusChange: ((Bool) -> Void)?
    var onMarkedTextChange: (() -> Void)?
    /// Asked for the keyboard before it had a window to take it in.
    var wantsFocus = false
    /// The key being interpreted, for its modifiers (`textView(_:doCommandBy:)`).
    private(set) var keyEvent: NSEvent?

    override func keyDown(with event: NSEvent) {
        keyEvent = event
        defer { keyEvent = nil }
        super.keyDown(with: event)
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            wantsFocus = false
            onFocusChange?(true)
        }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange?(false) }
        return resigned
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if wantsFocus, let window, window.firstResponder !== self { window.makeFirstResponder(self) }
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        onMarkedTextChange?()
    }

    override func unmarkText() {
        super.unmarkText()
        onMarkedTextChange?()
    }

    /// A dropped file must reach the composer's `.onDrop`, not this editor. NSTextView registers for file drops and
    /// inserts the PATH as text, and it is the deeper view under the pointer, so it won every drop on the text area —
    /// Tyler dragged two screenshots in and got two paths in the message. Text drags still land here.
    ///
    /// Image types are refused too now that the composer accepts image BYTES: a text view that takes them draws a dragged
    /// image inline or drops it, the same loss as the pasted paths wearing a different shape. Every name for each type,
    /// the pasteboard's old ones included, and as the types AppKit registers, rather than unregistering once: AppKit
    /// registers them again whenever the view's editable or rich-text state changes.
    static let refusedDragTypes: Set<NSPasteboard.PasteboardType> = [
        .fileURL, NSPasteboard.PasteboardType("NSFilenamesPboardType"), .png, .tiff,
        NSPasteboard.PasteboardType("Apple PNG pasteboard type"), NSPasteboard.PasteboardType("NeXT TIFF v4.0 pasteboard type"),
        NSPasteboard.PasteboardType("com.apple.NSFilePromiseItemMetaData"),
        NSPasteboard.PasteboardType("com.apple.pasteboard.promised-file-content-type"),
    ]

    override var acceptableDragTypes: [NSPasteboard.PasteboardType] {
        super.acceptableDragTypes.filter { !Self.refusedDragTypes.contains($0) }
    }
}

/// The field's scroll view: the text view always fills it, so a click anywhere in the field lands in the text, and the
/// field never shows a scrolled-away first line while its words fit.
final class ComposerScrollView: NSScrollView {
    override func tile() {
        super.tile()
        guard let text = documentView as? NSTextView else { return }
        let height = contentSize.height
        if text.minSize.height != height {
            text.minSize = NSSize(width: 0, height: height)
            text.sizeToFit()
        }
        // The text view scrolls its caret into view as it is typed, at the height the field had a moment ago; SwiftUI
        // grows the field after. Grown, it shows the words from their first line again.
        let clip = contentView
        let constrained = clip.constrainBoundsRect(clip.bounds).origin
        if constrained != clip.bounds.origin {
            clip.scroll(to: constrained)
            reflectScrolledClipView(clip)
        }
    }
}

/// The height of the field's text at a width, laid out by a TextKit 1 stack of its own: SwiftUI asks at several widths in
/// one pass, and the field's own layout is not the place to try them. One answer kept, since it asks the same twice.
@MainActor
private final class Measure {
    private let storage = NSTextStorage()
    private let layout = NSLayoutManager()
    private let container = NSTextContainer(size: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    private var last: (text: String, width: CGFloat, height: CGFloat)?

    init() {
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
    }

    func height(of text: NSAttributedString, at width: CGFloat) -> CGFloat {
        if let last, last.width == width, last.text == text.string { return last.height }
        storage.setAttributedString(text)
        // An empty field is one line of its own type, not of the default 12 pt face an empty storage has.
        if text.length == 0 { storage.setAttributedString(NSAttributedString(string: " ", attributes: ComposerEditor.attributes)) }
        container.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let height = ComposerEditing.height(used: layout.usedRect(for: container).height, lineSpacing: ConchType.readingLineSpacing)
        last = (text.string, width, height)
        return height
    }
}

/// The caret straddles the words instead of riding above them.
///
/// Tyler: the cursor "rides high". Measured off the running app at 2x, focused and empty: the caret's ink spans 108..143
/// while the placeholder's spans 115..142 — 7 px of caret above the words and 1 px below them. Nothing is wrong with the
/// leading. AppKit draws the caret to the LINE FRAGMENT, whose top is the ASCENT, and the reading font clears the cap line
/// by 3.9 pt up top while its descent only just clears the descender.
///
/// Everything closer to the caret was tried first, each with a compiled probe against a real NSTextView, because two
/// earlier attempts at "the caret" reasoned from simplified probes and shipped the wrong fix:
///
///     drawInsertionPoint(in:color:turnedOn:)  never called — under TextKit 2 the caret is an
///                                             NSTextInsertionIndicator SUBVIEW
///     that subview's bounds / layer transform  AppKit rewrites both on the next keystroke
///     .baselineOffset on the text              absorbed by the typesetter under BOTH TextKits:
///                                              the line grows, the ink does not move
///     this delegate, under TextKit 1           glyph ink 72..99 -> 68..95, caret 64..99 in both
///                                              runs: 8 px above / 0 below becomes 4 and 4
///
/// So the glyphs rise half the leading INSIDE the fragment while the fragment — the caret — stays where it was, and
/// `ComposerView.caretRaise` slides the whole editor back down by that same half. The words do not move by a pixel; only
/// the caret does. `ComposerEditor` is TextKit 1 from creation and installs this before its first layout; it used to be
/// installed by the introspector, after the editor had already drawn on TextKit 2 (2026-10-04).
final class ComposerCaretBaseline: NSObject, NSLayoutManagerDelegate {
    /// AppKit holds a layout manager's delegate weakly, and this one is stateless and the same for every composer, so one
    /// instance is kept alive here rather than parked on each view.
    static let shared = ComposerCaretBaseline()

    func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>,
        lineFragmentUsedRect: UnsafeMutablePointer<NSRect>,
        baselineOffset: UnsafeMutablePointer<CGFloat>,
        in textContainer: NSTextContainer,
        forGlyphRange glyphRange: NSRange
    ) -> Bool {
        baselineOffset.pointee -= ConchType.readingLineSpacing / 2
        return true
    }
}
