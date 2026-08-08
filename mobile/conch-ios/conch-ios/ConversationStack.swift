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
                Text(item.text)
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
            toolRow(item)
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
                    Circle()
                        .fill(statusColor(item.tool?.status))
                        .frame(width: 6, height: 6)
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
}
