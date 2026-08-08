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
    /// Sticks to the bottom only when already there, so reading history is not
    /// yanked away by an arriving message.
    @State private var pinnedToBottom = true
    @State private var expandedToolIDs: Set<String> = []

    private static let bottomAnchor = "conversation-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
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
            }
            .background(ConchPalette.bg)
            .onChange(of: conversation.items.last?.rev) { _, _ in
                guard pinnedToBottom else { return }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                }
            }
            .onChange(of: conversation.sessionId) { _, _ in
                // A different session is a different conversation: start at its
                // end, and re-arm the follow.
                pinnedToBottom = true
                expandedToolIDs = []
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
            .onAppear { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
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
                Text(item.text)
                    .font(.system(size: 13))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(ConchPalette.raised, in: RoundedRectangle(cornerRadius: 12))
            }
        case .assistant:
            Text(item.text)
                .font(.system(size: 13))
                .foregroundStyle(ConchPalette.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            Text(item.text)
                .font(.system(size: 12).italic())
                .foregroundStyle(ConchPalette.textFaint)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .review:
            Label(item.text, systemImage: "star.fill")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ConchPalette.statusReview)
        case .tool:
            toolRow(item)
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
