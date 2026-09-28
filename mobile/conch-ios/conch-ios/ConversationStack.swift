import ConchDesign
import SwiftUI

/// A session's conversation on the phone: your messages, replies and tool calls
/// in order, instead of one reply replaced every turn.
///
/// Lives inside SessionView's existing scroll view rather than owning one — the
/// screen already scrolls, already anchors to your live draft at the bottom, and
/// a scroll view inside a scroll view fights both.
struct ConversationStack: View {
    @ObservedObject var bridge: BridgeClient
    /// Everything older than the live window, and the whole text behind anything it cut.
    @ObservedObject var history: HistoryStore
    let conversation: Conversation
    let optionReplyInFlight: Bool
    /// A readable summary, one answer per question in order, and the question row's id. The
    /// answers are what the daemon types into the agent's picker: an option's LABEL sent as
    /// text records option 1 there, whatever it says. The summary is only what the send is
    /// called; the id is checked against the live conversation before anything goes.
    let onAnswer: (String, [QuestionAnswer], String) -> Void
    /// What was sent from a question card and not refused, by the question row it answers: the
    /// card shows "Submitted" until the row closes, as Tyler asked ("when submitted the state of
    /// the question ui … should change").
    var submittedAnswers: [String: String] = [:]
    /// Take me to the text field — I want to answer in my own words.
    ///
    /// Claude Code's own question UI always offers an "Other" row and conch
    /// showed only the listed options, so the way out of a question was to know
    /// the composer already worked. Tyler: "it was missing the 4th option where
    /// i coudl just write something". This points at the composer rather than
    /// growing a second text field inside the question.
    var onFreeform: () -> Void = {}
    /// Why conch cannot type into this session (a closed or app-server Codex
    /// thread, a background job with no window). Answering a question IS
    /// typing, so its buttons go dead and say why instead of failing on tap.
    var noTerminal: String? = nil
    /// Offered beside that reason when a window can be attached to the job.
    var onOpenInTerminal: (() -> Void)? = nil
    /// Why a send didn't land while a question card was the live one, by that card: the card is
    /// where it gets fixed, whether the card sent it or the composer did.
    var questionNotices: [String: String] = [:]
    @State private var expandedToolIDs: Set<String> = []
    /// Which folded runs are open. Its own set, not `expandedToolIDs`: a run is named by its
    /// first step, and sharing the set would open that step's output every time the run opens.
    @State private var openRunIDs: Set<String> = []
    /// Multi-select taps edit a retained set. Nothing crosses the bridge until
    /// the explicit Submit button sends the complete, option-ordered answer.
    @State private var multiSelections: [String: Set<String>] = [:]
    /// Words typed on a question card — one question of several, or a multi-select one — keyed
    /// like `multiSelections`.
    @State private var questionTexts: [String: String] = [:]
    /// A link that could not be opened from the phone, shown where it was
    /// tapped instead of a tap that does nothing (A13).
    @State private var linkFailure: String?
    /// A tapped link that turned out to be a Mac file, opened the way any
    /// other deliverable is.
    @State private var openFile: FileLink?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            // What the record store holds above the live window: a recorded message is still a
            // message, so it goes through the same row renderers. Windowed like the Mac's — the
            // rows near the viewport are views, the rest their heights — and read further back as
            // the reader scrolls up, with no button; its first row is the line saying where it
            // starts. The phone's old stopping point, a thousand rows, is gone with the button.
            // ponytail: folds are computed per list, so a run straddling the history/live
            // seam draws as two folds — the Mac's trade too: they are two layouts.
            let recorded = recordedEntries
            let liveFolds = folds(in: conversation.items)
            HistoryRegion(
                model: history.region,
                edge: historyEdge,
                note: conversation.shared ? "Shared with another window — both windows' messages are shown" : nil,
                entries: recorded,
                gap: 14,
                edgeFont: Type.caption
            ) { row in
                recordedRow(row)
            }
            ForEach(conversation.items) { item in
                foldedRow(for: item, in: conversation.items, folds: liveFolds).id(item.id)
            }
            LinkFailureLine(message: $linkFailure)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // A command, a path or a paragraph can be copied out of the transcript:
        // on a phone there is no other way to get it into another app.
        .textSelection(.enabled)
        // A currently published Mac file opens as a deliverable; anything
        // else says why it didn't, where the tap happened, and records it
        // (A13). The phone's one door decides, opens and reports.
        .environment(\.openURL, OpenURLAction { url in
            linkFailure = nil
            bridge.openLink(url, sessionId: conversation.sessionId, onFile: { openFile = FileLink(id: $0) }) { linkFailure = $0 }
            return .handled
        })
        .sheet(item: $openFile) { file in
            FileLinkSheet(bridge: bridge, path: file.id, sessionId: conversation.sessionId)
        }
        .onChange(of: conversation.sessionId) { _, _ in
            linkFailure = nil
            openFile = nil
            multiSelections = [:]
            questionTexts = [:]
        }
        // A long message the daemon cut to its tail is read whole as it arrives, rather than
        // behind "Show the rest".
        .onChange(of: cutLive, initial: true) { _, rows in
            history.wantWhole(rows.map { ($0.id, $0.text) })
        }
    }

    /// What the top of the recorded history says: nothing while more is coming, a spinner once
    /// a read is actually slow, "Start of the conversation" at the true start, and the plain
    /// sentence where history genuinely is not there (`HistoryEdge`, the Mac's rule). No button:
    /// scrolling up reads further back, and a failed read tries again on its own.
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

    /// The recorded rows that belong above the live window, as the region lays them out: an id
    /// and an estimate each, and the row itself built only when it is near the viewport.
    private var recordedEntries: [HistoryEntry<RecordedRow>] {
        // Undecorated, because the snapshot and the record name the same message
        // differently: `tool:call_7` here is `call_7` there.
        let live = Set(conversation.items.map { HistorySnapshot.nativeId(forSnapshotItem: $0.id) })
        let rows = HistorySnapshot.older(
            rows: history.paging.rows,
            thanSnapshot: live,
            startingAt: conversation.items.first?.at
        )
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
        let estimate = HistoryEstimate.phone
        let width = history.region.width > 0 ? history.region.width : 350
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

    private static func isToolStep(_ item: HistoryItem) -> Bool {
        item.kind == "tool_call" || item.kind == "tool_result"
    }

    @ViewBuilder
    private func recordedRow(_ recorded: RecordedRow) -> some View {
        if let run = recorded.run {
            runView(run, steps: recorded.steps.compactMap(conversationItem(recorded:)))
        } else if let item = conversationItem(recorded: recorded.item) {
            row(item)
        }
    }

    /// A recorded item as a row: its whole body once read — as it comes near the viewport — and
    /// its preview until then, marked as cut where there is more.
    private func conversationItem(recorded: HistoryItem) -> ConversationItem? {
        let body = history.body(for: recorded.id)
        let whole = body?.isComplete == true ? body?.text : nil
        return ConversationItem(recorded: recorded, text: whole ?? (recorded.hasFullBody ? recorded.preview + "…" : recorded.preview))
    }

    /// Ask for the page before the oldest row held. The region asks as the reader scrolls up;
    /// `HistoryStore.follow` asks once on arrival.
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
            .filter { ($0.kind == "assistant" || $0.kind == "user") && $0.text.hasPrefix("…") }
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

    /// How a body read is going, under the tool output waiting for it.
    @ViewBuilder
    private func fullBodyStatus(for item: ConversationItem) -> some View {
        let native = HistorySnapshot.nativeId(forSnapshotItem: item.id)
        let recorded = history.paging.items.first { $0.nativeId == native }
        switch recorded.flatMap({ history.body(for: $0.id) })?.status {
        case .some(.loading):
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Loading the rest…")
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
            }
        case let .some(.failed(message)):
            VStack(alignment: .leading, spacing: 4) {
                Text(message)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
                Button("Retry") { history.loadFullBodies(forSnapshotItems: [item.id]) }
                    .font(Type.caption.weight(.semibold))
                    .foregroundStyle(Palette.micOpen)
                    .buttonStyle(.plain)
            }
        default:
            EmptyView()
        }
    }

    /// The daemon's own caps, as `publishedConversation` applies them.
    private static let messageCap = 4_000
    private static let toolResultCap = 400

    /// Which rows fold (ConchDesign/ToolFolding): the generic tool line and a file change,
    /// the same rule as the Mac's transcript. Never a question — the session is blocked on
    /// it, and a phone is where that question is most often answered — and never a plan,
    /// which is the answer to "what is it doing".
    private func foldable(_ item: ConversationItem) -> Bool {
        guard item.kind == "tool" else { return false }
        if let asked = item.question, !asked.options.isEmpty { return false }
        if let plan = item.plan, !plan.isEmpty { return false }
        return true
    }

    private struct FoldIndex {
        var heads: [String: ToolRun] = [:]
        /// Every step after the first, pointing at the run that draws it.
        var memberOf: [String: String] = [:]
    }

    /// `at` goes in as the wire sends it (epoch milliseconds); the rule owns the units.
    private func folds(in items: [ConversationItem]) -> FoldIndex {
        var index = FoldIndex()
        for run in ToolFolding.runs(for: items.map { (id: $0.id, isTool: foldable($0), at: $0.at) }) {
            index.heads[run.id] = run
            for member in run.itemIDs.dropFirst() { index.memberOf[member] = run.id }
        }
        return index
    }

    /// One row, or the whole run it starts. A step that is not the first draws nothing: its
    /// run draws it, so six file reads between two sentences cost one line, not six — and
    /// on a phone six lines is the whole screen.
    @ViewBuilder
    private func foldedRow(for item: ConversationItem, in items: [ConversationItem], folds: FoldIndex) -> some View {
        if let run = folds.heads[item.id] {
            let members = Set(run.itemIDs)
            runView(run, steps: items.filter { members.contains($0.id) })
        } else if folds.memberOf[item.id] != nil {
            EmptyView()
        } else {
            row(item)
        }
    }

    /// A run of steps as one line, and the steps themselves once it is opened.
    private func runView(_ run: ToolRun, steps: [ConversationItem]) -> some View {
        let open = openRunIDs.contains(run.id)
        return VStack(alignment: .leading, spacing: 8) {
            Button {
                if open { openRunIDs.remove(run.id) } else { openRunIDs.insert(run.id) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(Type.caption.weight(.semibold))
                        .foregroundStyle(Palette.textFaint)
                        .frame(width: 16)
                    Text(run.summary)
                        .font(Type.caption.weight(.medium))
                        .foregroundStyle(Palette.textDim)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Hides these steps" : "Shows these steps")
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(steps) { step in
                        row(step)
                    }
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Palette.divider).frame(width: 1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func row(_ item: ConversationItem) -> some View {
        switch item.kind {
        case "user":
            if let receipt = item.receipt {
                // A canvas, a Show or a video he sent: one quiet row in his bubble, never the whole picture nor the
                // lines written for the agent. A tap opens the picture full screen, as any Mac file opens here.
                SentReceiptBubble(bridge: bridge, receipt: receipt, sessionId: conversation.sessionId) {
                    openFile = FileLink(id: $0)
                }
            } else {
                // Right-aligned and filled, matching the draft bubble below, so your
                // own words read the same whether they are sent or still being said.
                HStack {
                    Spacer(minLength: 40)
                    // Whole: a long paste the daemon cut to its tail is read back from the record.
                    Text(inlineMarkdown(text(of: item)))
                        .font(Type.body)
                        .foregroundStyle(Palette.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        case "thinking":
            Text(item.text)
                .font(Type.caption.italic())
                .foregroundStyle(Palette.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
        case "tool":
            // A question outranks every other shape a tool row can take: the
            // rest of the stack reports what already happened, this one is
            // blocked on a person. It must never look like something to skim.
            if let asked = item.question, !asked.options.isEmpty {
                let questions = item.allQuestions
                // Once answered it collapses to one line naming what was decided
                // (ConchDesign/QuestionOutcome, the Mac's rule). Only a FINISHED
                // call, and only when its result names an option: the wire never
                // states a choice, and guessing at a person's decision is worse
                // than leaving the block as it was.
                //
                // Only the live card is a form (`liveQuestionID`). One Tyler has talked past is
                // still "running" on disk, and it stayed pressable for an answer the Mac refused.
                let live = item.id == liveQuestionID
                if !live, let decided = answeredSummary(questions, result: item.tool?.result) {
                    answeredQuestionRow(decided)
                } else if live, let sent = submittedAnswers[item.id] {
                    submittedQuestionRow(sent)
                } else {
                    questionCard(
                        questions,
                        itemID: item.id,
                        isActive: live,
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
            else if let plan = item.plan, !plan.isEmpty {
                planRow(plan)
            } else if let change = item.change {
                changeRow(item, change)
            } else {
                toolRow(item)
            }
        case "material":
            MaterialRow(bridge: bridge, material: item.material, fallback: item.text, sessionId: conversation.sessionId)
        default:
            // Whole, always: a reply the daemon cut, or a recorded one past its preview, is read
            // from the record as it arrives or comes near the viewport. "Show the rest" is gone.
            MarkdownView(text: text(of: item))
                .foregroundStyle(Palette.textPrimary)
        }
    }

    private func toolRow(_ item: ConversationItem) -> some View {
        let expanded = expandedToolIDs.contains(item.id)
        // The record store's whole output once it has been read; until then the
        // snapshot's first 400 characters of it.
        let result = history.fullText(forSnapshotItem: item.id) ?? item.tool?.result ?? ""
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                guard !result.isEmpty else { return }
                if expanded {
                    expandedToolIDs.remove(item.id)
                } else {
                    expandedToolIDs.insert(item.id)
                    loadFullBody(of: item)
                }
            } label: {
                HStack(spacing: 8) {
                    // The dot carried status; the glyph carries what KIND of
                    // work this was. A stripe of identical dots left an edit
                    // indistinguishable from a shell command without reading
                    // every line.
                    Image(systemName: (item.tool?.kind ?? .unknown).symbol)
                        .font(Type.caption)
                        .foregroundStyle(statusColor(item.tool?.status))
                        .frame(width: 16)
                    Text(item.tool?.name ?? "tool")
                        .font(Type.mono)
                        .foregroundStyle(Palette.textDim)
                    if !item.text.isEmpty {
                        Text(item.text)
                            .font(Type.mono)
                            .foregroundStyle(Palette.textFaint)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            // Output is most of a transcript by volume and rarely what you came
            // for — especially on a phone, where it would bury the reply.
            if expanded, !result.isEmpty {
                Text(result)
                    .font(Type.mono)
                    .foregroundStyle(Palette.textDim)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 10))
                fullBodyStatus(for: item)
            }
        }
    }

    private func statusColor(_ status: String?) -> Color {
        switch status {
        case "error": return Palette.needs
        case "done": return Palette.textFaint
        default: return Palette.calm
        }
    }

    /// A file change, as a count you can scan and lines you can open. The
    /// collapsed line answers "what happened to that file" without a tap;
    /// reading the lines is a different activity from scanning for them, so
    /// they stay behind the same tap the other tool rows use.
    private func changeRow(_ item: ConversationItem, _ change: ConversationItem.FileChange) -> some View {
        let expanded = expandedToolIDs.contains(item.id)
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                if expanded { expandedToolIDs.remove(item.id) } else { expandedToolIDs.insert(item.id) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: ConversationItem.Tool.Kind.fileChange.symbol)
                        .font(Type.caption)
                        .foregroundStyle(statusColor(item.tool?.status))
                        .frame(width: 16)
                    Text(change.file)
                        .font(Type.mono)
                        .foregroundStyle(Palette.textDim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !change.added.isEmpty {
                        Text("+\(change.added.count)")
                            .font(Type.mono)
                            .foregroundStyle(Palette.calm)
                    }
                    if !change.removed.isEmpty {
                        Text("−\(change.removed.count)")
                            .font(Type.mono)
                            .foregroundStyle(Palette.needs)
                    }
                    // The counts stop at the daemon's cap, so without this a
                    // capped refactor would scan as a complete small edit.
                    if change.truncated {
                        Text("…")
                            .font(Type.mono)
                            .foregroundStyle(Palette.textFaint)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(change.removed.enumerated()), id: \.offset) { _, line in
                        diffLine(line, sign: "−", tint: Palette.needs)
                    }
                    ForEach(Array(change.added.enumerated()), id: \.offset) { _, line in
                        diffLine(line, sign: "+", tint: Palette.calm)
                    }
                    if change.truncated {
                        Text("… longer than this view shows")
                            .font(Type.caption)
                            .foregroundStyle(Palette.textFaint)
                            .padding(.top, 2)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    /// Added lines tint `working`, not the Mac's brand cyan: this palette
    /// reserves full cyan for the open mic (see stepColor), and the calm
    /// machine-busy teal is the honest colour for work the agent did.
    private func diffLine(_ text: String, sign: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(sign)
                .font(Type.mono)
                .foregroundStyle(tint)
            // A blank line keeps its height, or a whitespace-only edit
            // collapses into nothing and looks like a decode failure.
            Text(text.isEmpty ? " " : text)
                .font(Type.mono)
                .foregroundStyle(Palette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    /// The question card that can still be answered (`QuestionOutcome.liveQuestionID`): the
    /// newest running question with nothing said after it — the Mac's rule, and the daemon's.
    /// Every other card is settled (answered, expired, or talked past) and drawn as a record.
    private var liveQuestionID: String? {
        Self.liveQuestionID(in: conversation)
    }

    static func liveQuestionID(in conversation: Conversation) -> String? {
        QuestionOutcome.liveQuestionID(
            in: conversation.items,
            id: \.id,
            isUser: { $0.kind == "user" },
            isRunningQuestion: { $0.question != nil && $0.tool?.status == "running" }
        )
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

    /// The agent's question, drawn with the presence of the thing actually
    /// blocking the session — the same `needs` tint the ledger uses for
    /// "blocked on an answer" frames the question doing the blocking.
    ///
    /// One question as it always was; or, when the agent asked several at once, each one to
    /// fill in and ONE Submit that sends every answer in order — the Mac's card (#367).
    /// Claude Code records nothing until all of them are answered, and the phone used to know
    /// only the first. `chosen`: on a settled card, what each question's recorded answer names.
    @ViewBuilder
    private func questionCard(
        _ questions: [ConversationItem.AgentQuestion],
        itemID: String,
        isActive: Bool,
        chosen: [[String]] = []
    ) -> some View {
        let inSet = questions.count > 1
        VStack(alignment: .leading, spacing: 10) {
            // Why the last send here didn't land — from this card or the composer — on the card
            // that is still waiting for the answer.
            if isActive, let notice = questionNotices[itemID] {
                Text(notice)
                    .font(Type.caption.weight(.medium))
                    .foregroundStyle(Palette.needs)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(questions.enumerated()), id: \.offset) { index, asked in
                if index > 0 {
                    Rectangle().fill(Palette.divider).frame(height: 1).padding(.vertical, 4)
                }
                questionRow(
                    asked,
                    questionID: inSet ? "\(itemID)#\(index)" : itemID,
                    isActive: isActive,
                    inSet: inSet,
                    chosen: index < chosen.count ? chosen[index] : []
                )
            }
            if inSet, isActive {
                if noTerminal != nil { noTerminalReason }
                let filled = setAnswers(questions, itemID: itemID)
                Button {
                    if let filled { onAnswer(filled.summary, filled.answers, itemID) }
                } label: {
                    Text(filled == nil ? "Answer all \(questions.count) to submit" : "Submit answers")
                        .font(Type.caption.weight(.semibold))
                        .foregroundStyle(filled == nil ? Palette.textFaint : Palette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            filled == nil ? Palette.raised : Palette.needs,
                            in: RoundedRectangle(cornerRadius: 12)
                        )
                }
                .buttonStyle(.plain)
                .disabled(filled == nil || optionReplyInFlight || noTerminal != nil)
                .accessibilityHint("Sends every answer to the session, in order")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            (isActive ? Palette.needs : Palette.textFaint).opacity(isActive ? 0.07 : 0.035),
            in: RoundedRectangle(cornerRadius: 14)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder((isActive ? Palette.needs : Palette.textFaint).opacity(0.35))
        )
    }

    /// `inSet`: one of several questions asked at once. Its picks are held for the card's one
    /// Submit instead of sent. "Something else…" is typed here, in the card, for one of several
    /// and for a multi-select question (a form with its own Submit, where the words go beside the
    /// ticked options as Claude Code's picker records them); a lone single-choice question sends
    /// on a tap, so its words go through the composer.
    private func questionRow(
        _ asked: ConversationItem.AgentQuestion,
        questionID: String,
        isActive: Bool,
        inSet: Bool,
        chosen: [String] = []
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !asked.header.isEmpty {
                Text(asked.header)
                    .font(Type.caption.weight(.semibold))
                    .foregroundStyle(Palette.needs)
            }
            Text(inlineMarkdown(asked.question))
                .font(Type.body)
                .foregroundStyle(Palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(asked.options.enumerated()), id: \.offset) { index, option in
                if isActive {
                    let selected = multiSelections[questionID]?.contains(option.label) == true
                    Button {
                        if asked.multiSelect {
                            toggleSelection(option.label, for: questionID)
                        } else if inSet {
                            multiSelections[questionID] = [option.label]
                            questionTexts[questionID] = nil
                        } else {
                            onAnswer(option.label, [QuestionAnswer(choices: [index])], questionID)
                        }
                    } label: {
                        optionLabel(option, multiSelect: asked.multiSelect, selected: selected, live: true)
                    }
                    .buttonStyle(.plain)
                    .disabled(optionReplyInFlight || option.label.isEmpty || noTerminal != nil)
                    .accessibilityHint(
                        asked.multiSelect
                            ? "Toggles this option; Submit sends all selected options"
                            : (inSet
                                ? "Chooses this option; Submit answers sends every answer"
                                : "Sends this option as your reply")
                    )
                } else {
                    // Settled — answered, expired, or talked past. The transcript keeps it for
                    // context, as a record rather than controls: no press, no highlight, nothing
                    // to focus, so an old choice can never inject a reply into a later turn. What
                    // was chosen stays marked; the rest recede.
                    let picked = chosen.contains(option.label)
                    optionLabel(option, multiSelect: asked.multiSelect, selected: picked, live: false)
                        .opacity(picked ? 1 : 0.45)
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(picked ? .isSelected : [])
                        .accessibilityHint("This question is no longer active")
                }
            }

            if isActive, !inSet, noTerminal != nil { noTerminalReason }

            if isActive && (inSet || asked.multiSelect) {
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
                .font(Type.body)
                .foregroundStyle(Palette.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(
                            Palette.textDim.opacity(0.22),
                            style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                        )
                )
                .disabled(optionReplyInFlight || noTerminal != nil)
            } else if isActive && !inSet {
                Button(action: onFreeform) {
                    HStack(spacing: 10) {
                        // A pencil, not a circle: this is not a fourth choice,
                        // it is the way out of choosing.
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 11))
                            .foregroundStyle(Palette.textDim)
                        Text("Something else…")
                            .font(Type.caption.weight(.medium))
                            .foregroundStyle(Palette.textDim)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .strokeBorder(
                                Palette.textDim.opacity(0.22),
                                style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                            )
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(noTerminal != nil)
                .accessibilityHint("Moves to the message field so you can answer in your own words")
            }

            if asked.multiSelect && isActive && !inSet {
                let filled = multiAnswer(asked, questionID: questionID)
                Button {
                    if let filled { onAnswer(filled.summary, [filled.answer], questionID) }
                } label: {
                    Text(filled?.label ?? "Submit selections")
                        .font(Type.caption.weight(.semibold))
                        .foregroundStyle(filled == nil ? Palette.textFaint : Palette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            filled == nil ? Palette.raised : Palette.needs,
                            in: RoundedRectangle(cornerRadius: 12)
                        )
                }
                .buttonStyle(.plain)
                .disabled(filled == nil || optionReplyInFlight || noTerminal != nil)
                .accessibilityHint("Sends the selected options and any words of your own as your reply")
            }
        }
    }

    /// One option's row. Live, it sits on a raised ground that reads as pressable; settled, it
    /// has no ground at all, and only what was chosen is marked, with a check.
    private func optionLabel(
        _ option: ConversationItem.AgentQuestion.Option,
        multiSelect: Bool,
        selected: Bool,
        live: Bool
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // The mark's shape is how every form teaches pick-one
            // versus pick-many — no caption spells it out.
            Image(systemName: multiSelect
                ? (selected ? "checkmark.square.fill" : "square")
                : (selected ? (live ? "largecircle.fill.circle" : "checkmark.circle.fill") : "circle"))
                .font(Type.caption)
                .foregroundStyle(selected ? Palette.needs : Palette.textDim)
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(Type.body.weight(.medium))
                    .foregroundStyle(Palette.textPrimary)
                if let description = option.description, !description.isEmpty {
                    Text(description)
                        .font(Type.caption)
                        .foregroundStyle(Palette.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            selected ? Palette.needs.opacity(0.10) : (live ? Palette.raised : Color.clear),
            in: RoundedRectangle(cornerRadius: 12)
        )
    }

    /// A lone multi-select question's answer: the ticked options and any words of your own, as
    /// one answer (Claude Code records them together: "G1, G3, my words"); nil with neither.
    private func multiAnswer(
        _ asked: ConversationItem.AgentQuestion,
        questionID: String
    ) -> (answer: QuestionAnswer, summary: String, label: String)? {
        let selected = selectedLabels(for: asked, questionID: questionID)
        let picked = asked.options.indices.filter { selected.contains(asked.options[$0].label) }
        let typed = (questionTexts[questionID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !picked.isEmpty || !typed.isEmpty else { return nil }
        return (
            QuestionAnswer(choices: picked.isEmpty ? nil : picked, text: typed.isEmpty ? nil : typed),
            (selected + (typed.isEmpty ? [] : [typed])).joined(separator: ", "),
            typed.isEmpty ? "Submit \(picked.count) selected" : "Submit answer"
        )
    }

    /// Why nothing on this card can be pressed: answering IS typing, and this row has no
    /// terminal to type into. With "Open in Terminal" when a window can be attached.
    @ViewBuilder
    private var noTerminalReason: some View {
        if let noTerminal {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(noTerminal)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let onOpenInTerminal {
                    Button(action: onOpenInTerminal) {
                        Label("Open in Terminal", systemImage: "terminal")
                            .font(Type.caption)
                            .foregroundStyle(Palette.textPrimary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this session in a Terminal window on your Mac")
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
    ) -> (answers: [QuestionAnswer], summary: String)? {
        var answers: [QuestionAnswer] = []
        var lines: [String] = []
        for (index, asked) in questions.enumerated() {
            let id = "\(itemID)#\(index)"
            let typed = (questionTexts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let picked = asked.options.indices.filter { multiSelections[id]?.contains(asked.options[$0].label) == true }
            if asked.multiSelect, !picked.isEmpty, !typed.isEmpty {
                // Ticks and words together, as Claude Code's picker records them: "G1, G3, my words".
                answers.append(QuestionAnswer(choices: picked, text: typed))
                lines.append((picked.map { asked.options[$0].label } + [typed]).joined(separator: ", "))
            } else if !typed.isEmpty {
                answers.append(QuestionAnswer(text: typed))
                lines.append(typed)
            } else if !picked.isEmpty {
                answers.append(QuestionAnswer(choices: picked))
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

    /// The collapsed question: one quiet line saying what was decided. It replaces a
    /// header, the question and every option greyed out — the tallest thing in a finished
    /// transcript, saying the least, and on a phone it was a screen of it. Not a button:
    /// there is nothing left to do to it, and the exchange that produced it is right above.
    /// Sent, and waiting for the session to record it; the row then collapses to what was decided.
    private func submittedQuestionRow(_ summary: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "paperplane")
                .font(Type.caption)
                .foregroundStyle(Palette.textFaint)
                .frame(width: 16)
            Text("Submitted · \(summary)")
                .font(Type.caption.weight(.medium))
                .foregroundStyle(Palette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func answeredQuestionRow(_ decided: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(Type.caption)
                .foregroundStyle(Palette.textFaint)
                .frame(width: 16)
            Text(decided)
                .font(Type.caption.weight(.medium))
                .foregroundStyle(Palette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

    /// A plan, as a checklist. Done steps recede — struck through and faint —
    /// so the eye lands on the one happening now, not the pile already behind.
    private func planRow(_ steps: [ConversationItem.PlanStep]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: stepSymbol(step.status))
                        .font(Type.caption)
                        .foregroundStyle(stepColor(step.status))
                        .frame(width: 16)
                    Text(step.text)
                        .font(Type.caption)
                        .foregroundStyle(step.status == .done ? Palette.textFaint : Palette.textDim)
                        .strikethrough(step.status == .done, color: Palette.textFaint)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func stepSymbol(_ status: ConversationItem.PlanStep.Status) -> String {
        switch status {
        case .done: return "checkmark.circle.fill"
        case .running: return "circle.dotted"
        case .pending: return "circle"
        }
    }

    /// Running is the only coloured step: this palette reserves full brand
    /// cyan for the open mic, so done marks cannot borrow it the way the Mac's
    /// do — the checkmark and strikethrough already say finished.
    private func stepColor(_ status: ConversationItem.PlanStep.Status) -> Color {
        switch status {
        case .done: return Palette.textDim
        case .running: return Palette.calm
        case .pending: return Palette.textFaint
        }
    }

    /// Inline emphasis only, newlines kept — dictated text has no block
    /// structure to lose, and MarkdownView claims full width, which would
    /// stretch a one-word bubble across the screen. Assistant text already
    /// flows through MarkdownView, whose block parser renders headings as
    /// headings — the phone's answer to the Mac's promote-to-bold pre-pass.
    private func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}

/// Something Tyler sent through conch, as his own row: `SentReceiptRow` in the bubble his words use here, its picture
/// fetched from the Mac and decoded thumbnail-small. A tap hands the picture's path to the sheet any Mac file opens in.
private struct SentReceiptBubble: View {
    @ObservedObject var bridge: BridgeClient
    let receipt: ConchSentReceipt
    /// The session it belongs to; what a failed load is filed under.
    let sessionId: String
    let onOpen: (String) -> Void
    @State private var thumbnail: UIImage?

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            SentReceiptRow(
                receipt: receipt,
                thumbnail: thumbnail.map { Image(uiImage: $0) },
                fill: ConchColor.surfaceRaised,
                radius: 14
            ) {
                if let thumb = receipt.thumb { onOpen(thumb) }
            }
        }
        .task(id: receipt.thumb) { await loadThumbnail() }
    }

    /// Fetched, read small, and the download let go: the row keeps only the thumbnail. A picture that won't come says
    /// so in the Mac's error log (A13) and the row keeps its glyph.
    @MainActor
    private func loadThumbnail() async {
        thumbnail = nil
        guard let path = receipt.thumb else { return }
        guard let url = await bridge.downloadFile(path: path) else {
            let message = "Couldn't load the picture from your Mac: \(bridge.lastError ?? "it sent nothing back.") — \(path)"
            await bridge.reportAppError(operation: "load-image", message: message, sessionId: sessionId)
            return
        }
        defer { try? FileManager.default.removeItem(at: url) }
        let side = Int(4 * max(SentReceiptRow.thumbnailSize.width, SentReceiptRow.thumbnailSize.height))
        let preview = await ImageDownsampler.filePreview(at: url, maxBytes: 32 * 1024 * 1024, maxPixelSize: side)
        guard !Task.isCancelled else { return }
        if case let .image(decoded) = preview { thumbnail = UIImage(cgImage: decoded) }
    }
}

private struct MaterialRow: View {
    @ObservedObject var bridge: BridgeClient
    let material: ConversationItem.Material?
    let fallback: String
    /// The session it belongs to; what a failed load is filed under.
    let sessionId: String
    @State private var image: UIImage?
    @State private var temporaryURL: URL?
    /// Why the image would not load, said on the row instead of nothing (A13).
    @State private var failure: String?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Palette.divider, lineWidth: 0.5)
                    }
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: symbol)
                        .font(Type.caption)
                        .foregroundStyle(tint)
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(material?.title ?? "Material")
                            .font(Type.caption.weight(.medium))
                            .foregroundStyle(Palette.textDim)
                        if let failure {
                            Text(failure)
                                .font(Type.caption)
                                .foregroundStyle(Palette.needs)
                                .textSelection(.enabled)
                        } else if !detail.isEmpty {
                            Text(detail)
                                .font(Type.caption)
                                .foregroundStyle(Palette.textFaint)
                                .lineLimit(3)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Palette.raised.opacity(0.58), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .task(id: sourceID) { await loadImage() }
        .onDisappear { removeTemporaryFile() }
    }

    private var sourceID: String { material?.path ?? material?.dataUrl ?? "" }

    /// Decoded at the size it is drawn, never larger: the row is at most 320 pt tall across a
    /// phone's width, so its longest side needs no more than a 430 pt screen at 3x. At 2,048 a
    /// screenshot held twice the pixels anyone could see, for as long as the row was built.
    nonisolated private static let maxPixelSize = 1_300
    private var detail: String { material?.detail ?? fallback }

    private var symbol: String {
        switch material?.kind {
        case "image": return "photo"
        case "document": return "doc"
        case "system_note": return "info.circle"
        case "interruption": return "stop.circle"
        case "command_output": return "terminal"
        case "task": return "shippingbox"
        default: return "square.stack"
        }
    }

    private var tint: Color {
        material?.status == "error" ? Palette.needs : Palette.textFaint
    }

    @MainActor
    private func loadImage() async {
        removeTemporaryFile()
        image = nil
        failure = nil
        guard material?.kind == "image" else { return }

        if let path = material?.path {
            let downloaded = await bridge.downloadFile(path: path)
            guard !Task.isCancelled else {
                if let downloaded { try? FileManager.default.removeItem(at: downloaded) }
                return
            }
            // The bridge's own reason, read on the main actor straight after
            // the call that set it, as the deliverable sheet does.
            guard let url = downloaded else {
                fail("Couldn't load the image from your Mac: \(bridge.lastError ?? "it sent nothing back.")", path: path)
                return
            }
            temporaryURL = url
            let preview = await ImageDownsampler.filePreview(
                at: url,
                maxBytes: 32 * 1024 * 1024,
                maxPixelSize: Self.maxPixelSize
            )
            guard !Task.isCancelled else { return }
            if case let .image(decoded) = preview { image = UIImage(cgImage: decoded) }
            return
        }

        guard let dataUrl = material?.dataUrl,
              let comma = dataUrl.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])),
              data.count <= 512 * 1024
        else { return }
        let preview = await Task.detached(priority: .userInitiated) {
            guard let source = ImageDownsampler.source(data: data),
                  let decoded = ImageDownsampler.thumbnail(source: source, maxPixelSize: Self.maxPixelSize)
            else { return ImageDownsampler.FilePreview.unreadable }
            return ImageDownsampler.FilePreview.image(decoded)
        }.value
        guard !Task.isCancelled else { return }
        if case let .image(decoded) = preview { image = UIImage(cgImage: decoded) }
    }

    /// Said on the row with the path on the Mac, and filed there as
    /// `load-image` (A13): a failed download used to leave only the title.
    @MainActor
    private func fail(_ reason: String, path: String) {
        let message = "\(reason) — \(path)"
        failure = message
        Task { await bridge.reportAppError(operation: "load-image", message: message, sessionId: sessionId) }
    }

    @MainActor
    private func removeTemporaryFile() {
        if let temporaryURL { try? FileManager.default.removeItem(at: temporaryURL) }
        temporaryURL = nil
    }
}
