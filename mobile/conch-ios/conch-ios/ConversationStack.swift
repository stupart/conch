import SwiftUI

/// A session's conversation on the phone: your messages, replies and tool calls
/// in order, instead of one reply replaced every turn.
///
/// Lives inside SessionView's existing scroll view rather than owning one — the
/// screen already scrolls, already anchors to your live draft at the bottom, and
/// a scroll view inside a scroll view fights both.
struct ConversationStack: View {
    let conversation: Conversation
    let optionReplyInFlight: Bool
    let onSelectOption: (String) -> Void
    @State private var expandedToolIDs: Set<String> = []
    /// Multi-select taps edit a retained set. Nothing crosses the bridge until
    /// the explicit Submit button sends the complete, option-ordered answer.
    @State private var multiSelections: [String: Set<String>] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if conversation.truncated {
                Text("Earlier messages not shown")
                    .font(Type.caption)
                    .foregroundStyle(Palette.textFaint)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            ForEach(conversation.items) { item in
                row(item).id(item.id)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func row(_ item: ConversationItem) -> some View {
        switch item.kind {
        case "user":
            // Right-aligned and filled, matching the draft bubble below, so your
            // own words read the same whether they are sent or still being said.
            HStack {
                Spacer(minLength: 40)
                Text(inlineMarkdown(item.text))
                    .font(Type.body)
                    .foregroundStyle(Palette.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14))
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
                questionRow(
                    asked,
                    questionID: item.id,
                    isActive: item.tool?.status == "running"
                )
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
        default:
            MarkdownView(text: item.text)
                .foregroundStyle(Palette.textPrimary)
        }
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
            }
        }
    }

    private func statusColor(_ status: String?) -> Color {
        switch status {
        case "error": return Palette.needs
        case "done": return Palette.textFaint
        default: return Palette.working
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
                            .foregroundStyle(Palette.working)
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
                        diffLine(line, sign: "+", tint: Palette.working)
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

    /// The agent's question, drawn with the presence of the thing actually
    /// blocking the session — the same `needs` tint the ledger uses for
    /// "blocked on an answer" frames the question doing the blocking.
    ///
    private func questionRow(
        _ asked: ConversationItem.AgentQuestion,
        questionID: String,
        isActive: Bool
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
            ForEach(Array(asked.options.enumerated()), id: \.offset) { _, option in
                let selected = multiSelections[questionID]?.contains(option.label) == true
                Button {
                    if asked.multiSelect {
                        toggleSelection(option.label, for: questionID)
                    } else {
                        onSelectOption(option.label)
                    }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        // The mark's shape is how every form teaches pick-one
                        // versus pick-many — no caption spells it out.
                        Image(systemName: asked.multiSelect && selected ? "checkmark.square.fill" : (asked.multiSelect ? "square" : "circle"))
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
                        selected ? Palette.needs.opacity(0.10) : Palette.raised,
                        in: RoundedRectangle(cornerRadius: 12)
                    )
                }
                .buttonStyle(.plain)
                // The transcript keeps completed questions for context, but
                // their old choices must not inject a reply into a later turn.
                .disabled(!isActive || optionReplyInFlight || option.label.isEmpty)
                .accessibilityHint(
                    !isActive
                        ? "This question is no longer active"
                        : (asked.multiSelect
                            ? "Toggles this option; Submit sends all selected options"
                            : "Sends this option as your reply")
                )
            }

            if asked.multiSelect && isActive {
                let selected = selectedLabels(for: asked, questionID: questionID)
                Button {
                    onSelectOption(selected.joined(separator: ", "))
                } label: {
                    Text(selected.isEmpty ? "Submit selections" : "Submit \(selected.count) selected")
                        .font(Type.caption.weight(.semibold))
                        .foregroundStyle(selected.isEmpty ? Palette.textFaint : Palette.bg)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(
                            selected.isEmpty ? Palette.raised : Palette.needs,
                            in: RoundedRectangle(cornerRadius: 12)
                        )
                }
                .buttonStyle(.plain)
                .disabled(selected.isEmpty || optionReplyInFlight)
                .accessibilityHint("Sends all selected options as your reply")
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
        case .running: return Palette.working
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
