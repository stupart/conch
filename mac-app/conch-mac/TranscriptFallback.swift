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

    /// Render an agent reply as markdown rather than showing its syntax.
    ///
    /// Foundation gives us a parse tree, not a layout: `.inlineOnly` leaves
    /// `## `, `- ` and `> ` markers visible, while `.full` strips them but drops
    /// every newline (a three-item list arrives as "onetwothree"). So we parse
    /// with `.full` and rebuild the block layout ourselves — separators between
    /// blocks, bullets and ordinals for list items, an indent for quotes and
    /// code, and heading weight — then apply inline emphasis within each run.
    ///
    /// Unparseable input falls back to the literal string, so a malformed reply
    /// can never blank the pane. The caller styles spoken vs unspoken by passing
    /// different base attributes per half, so base is applied FIRST and the
    /// parsed emphasis re-applied over it — bold must survive in both halves.
    static func markdown(
        _ text: String,
        attributes base: [NSAttributedString.Key: Any]
    ) -> NSAttributedString {
        guard !text.isEmpty else { return NSAttributedString(string: "", attributes: base) }
        guard let parsed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                allowsExtendedAttributes: true,
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ), !parsed.characters.isEmpty else {
            return NSAttributedString(string: text, attributes: base)
        }

        let baseFont = (base[.font] as? NSFont) ?? ConchTypography.nsFont(size: 16)
        let output = NSMutableAttributedString()
        var previousBlock: Int?
        var previousWasListItem = false
        var previousWasTableCell = false

        for run in parsed.runs {
            let piece = NSMutableAttributedString(
                attributedString: NSAttributedString(AttributedString(parsed[run.range]))
            )
            guard piece.length > 0 else { continue }
            var whole = NSRange(location: 0, length: piece.length)
            piece.addAttributes(base, range: whole)

            let intent = run.presentationIntent
            let blockID = intent?.components.first?.identity
            let isNewBlock = blockID != previousBlock

            // Block styling: heading weight, monospace for code, indent for
            // quotes/code. `.full` erases the source newlines, so reinsert one
            // blank line between blocks and a single break between list items.
            var prefix = ""
            var indent: CGFloat = 0
            var blockFont = baseFont
            var isTableCell = false
            var startsTableRow = false
            var isHeaderRow = false
            var isListItem = false
            if let components = intent?.components {
                // Nesting depth drives the indent: a list inside a list carries
                // two listItem components, so count them rather than assuming one.
                let listDepth = components.filter {
                    if case .listItem = $0.kind { return true }
                    return false
                }.count
                for component in components {
                    switch component.kind {
                    case .header(let level):
                        let size = baseFont.pointSize + (level <= 1 ? 5 : level == 2 ? 3 : 1)
                        let descriptor = baseFont.fontDescriptor.withSymbolicTraits(.bold)
                        blockFont = NSFont(descriptor: descriptor, size: size)
                            ?? NSFont.boldSystemFont(ofSize: size)
                    case .listItem(let ordinal):
                        isListItem = true
                        // "Is ANY ancestor an ordered list" made a bullet nested
                        // under a numbered item render as a number, and left the
                        // "◦ " branch unreachable. What matters is the list this
                        // item actually belongs to: the NEAREST list ancestor.
                        let ordered: Bool = {
                            for candidate in components {
                                if case .orderedList = candidate.kind { return true }
                                if case .unorderedList = candidate.kind { return false }
                            }
                            return false
                        }()
                        // Only the OUTERMOST listItem marks this line; the inner
                        // components describe ancestors, whose bullets already ran.
                        if isNewBlock, prefix.isEmpty {
                            prefix = ordered ? "\(ordinal). " : (listDepth > 1 ? "◦ " : "• ")
                        }
                        indent = CGFloat(listDepth) * 16
                    case .blockQuote:
                        // Dimming a quote collides with reading progress, which
                        // dims the text the voice has NOT reached yet: during a
                        // read-aloud a quote looked unread and unread text looked
                        // quoted. Indent carries the quote instead.
                        indent = 22
                    case .codeBlock:
                        blockFont = NSFont.monospacedSystemFont(
                            ofSize: baseFont.pointSize - 1,
                            weight: .regular
                        )
                        indent = 16
                    // A table arrives as one run PER CELL. Without this every
                    // cell became its own line, so a 2x2 table rendered as four
                    // stacked fragments. Keep a row on one line, separated, and
                    // bold the header row.
                    case .tableCell(let column):
                        isTableCell = true
                        if column == 0 { startsTableRow = true }
                        blockFont = NSFont.monospacedSystemFont(
                            ofSize: baseFont.pointSize - 1,
                            weight: .regular
                        )
                    case .tableHeaderRow:
                        isHeaderRow = true
                    default:
                        break
                    }
                }
            }
            if isTableCell, isHeaderRow {
                let descriptor = blockFont.fontDescriptor.withSymbolicTraits(.bold)
                blockFont = NSFont(descriptor: descriptor, size: blockFont.pointSize) ?? blockFont
            }
            piece.addAttribute(.font, value: blockFont, range: whole)

            // We own the newlines, so a newline the parser did leave in (code
            // blocks keep theirs) would double up against our own separator.
            while piece.length > 0, piece.string.hasSuffix("\n") {
                piece.deleteCharacters(in: NSRange(location: piece.length - 1, length: 1))
            }
            guard piece.length > 0 else { continue }
            whole = NSRange(location: 0, length: piece.length)

            // The indent has to be on the WHOLE LINE, not just the text: AppKit
            // takes a paragraph's style from its FIRST character, which for a
            // list item is the bullet. Styling only the text left it dead.
            var lineAttributes = base
            if indent > 0, let paragraph = (base[.paragraphStyle] as? NSParagraphStyle)?
                .mutableCopy() as? NSMutableParagraphStyle {
                paragraph.firstLineHeadIndent = indent
                // Hanging indent so a wrapped item lines up under its own text
                // rather than sliding back under the bullet.
                paragraph.headIndent = indent + (prefix.isEmpty ? 0 : 14)
                lineAttributes[.paragraphStyle] = paragraph
                piece.addAttribute(
                    .paragraphStyle,
                    value: paragraph,
                    range: NSRange(location: 0, length: piece.length)
                )
            }

            // Tab stops are what make a table read as columns. Placed after
            // lineAttributes exists so the separator and the cell share them.
            if isTableCell,
               let tabbed = (base[.paragraphStyle] as? NSParagraphStyle)?
                   .mutableCopy() as? NSMutableParagraphStyle {
                tabbed.tabStops = (1...8).map {
                    NSTextTab(textAlignment: .left, location: CGFloat($0) * 118)
                }
                tabbed.defaultTabInterval = 118
                lineAttributes[.paragraphStyle] = tabbed
                piece.addAttribute(.paragraphStyle, value: tabbed, range: whole)
            }

            if isTableCell {
                // Row breaks come from the first cell; cells within a row are
                // separated inline so the row reads as a row.
                if output.length > 0 {
                    // A table is a block like any other: it needs air above it,
                    // not to be welded onto the sentence before it. Rows within
                    // the table stay tight.
                    let separator = startsTableRow
                        ? (previousWasTableCell ? "\n" : "\n\n")
                        : "\t"
                    output.append(NSAttributedString(string: separator, attributes: base))
                }
            } else {
                if isNewBlock, output.length > 0 {
                    // Blocks only read as blocks with air between them. The
                    // exception is a run of list items, which is visually ONE
                    // block — a blank line between bullets looks broken.
                    let tight = isListItem && previousWasListItem
                    output.append(
                        NSAttributedString(string: tight ? "\n" : "\n\n", attributes: base)
                    )
                }
                if !prefix.isEmpty {
                    output.append(NSAttributedString(string: prefix, attributes: lineAttributes))
                }
            }

            // Inline emphasis within the block.
            piece.enumerateAttribute(.inlinePresentationIntent, in: whole) { value, range, _ in
                guard let raw = value as? UInt else { return }
                let inline = InlinePresentationIntent(rawValue: raw)
                if inline.contains(.code) {
                    piece.addAttribute(
                        .font,
                        value: NSFont.monospacedSystemFont(
                            ofSize: blockFont.pointSize - 1,
                            weight: .regular
                        ),
                        range: range
                    )
                    return
                }
                if inline.contains(.strikethrough) {
                    piece.addAttribute(
                        .strikethroughStyle,
                        value: NSUnderlineStyle.single.rawValue,
                        range: range
                    )
                }
                var traits: NSFontDescriptor.SymbolicTraits = []
                if inline.contains(.stronglyEmphasized) { traits.insert(.bold) }
                if inline.contains(.emphasized) { traits.insert(.italic) }
                guard !traits.isEmpty else { return }
                let descriptor = blockFont.fontDescriptor.withSymbolicTraits(traits)
                if let styled = NSFont(descriptor: descriptor, size: blockFont.pointSize) {
                    piece.addAttribute(.font, value: styled, range: range)
                }
            }

            output.append(piece)
            previousBlock = blockID
            previousWasListItem = isListItem
            previousWasTableCell = isTableCell
        }

        guard output.length > 0 else { return NSAttributedString(string: text, attributes: base) }
        return output
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
    static let maxMeasure: CGFloat = 580

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
