import SwiftUI
import UniformTypeIdentifiers

/// Type to a session from the Mac, with images.
///
/// conch could speak to an agent and the phone could type to one, but the Mac
/// app — the window actually open on the machine the agents are running on —
/// was read-only. Tyler put it plainly: "i can't even input text or images on
/// our mac app yet lol".
///
/// Images do NOT need the phone's upload dance. That exists because a picture
/// on a phone is not on the Mac; here the file is already local, so the agent
/// can read it straight off disk and all we have to send is the path. No
/// resizing either — downscaling exists to avoid pushing pixels over a metered
/// relay, and there is no relay in this direction.
struct ComposerView: View {
    let sessionID: String
    let sessionLabel: String
    /// What conch is hearing right now, so dictation appears where you would
    /// type it rather than somewhere else on screen.
    let dictation: String
    let onSend: (String) -> Void

    @State private var draft = ""
    @State private var attachments: [URL] = []
    @State private var isTargetedForDrop = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                AttachmentStrip(attachments: attachments) { url in
                    attachments.removeAll { $0 == url }
                }
            }

            HStack(alignment: .center, spacing: 8) {
                Button(action: chooseFiles) {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .foregroundStyle(ConchPalette.textDim)
                .help("Attach an image")

                composerField

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .background(
                            Circle().fill(
                                canSend ? ConchPalette.brandCyan : ConchPalette.hover
                            )
                        )
                        .foregroundStyle(canSend ? Color.black : ConchPalette.textDim)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: [])
                .help("Send to \(sessionLabel)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(ConchPalette.raised)
        .overlay(alignment: .top) {
            Rectangle().fill(ConchPalette.divider).frame(height: 1)
        }
        // Dropping a screenshot straight onto the window is how anyone actually
        // shares one, so it must work without opening a file picker first.
        .onDrop(of: [.fileURL], isTargeted: $isTargetedForDrop) { providers in
            load(providers)
            return true
        }
        .overlay {
            if isTargetedForDrop {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(ConchPalette.brandCyan, lineWidth: 1.5)
                    .padding(4)
            }
        }
    }

    private var composerField: some View {
        ZStack(alignment: .topLeading) {
            // Dictation takes over the field while you speak. It is deliberately
            // not written INTO the draft: the transcript is still being revised
            // right up until it lands, and typing over a moving target is worse
            // than watching it settle.
            if !dictation.isEmpty {
                Text(dictation)
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.brandCyan)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
            } else {
                TextEditor(text: $draft)
                    .font(ConchTypography.font(size: 12.5))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .scrollContentBackground(.hidden)
                    .focused($fieldFocused)
                    .padding(.vertical, 2)
                    .padding(.horizontal, 4)
                    // TextEditor has no intrinsic content height on macOS — it
                    // fills whatever it is given, which turned the composer into
                    // a third of the window. Size it from the text instead, so
                    // it starts as one line and grows only as far as it earns.
                    .frame(height: fieldHeight)

                if draft.isEmpty {
                    Text("Message \(sessionLabel)")
                        .font(ConchTypography.font(size: 12.5))
                        .foregroundStyle(ConchPalette.textDim)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 8)
                        .allowsHitTesting(false)
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8).fill(ConchPalette.bg)
        )
    }

    private var canSend: Bool {
        !composed.isEmpty
    }

    /// One line until there is more, then up to six.
    private var fieldHeight: CGFloat {
        let lines = draft.isEmpty ? 1 : draft.reduce(into: 1) { total, character in
            if character == "\n" { total += 1 }
        }
        // Wrapped long lines still need room; approximate rather than measure,
        // since being a few pixels generous costs nothing and measuring costs a
        // layout pass on every keystroke.
        let wrapped = max(lines, Int(ceil(Double(draft.count) / 110.0)))
        return CGFloat(min(6, max(1, wrapped))) * 17 + 9
    }

    /// Paths first, then the words.
    ///
    /// Both Claude Code and Codex read an image when its path appears in the
    /// message, so an attachment is literally its own absolute path on a line.
    /// Leading rather than trailing because a trailing path after a long
    /// message reads as an afterthought and is easier for a model to skim past.
    private var composed: String {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !attachments.isEmpty else { return text }
        let paths = attachments.map(\.path).joined(separator: "\n")
        return text.isEmpty ? paths : "\(paths)\n\(text)"
    }

    private func send() {
        let payload = composed
        guard !payload.isEmpty else { return }
        onSend(payload)
        draft = ""
        attachments = []
        fieldFocused = true
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image, .pdf, .plainText]
        guard panel.runModal() == .OK else { return }
        attachments.append(contentsOf: panel.urls.filter { !attachments.contains($0) })
    }

    private func load(_ providers: [NSItemProvider]) {
        for provider in providers {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in
                    guard !attachments.contains(url) else { return }
                    attachments.append(url)
                }
            }
        }
    }
}

/// Attached files, each removable. Shown as a name rather than a thumbnail:
/// what you need to confirm before sending is *which* file, and a 40px preview
/// of a screenshot is unreadable anyway.
private struct AttachmentStrip: View {
    let attachments: [URL]
    let onRemove: (URL) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments, id: \.self) { url in
                    HStack(spacing: 5) {
                        Image(systemName: "paperclip")
                            .font(.system(size: 9.5))
                        Text(url.lastPathComponent)
                            .font(ConchTypography.font(size: 11))
                            .lineLimit(1)
                        Button {
                            onRemove(url)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .bold))
                        }
                        .buttonStyle(.plain)
                    }
                    .foregroundStyle(ConchPalette.textDim)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 6).fill(ConchPalette.hover)
                    )
                }
            }
        }
        .frame(maxHeight: 26)
    }
}
