import AppKit
import ConchDesign
import ImageIO
import QuickLook
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
    /// A readable summary, and one answer per question, in order. The answers are what the
    /// daemon types into the agent's picker; the summary is only what the send is called.
    /// The third value is the question row the answers are for, so the daemon can refuse them
    /// if another question is up by the time they arrive.
    let onAnswer: (String, [ConchQuestionAnswer], String) -> Void
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
    /// Whether this daemon reports `viewedAt` at all. Without it every deliverable looks unviewed,
    /// so the card must not be gated on a field that is always nil.
    var reportsViewedState = true
    /// The work half is already showing a deliverable, so the card would be the same thing
    /// twice on one screen. It returns when the pane is closed: the card is the way IN to the
    /// deliverable, and a way in you are already through is just noise at the end of a
    /// transcript.
    var artifactShownBeside = false
    /// Opened from this card since the app started: seen, but it comes back once the pane that
    /// showed it closes. Tyler: "it doesn't need to show inline in convo anymore now that its in
    /// open panel until panel is closed".
    var artifactOpenedHere = false
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
    /// How much of the bottom the composer covers.
    ///
    /// The composer floats OVER the transcript now, so the last message would sit behind it.
    /// This is the room left for it, included in the bottom anchor itself so
    /// "scroll to the bottom" reaches the document's true end. Tyler: "still have a spacer so i can read everything".
    var bottomInset: CGFloat = 0
    /// Open the subagent a Task/Agent block started, in this same pane (C4).
    /// The daemon says which agent that was; the pane decides how to show it.
    var onOpenSubagent: (ConversationItem.Tool.Subagent) -> Void = { _ in }
    /// Why conch cannot type into this session (a closed or app-server Codex
    /// thread, a background job with no window). Answering a question IS
    /// typing, so its buttons go dead and say why instead of failing on press.
    var noTerminal: String? = nil
    /// Offered beside that reason when a window can be attached to the job.
    var onOpenInTerminal: (() -> Void)? = nil
    /// The permission prompt this session is showing, answered here rather than only marked
    /// red in the sidebar. Tyler: "it was a confirm thing but it wasn't surfacing in conch".
    var approval: SessionRow.PendingApproval? = nil
    /// "once", "always" or "deny".
    var onApprove: ((String) -> Void)? = nil
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
    /// A multi-select question is a tiny form: taps edit this set and only the
    /// explicit Submit button sends it. Keying by tool row keeps two questions
    /// in the retained transcript from sharing checkmarks.
    @State private var multiSelections: [String: Set<String>] = [:]
    /// Words typed on a question card — one question of several, or a multi-select one — keyed
    /// like `multiSelections`.
    @State private var questionTexts: [String: String] = [:]
    /// What was sent from a question card, by the question row it answers. The card gives way
    /// to "Submitted" at once — Tyler: "when submitted the state of the question ui … should
    /// change" — and comes back with the reason if the send fails (the store's row message,
    /// which a send clears at the press and a failure sets).
    @State private var submittedAnswers: [String: String] = [:]
    /// `.qo:hover` — which option the pointer is on, so an option can be transparent at rest.
    /// A live card's only: a settled one follows no pointer.
    @State private var hoveredOption: String?
    /// Why a send to this session didn't land while a question card was the live one, by that
    /// card — the card is where it gets fixed. Read from the store's row message, which a press
    /// clears and a failure sets, whichever sent it: this card, the composer, or a voice reply.
    @State private var questionNotices: [String: String] = [:]
    @State private var scrollRequestGeneration = 0
    /// Selecting across the whole conversation, as in a document (ConchDesign/ConversationSelection.swift). Tyler: "I
    /// would also like to drag to select areas for copying in our conversation panel — it currently only lets me do 1
    /// line at a time." Every paragraph was its own SwiftUI text, and a SwiftUI selection cannot leave the text it
    /// started in. This keeps the selection as rows and offsets instead, so it runs across messages and survives the
    /// history region letting rows go.
    @StateObject private var selection = ConversationSelectionController()

    private static let bottomAnchor = "conversation-bottom"

    /// Room above your turn on top of the stack's 22 between rows. An exchange starts where you speak; at one gap for
    /// everything, a reply, the steps after it and your next message sat the same distance apart and read as one list.
    /// Your pending copy and a sent receipt take it too, so the transcript's own copy replaces them without a move.
    static let turnBreak: CGFloat = 12

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
    /// folds. The recorded rows are a separate, windowed region above the live tail
    /// (`HistoryRegion`), and a fold drawn across the two would be one row in two layouts.
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
            let members = Set(run.itemIDs)
            runView(run, steps: items.filter { members.contains($0.id) })
        } else if folds.memberOf[item.id] != nil {
            EmptyView()
        } else {
            memoRow(item)
        }
    }

    /// A run of steps as §3's one quiet line, and the steps themselves once it is opened.
    private func runView(_ run: ToolRun, steps: [ConversationItem]) -> some View {
        let open = isExpanded(run.id)
        return VStack(alignment: .leading, spacing: 8) {
            Button { toggleExpanded(run.id) } label: {
                HStack(spacing: 6) {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8))
                        .foregroundStyle(ConchPalette.textFaint)
                    Text(run.summary)
                        .font(ConchType.secondary)
                        .foregroundStyle(ConchPalette.textFaint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(open ? "Hide these steps" : "Show these steps")

            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(steps) { step in
                        memoRow(step)
                    }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(ConchPalette.divider).frame(width: 1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `row(for:)`, redrawn only when something it shows has changed.
    ///
    /// This body runs on every snapshot from ANY session — four a second while anything is
    /// working — and each run rebuilt every row: 44 markdown parses a second for a 30-row
    /// window, 236 once history was paged in, and a SwiftUI diff of the whole stack whose
    /// frame hitches grew with the row count, 8 ms at 30 rows and 58–67 ms at ~300
    /// (Instruments, 2026-09-20). That stall landing four times a second is what made
    /// scrolling stutter. `EquatableView` leaves a row's subtree untouched while its key is
    /// unchanged, so a snapshot that changed nothing here costs one comparison per row.
    @ViewBuilder
    private func memoRow(_ item: ConversationItem) -> some View {
        let memo = MemoRow(key: rowKey(for: item)) { row(for: item) }.equatable()
        switch selectability(of: item) {
        case .none: memo
        case .whole: memo.conversationSelectionRow(item.id, in: selection)
        case .text: memo.conversationSelectionRow(item.id, in: selection, wholeRow: false)
        }
    }

    /// How much of a row the conversation's selection takes. A message is text through and through: a press anywhere on
    /// it selects. A tool row whose output is open is text only there — its header stays the button that opens it. The
    /// rest (a question, a plan, a file change, a picture) keeps its own controls, and a drag passes over it.
    private enum Selectability { case none, whole, text }

    private func selectability(of item: ConversationItem) -> Selectability {
        switch item.kind {
        case .user: return item.receipt == nil ? .whole : .none
        case .assistant, .thinking: return .whole
        case .tool: return toolOutput(of: item) != nil && isExpanded(item.id) ? .text : .none
        case .review, .material: return .none
        }
    }

    /// The output a tool row shows when opened, or nil for a row that shows none (a question, a plan, a change).
    private func toolOutput(of item: ConversationItem) -> String? {
        guard item.kind == .tool else { return nil }
        if let asked = item.question, !asked.options.isEmpty { return nil }
        if let plan = item.plan, !plan.isEmpty { return nil }
        if item.change != nil { return nil }
        let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? ""
        return result.isEmpty ? nil : result
    }

    /// Everything `row(for:)` reads besides its callbacks. A row is redrawn exactly when one
    /// of these changes, so a value the row reads that is missing here is a row that goes
    /// stale — the callbacks are the only thing deliberately left out, since a stale closure
    /// still reaches the same store and workspace.
    private func rowKey(for item: ConversationItem) -> RowKey {
        let expanded = isExpanded(item.id)
        let live = item.question != nil && item.id == liveQuestionID
        return RowKey(
            item: item,
            expanded: expanded,
            fullText: history.fullText(forSnapshotItem: item.id),
            bodyStatus: expanded && wasCut(item) ? bodyStatus(for: item) : nil,
            selections: multiSelections.filter { $0.key == item.id || $0.key.hasPrefix(item.id + "#") },
            typed: questionTexts.filter { $0.key == item.id || $0.key.hasPrefix(item.id + "#") },
            // A settled card draws no hover, so the pointer crossing it redraws nothing.
            hovered: live ? hoveredOption : nil,
            live: live,
            submitted: item.question == nil ? nil : submittedAnswers[item.id],
            notice: live ? questionNotices[item.id] : nil,
            noTerminal: noTerminal,
            canOpenInTerminal: onOpenInTerminal != nil
        )
    }

    /// The question card that can still be answered (`QuestionOutcome.liveQuestionID`): the
    /// newest running question with nothing said after it — the daemon's own rule. Every other
    /// card is settled (answered, expired, or talked past) and is drawn as a record, not controls.
    private var liveQuestionID: String? {
        QuestionOutcome.liveQuestionID(
            in: conversation.items,
            id: \.id,
            isUser: { $0.kind == .user },
            isRunningQuestion: { $0.question != nil && $0.tool?.status == "running" }
        )
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
        // Read when the selection needs it, from this body's conversation: nothing is worked out here.
        let _ = selection.source = selectionSource
        ScrollViewReader { proxy in
            ScrollView {
                // Eager, still, for the live tail. A lazy stack leaves the viewport at an offset
                // whose rows have not been materialised, which showed as bare scroll background
                // while a streaming row changed the document height — and the live window is where
                // rows stream. It is at most the daemon's forty items; building all of it is cheap.
                //
                // Everything older is `HistoryRegion`: windowed, not lazy. Rows near the viewport
                // are real views and the rest are spacers at the height each row was drawn at, so
                // the document's geometry is exact, and nothing streams there to disturb it. That
                // lifted the ceiling the eager stack put on how much history can be read: measured
                // offscreen with conch-scroll-bench, a 5,000-item session lays out a few dozen rows.
                VStack(alignment: .leading, spacing: 22) {
                    // Computed ONCE per body. As a property read inside the loop below it was
                    // rebuilt for every row it was handed to — n rows × n recorded items per
                    // snapshot, 270k `ConversationItem`s a body with 520 rows paged in, and
                    // 67% of the main thread at rest (Time Profiler, 2026-09-20). Quadratic
                    // in how far back the reader has scrolled, which is why a long session
                    // stuttered harder the longer it was read.
                    let recordedEntries = self.recordedEntries
                    let liveFolds = folds(in: conversation.items)
                    // What the record store holds above the live window, drawn by the same
                    // renderers — a recorded message is still a message — and read further back as
                    // the reader scrolls up. Its first row is the line saying where it starts.
                    HistoryRegion(
                        model: history.region,
                        edge: historyEdge,
                        note: conversation.shared ? "Shared with another window — both windows' messages are shown" : nil,
                        entries: recordedEntries,
                        gap: 22,
                        edgeFont: .system(size: 11)
                    ) { recorded in
                        recordedRow(recorded)
                    }
                    ForEach(conversation.items) { item in
                        foldedRow(for: item, in: conversation.items, folds: liveFolds).id(item.id)
                    }
                    // What this Mac has sent that the transcript has not caught up to. Tyler:
                    // "im not seeing mesages i send show in the mac app - just the same ux thing
                    // as teh phone where we want instant response on send and confirm iwth
                    // checkmark". The daemon reads transcripts on a poll, so a sent message had
                    // seconds of saying nothing at all.
                    ForEach(store.outbox.entries(for: conversation.sessionId)) { pending in
                        // A message to the selection, but only its bubble: the line under it has Dismiss (`PendingMessage`).
                        PendingMessage(entry: pending, selection: selection, onDismiss: { store.discardOutgoing(pending.id) })
                            .id(pending.id)
                    }
                    if let approval {
                        approvalCard(approval)
                    }
                    // An anchor rather than scrolling to the last item: the last
                    // item GROWS while it streams, and scrolling to a growing view
                    // lands part-way up it.
                    // Only a deliverable nobody has looked at yet belongs IN the conversation.
                    // One that was filed days ago and already opened is history, and pinning it to
                    // the end of the stack makes stale work look like fresh work waiting on you —
                    // Tyler: "this one is showing green circle with a check tho becuase of a really
                    // old deliverable that shows at the bottom of teh chat". `viewedAt` is the same
                    // unviewed test the ledger already uses (`isUnviewed`), gated on the daemon
                    // actually reporting it, so an older daemon keeps today's behaviour rather than
                    // silently hiding every card.
                    if let artifact, !artifactShownBeside,
                       artifact.viewedAt == nil || !reportsViewedState || artifactOpenedHere {
                        // Keyed like the rows: the card reads its file — or decodes its image —
                        // on every body, and the body runs four times a second (the probe
                        // showed one markdown parse per snapshot at rest, this one).
                        MemoRow(key: artifact) { ArtifactPreview(artifact: artifact, onOpen: onOpenArtifact) }.equatable()
                    }

                    // One footer owns the bottom margin AND the floating composer's room.
                    // Its bottom is the real document end, also used by the native observer.
                    // Separate siblings added VStack spacing after the anchor and made every
                    // refresh scroll to a different endpoint than AppKit's bottom clamp.
                    Color.clear
                        .frame(height: 14 + max(0, bottomInset))
                        .id(Self.bottomAnchor)
                }
                .padding(.horizontal, 18)
                .padding(.top, 14)
                // The same measure the AppKit fallback uses, so the two renderers do not
                // disagree about how wide a line of this conversation is.
                .frame(maxWidth: ConversationTextView.maxMeasure, alignment: .leading)
                // The column's own space, and over it the surface that takes a press on its text:
                // a drag runs across every message, and Copy and Select All come here once it has.
                .conversationSelectionSurface(selection)
                .background(
                    ConversationScrollObserver(
                        onUserScroll: { isAtBottom in pinnedToBottom = isAtBottom },
                        onScrolled: onScrolled
                    )
                )
                // Centred in whatever the window leaves: the column stays put when the
                // sidebar opens and closes, rather than sliding under the eye.
                .frame(maxWidth: .infinity, alignment: .center)
                .opacity(switchFade)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: switchFade)
            }
            // The stage is a `surface` panel (§3); painting the window ground here covered it,
            // so the panel had the right shape and the wrong fill.
            .background(ConchPalette.surface)
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
            .onChange(of: bottomInset) { _, _ in
                guard pinnedToBottom else { return }
                requestBottomScroll(using: proxy)
            }
            // A session drawn from its record alone — the daemon published no live window for it
            // (`ConversationSource.recorded`) — ends with the record's newest row, not a live one:
            // it opens there once that row arrives, as a live session opens at its tail. Older
            // pages landing above leave the newest row where it is, so they do not trigger this.
            .onChange(of: conversation.items.isEmpty ? history.paging.rows.last?.id : nil) { _, _ in
                guard pinnedToBottom else { return }
                requestBottomScroll(using: proxy)
            }
            // A send's failure while a question waits is said on that question's card as well.
            .onChange(of: store.rowMessages[conversation.sessionId]) { _, message in
                guard let live = liveQuestionID else { return }
                questionNotices[live] = message
            }
            .onChange(of: conversation.sessionId) { _, _ in
                // A different session is a different conversation: start at its
                // end, and re-arm the follow. The recorded reader is told too —
                // anything still in flight for the old session is refused, not merged.
                history.select(session: conversation.sessionId, branchTip: branchTip)
                loadOlder()
                history.wantWhole(cutLive.map { ($0.id, $0.text) })
                pinnedToBottom = true
                multiSelections = [:]
                questionTexts = [:]
                questionNotices = [:]
                linkFailure = nil
                selection.clear()
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
                // After it, scrolling up is what reads further back (`HistoryRegion`).
                loadOlder()
                history.wantWhole(cutLive.map { ($0.id, $0.text) })
                requestBottomScroll(using: proxy)
            }
            // A long message the daemon cut to its tail is read whole as it arrives, rather than
            // behind "Show the rest". Older rows landing above the reader need nothing here: the
            // region moves the clip by exactly what arrived, in the layout pass that adds it.
            .onChange(of: cutLive) { _, rows in
                history.wantWhole(rows.map { ($0.id, $0.text) })
            }
        }
    }

    /// What the top of the recorded history says: nothing while more is coming, a spinner once
    /// a read is actually slow, "Start of the conversation" at the true start, and the plain
    /// sentence where history genuinely is not there (`HistoryEdge`). There is no button: the
    /// reader scrolling up is what reads further back, and a failed read tries again on its own.
    private var historyEdge: HistoryEdge {
        HistoryEdge.of(
            history.paging,
            liveIsWhole: !conversation.truncated && !conversation.items.isEmpty,
            slow: true,
            oldest: oldestRecorded
        )
    }

    /// When the record starts, in the reader's own locale — the view's job, not the
    /// state machine's, which would otherwise hold a string that reads differently in
    /// every timezone it is tested from.
    private var oldestRecorded: String? {
        guard let at = history.paging.oldestAt else { return nil }
        return Date(timeIntervalSince1970: at / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    /// One row of recorded history as the region draws it: an item, or the fold it heads.
    private struct RecordedRow {
        let item: HistoryItem
        let run: ToolRun?
        let steps: [HistoryItem]
    }

    /// The recorded rows that belong above the live window, as the region lays them out.
    ///
    /// Only what a row NEEDS to be laid out as a height is worked out here — its id and an
    /// estimate. The row itself, a `ConversationItem` and its markdown, is built only when the
    /// region makes it a real view, near the viewport.
    private var recordedEntries: [HistoryEntry<RecordedRow>] {
        // Undecorated, because the snapshot and the record name the same message
        // differently: `tool:call_7` here is `call_7` there.
        let live = Set(conversation.items.map { HistorySnapshot.nativeId(forSnapshotItem: $0.id) })
        let rows = HistorySnapshot.older(
            rows: history.paging.rows,
            thanSnapshot: live,
            startingAt: conversation.items.first?.at
        )
        // §3's folds, over the recorded list on its own (see `folds(in:)`).
        let runs = ToolFolding.runs(for: rows.map { (id: $0.id, isTool: $0.item.map(Self.isToolStep) ?? false, at: $0.item?.at) })
        var heads: [String: ToolRun] = [:]
        var members: Set<String> = []
        for run in runs {
            heads[run.id] = run
            members.formUnion(run.itemIDs.dropFirst())
        }
        let items = members.isEmpty ? [:] : Dictionary(
            rows.compactMap { row in row.item.map { (row.id, $0) } },
            uniquingKeysWith: { first, _ in first }
        )
        let estimate = HistoryEstimate.mac
        let width = history.region.width > 0 ? history.region.width : ConversationTextView.maxMeasure - 36
        return rows.compactMap { row in
            guard !members.contains(row.id) else { return nil }
            guard let item = row.item else { return HistoryEntry(id: row.id, estimate: 0, payload: nil) }
            if let run = heads[row.id] {
                return HistoryEntry(
                    id: row.id,
                    estimate: estimate.toolRow + estimate.gap,
                    payload: RecordedRow(item: item, run: run, steps: run.itemIDs.compactMap { items[$0] })
                )
            }
            return HistoryEntry(
                id: row.id,
                estimate: estimate.height(kind: item.kind, role: item.role, characters: max(item.bodyBytes, item.preview.count), width: width),
                payload: RecordedRow(item: item, run: nil, steps: [])
            )
        }
    }

    /// What a recorded row becomes in the stack: `ConversationItem(recorded:)` renders it.
    private static func isToolStep(_ item: HistoryItem) -> Bool {
        item.kind == "tool_call" || item.kind == "tool_result"
    }

    @ViewBuilder
    private func recordedRow(_ recorded: RecordedRow) -> some View {
        if let run = recorded.run {
            runView(run, steps: recorded.steps.map(conversationItem(recorded:)))
        } else {
            memoRow(conversationItem(recorded: recorded.item))
        }
    }

    /// A recorded item as a row: its whole body once it has been read — which it is, as it comes
    /// near the viewport — and its preview until then, marked as cut where there is more, so a
    /// sentence stopped at 240 characters does not read as a rendering bug.
    private func conversationItem(recorded: HistoryItem) -> ConversationItem {
        let body = history.body(for: recorded.id)
        let whole = body?.isComplete == true ? body?.text : nil
        return ConversationItem(recorded: recorded, text: whole ?? (recorded.hasFullBody ? recorded.preview + "…" : recorded.preview))
    }

    /// Which branch of a shared transcript this window is (A8), for the record store to
    /// read the ancestry above.
    ///
    /// The pane below is already this window's branch; this hands the same fact to the
    /// history above it, so the two cannot disagree about whose conversation this is.
    private var branchTip: String? {
        HistorySnapshot.branchTip(forSnapshotItems: conversation.items.map(\.id), shared: conversation.shared)
    }

    /// Ask for the page before the oldest row held: on arrival, which answers whether anything
    /// is recorded at all. After that the region asks, as the reader scrolls up.
    ///
    /// Nothing about the reader's place is captured here, deliberately: a baseline taken when a
    /// page is asked for was overwritten by the next scroll tick before the page it belonged to
    /// arrived (2026-09-20). The region measures each change when it happens.
    private func loadOlder() {
        guard history.paging.canLoadOlder else { return }
        history.loadOlder(anchor: history.paging.rows.first?.id ?? conversation.items.first?.id)
    }

    /// A live message the daemon cut to its tail, and the text it was cut to.
    private struct CutRow: Equatable {
        let id: String
        let rev: Int
        let text: String

        static func == (a: Self, b: Self) -> Bool { a.id == b.id && a.rev == b.rev }
    }

    /// The live window's messages the daemon cut to their tail, read whole as they appear.
    private var cutLive: [CutRow] {
        conversation.items
            .filter { ($0.kind == .assistant || $0.kind == .user) && $0.text.hasPrefix("…") }
            .map { CutRow(id: $0.id, rev: $0.rev, text: $0.text) }
    }

    /// The row's text: the whole message once the record has it, joined to the snapshot's own
    /// tail where the record is still behind; the snapshot's text until then.
    private func text(of item: ConversationItem) -> String {
        guard let full = history.fullText(forSnapshotItem: item.id) else { return item.text }
        return HistorySnapshot.whole(record: full, cut: item.text) ?? item.text
    }

    /// Whether the snapshot cut this row, and so whether the store has more of it.
    private func wasCut(_ item: ConversationItem) -> Bool {
        if let result = item.tool?.result { return HistorySnapshot.wasCut(result, cap: Self.toolResultCap) }
        return HistorySnapshot.wasCut(item.text, cap: Self.messageCap)
    }

    /// A tool row's whole output, read when it is opened: the live row's from the record behind
    /// it, a recorded row's from its own body.
    private func loadFullBody(of item: ConversationItem) {
        history.loadRecordedBody(item.id)
        guard wasCut(item), history.fullText(forSnapshotItem: item.id) == nil else { return }
        history.loadFullBodies(forSnapshotItems: [item.id])
    }

    /// How the read of a cut row's whole body is going, if one was asked for.
    private func bodyStatus(for item: ConversationItem) -> HistoryStatus? {
        let native = HistorySnapshot.nativeId(forSnapshotItem: item.id)
        let recorded = history.paging.items.first { $0.nativeId == native }
        return recorded.flatMap { history.body(for: $0.id) }?.status
    }

    /// How a body read is going, under the tool output waiting for it.
    @ViewBuilder
    private func fullBodyStatus(for item: ConversationItem) -> some View {
        switch bodyStatus(for: item) {
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
            guard generation == scrollRequestGeneration, pinnedToBottom else { return }
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
            if let receipt = item.receipt {
                // A canvas, a Show or a video he sent: one quiet row in his bubble, never the picture of the screen he
                // is looking at, nor the lines written for the agent.
                SentReceiptBubble(receipt: receipt)
                    .padding(.top, Self.turnBreak)
            } else {
                // The one kind that is right-aligned and filled. Everything else in
                // the stack is the machine talking; this is you, and it should be
                // findable while scrolling past without reading a word.
                HStack {
                    Spacer(minLength: 48)
                    // Whole: a long paste the daemon cut to its tail is read back from the record.
                    Text(AttributedString.conchMarkdown(text(of: item)))
                        .conversationSelectable(row: item.id, segment: 0)
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
                .padding(.top, Self.turnBreak)
            }
        case .assistant:
            // The reply as a document: headings on a scale, lists, code on a ground, tables as columns — the
            // renderer both apps share (ConchDesign/Markdown.swift), at readingBody's size. It replaced an inline
            // parse that flattened a table to "**first** — rest · rest", which made a 54-row document a wall of
            // bold runs (Tyler: "i think it might be tables that are broken?"). Affordable because the row is
            // memoised above, and its parse is cached by text: once per revision, not once per snapshot, and
            // not again when a recorded row scrolls away and back.
            //
            // Whole, always. A reply the daemon cut to its tail, or a recorded one past its preview, is read
            // from the record as it arrives or comes near the viewport; "Show the rest" is gone. Tyler: "those
            // should just smooth infinite scroll".
            MarkdownView(text: text(of: item))
                .lineSpacing(ConchType.readingLineSpacing)
                .foregroundStyle(ConchPalette.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            Text(AttributedString.conchMarkdown(item.text))
                .conversationSelectable(row: item.id, segment: 0)
                .font(.system(size: 12).italic())
                .foregroundStyle(ConchPalette.textFaint)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .review:
            // The lab's review mark is a CHECK on the ready green (line 895:
            // `badge review` + `ic('check')`), never a star — and §5's state
            // language says the same: "`ready` green circle with ✓".
            Label(item.text, systemImage: "checkmark.circle.fill")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ConchPalette.statusReview)
        case .material:
            MaterialRow(material: item.material, fallback: item.text)
        case .tool:
            // A question outranks the generic tool shell: this row exists only
            // because the session is blocked on one of these choices.
            if let asked = item.question, !asked.options.isEmpty {
                let questions = item.allQuestions
                // §3: once answered it collapses to one line naming what was decided. Only
                // when the answer actually names an option — the wire never states a choice,
                // so it is recovered from the finished call's result text, and when nothing
                // matches the block stays exactly as it was. Guessing at a person's decision
                // is worse than not summarising it.
                //
                // Only the live card is a form (`liveQuestionID`). One Tyler has talked past is
                // still "running" on disk, and it stayed pressable for an answer the daemon refused.
                let live = item.id == liveQuestionID
                if !live, let decided = answeredSummary(questions, result: item.tool?.result) {
                    answeredQuestionRow(decided)
                } else if live, let sent = submittedAnswers[item.id], questionNotices[item.id] == nil {
                    submittedQuestionRow(sent)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        // Why the last send here didn't land — from this card, the composer or a
                        // voice reply — on the card that is still waiting for the answer.
                        if live, let failure = questionNotices[item.id] {
                            Text(failure)
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(ConchPalette.statusNeeds)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        questionCard(
                            questions,
                            itemID: item.id,
                            answerable: live,
                            chosen: live ? [] : QuestionOutcome.chosenPerQuestion(
                                questions: questions.map(\.question),
                                options: questions.map { $0.options.map(\.label) },
                                result: item.tool?.result
                            )
                        )
                    }
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

    /// The permission prompt, as the question card's shape: what it wants, and the three
    /// answers Claude Code's dialog offers. Where conch can't press keys at the dialog, it
    /// says so and points at the terminal instead of offering buttons that would fail.
    private func approvalCard(_ approval: SessionRow.PendingApproval) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Wants to use \(approval.name)")
                .font(ConchTypography.font(size: 12, weight: .semibold))
                .foregroundStyle(ConchPalette.statusNeeds)
            Text(approval.summary)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(ConchPalette.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if approval.answerable == false || onApprove == nil {
                Text("conch can't answer this agent's permission prompt — answer it in its terminal.")
                    .font(.system(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
            } else if let noTerminal {
                Text(noTerminal)
                    .font(.system(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
            } else {
                // No "Always allow": Claude Code 2.1.280's second option grants something
                // different per tool (for a Bash command, measured: "always allow access to
                // <folder> from this project"), and a button cannot say what it would grant.
                HStack(spacing: 8) {
                    approvalButton("Allow", kind: "once", primary: true)
                    approvalButton("Deny", kind: "deny", primary: false)
                }
                .padding(.top, 2)
            }
        }
        .padding(.top, 14)
        .padding(.trailing, 10)
        .padding(.bottom, 12)
        .padding(.leading, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(ConchPalette.hairlineStrong, lineWidth: 1)
        )
    }

    private func approvalButton(_ title: String, kind: String, primary: Bool) -> some View {
        Button { onApprove?(kind) } label: {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(primary ? ConchPalette.bg : ConchPalette.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(primary ? ConchPalette.statusNeeds : ConchPalette.raised)
                )
        }
        .buttonStyle(.plain)
        .help(kind == "deny" ? "Deny, and tell it what to do instead in the composer" : "Allow this once")
    }

    /// §3's collapsed question: one quiet line saying what was decided.
    ///
    /// It replaces a header, the whole question, and every option greyed out at 0.58 — the
    /// largest thing in a finished transcript, saying the least. Not a button: there is
    /// nothing left to do to it, and the exchange that produced it is right above.
    /// Sent, and waiting for the session to record it; the row then collapses to what was decided.
    private func submittedQuestionRow(_ summary: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "paperplane")
                .font(.system(size: 9.5))
                .foregroundStyle(ConchPalette.textFaint)
            Text("Submitted · \(summary)")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
                .lineLimit(8)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func submitAnswer(_ summary: String, _ answers: [ConchQuestionAnswer], itemID: String) {
        submittedAnswers[itemID] = summary
        onAnswer(summary, answers, itemID)
    }

    private func answeredQuestionRow(_ decided: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 9.5))
                .foregroundStyle(ConchPalette.textFaint)
            Text(decided)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
                .lineLimit(8)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `inSet`: one of several questions asked at once. Its picks are held for the card's one
    /// Submit instead of sent. "Something else…" is typed here, in the card, for one of several
    /// and for a multi-select question (a form with its own Submit, where the words go beside the
    /// ticked options as Claude Code's picker records them); a lone single-choice question sends
    /// on a tap, so its words go through the composer. `chosen`: on a settled card, what the
    /// recorded answer names.
    private func questionRow(
        _ asked: ConversationItem.AgentQuestion,
        questionID: String,
        answerable: Bool,
        inSet: Bool = false,
        chosen: [String] = []
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !asked.header.isEmpty {
                // `.qh{font:600 12px;color:var(--attention)}` — it was 11 semibold.
                Text(asked.header)
                    .font(ConchTypography.font(size: 12, weight: .semibold))
                    .foregroundStyle(ConchPalette.statusNeeds)
            }
            // `.qq{font:500 15px/1.45}`. This was set at 13 — SMALLER than the transcript
            // around it, for the one thing on screen that is blocking a session on you.
            Text(AttributedString.conchMarkdown(asked.question))
                .font(ConchTypography.font(size: 15, weight: .medium))
                .lineSpacing(15 * 0.45)
                .foregroundStyle(ConchPalette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 2)

            ForEach(Array(asked.options.enumerated()), id: \.offset) { index, option in
                if answerable {
                    let selected = multiSelections[questionID]?.contains(option.label) == true
                    Button {
                        if asked.multiSelect {
                            toggleSelection(option.label, for: questionID)
                        } else if inSet {
                            multiSelections[questionID] = [option.label]
                            questionTexts[questionID] = nil
                        } else {
                            submitAnswer(option.label, [ConchQuestionAnswer(choices: [index])], itemID: questionID)
                        }
                    } label: {
                        questionOption(
                            option,
                            multiSelect: asked.multiSelect,
                            selected: selected,
                            live: true
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
                    // Settled — answered, expired, or talked past. The question stays in the
                    // transcript as a record, and a record is not a control: no hover, no press,
                    // nothing to focus. What was chosen stays marked; the rest recede. Tyler:
                    // "Remove the hover state from old multiple choice questions" (2026-09-28).
                    let picked = chosen.contains(option.label)
                    questionOption(option, multiSelect: asked.multiSelect, selected: picked, live: false)
                        .opacity(picked ? 1 : 0.45)
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(picked ? .isSelected : [])
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

            if answerable && (inSet || asked.multiSelect) {
                // Claude Code's "Type something": the words become this question's answer — in
                // place of a pick on a single-choice question, beside the ticks on a multi-select one.
                TextField("Something else…", text: Binding(
                    get: { questionTexts[questionID] ?? "" },
                    set: { typed in
                        questionTexts[questionID] = typed
                        if !typed.isEmpty && !asked.multiSelect { multiSelections[questionID] = nil }
                    }
                ))
                .textFieldStyle(.plain)
                .font(.system(size: 12.5, weight: .medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(ConchPalette.textDim.opacity(0.22), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                )
                .disabled(noTerminal != nil)
                .onSubmit {
                    if !inSet, let filled = multiAnswer(asked, questionID: questionID) {
                        submitAnswer(filled.summary, [filled.answer], itemID: questionID)
                    }
                }
            } else if answerable && !inSet {
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

            if asked.multiSelect && answerable && !inSet {
                let filled = multiAnswer(asked, questionID: questionID)
                Button {
                    if let filled { submitAnswer(filled.summary, [filled.answer], itemID: questionID) }
                } label: {
                    Text(filled?.label ?? "Submit selections")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(filled == nil ? ConchPalette.textFaint : ConchPalette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 9)
                                .fill(filled == nil ? ConchPalette.raised : ConchPalette.statusNeeds)
                        )
                }
                .buttonStyle(.plain)
                .disabled(filled == nil || noTerminal != nil)
                .accessibilityHint("Sends the selected options and any words of your own to the session")
            }
        }
        // `.qb{border-radius:14px;box-shadow:inset 0 0 0 1px var(--hair2);
        // padding:14px 10px 8px 16px}` — asymmetric, and a NEUTRAL hairline.
        //
        // The card was uniform 12 at radius 10, ringed in the attention colour. The colour
        // said "answer me" a second time, louder than the header that already says it, and
        // on a settled question it still glowed at 0.18. Live-versus-settled is carried by
        // the options, which recede on a settled card to all but what was chosen.
        .padding(.top, 14)
        .padding(.trailing, 10)
        .padding(.bottom, 8)
        .padding(.leading, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(ConchPalette.hairlineStrong, lineWidth: 1)
        )
    }

    /// A lone multi-select question's answer: the ticked options and any words of your own, as
    /// one answer (Claude Code records them together: "G1, G3, my words"); nil with neither.
    private func multiAnswer(
        _ asked: ConversationItem.AgentQuestion,
        questionID: String
    ) -> (answer: ConchQuestionAnswer, summary: String, label: String)? {
        let selected = selectedLabels(for: asked, questionID: questionID)
        let picked = asked.options.indices.filter { selected.contains(asked.options[$0].label) }
        let typed = (questionTexts[questionID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !picked.isEmpty || !typed.isEmpty else { return nil }
        return (
            ConchQuestionAnswer(choices: picked.isEmpty ? nil : picked, text: typed.isEmpty ? nil : typed),
            (selected + (typed.isEmpty ? [] : [typed])).joined(separator: ", "),
            typed.isEmpty ? "Submit \(picked.count) selected" : "Submit answer"
        )
    }

    private func questionOption(
        _ option: ConversationItem.AgentQuestion.Option,
        multiSelect: Bool,
        selected: Bool,
        live: Bool
    ) -> some View {
        // `.qo{gap:12px;align-items:flex-start;padding:8px 10px;border-radius:9px}`,
        // `.qo b{font:500 14px/20px}`, `.qo small{font-size:12.5px;color:var(--text2)}`.
        //
        // Every option carried a permanent `raised` fill, so three choices read as three
        // stacked cards inside a card. In the lab an option is a ROW: transparent until the
        // pointer is on it, filled only when it is the one you picked. On a settled card only
        // what was chosen is filled, with a check, and nothing follows the pointer.
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: multiSelect
                ? (selected ? "checkmark.square.fill" : "square")
                : (selected && !live ? "checkmark.circle.fill" : "circle"))
                .font(.system(size: 10.5))
                .foregroundStyle(selected ? ConchPalette.statusNeeds : ConchPalette.textDim)
            VStack(alignment: .leading, spacing: 1) {
                Text(option.label)
                    .font(ConchTypography.font(size: 14, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                if let description = option.description, !description.isEmpty {
                    Text(description)
                        .font(ConchTypography.font(size: 12.5))
                        .foregroundStyle(ConchPalette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // `--hover` and `--sel`, through the app's own measured tokens rather than the lab's
        // raw 3.5%/6.5%: RowStateTokenTests records that those fail perceptibility here —
        // hover once read as MORE selected than selected.
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(selected ? ConchPalette.selection : (live && hoveredOption == option.label ? ConchPalette.hover : .clear))
        )
        .modifier(OptionHover(live: live, label: option.label, hovered: $hoveredOption))
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

    /// What a finished question decided, one line per question, or nil when the result
    /// does not say for certain.
    private func answeredSummary(_ questions: [ConversationItem.AgentQuestion], result: String?) -> String? {
        if questions.count == 1, let asked = questions.first {
            return QuestionOutcome.summary(
                header: asked.header,
                question: asked.question,
                options: asked.options.map(\.label),
                result: result
            )
        }
        guard let answers = QuestionOutcome.answers(to: questions.map(\.question), in: result) else { return nil }
        return zip(questions, answers)
            .map { asked, answer in asked.header.isEmpty ? answer : "\(asked.header) · \(answer)" }
            .joined(separator: "\n")
    }

    /// One question as it always was; or, when the agent asked several at once, each one to
    /// fill in and ONE Submit that sends every answer in order. Claude Code records nothing
    /// until all of them are answered, and a card that knew only the first kept sending that
    /// answer to whichever question the terminal had moved on to (2026-09-23).
    @ViewBuilder
    private func questionCard(
        _ questions: [ConversationItem.AgentQuestion],
        itemID: String,
        answerable: Bool,
        chosen: [[String]] = []
    ) -> some View {
        if questions.count == 1, let asked = questions.first {
            questionRow(asked, questionID: itemID, answerable: answerable, chosen: chosen.first ?? [])
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(questions.enumerated()), id: \.offset) { index, asked in
                    questionRow(asked, questionID: "\(itemID)#\(index)", answerable: answerable, inSet: true,
                                chosen: index < chosen.count ? chosen[index] : [])
                }
                if answerable {
                    let filled = setAnswers(questions, itemID: itemID)
                    Button {
                        if let filled { submitAnswer(filled.summary, filled.answers, itemID: itemID) }
                    } label: {
                        Text(filled == nil ? "Answer all \(questions.count) to submit" : "Submit answers")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(filled == nil ? ConchPalette.textFaint : ConchPalette.bg)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(
                                RoundedRectangle(cornerRadius: 9)
                                    .fill(filled == nil ? ConchPalette.raised : ConchPalette.statusNeeds)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(filled == nil || noTerminal != nil)
                    .accessibilityHint("Sends every answer to the session, in order")
                }
            }
        }
    }

    /// Every question's answer in order, and a summary to name the send by; nil while any
    /// question is unanswered. Words typed for a single-choice question win over its pick; a
    /// multi-select one takes its ticks and the words together.
    private func setAnswers(
        _ questions: [ConversationItem.AgentQuestion],
        itemID: String
    ) -> (answers: [ConchQuestionAnswer], summary: String)? {
        var answers: [ConchQuestionAnswer] = []
        var lines: [String] = []
        for (index, asked) in questions.enumerated() {
            let id = "\(itemID)#\(index)"
            let typed = (questionTexts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let picked = asked.options.indices.filter { multiSelections[id]?.contains(asked.options[$0].label) == true }
            if asked.multiSelect, !picked.isEmpty, !typed.isEmpty {
                // Ticks and words together, as Claude Code's picker records them: "G1, G3, my words".
                answers.append(ConchQuestionAnswer(choices: picked, text: typed))
                lines.append((picked.map { asked.options[$0].label } + [typed]).joined(separator: ", "))
            } else if !typed.isEmpty {
                answers.append(ConchQuestionAnswer(text: typed))
                lines.append(typed)
            } else if !picked.isEmpty {
                answers.append(ConchQuestionAnswer(choices: picked))
                lines.append(picked.map { asked.options[$0].label }.joined(separator: ", "))
            } else {
                return nil
            }
        }
        let summary = zip(questions, lines)
            .map { asked, line in asked.header.isEmpty ? line : "\(asked.header): \(line)" }
            .joined(separator: "; ")
        return (answers, summary)
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
                            .font(ConchType.secondary)
                            .foregroundStyle(ConchPalette.textDim)
                        if !item.text.isEmpty {
                            Text(item.text)
                                .font(ConchType.code)
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
                    MarkdownView(text: result, size: 12.5)
                        .foregroundStyle(ConchPalette.textPrimary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ConchPalette.hover, in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text(result)
                        .conversationSelectable(row: item.id, segment: 0)
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

    // MARK: - The selection's reading of the conversation

    /// The agent's name, for a copied exchange's labels.
    private var agentName: String {
        store.state?.row(conversation.sessionId)?.backend?.lowercased() == "codex" ? "Codex" : "Claude"
    }

    /// The conversation as the selection reads it: every row in the order drawn — the record's, the live window's, what
    /// this Mac has sent — and each one's selectable texts, exactly as `row(for:)` draws and tags them. Closures, run only
    /// when a selection needs them: building every row's text on every snapshot is what the memoised rows avoid.
    private var selectionSource: ConversationSelectionController.Source {
        let view = self
        let store = self.store
        return .init(
            rowIDs: {
                let recorded = view.recordedRowsInOrder
                return recorded.map(\.id) + view.conversation.items.map(\.id)
                    + store.outbox.entries(for: view.conversation.sessionId).map(\.id)
            },
            rowTexts: { ids in view.selectableTexts(ids) },
            alias: { id in
                // A live row that aged out of the snapshot is a recorded row now, by its native id.
                let native = HistorySnapshot.nativeId(forSnapshotItem: id)
                return view.history.paging.rows.first { $0.item?.nativeId == native || $0.id == native }?.id
            }
        )
    }

    /// The record's rows above the live window, in order.
    private var recordedRowsInOrder: [HistoryRow] {
        let live = Set(conversation.items.map { HistorySnapshot.nativeId(forSnapshotItem: $0.id) })
        return HistorySnapshot.older(rows: history.paging.rows, thanSnapshot: live, startingAt: conversation.items.first?.at)
    }

    /// `ids`' selectable texts, the rows among them that have any.
    private func selectableTexts(_ ids: [String]) -> [String: SelectableRowText] {
        let wanted = Set(ids)
        var texts: [String: SelectableRowText] = [:]
        let agent = agentName
        // A step folded into a run shows only while the run is open, whatever its own row says.
        let liveFolds = folds(in: conversation.items)
        for item in conversation.items where wanted.contains(item.id) {
            let run = liveFolds.heads[item.id]?.id ?? liveFolds.memberOf[item.id]
            texts[item.id] = selectableText(of: item, agent: agent, shown: run.map(isExpanded) ?? true)
        }
        if texts.count < wanted.count {
            // One pass over the record. A message needs nothing else; only a tool step asks which run it is folded
            // into, which means laying the folds out over the whole record, so that is done only when one is wanted.
            var steps: [HistoryRow] = []
            for row in history.paging.rows where wanted.contains(row.id) {
                guard let item = row.item else { continue }
                if Self.isToolStep(item) { steps.append(row); continue }
                texts[row.id] = selectableText(of: conversationItem(recorded: item), agent: agent, shown: true)
            }
            if !steps.isEmpty {
                let recorded = recordedRowsInOrder
                var runOf: [String: String] = [:]
                for run in ToolFolding.runs(for: recorded.map { (id: $0.id, isTool: $0.item.map(Self.isToolStep) ?? false, at: $0.item?.at) }) {
                    for member in run.itemIDs { runOf[member] = run.id }
                }
                for row in steps {
                    guard let item = row.item else { continue }
                    texts[row.id] = selectableText(of: conversationItem(recorded: item), agent: agent, shown: runOf[row.id].map(isExpanded) ?? true)
                }
            }
            for entry in store.outbox.entries(for: conversation.sessionId) where wanted.contains(entry.id) {
                texts[entry.id] = SelectableRowText(id: entry.id, speaker: .you, segments: [SelectableSegment(AttributedString.conchMarkdown(entry.text))])
            }
        }
        return texts
    }

    /// One row's selectable texts, as `row(for:)` draws them; nil for a row with none. `shown`: the row is not folded
    /// away inside a closed run.
    private func selectableText(of item: ConversationItem, agent: String, shown: Bool) -> SelectableRowText? {
        switch item.kind {
        case .user:
            guard item.receipt == nil else { return nil }
            return SelectableRowText(id: item.id, speaker: .you, segments: [SelectableSegment(AttributedString.conchMarkdown(text(of: item)))])
        case .assistant:
            return SelectableRowText(id: item.id, speaker: .agent(agent), segments: MarkdownView.selectableSegments(text(of: item)))
        case .thinking:
            return SelectableRowText(id: item.id, speaker: .thinking(agent), segments: [SelectableSegment(AttributedString.conchMarkdown(item.text))])
        case .tool:
            guard shown, isExpanded(item.id), let output = toolOutput(of: item) else { return nil }
            let name = item.tool?.name ?? "Tool"
            if item.tool?.kind == .subagent {
                return SelectableRowText(id: item.id, speaker: .output(name), segments: MarkdownView.selectableSegments(output, size: 12.5))
            }
            return SelectableRowText(id: item.id, speaker: .output(name), segments: [SelectableSegment(text: output, kind: .code)])
        case .review, .material:
            return nil
        }
    }

    private func statusColor(_ status: String?) -> Color {
        switch status {
        case "error": return ConchPalette.statusNeeds
        case "done": return ConchPalette.textFaint
        // Faint, not working's blue. A tool call is "running" until its result lands, and one
        // whose result never does (an interrupted turn, a question answered elsewhere) reads
        // running for good, so blue here would claim work that stopped long ago.
        default: return ConchPalette.statusQuiet
        }
    }
}

/// A live question option's pointer tracking. A settled card's options get none — no hover
/// fill, no hit shape — so nothing on a finished question reacts to the pointer.
private struct OptionHover: ViewModifier {
    let live: Bool
    let label: String
    @Binding var hovered: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if live {
            content
                .contentShape(Rectangle())
                .onHover { inside in
                    if inside { hovered = label } else if hovered == label { hovered = nil }
                }
        } else {
            content
        }
    }
}

/// What one row is drawn from (`rowKey(for:)`).
private struct RowKey: Equatable {
    let item: ConversationItem
    let expanded: Bool
    /// The record store's whole text once read, shown in place of the snapshot's cut.
    let fullText: String?
    /// The read's progress under an opened cut row.
    let bodyStatus: HistoryStatus?
    /// A question card's ticked options, per question.
    let selections: [String: Set<String>]
    /// Words typed for one question of several, per question.
    let typed: [String: String]
    /// Which option the pointer is on — the live question card's only, so a hover over one
    /// question does not redraw every other, and a settled card never redraws for the pointer.
    let hovered: String?
    /// The question card that can still be answered (`liveQuestionID`).
    let live: Bool
    /// What this question card sent, while the session records it.
    let submitted: String?
    /// Why a send didn't land, on the live question card.
    let notice: String?
    let noTerminal: String?
    let canOpenInTerminal: Bool
}

/// A view that is rebuilt only when its key changes — SwiftUI's `EquatableView`, keyed
/// explicitly because the content closure cannot be compared. The same idea as the
/// overlay's `TurnLine: View, Equatable` (ConchDesign/Components.swift).
private struct MemoRow<Key: Equatable, Content: View>: View, Equatable {
    let key: Key
    let content: () -> Content

    static func == (a: Self, b: Self) -> Bool { a.key == b.key }

    var body: some View { content() }
}

/// SwiftUI exposes scrolling commands on macOS 14, but not whether the person
/// has moved the underlying scroll view. Listening only to AppKit's live-scroll
/// notifications avoids treating content growth as a user scroll: the document
/// may get taller while its clip view stays still, and that must not disarm an
/// already-following conversation before it can advance to the new bottom.
private struct ConversationScrollObserver: NSViewRepresentable {
    let onUserScroll: (Bool) -> Void
    /// Scrolled away from the top: §3 shows the header's hairline only once something has
    /// passed under it. Not the same question as `onUserScroll`, which asks about the BOTTOM —
    /// a long transcript sitting at its top is not at the bottom and has still scrolled nothing.
    let onScrolled: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onUserScroll: onUserScroll, onScrolled: onScrolled)
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
        private weak var scrollView: NSScrollView?
        private var observations: [NSObjectProtocol] = []

        init(
            onUserScroll: @escaping (Bool) -> Void,
            onScrolled: @escaping (Bool) -> Void
        ) {
            self.onUserScroll = onUserScroll
            self.onScrolled = onScrolled
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
            // The other end of the same measurement: has anything gone under the header yet?
            // A couple of points of slack, because a trackpad rests at 0.5. Reading further back
            // as the top nears is the history region's own (`HistoryRegion`), which sees every
            // scroll rather than only the live ones.
            let fromTop = documentView.isFlipped
                ? visible.minY - document.minY
                : document.maxY - visible.maxY
            onScrolled(document.height > visible.height && fromTop > 2)
        }
    }
}

/// The inline parse, for the rows that are one flow of text in a bubble or a line — your turn, a pending send, a
/// thought, a question — where a block-per-view document would claim the full width. It is the overlay's renderer,
/// so those rows and the fog agree. An agent's reply and a document go through `MarkdownView` instead.
extension AttributedString {
    static func conchMarkdown(_ source: String) -> AttributedString {
        ConversationFog.inlineMarkdown(source)
    }
}

/// Something Tyler sent through conch, as his own row: `SentReceiptRow`, right-aligned in the bubble his words use, its
/// picture a thumbnail read small off the main thread. A click opens it whole in Quick Look — the picture, or a Show's
/// or a video's recording — and Esc puts it away; nothing here is ever drawn big.
private struct SentReceiptBubble: View {
    let receipt: ConchSentReceipt
    @State private var thumbnail: NSImage?
    /// What Quick Look is showing; nil when it is closed.
    @State private var preview: URL?

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            SentReceiptRow(receipt: receipt, thumbnail: thumbnail.map { Image(nsImage: $0) }) { preview = opens }
                .help(opens?.path ?? receipt.title)
        }
        .task(id: receipt.thumb) {
            guard let path = receipt.thumb else { return }
            thumbnail = await Task.detached(priority: .utility) { Self.thumbnail(of: path) }.value
        }
        .quickLookPreview($preview)
    }

    /// The recording when it is still on this Mac, else the picture; nil once both are gone (a canvas is kept two
    /// weeks, a phone upload a day).
    private var opens: URL? {
        [receipt.open, receipt.thumb].compactMap { $0 }
            .first { FileManager.default.fileExists(atPath: $0) }
            .map { URL(fileURLWithPath: $0) }
    }

    /// The picture decoded as small as a Retina thumbnail cropped to fill needs, never whole: a flat.png is 1568 px.
    nonisolated private static func thumbnail(of path: String) -> NSImage? {
        let side = 4 * max(SentReceiptRow.thumbnailSize.width, SentReceiptRow.thumbnailSize.height)
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: side,
              ] as CFDictionary)
        else { return nil }
        return NSImage(cgImage: image, size: .zero)
    }
}

private struct MaterialRow: View {
    let material: ConversationItem.Material?
    let fallback: String
    /// The picture, decoded off the main thread, under the key it was decoded for. A nil image
    /// is one that would not decode: the row says what it is instead.
    @State private var decoded: Decoded?

    private struct Decoded {
        let key: String
        let image: NSImage?
    }

    /// The picture this row draws, named and shaped without decoding it: the file at its path
    /// while there is one, else the attachment inline. Named by the file's modification time and
    /// size as well as its path (`ConchImage.key(forPath:)`), so a picture rewritten where it was
    /// is drawn as it is now, not as it was first decoded.
    private var picture: ConchImage.Picture? {
        guard material?.kind == .image else { return nil }
        if let path = material?.path, let picture = ConchImage.picture(atPath: path) { return picture }
        return material?.dataUrl.flatMap(ConchImage.picture(dataURL:))
    }

    /// Decoded for the row it is drawn in, never whole: this row is at most 320 pt tall in a
    /// 700 pt column, so its longest side needs 1,400 pixels at 2x. `NSImage(contentsOfFile:)`
    /// decoded a 2880 × 1800 screenshot whole, twenty megabytes held for as long as the row was.
    private static let maxPixelSize = 1_400

    var body: some View {
        if let picture, !(decoded?.key == picture.key && decoded?.image == nil) {
            pictureView(picture)
        } else {
            detailRow
        }
    }

    /// The picture, or its shape while it is decoded — the same size either way, so nothing
    /// moves when it lands. Decoded in a task, off the main thread: in `body` it was tens of
    /// milliseconds a screenshot, on the main thread, in the frame the row came into view. One
    /// already decoded is drawn at once.
    private func pictureView(_ picture: ConchImage.Picture) -> some View {
        let image = decoded?.key == picture.key
            ? decoded?.image
            : ConchImage.decoded(picture, maxPixelSize: Self.maxPixelSize).map { NSImage(cgImage: $0, size: .zero) }
        return Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Color.clear.aspectRatio(picture.aspect, contentMode: .fit)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(ConchPalette.divider, lineWidth: 0.5)
        }
        .help(material?.path ?? material?.title ?? "Image")
        .task(id: picture.key) {
            guard decoded?.key != picture.key else { return }
            let size = Self.maxPixelSize
            let image = await Task.detached(priority: .userInitiated) {
                ConchImage.decode(picture, maxPixelSize: size)
            }.value
            guard !Task.isCancelled else { return }
            decoded = Decoded(key: picture.key, image: image.map { NSImage(cgImage: $0, size: .zero) })
        }
    }

    private var detailRow: some View {
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
                        .font(ConchType.secondary)
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
        // Faint, as every step's mark is: the brand cyan here measured 1.9:1 on the stage, and at full strength it is
        // the open microphone's alone.
        case .done: return ConchPalette.textFaint
        // Faint for the tool call's reason: a plan left mid-step when its turn ended still says running.
        case .running: return ConchPalette.statusQuiet
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
                        .foregroundStyle(ConchPalette.statusQuiet)
                        .frame(width: 12)
                    Text(change.file)
                        .font(ConchType.code)
                        .foregroundStyle(ConchPalette.textDim)
                        // The name stays; the PATH is a hover away. A row that reads
                        // `shot.mjs` names one of every shot.mjs in the checkout, and putting
                        // the absolute path on the line itself is the clutter Tyler already
                        // objected to above the deliverables.
                        .help(change.path.isEmpty ? change.file : change.path)
                    if !change.added.isEmpty {
                        Text("+\(change.added.count)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ConchPalette.added)
                    }
                    if !change.removed.isEmpty {
                        Text("−\(change.removed.count)")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(ConchPalette.removed)
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
                        DiffLine(text: line, sign: "−", tint: ConchPalette.removed)
                    }
                    ForEach(Array(change.added.enumerated()), id: \.offset) { _, line in
                        DiffLine(text: line, sign: "+", tint: ConchPalette.added)
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
/// A message this Mac sent that the transcript has not shown yet.
///
/// The bubble is the `.user` row exactly — same fill, radius, measure and type — so when the
/// transcript's own copy arrives and retires this one, nothing on screen moves. Only the line
/// beneath it changes, and it says what conch actually KNOWS rather than what it hopes: sent,
/// sent and confirmed, staged, or why it did not land.
private struct PendingMessage: View {
    let entry: ConchOutboxEntry
    let selection: ConversationSelectionController
    /// Takes a send that did not land off the conversation. Its words are already back in the composer; without
    /// this a failed send sat under everything that came after it for good, reading as a fresh failure hours later
    /// (2026-10-02: "Not delivered" under a session that had been working fine since).
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            HStack {
                Spacer(minLength: 48)
                Text(AttributedString.conchMarkdown(entry.text))
                    .conversationSelectable(row: entry.id, segment: 0)
                    .font(ConchType.readingBody)
                    .lineSpacing(ConchType.readingLineSpacing)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(ConchPalette.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
            }
            // The bubble is the selection's row, and only the bubble. 2026-10-05, Tyler: Dismiss "didn't work per
            // usual" (2026-10-02: "Dismiss button doesn't work"). A message is selectable whole, so the surface over
            // the conversation takes a press ANYWHERE in its row once the pointer has crossed it — and the row was this
            // whole stack, the line beneath with Dismiss included. A click on Dismiss put the caret down instead, and
            // the bubble went only when the transcript's own copy retired it ("Oh its gone now"). Proven with real
            // views and clicks in ConversationSelectionHostTests.
            .conversationSelectionRow(entry.id, in: selection)
            status
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.top, ConversationStackView.turnBreak)
    }

    @ViewBuilder
    private var status: some View {
        switch entry.state {
        // Optimistic, immediate, and honest: it says the send went through, never that anything
        // has been delivered. It stays as long as the daemon is still working on it.
        case .sent:
            Text("Sent")
                .font(.system(size: 11))
                .foregroundStyle(ConchPalette.textFaint)
        // The quiet mark: still "Sent", now with proof beside it. Tyler asked for exactly this —
        // "a confirmed icon but still show as sent" — so nothing jumps when it lands.
        case .confirmed:
            Label("Sent", systemImage: "checkmark")
                .font(.system(size: 11))
                .foregroundStyle(ConchPalette.textFaint)
                .accessibilityLabel("Sent, and confirmed")
        case .staged:
            Text("Staged — not submitted")
                .font(.system(size: 11))
                .foregroundStyle(ConchPalette.statusNeeds)
        // Not a failure and not a confirmation: conch could not tell. It says so, and waits for
        // the outcome the daemon publishes afterwards.
        case let .unknown(reason):
            unsettled(reason, color: ConchPalette.statusWaiting)
        case let .failed(reason):
            unsettled(reason, color: ConchPalette.statusNeeds)
        }
    }

    /// What became of a send that did not land, when it was sent — so an old one never reads as news — and a way to
    /// clear it.
    private func unsettled(_ reason: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(entry.sentAt.formatted(date: .omitted, time: .shortened)) · \(reason)")
                .font(.system(size: 11))
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
            Button("Dismiss", action: onDismiss)
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)
                .help("Take this off the conversation. Its words are in the composer.")
        }
        .contextMenu { Button("Dismiss", action: onDismiss) }
    }
}

private struct ArtifactPreview: View {
    let artifact: ReviewInfo
    let onOpen: () -> Void
    @State private var isHovering = false
    /// The picture, decoded off the main thread, under the key it was decoded for (`MaterialRow`'s way).
    @State private var decoded: (key: String, image: NSImage)?

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
            // The work itself, and as little else as possible. Tyler: "just
            // like an image or preview of the work with little or no text …
            // aspect ratio can change to fit deliverable better".
            //
            // What went: an uppercase "DELIVERABLE" eyebrow in the review
            // colour, the file path, an expand arrow, and a tinted ring around
            // the whole thing. None of that is in the lab — `.dc` is a plain
            // `inset 0 0 0 1px var(--hair2)` hairline holding a picture and one
            // line of words — and four labels around a thumbnail is the "random
            // card UI" this card already replaced once.
            //
            // Not the Deliverable pane's renderers: those are NSScrollViews,
            // and a scroller inside the conversation's scroller captures the
            // wheel. A bounded, clipped render of the head is enough to
            // recognise the thing; the gesture below still opens it whole.
            inlinePreview
            HStack(alignment: .center, spacing: 10) {
                if inlinePreviewKind == nil { thumbnail }
                // The summary is the one line of text that stays: without it a
                // picture of a website is a picture of a website, and the card
                // never says which one this session filed.
                Text(artifact.summary)
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.textDim)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isHovering ? ConchPalette.hover : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(ConchPalette.hairlineStrong, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help("Open the deliverable")
        .accessibilityLabel("Deliverable: \(artifact.summary)")
        .accessibilityHint("Opens it full size")
    }

    /// The type's mark, for a deliverable with no inline preview: a local picture
    /// always has one (`inlinePreview`), so this is never a picture.
    private var thumbnail: some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(ConchPalette.bg)
            .frame(width: 44, height: 44)
            .overlay(
                Image(systemName: symbol)
                    .font(.system(size: 15))
                    .foregroundStyle(ConchPalette.statusReview.opacity(0.85))
            )
    }

    private enum InlinePreviewKind { case image, document }

    /// Which inline render this artifact gets, or nil for icon-only. Only
    /// absolute local paths qualify — a relative link resolves against the
    /// app's cwd, not the session's, which is why the daemon now publishes
    /// them absolute.
    private var inlinePreviewKind: InlinePreviewKind? {
        guard let link = artifact.link, link.hasPrefix("/") else { return nil }
        switch (link as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic", "webp": return picture == nil ? nil : .image
        case "md", "markdown", "txt": return documentHead == nil ? nil : .document
        default: return nil
        }
    }

    @ViewBuilder
    private var inlinePreview: some View {
        switch inlinePreviewKind {
        case .image:
            if let picture {
                // The deliverable's OWN aspect ratio, not a letterboxed 260 pt
                // slot: a wide screenshot and a tall phone capture are
                // different shapes, and forcing both into one box wasted half
                // the card on empty space for one of them. Capped generously so
                // a very tall capture still cannot run away with the scroller.
                // The same size before and after the decode lands, so nothing moves.
                Group {
                    if let image = image(for: picture) {
                        Image(nsImage: image).resizable()
                    } else {
                        Color.clear
                    }
                }
                .aspectRatio(picture.aspect, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 420)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .task(id: picture.key) {
                    guard decoded?.key != picture.key else { return }
                    let size = Self.maxPixelSize
                    let image = await Task.detached(priority: .userInitiated) {
                        ConchImage.decode(picture, maxPixelSize: size)
                    }.value
                    guard !Task.isCancelled, let image else { return }
                    decoded = (picture.key, NSImage(cgImage: image, size: .zero))
                }
            }
        case .document:
            if let head = documentHead {
                // The same markdown path the replies use, so a deliverable
                // reads like the conversation it arrived in — and its
                // frontmatter is stripped, where before `type: document` and
                // both `---` fences filled the top third of the card. Clipped
                // at fourteen lines' worth, then faded, so the cut reads as
                // "there is more" rather than as the file ending mid-word.
                MarkdownView(text: head, size: 12.5)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .frame(maxWidth: .infinity, maxHeight: 14 * 19, alignment: .topLeading)
                    .clipped()
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

    /// The deliverable's picture, when its link is one on this Mac: named and shaped from its header, never decoded
    /// here (`ConchImage.picture`). This used to open the file as a new NSImage two or three times in every body — the
    /// whole file from disk, then decoded again, whole, on the main thread when SwiftUI drew it — and a body runs at
    /// every publish while the card is on screen, so each publish stalled a scrolling conversation by a decode.
    private var picture: ConchImage.Picture? {
        guard let link = artifact.link, link.hasPrefix("/"),
              ["png", "jpg", "jpeg", "gif", "heic", "webp"].contains((link as NSString).pathExtension.lowercased())
        else { return nil }
        return ConchImage.picture(atPath: link)
    }

    /// The card is at most 420 pt tall in a 700 pt column: 1,400 pixels on its longest side is 2x either way.
    private static let maxPixelSize = 1_400

    /// Decoded already, for this card or any other showing the same file: drawn at once. Else nothing yet.
    private func image(for picture: ConchImage.Picture) -> NSImage? {
        if let decoded, decoded.key == picture.key { return decoded.image }
        return ConchImage.decoded(picture, maxPixelSize: Self.maxPixelSize).map { NSImage(cgImage: $0, size: .zero) }
    }

    private var symbol: String {
        // The lab uses `star` for exactly one type — `none`, "No link" — and a
        // glyph for every real one. A star on every deliverable said "special"
        // where the type should have said "website" or "document".
        guard let link = artifact.link, !link.isEmpty else { return "questionmark.circle" }
        if link.hasPrefix("http") { return "globe" }
        if artifact.kind == "folder" { return "folder" }
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
