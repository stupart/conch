import AppKit
import ConchDesign
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
    /// Everything older than the live window, and the whole text behind anything it cut.
    @ObservedObject var history: HistoryStore
    let onAnswer: (String) -> Void
    /// The artifact this session produced, shown where it happened rather than
    /// only behind a tab.
    ///
    /// Tyler: "maybe it defaults to conversation but shows the artifact preview
    /// inline and then you click or tap on it and it goes gets big and the top
    /// tab changes to artifact — that way you're not annoyed always switching
    /// back if u just want to chat but the artifact content is front and centre
    /// and easy to focus on entirely if u want."
    ///
    /// At the end of the stack, which for one-artifact-per-session IS where it
    /// happened: it is the latest thing the session produced. A `review` item
    /// kind has existed in the conversation model all along and nothing ever
    /// emitted one, so this is the position that kind was reserving.
    var artifact: ReviewInfo?
    /// The session's working directory: what a relative link in the agent's
    /// prose is relative to (A13). Nil on an older daemon.
    var cwd: String? = nil
    /// Enlarge it, and switch the tab so the move is explained.
    var onOpenArtifact: () -> Void = {}

    /// Take me to the text field — I want to answer in my own words.
    ///
    /// Claude Code's own question UI always offers an "Other" row, and conch
    /// showed only the options the tool listed. Tyler: "it was missing the 4th
    /// option where i coudl just write something and also the like ignore and
    /// just chat about it option but maybe i could have just used the nromal
    /// input bar for that?" He was right that the composer already does this —
    /// so this points at it rather than growing a second text field inside the
    /// question.
    var onFreeform: () -> Void = {}
    /// Whether the transcript has scrolled away from its top (§3: the header's hairline).
    var onScrolled: (Bool) -> Void = { _ in }
    /// Open the subagent a Task/Agent block started, in this same pane (C4).
    /// The daemon says which agent that was; the pane decides how to show it.
    var onOpenSubagent: (ConversationItem.Tool.Subagent) -> Void = { _ in }
    /// Why conch cannot type into this session (a closed or app-server Codex
    /// thread, a background job with no window). Answering a question IS
    /// typing, so its buttons go dead and say why instead of failing on press.
    var noTerminal: String? = nil
    /// Offered beside that reason when a window can be attached to the job.
    var onOpenInTerminal: (() -> Void)? = nil
    @EnvironmentObject private var store: StateStore
    /// The last link that would not open — the OS's own words and the
    /// resolved target — shown here, where the click happened, never as a
    /// Finder alert (A13).
    @State private var linkFailure: String?
    /// Sticks to the bottom only when already there, so reading history is not
    /// yanked away by an arriving message.
    @State private var pinnedToBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// §4: a switched-to transcript fades in over 0.12 s, and never slides — moving a reading
    /// surface is exactly what Tyler called distracting on the feed lab.
    @State private var switchFade: Double = 1
    /// Which tool rows are open — kept per session by the workspace model, so leaving a
    /// session and coming back finds the rows you opened still open (ConchDesign/Workspace.swift).
    @EnvironmentObject private var workspace: WorkspaceModel
    /// Where the reader was looking when older messages were asked for.
    @State private var scrollAnchor = ConversationScrollAnchor()
    /// A multi-select question is a tiny form: taps edit this set and only the
    /// explicit Submit button sends it. Keying by tool row keeps two questions
    /// in the retained transcript from sharing checkmarks.
    @State private var multiSelections: [String: Set<String>] = [:]
    @State private var scrollRequestGeneration = 0

    private static let bottomAnchor = "conversation-bottom"

    /// Which rows fold (§3): the generic tool line, and a file change.
    ///
    /// Never a question — the session is BLOCKED on it, and hiding the one row a person must
    /// act on behind a summary would be a bug whatever any list says. Never a plan either:
    /// that is the answer to "what is it doing", and the row below already argues it should
    /// render as itself rather than as something you must think to open.
    private func foldable(_ item: ConversationItem) -> Bool {
        guard item.kind == .tool else { return false }
        if let asked = item.question, !asked.options.isEmpty { return false }
        if let plan = item.plan, !plan.isEmpty { return false }
        return true
    }

    private struct FoldIndex {
        var heads: [String: ToolRun] = [:]
        /// Every step after the first, pointing at the run that draws it.
        var memberOf: [String: String] = [:]
    }

    /// ponytail: computed per list, so a run straddling the history/live seam draws as two
    /// folds. Merging the two lists would mean restructuring the scroll anchoring that history
    /// paging depends on, which is a great deal of risk for a seam.
    private func folds(in items: [ConversationItem]) -> FoldIndex {
        var index = FoldIndex()
        for run in ToolFolding.runs(for: items.map { (id: $0.id, isTool: foldable($0), at: $0.at) }) {
            index.heads[run.id] = run
            for member in run.itemIDs.dropFirst() { index.memberOf[member] = run.id }
        }
        return index
    }

    /// One row, or the whole run it starts. A step that is not the first draws nothing: its
    /// run draws it, so the steps share one guide instead of one hairline each.
    @ViewBuilder
    private func foldedRow(for item: ConversationItem, in items: [ConversationItem], folds: FoldIndex) -> some View {
        if let run = folds.heads[item.id] {
            let open = isExpanded(run.id)
            VStack(alignment: .leading, spacing: 8) {
                Button { toggleExpanded(run.id) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: open ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8))
                            .foregroundStyle(ConchPalette.textFaint)
                        Text(run.summary)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(ConchPalette.textDim)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(open ? "Hide these steps" : "Show these steps")

                if open {
                    let members = Set(run.itemIDs)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(items.filter { members.contains($0.id) }) { step in
                            row(for: step)
                        }
                    }
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(ConchPalette.divider).frame(width: 1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if folds.memberOf[item.id] != nil {
            EmptyView()
        } else {
            row(for: item)
        }
    }

    private func isExpanded(_ itemID: String) -> Bool {
        workspace.isToolExpanded(itemID, for: conversation.sessionId)
    }

    private func toggleExpanded(_ itemID: String) {
        workspace.toggleTool(itemID, for: conversation.sessionId)
    }

    private func expand(_ itemID: String) {
        guard !isExpanded(itemID) else { return }
        toggleExpanded(itemID)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Eager, still. A lazy stack leaves the viewport at an offset whose rows
                // have not been materialised, which showed as bare scroll background while
                // a streaming row changed the document height.
                //
                // ponytail: that is a ceiling on how much recorded history can be on
                // screen at once, since every loaded page is laid out. Virtualise when it
                // can be MEASURED on a Mac with Xcode — guessing is how the bare
                // background got shipped the first time.
                VStack(alignment: .leading, spacing: 22) {
                    let recordedFolds = folds(in: recordedRows)
                    let liveFolds = folds(in: conversation.items)
                    historyHeader
                    if conversation.shared {
                        Text("Shared with another window — both windows' messages are shown")
                            .font(.system(size: 11))
                            .foregroundStyle(ConchPalette.textFaint)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.bottom, 4)
                    }
                    // What the record store holds above the live window, drawn by the
                    // same renderers: a recorded message is still a message.
                    ForEach(recordedRows) { item in
                        foldedRow(for: item, in: recordedRows, folds: recordedFolds).id(item.id)
                    }
                    ForEach(conversation.items) { item in
                        foldedRow(for: item, in: conversation.items, folds: liveFolds).id(item.id)
                    }
                    // A zero-height anchor rather than scrolling to the last
                    // item: the last item GROWS while it streams, and scrolling
                    // to a growing view lands part-way up it.
                    if let artifact {
                        ArtifactPreview(artifact: artifact, onOpen: onOpenArtifact)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchor)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                // The same measure the AppKit fallback uses, so the two renderers do not
                // disagree about how wide a line of this conversation is.
                .frame(maxWidth: ConversationTextView.maxMeasure, alignment: .leading)
                .background(
                    ConversationScrollObserver(
                        onUserScroll: { isAtBottom in pinnedToBottom = isAtBottom },
                        onScrolled: onScrolled,
                        onReachTop: { loadOlder() },
                        anchor: scrollAnchor
                    )
                )
                // Centred in whatever the window leaves: the column stays put when the
                // sidebar opens and closes, rather than sliding under the eye.
                .frame(maxWidth: .infinity, alignment: .center)
                .opacity(switchFade)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: switchFade)
            }
            .background(ConchPalette.bg)
            .overlay(alignment: .bottom) {
                LinkFailureLine(message: $linkFailure)
            }
            // Every link in the stack — a reply's markdown, a question, a
            // nested agent's prose, the artifact card's document head — opens
            // through the one door that reports (A13). SwiftUI's default
            // action handed a schemeless link straight to LaunchServices,
            // which answered -50 in a Finder alert: only web links are URLs;
            // a path is the agent's prose and means "from where the session
            // runs", which only the row knows.
            .environment(\.openURL, OpenURLAction { url in
                linkFailure = nil
                store.openLink(LinkTarget.text(of: url), cwd: cwd, rowId: conversation.sessionId) {
                    linkFailure = $0
                }
                return .handled
            })
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
                // end, and re-arm the follow. The recorded reader is told too —
                // anything still in flight for the old session is refused, not merged.
                history.select(session: conversation.sessionId, branchTip: branchTip)
                loadOlder()
                pinnedToBottom = true
                multiSelections = [:]
                linkFailure = nil
                requestBottomScroll(using: proxy)
                // Declarative, never an imperative animation block: mac-phase1-source forbids
                // those here, because one that restarts on every streamed token never settles
                // the viewport. The fade rides an .animation(_:value:) modifier instead, so it
                // cannot touch the scroll path at all.
                switchFade = 0
                Task { @MainActor in switchFade = 1 }
            }
            .onAppear {
                history.select(session: conversation.sessionId, branchTip: branchTip)
                // One read answers "is any of this recorded" — including the honest
                // "records are off" — rather than leaving that to a button nobody presses.
                loadOlder()
                requestBottomScroll(using: proxy)
            }
            // Older rows land ABOVE the viewport and push everything down. Restoring the
            // offset by how much the document grew keeps the row under the eye there.
            .onChange(of: history.paging.items.count) { _, _ in
                Task { @MainActor in
                    // After layout: the document is only taller once the new rows measure.
                    await Task.yield()
                    scrollAnchor.restore()
                }
            }
        }
    }

    /// What the reader is told about everything above the live window: that older
    /// messages can be asked for, that they are coming, that only part of the session
    /// was recorded, that a read failed — or that nothing is being recorded at all.
    ///
    /// Each of those is a different answer to "why does this conversation start here",
    /// and an empty conversation is a fifth. They must not all read as the same shrug.
    @ViewBuilder
    private var historyHeader: some View {
        VStack(spacing: 6) {
            switch history.paging.status {
            case .off:
                // Not an error, and not an empty session: nothing is being recorded, and
                // there is exactly one thing to do about it.
                Text(HistoryNotice.off)
            case .loading:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading earlier messages…")
                }
            case let .failed(message):
                HStack(spacing: 8) {
                    Text(message)
                    Button("Retry") { loadOlder() }
                        .buttonStyle(.link)
                }
            case .idle:
                if history.paging.canLoadOlder {
                    Button("Load earlier messages") { loadOlder() }
                        .buttonStyle(.link)
                } else if conversation.truncated, history.paging.items.isEmpty {
                    Text("Earlier messages not shown")
                }
            }
            if let note = HistoryNotice.coverage(
                history.paging.coverage,
                reachedStart: history.paging.reachedStart,
                oldest: oldestRecorded,
                sharedBranch: history.paging.sharedBranch
            ) {
                Text(note)
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(ConchPalette.textFaint)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.bottom, 4)
    }

    /// When the record starts, in the reader's own locale — the view's job, not the
    /// state machine's, which would otherwise hold a string that reads differently in
    /// every timezone it is tested from.
    private var oldestRecorded: String? {
        guard let at = history.paging.items.first?.at else { return nil }
        return Date(timeIntervalSince1970: at / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    /// The recorded rows that belong above the live window.
    private var recordedRows: [ConversationItem] {
        // Undecorated, because the snapshot and the record name the same message
        // differently: `tool:call_7` here is `call_7` there.
        let live = Set(conversation.items.map { HistorySnapshot.nativeId(forSnapshotItem: $0.id) })
        return HistorySnapshot.older(
            history.paging.items,
            thanSnapshot: live,
            startingAt: conversation.items.first?.at
        ).map { recorded in
            let body = history.body(for: recorded.id)
            let whole = body?.isComplete == true ? body?.text : nil
            return ConversationItem(recorded: recorded, text: whole ?? recorded.preview)
        }
    }

    /// Which branch of a shared transcript this window is (A8), for the record store to
    /// read the ancestry above.
    ///
    /// The pane below is already this window's branch; this hands the same fact to the
    /// history above it, so the two cannot disagree about whose conversation this is.
    private var branchTip: String? {
        HistorySnapshot.branchTip(forSnapshotItems: conversation.items.map(\.id), shared: conversation.shared)
    }

    /// Ask for the page before the oldest row on screen, remembering where the reader is.
    private func loadOlder() {
        guard history.paging.canLoadOlder else { return }
        scrollAnchor.capture()
        history.loadOlder(anchor: recordedRows.first?.id ?? conversation.items.first?.id)
    }

    /// The row's text: the record store's whole version when it has been read, else the
    /// snapshot's — which for a long message is its tail rather than all of it.
    private func text(of item: ConversationItem) -> String {
        history.fullText(forSnapshotItem: item.id) ?? item.text
    }

    /// Whether the snapshot cut this row, and so whether the store has more of it.
    private func wasCut(_ item: ConversationItem) -> Bool {
        if let result = item.tool?.result { return HistorySnapshot.wasCut(result, cap: Self.toolResultCap) }
        return HistorySnapshot.wasCut(item.text, cap: Self.messageCap)
    }

    private func loadFullBody(of item: ConversationItem) {
        guard wasCut(item), history.fullText(forSnapshotItem: item.id) == nil else { return }
        history.loadFullBodies(forSnapshotItems: [item.id])
    }

    /// A cut message ends in an offer to read the rest of it.
    ///
    /// ponytail: the stack offers this on the machine's replies only; the full-screen
    /// overlay reads any message whole, which is where a long one is actually read.
    @ViewBuilder
    private func cutTail(_ item: ConversationItem) -> some View {
        if wasCut(item), history.fullText(forSnapshotItem: item.id) == nil {
            if isExpanded(item.id) {
                fullBodyStatus(for: item)
            } else {
                Button("Show the rest") {
                    expand(item.id)
                    loadFullBody(of: item)
                }
                .buttonStyle(.link)
                .font(.system(size: 10.5))
            }
        }
    }

    /// How a body read is going, under the row waiting for it.
    @ViewBuilder
    private func fullBodyStatus(for item: ConversationItem) -> some View {
        let native = HistorySnapshot.nativeId(forSnapshotItem: item.id)
        let recorded = history.paging.items.first { $0.nativeId == native }
        switch recorded.flatMap({ history.body(for: $0.id) })?.status {
        case .some(.loading):
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Loading the rest…")
            }
            .font(.system(size: 10.5))
            .foregroundStyle(ConchPalette.textFaint)
        case let .some(.failed(message)):
            HStack(spacing: 8) {
                Text(message)
                Button("Retry") { history.loadFullBodies(forSnapshotItems: [item.id]) }
                    .buttonStyle(.link)
            }
            .font(.system(size: 10.5))
            .foregroundStyle(ConchPalette.textFaint)
        default:
            EmptyView()
        }
    }

    /// The daemon's own caps, as `publishedConversation` applies them.
    private static let messageCap = 4_000
    private static let toolResultCap = 400

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
                    // workspace-v1 §3: the transcript reads at 15/23, not at the 13 the tool
                    // rows and captions around it use. This is the one thing on screen that is
                    // actually READ rather than scanned.
                    .font(ConchType.readingBody)
                    .lineSpacing(ConchType.readingLineSpacing)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(ConchPalette.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 4) {
                Text(AttributedString.conchMarkdown(text(of: item)))
                    .font(ConchType.readingBody)
                    .lineSpacing(ConchType.readingLineSpacing)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                cutTail(item)
            }
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
        case .material:
            MaterialRow(material: item.material, fallback: item.text)
        case .tool:
            // A question outranks the generic tool shell: this row exists only
            // because the session is blocked on one of these choices.
            if let asked = item.question, !asked.options.isEmpty {
                // §3: once answered it collapses to one line naming what was decided. Only
                // when the answer actually names an option — the wire never states a choice,
                // so it is recovered from the finished call's result text, and when nothing
                // matches the block stays exactly as it was. Guessing at a person's decision
                // is worse than not summarising it.
                if item.tool?.status != "running",
                   let decided = QuestionOutcome.summary(
                       header: asked.header,
                       chosen: QuestionOutcome.chosen(
                           from: asked.options.map(\.label),
                           in: item.tool?.result
                       )
                   ) {
                    answeredQuestionRow(decided)
                } else {
                    questionRow(
                        asked,
                        questionID: item.id,
                        answerable: item.tool?.status == "running"
                    )
                }
            // A plan is not a tool call you might expand — it is the answer to
            // "what is it doing", so it renders as itself rather than as a
            // collapsed row you would have to think to open.
            } else if let plan = item.plan, !plan.isEmpty {
                PlanRow(steps: plan)
            } else if let change = item.change {
                ChangeRow(
                    change: change,
                    expanded: isExpanded(item.id),
                    toggle: { toggleExpanded(item.id) }
                )
            } else {
                toolRow(item)
            }
        }
    }

    /// §3's collapsed question: one quiet line saying what was decided.
    ///
    /// It replaces a header, the whole question, and every option greyed out at 0.58 — the
    /// largest thing in a finished transcript, saying the least. Not a button: there is
    /// nothing left to do to it, and the exchange that produced it is right above.
    private func answeredQuestionRow(_ decided: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 9.5))
                .foregroundStyle(ConchPalette.textFaint)
            Text(decided)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func questionRow(
        _ asked: ConversationItem.AgentQuestion,
        questionID: String,
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
                let selected = multiSelections[questionID]?.contains(option.label) == true
                if answerable {
                    Button {
                        if asked.multiSelect {
                            toggleSelection(option.label, for: questionID)
                        } else {
                            onAnswer(option.label)
                        }
                    } label: {
                        questionOption(
                            option,
                            multiSelect: asked.multiSelect,
                            selected: selected
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(noTerminal != nil)
                    .opacity(noTerminal != nil ? 0.58 : 1)
                    .help(noTerminal ?? (asked.multiSelect ? "Select \(option.label)" : "Answer \(option.label)"))
                    .accessibilityHint(
                        asked.multiSelect
                            ? "Toggles this option; Submit sends all selected options"
                            : "Sends this option to the session"
                    )
                } else {
                    // The question remains part of the transcript, but a
                    // completed tool is no longer a valid destination. Leaving
                    // it looking tappable is an invitation to answer a later
                    // prompt with an earlier choice.
                    questionOption(option, multiSelect: asked.multiSelect, selected: false)
                        .opacity(0.58)
                        .accessibilityHint("This question is no longer waiting for an answer")
                }
            }

            if answerable, let noTerminal {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(noTerminal)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if let onOpenInTerminal {
                        Button(action: onOpenInTerminal) {
                            Label("Open in Terminal", systemImage: "terminal")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(ConchPalette.brandCyan)
                        .help("Open this session in a new Terminal window")
                        .fixedSize()
                    }
                }
            }

            if answerable {
                Button(action: onFreeform) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        // A pencil, not a circle: this is not a fourth choice,
                        // it is the way out of choosing.
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 10.5))
                            .foregroundStyle(ConchPalette.textDim)
                        Text("Something else…")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(ConchPalette.textDim)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 9)
                            .strokeBorder(ConchPalette.textDim.opacity(0.22), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(noTerminal != nil)
                .help(noTerminal ?? "Answer in your own words")
                .accessibilityHint("Moves to the message field so you can answer in your own words")
            }

            if asked.multiSelect && answerable {
                let selected = selectedLabels(for: asked, questionID: questionID)
                Button {
                    onAnswer(selected.joined(separator: ", "))
                } label: {
                    Text(selected.isEmpty ? "Submit selections" : "Submit \(selected.count) selected")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(selected.isEmpty ? ConchPalette.textFaint : ConchPalette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 9)
                                .fill(selected.isEmpty ? ConchPalette.raised : ConchPalette.statusNeeds)
                        )
                }
                .buttonStyle(.plain)
                .disabled(selected.isEmpty || noTerminal != nil)
                .accessibilityHint("Sends all selected options to the session")
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
        multiSelect: Bool,
        selected: Bool
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: multiSelect && selected ? "checkmark.square.fill" : (multiSelect ? "square" : "circle"))
                .font(.system(size: 10.5))
                .foregroundStyle(selected ? ConchPalette.statusNeeds : ConchPalette.textDim)
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
                .fill(selected ? ConchPalette.statusNeeds.opacity(0.10) : ConchPalette.raised)
        )
        .contentShape(Rectangle())
    }

    private func toggleSelection(_ label: String, for questionID: String) {
        var selected = multiSelections[questionID] ?? []
        if selected.contains(label) {
            selected.remove(label)
        } else {
            selected.insert(label)
        }
        multiSelections[questionID] = selected
    }

    private func selectedLabels(
        for question: ConversationItem.AgentQuestion,
        questionID: String
    ) -> [String] {
        let selected = multiSelections[questionID] ?? []
        return question.options.map(\.label).filter(selected.contains)
    }

    private func toolRow(_ item: ConversationItem) -> some View {
        let expanded = isExpanded(item.id)
        // The record store's whole output once it has been read; until then the
        // snapshot's first 400 characters of it.
        let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? ""
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    guard !result.isEmpty else { return }
                    toggleExpanded(item.id)
                    if !expanded { loadFullBody(of: item) }
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
                // A nested agent is reachable from the block that started it (C4).
                // Only when the daemon named one: a Task block with no agent id is
                // some other agent's tool, and there is nothing to open.
                if item.tool?.kind == .subagent, let agent = item.tool?.subagent {
                    Button {
                        onOpenSubagent(agent)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                            .font(.system(size: 10))
                            .foregroundStyle(ConchPalette.textDim)
                            .frame(width: 18, height: 18)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Open this agent's transcript")
                    .accessibilityLabel("Open agent \(item.text)")
                }
            }
            // Output is the bulk of a transcript and almost never what you are
            // looking for; it stays behind a tap.
            if expanded, !result.isEmpty {
                // A nested agent's reply is prose and gets the conversation's
                // markdown; everything else is a log and stays raw monospace.
                // Decided by the daemon's classification, deliberately not by
                // sniffing whether the text "looks like" markdown — that is
                // how a log file gets mangled.
                if item.tool?.kind == .subagent {
                    Text(AttributedString.conchMarkdown(result))
                        .font(ConchTypography.font(size: 12.5))
                        .foregroundStyle(ConchPalette.textPrimary)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ConchPalette.hover, in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text(result)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(ConchPalette.textDim)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ConchPalette.hover, in: RoundedRectangle(cornerRadius: 8))
                }
                fullBodyStatus(for: item)
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
/// Where the reader was, in pixels, across a prepend.
///
/// Older messages arriving above the viewport push everything down by their own
/// height, which without this reads as the transcript jumping while you are looking at
/// it. The document's height is taken before the request and the offset moved by
/// however much it grew, so the row under the eye stays under the eye.
final class ConversationScrollAnchor {
    fileprivate weak var scrollView: NSScrollView?
    private var height: CGFloat?
    private var offset: CGFloat?

    func capture() {
        guard let scrollView, let document = scrollView.documentView else { return }
        height = document.bounds.height
        offset = scrollView.contentView.bounds.origin.y
    }

    func restore() {
        guard let scrollView, let document = scrollView.documentView,
              let height, let offset else { return }
        let grown = document.bounds.height - height
        self.height = nil
        self.offset = nil
        // Only a prepend moves the reader. Anything else — a row growing as it streams,
        // the window resizing — is not something to correct for.
        guard grown > 0 else { return }
        scrollView.contentView.scroll(
            to: NSPoint(x: scrollView.contentView.bounds.origin.x, y: offset + grown)
        )
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}

private struct ConversationScrollObserver: NSViewRepresentable {
    let onUserScroll: (Bool) -> Void
    /// Scrolled away from the top: §3 shows the header's hairline only once something has
    /// passed under it. Not the same question as `onUserScroll`, which asks about the BOTTOM —
    /// a long transcript sitting at its top is not at the bottom and has still scrolled nothing.
    let onScrolled: (Bool) -> Void
    /// Reaching the oldest row held is the request for the page before it. The stack is
    /// eagerly laid out, so nothing "appears" on the way up: the scroll view has to say so.
    let onReachTop: () -> Void
    /// Handed the scroll view as soon as one is found, so a prepend can be absorbed.
    let anchor: ConversationScrollAnchor

    func makeCoordinator() -> Coordinator {
        Coordinator(onUserScroll: onUserScroll, onScrolled: onScrolled, onReachTop: onReachTop, anchor: anchor)
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
        context.coordinator.onScrolled = onScrolled
        context.coordinator.onReachTop = onReachTop
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
        var onScrolled: (Bool) -> Void
        var onReachTop: () -> Void
        let anchor: ConversationScrollAnchor
        private weak var scrollView: NSScrollView?
        private var observations: [NSObjectProtocol] = []

        init(
            onUserScroll: @escaping (Bool) -> Void,
            onScrolled: @escaping (Bool) -> Void,
            onReachTop: @escaping () -> Void,
            anchor: ConversationScrollAnchor
        ) {
            self.onUserScroll = onUserScroll
            self.onScrolled = onScrolled
            self.onReachTop = onReachTop
            self.anchor = anchor
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
            anchor.scrollView = scrollView
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
            // The other end of the same measurement: within a screenful of the oldest row
            // held is close enough to ask for the page before it, so it has arrived by the
            // time the reader gets there.
            let fromTop = documentView.isFlipped
                ? visible.minY - document.minY
                : document.maxY - visible.maxY
            // The same `fromTop`, asked a different question: has anything gone under the
            // header yet? A couple of points of slack, because a trackpad rests at 0.5.
            onScrolled(document.height > visible.height && fromTop > 2)
            if document.height > visible.height, fromTop <= visible.height { onReachTop() }
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

private struct MaterialRow: View {
    let material: ConversationItem.Material?
    let fallback: String

    private var image: NSImage? {
        guard material?.kind == .image else { return nil }
        if let path = material?.path, let image = NSImage(contentsOfFile: path) {
            return image
        }
        guard let dataUrl = material?.dataUrl,
              let comma = dataUrl.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...]))
        else { return nil }
        return NSImage(data: data)
    }

    var body: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(ConchPalette.divider, lineWidth: 0.5)
                }
                .help(material?.path ?? material?.title ?? "Image")
        } else {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 11))
                    .foregroundStyle(tint)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(material?.title ?? "Material")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(ConchPalette.textDim)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 11.5))
                            .foregroundStyle(ConchPalette.textFaint)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(ConchPalette.raised.opacity(0.58), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var detail: String { material?.detail ?? fallback }

    private var symbol: String {
        switch material?.kind {
        case .image: return "photo"
        case .document: return "doc"
        case .systemNote: return "info.circle"
        case .interruption: return "stop.circle"
        case .commandOutput: return "terminal"
        case .task: return "shippingbox"
        case .unknown, nil: return "square.stack"
        }
    }

    private var tint: Color {
        material?.status == "error" ? ConchPalette.statusNeeds : ConchPalette.textFaint
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

/// The artifact, previewed where it happened.
///
/// Not a banner and not a link: the point is that you can see what it IS
/// without leaving the conversation, and reach it in one gesture when you want
/// it whole. The tab switch that comes with that gesture is what explains where
/// you went — otherwise enlarging something feels like the app moved on its own.
private struct ArtifactPreview: View {
    let artifact: ReviewInfo
    let onOpen: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 10) {
            // The artifact itself, first, at a height that fits a conversation.
            // An icon and a filename told you a deliverable EXISTED; this shows
            // what it is. Tyler, side by side with the card: "preview the
            // actual artifact in conch instead of this random card UI".
            //
            // Not the Deliverable pane's renderers: those are NSScrollViews,
            // and a scroller inside the conversation's scroller captures the
            // wheel. A bounded, clipped render of the head is enough to
            // recognise the thing; the gesture below still opens it whole.
            inlinePreview
            HStack(alignment: .top, spacing: 11) {
                if inlinePreviewKind == nil { thumbnail }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Deliverable")
                        .font(ConchTypography.font(size: 9.5, weight: .medium))
                        .foregroundStyle(ConchPalette.statusReview)
                        .textCase(.uppercase)
                        .tracking(0.6)
                    Text(artifact.summary)
                        .font(ConchTypography.font(size: 12.5))
                        .foregroundStyle(ConchPalette.textPrimary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let link = artifact.link, !link.isEmpty {
                        Text(shortLink(link))
                            .font(ConchTypography.font(size: 10.5))
                            .foregroundStyle(ConchPalette.textFaint)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ConchPalette.textFaint)
            }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isHovering ? ConchPalette.hover : ConchPalette.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(ConchPalette.statusReview.opacity(0.35), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help("Open the deliverable")
        .accessibilityLabel("Deliverable: \(artifact.summary)")
        .accessibilityHint("Opens it full size")
    }

    /// A real thumbnail when the artifact is a local image, because seeing the
    /// thing beats reading its name — the same reason the composer stopped
    /// showing attachments as filenames.
    @ViewBuilder
    private var thumbnail: some View {
        if let image = localImage {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            RoundedRectangle(cornerRadius: 6)
                .fill(ConchPalette.bg)
                .frame(width: 44, height: 44)
                .overlay(
                    Image(systemName: symbol)
                        .font(.system(size: 15))
                        .foregroundStyle(ConchPalette.statusReview.opacity(0.85))
                )
        }
    }

    private enum InlinePreviewKind { case image, document }

    /// Which inline render this artifact gets, or nil for icon-only. Only
    /// absolute local paths qualify — a relative link resolves against the
    /// app's cwd, not the session's, which is why the daemon now publishes
    /// them absolute.
    private var inlinePreviewKind: InlinePreviewKind? {
        guard let link = artifact.link, link.hasPrefix("/") else { return nil }
        switch (link as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic", "webp": return localImage == nil ? nil : .image
        case "md", "markdown", "txt": return documentHead == nil ? nil : .document
        default: return nil
        }
    }

    @ViewBuilder
    private var inlinePreview: some View {
        switch inlinePreviewKind {
        case .image:
            if let image = localImage {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: 260, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        case .document:
            if let head = documentHead {
                // The same markdown path the replies use, so a deliverable
                // reads like the conversation it arrived in. Clipped, then
                // faded, so the cut reads as "there is more" rather than as
                // the file ending mid-word.
                Text(AttributedString.conchMarkdown(head))
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .lineLimit(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .mask(
                        LinearGradient(
                            stops: [.init(color: .black, location: 0.72), .init(color: .clear, location: 1)],
                            startPoint: .top, endPoint: .bottom
                        )
                    )
            }
        case nil:
            EmptyView()
        }
    }

    /// The first few KB of a text deliverable. Bounded by construction: a
    /// 5MB log must not be read whole to draw fourteen lines of it.
    private var documentHead: String? {
        guard let link = artifact.link, link.hasPrefix("/"),
              let handle = FileHandle(forReadingAtPath: link) else { return nil }
        defer { try? handle.close() }
        let data = handle.readData(ofLength: 6 * 1024)
        guard let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    private var localImage: NSImage? {
        guard let link = artifact.link, link.hasPrefix("/") else { return nil }
        let image = ["png", "jpg", "jpeg", "gif", "heic", "webp"]
            .contains((link as NSString).pathExtension.lowercased())
        return image ? NSImage(contentsOfFile: link) : nil
    }

    private var symbol: String {
        guard let link = artifact.link, !link.isEmpty else { return "star.fill" }
        if link.hasPrefix("http") { return "globe" }
        switch (link as NSString).pathExtension.lowercased() {
        case "pdf": return "doc.richtext"
        case "mp4", "mov", "webm": return "play.rectangle"
        case "md", "markdown", "txt": return "doc.text"
        default: return "doc"
        }
    }

    private func shortLink(_ link: String) -> String {
        if link.hasPrefix("http") { return link }
        let parts = link.split(separator: "/")
        return parts.suffix(2).joined(separator: "/")
    }
}
