import AppKit
import SwiftUI

/// The conversation as a stack of messages, rather than one replaced string.
///
/// The pane beside this shows a single reply that is overwritten every turn,
/// which is why a long answer arrives as a fragment, why the previous reply
/// disappears when a new turn starts, and why tool calls are invisible. This
/// renders what the daemon now publishes: the real sequence, your messages
/// included.
///
/// Rows are keyed by the daemon's stable item id. That is the whole scroll
/// story — SwiftUI rebuilds and re-measures any row whose identity changes, so
/// appending to the end leaves everything above it untouched and still.
struct ConversationStackView: View {
    let conversation: Conversation
    let onAnswer: (String) -> Void
    /// Reports a link activation, so "are links even clickable" stops being a
    /// question nobody can answer.
    ///
    /// The markdown parser does produce `.link` attributes — they render blue,
    /// which is where that colour comes from — but `.textSelection(.enabled)`
    /// on the same Text competes for the click on macOS, and there was no way
    /// to tell a swallowed click from a working one by looking. Owning
    /// `openURL` makes the difference observable, and conch should decide how
    /// its own links open regardless.
    var onOpenLink: (URL) -> Void = { _ in }
    /// Sticks to the bottom only when already there, so reading history is not
    /// yanked away by an arriving message.
    @State private var pinnedToBottom = true
    @State private var expandedToolIDs: Set<String> = []
    @State private var scrollRequestGeneration = 0

    private static let bottomAnchor = "conversation-bottom"

    var body: some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                onOpenLink(url)
                NSWorkspace.shared.open(url)
                return .handled
            })
    }

    private var content: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // The daemon caps this window at thirty items. Eager layout is
                // therefore bounded, and avoids leaving the viewport pointed at
                // an unmaterialised region while a streaming row changes height.
                VStack(alignment: .leading, spacing: 14) {
                    if conversation.truncated {
                        Text("Earlier messages not shown")
                            .font(.system(size: 11))
                            .foregroundStyle(ConchPalette.textFaint)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.bottom, 4)
                    }
                    ForEach(conversation.items) { item in
                        row(for: item).id(item.id)
                    }
                    // A zero-height anchor rather than scrolling to the last
                    // item: the last item GROWS while it streams, and scrolling
                    // to a growing view lands part-way up it.
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchor)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    ConversationScrollObserver { isAtBottom in
                        pinnedToBottom = isAtBottom
                    }
                )
            }
            .background(ConchPalette.bg)
            .onChange(of: revisionVector) { _, _ in
                // Capture the position from before SwiftUI lays out the added
                // height. Geometry measured after growth briefly says "not at
                // bottom" even when the reader was following; user-driven
                // AppKit scroll notifications make that distinction explicit.
                guard pinnedToBottom else { return }
                requestBottomScroll(using: proxy)
            }
            .onChange(of: conversation.sessionId) { _, _ in
                // A different session is a different conversation: start at its
                // end, and re-arm the follow.
                pinnedToBottom = true
                expandedToolIDs = []
                requestBottomScroll(using: proxy)
            }
            .onAppear { requestBottomScroll(using: proxy) }
        }
    }

    private struct RevisionVector: Equatable {
        struct Item: Equatable {
            let id: String
            let revision: Int
        }

        let sessionID: String
        let items: [Item]
    }

    /// Every row revision matters: tool results and plans can update an earlier
    /// row even when the final message is unchanged. Published timestamps do not.
    private var revisionVector: RevisionVector {
        RevisionVector(
            sessionID: conversation.sessionId,
            items: conversation.items.map { .init(id: $0.id, revision: $0.rev) }
        )
    }

    private func requestBottomScroll(using proxy: ScrollViewProxy) {
        scrollRequestGeneration &+= 1
        let generation = scrollRequestGeneration
        Task { @MainActor in
            // ScrollViewReader cannot resolve a sentinel until the new stack has
            // participated in layout. A synchronous request can silently land on
            // the old document height and leave a fresh session apparently empty.
            await Task.yield()
            guard generation == scrollRequestGeneration else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
        }
    }

    @ViewBuilder
    private func row(for item: ConversationItem) -> some View {
        switch item.kind {
        case .user:
            // The one kind that is right-aligned and filled. Everything else in
            // the stack is the machine talking; this is you, and it should be
            // findable while scrolling past without reading a word.
            HStack {
                Spacer(minLength: 48)
                Text(AttributedString.conchMarkdown(item.text))
                    .font(.system(size: 13))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(ConchPalette.raised, in: RoundedRectangle(cornerRadius: 12))
            }
        case .assistant:
            Text(AttributedString.conchMarkdown(item.text))
                .font(.system(size: 13))
                .foregroundStyle(ConchPalette.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            Text(AttributedString.conchMarkdown(item.text))
                .font(.system(size: 12).italic())
                .foregroundStyle(ConchPalette.textFaint)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .review:
            Label(item.text, systemImage: "star.fill")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ConchPalette.statusReview)
        case .tool:
            // A question outranks the generic tool shell: this row exists only
            // because the session is blocked on one of these choices.
            if let asked = item.question, !asked.options.isEmpty {
                questionRow(
                    asked,
                    answerable: item.tool?.status == "running"
                )
            // A plan is not a tool call you might expand — it is the answer to
            // "what is it doing", so it renders as itself rather than as a
            // collapsed row you would have to think to open.
            } else if let plan = item.plan, !plan.isEmpty {
                PlanRow(steps: plan)
            } else if let change = item.change {
                ChangeRow(
                    change: change,
                    expanded: expandedToolIDs.contains(item.id),
                    toggle: {
                        if expandedToolIDs.contains(item.id) {
                            expandedToolIDs.remove(item.id)
                        } else {
                            expandedToolIDs.insert(item.id)
                        }
                    }
                )
            } else {
                toolRow(item)
            }
        }
    }

    private func questionRow(
        _ asked: ConversationItem.AgentQuestion,
        answerable: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !asked.header.isEmpty {
                Text(asked.header)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ConchPalette.statusNeeds)
            }
            Text(AttributedString.conchMarkdown(asked.question))
                .font(.system(size: 13))
                .foregroundStyle(ConchPalette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(Array(asked.options.enumerated()), id: \.offset) { _, option in
                if answerable {
                    Button {
                        onAnswer(option.label)
                    } label: {
                        questionOption(option, multiSelect: asked.multiSelect)
                    }
                    .buttonStyle(.plain)
                    .help("Answer \(option.label)")
                    .accessibilityHint("Sends this option to the session")
                } else {
                    // The question remains part of the transcript, but a
                    // completed tool is no longer a valid destination. Leaving
                    // it looking tappable is an invitation to answer a later
                    // prompt with an earlier choice.
                    questionOption(option, multiSelect: asked.multiSelect)
                        .opacity(0.58)
                        .accessibilityHint("This question is no longer waiting for an answer")
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(ConchPalette.statusNeeds.opacity(answerable ? 0.45 : 0.18), lineWidth: 1)
        )
    }

    private func questionOption(
        _ option: ConversationItem.AgentQuestion.Option,
        multiSelect: Bool
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: multiSelect ? "square" : "circle")
                .font(.system(size: 10.5))
                .foregroundStyle(ConchPalette.textDim)
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                if let description = option.description, !description.isEmpty {
                    Text(description)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(ConchPalette.raised)
        )
        .contentShape(Rectangle())
    }

    private func toolRow(_ item: ConversationItem) -> some View {
        let expanded = expandedToolIDs.contains(item.id)
        let result = item.tool?.result ?? ""
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                guard !result.isEmpty else { return }
                if expanded { expandedToolIDs.remove(item.id) } else { expandedToolIDs.insert(item.id) }
            } label: {
                HStack(spacing: 8) {
                    // The dot carried status; the glyph carries what KIND of
                    // work this was. A stripe of identical dots is what made a
                    // Codex session read as an undifferentiated string of tool
                    // calls — you could not tell an edit from a shell command
                    // without reading every line.
                    Image(systemName: (item.tool?.kind ?? .unknown).symbol)
                        .font(.system(size: 9.5))
                        .foregroundStyle(statusColor(item.tool?.status))
                        .frame(width: 12)
                    Text(item.tool?.name ?? "tool")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(ConchPalette.textDim)
                    if !item.text.isEmpty {
                        Text(item.text)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(ConchPalette.textFaint)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if !result.isEmpty {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8))
                            .foregroundStyle(ConchPalette.textFaint)
                    }
                }
            }
            .buttonStyle(.plain)
            // Output is the bulk of a transcript and almost never what you are
            // looking for; it stays behind a tap.
            if expanded, !result.isEmpty {
                Text(result)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ConchPalette.textDim)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ConchPalette.hover, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statusColor(_ status: String?) -> Color {
        switch status {
        case "error": return ConchPalette.statusNeeds
        case "done": return ConchPalette.textFaint
        default: return ConchPalette.statusWorking
        }
    }
}

/// SwiftUI exposes scrolling commands on macOS 14, but not whether the person
/// has moved the underlying scroll view. Listening only to AppKit's live-scroll
/// notifications avoids treating content growth as a user scroll: the document
/// may get taller while its clip view stays still, and that must not disarm an
/// already-following conversation before it can advance to the new bottom.
private struct ConversationScrollObserver: NSViewRepresentable {
    let onUserScroll: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onUserScroll: onUserScroll)
    }

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.onMoveToWindow = { [weak coordinator = context.coordinator, weak view] in
            guard let view else { return }
            coordinator?.attach(toAncestorOf: view)
        }
        DispatchQueue.main.async { [weak coordinator = context.coordinator, weak view] in
            guard let view else { return }
            coordinator?.attach(toAncestorOf: view)
        }
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        context.coordinator.onUserScroll = onUserScroll
        DispatchQueue.main.async { [weak coordinator = context.coordinator, weak view] in
            guard let view else { return }
            coordinator?.attach(toAncestorOf: view)
        }
    }

    static func dismantleNSView(_ view: ProbeView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class ProbeView: NSView {
        var onMoveToWindow: (() -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            onMoveToWindow?()
        }
    }

    final class Coordinator {
        var onUserScroll: (Bool) -> Void
        private weak var scrollView: NSScrollView?
        private var observations: [NSObjectProtocol] = []

        init(onUserScroll: @escaping (Bool) -> Void) {
            self.onUserScroll = onUserScroll
        }

        deinit {
            detach()
        }

        func attach(toAncestorOf view: NSView) {
            var ancestor = view.superview
            while let candidate = ancestor, !(candidate is NSScrollView) {
                ancestor = candidate.superview
            }
            guard let scrollView = ancestor as? NSScrollView,
                  scrollView !== self.scrollView else {
                return
            }

            detach()
            self.scrollView = scrollView
            let center = NotificationCenter.default
            for name in [
                NSScrollView.didLiveScrollNotification,
                NSScrollView.didEndLiveScrollNotification,
            ] {
                observations.append(
                    center.addObserver(
                        forName: name,
                        object: scrollView,
                        queue: .main
                    ) { [weak self] _ in
                        self?.publishPosition()
                    }
                )
            }
        }

        func detach() {
            let center = NotificationCenter.default
            observations.forEach(center.removeObserver)
            observations = []
            scrollView = nil
        }

        private func publishPosition() {
            guard let scrollView, let documentView = scrollView.documentView else { return }
            let visible = scrollView.contentView.documentVisibleRect
            let document = documentView.bounds
            let distance: CGFloat
            if documentView.isFlipped {
                distance = document.maxY - visible.maxY
            } else {
                distance = visible.minY - document.minY
            }
            onUserScroll(document.height <= visible.height || distance <= 8)
        }
    }
}

/// Agent replies are markdown, and until now the stack showed the source.
///
/// `**Storage moved**` rendered with its asterisks and `` `path/to/file` ``
/// with its backticks, which is most of what an agent's summary is made of —
/// so the most important messages read the worst.
///
/// `.inlineOnlyPreservingWhitespace` is the parse that fits a chat stack. The
/// default markdown parse COLLAPSES newlines, which would run every bulleted
/// list into one paragraph; this one keeps the line breaks exactly as written
/// and still resolves bold, italic, code spans and links. Block constructs stay
/// literal, which is fine — a leading "- " already reads as a bullet.
extension AttributedString {
    static func conchMarkdown(_ source: String) -> AttributedString {
        var parsed = (try? AttributedString(
            markdown: promoteHeadings(flattenTables(source)),
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(source)
        underlineLinks(&parsed)
        return parsed
    }

    /// Make a link LOOK like the link it already is.
    ///
    /// The links worked the whole time — Tyler tested one — but nothing said
    /// so. They were blue against text that is also occasionally coloured, with
    /// no underline and no hover state, so the only way to discover a link was
    /// to click text on the off chance. "it's just a ui problem really, to show
    /// me with an underline on hover that i can click on it."
    ///
    /// A permanent underline rather than a hover one, deliberately: SwiftUI's
    /// `Text` draws an AttributedString as a single view and cannot hit-test
    /// one run inside it, so there is no honest way to underline only the link
    /// under the pointer. The web convention of always-underlined is the same
    /// signal, available before the pointer arrives rather than after, and it
    /// survives being read rather than hovered.
    private static func underlineLinks(_ text: inout AttributedString) {
        for run in text.runs where run.link != nil {
            text[run.range].underlineStyle = .single
        }
    }

    /// Inline-only parsing leaves `## Heading` showing its hashes, and agents
    /// write in headings constantly. Rewriting them as bold keeps the emphasis
    /// the author intended without switching to a block parse, which would
    /// collapse every newline in the message.
    /// Flatten a markdown table into lines a person can read.
    ///
    /// Inline parsing cannot lay out a table, so one arrives as a wall of pipes
    /// and dashes — and the divider row (`|---|---|`) is pure noise once there
    /// are no columns. Agents reach for tables constantly to summarise work, so
    /// this is not a rare case: it is the shape a summary usually takes.
    ///
    /// Each row becomes "first cell — the rest", which is what a table of two
    /// or three columns is actually saying, and is how you would read it aloud.
    private static func flattenTables(_ source: String) -> String {
        guard source.contains("|") else { return source }
        return source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|"), trimmed.count > 1 else {
                    return String(line)
                }
                let cells = trimmed
                    .dropFirst()
                    .dropLast()
                    .split(separator: "|", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                // The alignment row carries no content once the grid is gone.
                let isDivider = cells.allSatisfy { cell in
                    !cell.isEmpty && cell.allSatisfy { ":-".contains($0) }
                }
                if isDivider { return nil }
                let filled = cells.filter { !$0.isEmpty }
                if filled.isEmpty { return nil }
                if filled.count == 1 { return filled[0] }
                return "**\(filled[0])** — \(filled.dropFirst().joined(separator: " · "))"
            }
            .joined(separator: "\n")
    }

    private static func promoteHeadings(_ source: String) -> String {
        guard source.contains("#") else { return source }
        return source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard line.hasPrefix("#") else { return line }
                let hashes = line.prefix { $0 == "#" }
                guard hashes.count <= 6 else { return line }
                let rest = line.dropFirst(hashes.count).drop { $0 == " " }
                // Bold needs something to wrap, and `**` alone parses as literal.
                guard !rest.isEmpty else { return line }
                return Substring("**\(rest)**")
            }
            .joined(separator: "\n")
    }
}

/// A plan, as a checklist.
private struct PlanRow: View {
    let steps: [ConversationItem.PlanStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Image(systemName: symbol(step.status))
                        .font(.system(size: 10))
                        .foregroundStyle(colour(step.status))
                        .frame(width: 12)
                    Text(step.text)
                        .font(.system(size: 11.5))
                        // Done steps recede: the eye should land on what is
                        // happening now, not on the pile already finished.
                        .foregroundStyle(
                            step.status == .done ? ConchPalette.textFaint : ConchPalette.textDim
                        )
                        .strikethrough(step.status == .done, color: ConchPalette.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.leading, 2)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func symbol(_ status: ConversationItem.PlanStep.Status) -> String {
        switch status {
        case .done: return "checkmark.circle.fill"
        case .running: return "circle.dotted"
        case .pending: return "circle"
        }
    }

    private func colour(_ status: ConversationItem.PlanStep.Status) -> Color {
        switch status {
        case .done: return ConchPalette.brandCyan
        case .running: return ConchPalette.statusWorking
        case .pending: return ConchPalette.textFaint
        }
    }
}

/// A file change, as a count you can scan and lines you can open.
///
/// The collapsed line answers "what happened to that file" without a tap, which
/// is what you want while scrolling. The lines themselves are one tap away
/// because reading them is a different activity from scanning for them.
private struct ChangeRow: View {
    let change: ConversationItem.FileChange
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 9.5))
                        .foregroundStyle(ConchPalette.brandCyan)
                        .frame(width: 12)
                    Text(change.file)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(ConchPalette.textDim)
                    if !change.added.isEmpty {
                        Text("+\(change.added.count)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ConchPalette.brandCyan)
                    }
                    if !change.removed.isEmpty {
                        Text("−\(change.removed.count)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ConchPalette.statusNeeds)
                    }
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8))
                        .foregroundStyle(ConchPalette.textFaint)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(change.removed.enumerated()), id: \.offset) { _, line in
                        DiffLine(text: line, sign: "−", tint: ConchPalette.statusNeeds)
                    }
                    ForEach(Array(change.added.enumerated()), id: \.offset) { _, line in
                        DiffLine(text: line, sign: "+", tint: ConchPalette.brandCyan)
                    }
                    if change.truncated {
                        Text("… longer than this view shows")
                            .font(.system(size: 10))
                            .foregroundStyle(ConchPalette.textFaint)
                            .padding(.top, 2)
                    }
                }
                .padding(.leading, 20)
                .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DiffLine: View {
    let text: String
    let sign: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(sign)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(tint)
            Text(text.isEmpty ? " " : text)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}
