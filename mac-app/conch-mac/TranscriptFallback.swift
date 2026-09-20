import AppKit
import ConchDesign
import SwiftUI

struct ConversationDocument {
    let text: NSAttributedString
    let scrollTarget: ConversationScrollTarget
    /// Which session's reply this is. Scroll position resets when the CONTENT
    /// changes identity, never merely because a streaming reply got longer.
    let contentID: String

    init(
        state: PublishedState?,
        targetRow: SessionRow?,
        isTargetLive: Bool,
        staticContent: SessionStaticContent
    ) {
        contentID = targetRow?.id ?? ""
        guard let state else {
            text = NSAttributedString(
                string: "Waiting for Conch…",
                attributes: ConversationDocument.attributes(
                    color: NSColor(ConchPalette.textDim)
                )
            )
            scrollTarget = .none
            return
        }

        guard isTargetLive else {
            let content: SessionStaticContent
            if targetRow == nil, state.rows.isEmpty {
                content = SessionStaticContent(
                    rowID: nil,
                    text: "",
                    isPlaceholder: true
                )
            } else {
                content = staticContent
            }
            let staticAttributes = ConversationDocument.attributes(
                color: NSColor(
                    content.isPlaceholder
                        ? ConchPalette.textDim
                        : ConchPalette.textPrimary
                )
            )
            // A placeholder is our own prose, never markdown; a real reply is an
            // agent's markdown and must render as prose, not as source. This is
            // the path a session spends MOST of its life in — only the live
            // reading path was being rendered before.
            text = content.isPlaceholder
                ? NSAttributedString(string: content.text, attributes: staticAttributes)
                : ConversationDocument.markdown(content.text, attributes: staticAttributes)
            scrollTarget = .none
            return
        }

        let live = state.live
        let isDictating = live.isCapturing || live.state == "transcribing"

        var replyText = ""
        var spokenFraction = 0.0
        var isQuotedReply = false
        var showsReadingProgress = false

        if isDictating {
            if let reading = live.reading, !reading.text.isEmpty {
                replyText = reading.displayText
                spokenFraction = reading.spokenFraction
            } else if let reply = state.reply, !reply.text.isEmpty {
                replyText = reply.displayText
                spokenFraction = reply.spokenFraction
            }
            isQuotedReply = true
        } else if let reading = live.reading, !reading.text.isEmpty {
            replyText = reading.displayText
            spokenFraction = reading.spokenFraction
            showsReadingProgress = true
        } else if let reply = state.reply, !reply.text.isEmpty {
            replyText = reply.displayText
            spokenFraction = reply.spokenFraction
            showsReadingProgress = true
        }

        var transcript = live.transcriptPrefix
        if !transcript.isEmpty && !live.partial.isEmpty {
            transcript += " "
        }
        transcript += live.partial

        let output = NSMutableAttributedString()
        let body = ConversationDocument.attributes(color: NSColor(ConchPalette.textPrimary))
        let dim = ConversationDocument.attributes(color: NSColor(ConchPalette.textDim))
        let accent = ConversationDocument.attributes(color: NSColor(ConchPalette.brandCyan))
        var spokenLocation: Int?

        if !replyText.isEmpty {
            if isDictating {
                output.append(NSAttributedString(string: "↪ replying to · ", attributes: dim))
            }

            if isQuotedReply {
                output.append(ConversationDocument.markdown(replyText, attributes: dim))
            } else if live.state == "speaking", showsReadingProgress {
                // Parse the WHOLE reply once, then dim the unspoken tail.
                //
                // Rendering the two halves separately corrupts block structure:
                // a list straddling the boundary is parsed twice, so one half
                // loses its bullets and the other injects one mid-sentence.
                let rendered = NSMutableAttributedString(
                    attributedString: ConversationDocument.markdown(replyText, attributes: body)
                )
                // Progress arrives as a fraction of the SPOKEN text, which has no
                // markdown in it — so a character offset from it cannot index the
                // rendered string. Scale the fraction onto the rendered length.
                let spokenLength = min(
                    Int((Double(rendered.length) * spokenFraction).rounded()),
                    rendered.length
                )
                if spokenLength < rendered.length {
                    rendered.addAttribute(
                        .foregroundColor,
                        value: NSColor(ConchPalette.textDim),
                        range: NSRange(
                            location: spokenLength,
                            length: rendered.length - spokenLength
                        )
                    )
                }
                spokenLocation = output.length + spokenLength
                output.append(rendered)
            } else {
                output.append(ConversationDocument.markdown(replyText, attributes: body))
            }
        }

        if isDictating {
            if output.length > 0 {
                output.append(NSAttributedString(string: "\n\n", attributes: body))
            }
            output.append(NSAttributedString(string: transcript, attributes: body))
            if live.isCapturing {
                output.append(NSAttributedString(string: "▌", attributes: accent))
            }
        }

        if output.length == 0 {
            let label: String
            if let targetRow, !targetRow.label.isEmpty {
                label = " from ‹\(targetRow.label)›"
            } else {
                label = ""
            }
            let placeholder = live.state == "transcribing"
                ? "Transcribing…"
                : "Waiting for a reply\(label)…"
            output.append(NSAttributedString(string: placeholder, attributes: dim))
        }

        text = output
        if isDictating {
            scrollTarget = .end
        } else if live.state == "speaking", let spokenLocation {
            scrollTarget = .character(spokenLocation)
        } else {
            scrollTarget = .none
        }
    }

    static func attributes(color: NSColor) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 5
        paragraph.paragraphSpacing = 0
        paragraph.lineBreakMode = .byWordWrapping
        return [
            .font: ConchTypography.nsFont(size: 16),
            .foregroundColor: color,
            .kern: -0.25,
            .paragraphStyle: paragraph,
        ]
    }

    /// An agent's reply as a document, through the typesetter both of this app's AppKit surfaces share
    /// (ConchDesign/Markdown.swift): headings on a scale, lists on hanging indents, code on a ground, and tables as
    /// `NSTextTable` columns.
    ///
    /// This used to rebuild the block layout by hand from Foundation's `.full` parse — separators, bullets, indents —
    /// and set a table's cells on 118 pt tab stops, which no cell of the atlas documents fits, so a row became one
    /// long line wrapped at random. `NSTextTable` is TextKit's own table layout; nothing else here had to change.
    ///
    /// The caller styles spoken vs unspoken by dimming a character range of the result, which is why this is one
    /// attributed string and not a view per block. Unparseable input comes back literal, so a malformed reply can
    /// never blank the pane.
    static func markdown(
        _ text: String,
        attributes base: [NSAttributedString.Key: Any]
    ) -> NSAttributedString {
        guard !text.isEmpty else { return NSAttributedString(string: "", attributes: base) }
        return MarkdownTypesetter.attributedString(text, base: base)
    }
}

enum ConversationScrollTarget: Equatable {
    case none
    case character(Int)
    case end
}

struct ConversationTextView: NSViewRepresentable {
    let attributedText: NSAttributedString
    let scrollTarget: ConversationScrollTarget
    let contentID: String
    /// A markdown link in the rendered reply, clicked. Without a delegate
    /// NSTextView hands it to `NSWorkspace.open` and drops the answer — the
    /// silent half of A13.
    var onOpenLink: (String) -> Void = { _ in }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var previousText = NSAttributedString(string: "")
        var previousScrollTarget = ConversationScrollTarget.none
        var previousContentID = ""
        var onOpenLink: (String) -> Void = { _ in }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            onOpenLink(LinkTarget.text(of: link))
            return true
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.borderType = .noBorder

        let textView = NSTextView()
        // TextKit 1, up front. `NSTextView()` starts on TextKit 2, which has no `NSTextTable`, and a reply's tables
        // are `NSTextTable`s now: laid out on TextKit 2 the atlas document set every cell as its own full-width
        // paragraph (7,317 pt of stacked cells against 8,604 pt of columns, 2026-09-20). Touching `layoutManager` is
        // the documented switch, so the columns do not depend on AppKit noticing the attribute on its own.
        _ = textView.layoutManager
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.importsGraphics = false
        textView.allowsUndo = false
        textView.usesFindBar = false
        textView.focusRingType = .none
        textView.textContainerInset = NSSize(width: 24, height: 24)
        textView.minSize = .zero
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        // Measure is capped rather than tracking the view: at full width a wide
        // window ran ~95 characters per line, well past the 60-75 that reads
        // comfortably, and it got worse the wider the window went.
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: ConversationTextView.maxMeasure,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.delegate = context.coordinator
        scrollView.documentView = textView
        return scrollView
    }

    /// ~75 characters at the 16pt body size.
    /// The reading measure, shared by both of this app's transcript renderers (workspace-v1
    /// §3: "a 700 pt measure, centred"). A line that runs the full width of a wide window is
    /// a line the eye loses its place in on the way back.
    static let maxMeasure: CGFloat = 700

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        context.coordinator.onOpenLink = onOpenLink
        // Centre the capped measure. Left-aligning it left ~800pt of dead black
        // to the right of the text on a wide pane, which reads as broken rather
        // than as a deliberate column.
        let available = max(200, scrollView.contentSize.width - 48)
        let measure = min(available, Self.maxMeasure)
        let sideInset = max(24, (scrollView.contentSize.width - measure) / 2)
        if textView.textContainerInset.width != sideInset {
            textView.textContainerInset = NSSize(width: sideInset, height: 24)
        }
        if textView.textContainer?.containerSize.width != measure {
            textView.textContainer?.containerSize = NSSize(
                width: measure,
                height: CGFloat.greatestFiniteMagnitude
            )
        }
        textView.frame.size.width = scrollView.contentSize.width
        let textChanged = !context.coordinator.previousText.isEqual(to: attributedText)
        let targetChanged = context.coordinator.previousScrollTarget != scrollTarget

        if textChanged {
            let selectedRanges = textView.selectedRanges
            textView.textStorage?.setAttributedString(attributedText)
            let restoredRanges: [NSValue] = selectedRanges.compactMap { value -> NSValue? in
                let range = value.rangeValue
                guard range.location <= attributedText.length else { return nil }
                return NSValue(
                    range: NSRange(
                        location: range.location,
                        length: min(range.length, attributedText.length - range.location)
                    )
                )
            }
            textView.selectedRanges = restoredRanges.isEmpty
                ? [NSValue(range: NSRange(location: attributedText.length, length: 0))]
                : restoredRanges
            context.coordinator.previousText = attributedText.copy() as? NSAttributedString
                ?? attributedText
        }

        context.coordinator.previousScrollTarget = scrollTarget
        // Resetting on ANY text change dragged the reader back to the top every
        // poll while a reply was still being written — the most common state in
        // a voice loop, and the one where you most want to read. Only a change
        // of WHOSE reply this is starts you at the top again.
        let identityChanged = context.coordinator.previousContentID != contentID
        context.coordinator.previousContentID = contentID
        guard textChanged || targetChanged else { return }

        DispatchQueue.main.async { [weak scrollView, weak textView] in
            guard let scrollView, let textView else { return }
            scroll(textView, in: scrollView, to: scrollTarget, reset: identityChanged)
        }
    }

    private func scroll(
        _ textView: NSTextView,
        in scrollView: NSScrollView,
        to target: ConversationScrollTarget,
        reset: Bool
    ) {
        switch target {
        case .none:
            if reset {
                scrollView.contentView.scroll(to: .zero)
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }
        case .end:
            textView.scrollRangeToVisible(
                NSRange(location: textView.string.utf16.count, length: 0)
            )
        case let .character(location):
            centerCharacter(location, in: textView, scrollView: scrollView)
        }
    }

    private func centerCharacter(
        _ location: Int,
        in textView: NSTextView,
        scrollView: NSScrollView
    ) {
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer,
              textView.string.utf16.count > 0 else {
            return
        }

        layoutManager.ensureLayout(for: textContainer)
        let characterLocation = min(max(0, location), textView.string.utf16.count - 1)
        let glyphRange = layoutManager.glyphRange(
            forCharacterRange: NSRange(location: characterLocation, length: 1),
            actualCharacterRange: nil
        )
        var glyphRect = layoutManager.boundingRect(
            forGlyphRange: glyphRange,
            in: textContainer
        )
        glyphRect.origin.x += textView.textContainerOrigin.x
        glyphRect.origin.y += textView.textContainerOrigin.y

        let maximumY = max(
            0,
            textView.bounds.height - scrollView.contentView.bounds.height
        )
        let centeredY = min(
            maximumY,
            max(0, glyphRect.midY - scrollView.contentView.bounds.height / 2)
        )
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: centeredY))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}
