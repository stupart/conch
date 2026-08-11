import SwiftUI

/// A session's conversation on the phone: your messages, replies and tool calls
/// in order, instead of one reply replaced every turn.
///
/// Lives inside SessionView's existing scroll view rather than owning one — the
/// screen already scrolls, already anchors to your live draft at the bottom, and
/// a scroll view inside a scroll view fights both.
struct ConversationStack: View {
    let conversation: Conversation
    @State private var expandedToolIDs: Set<String> = []

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
            // A plan is not a tool call you might expand — it is the answer to
            // "what is it doing", so it renders as itself rather than as a
            // collapsed row you would have to think to open.
            if let plan = item.plan, !plan.isEmpty {
                planRow(plan)
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
