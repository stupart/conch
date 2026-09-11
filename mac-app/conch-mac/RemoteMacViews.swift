import AppKit
import QuickLookUI
import SwiftUI

struct RemoteMacPairingsView: View {
    @EnvironmentObject private var remotes: RemoteMacStore
    @EnvironmentObject private var local: StateStore
    @State private var adding = false
    @State private var host = ""
    @State private var port = "8674"
    @State private var code = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            Text("Other Macs").font(.headline)
            Text("See sessions and send typed text on your LAN. Use the host and new six-digit code from the other Mac’s Phone app tab.")
                .font(.callout).foregroundStyle(ConchPalette.textDim)
            ForEach(remotes.pairings) { pairing in
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(pairing.endpoint.title)
                        Text("Owner: \(pairing.ownerDeviceId)").font(.caption.monospaced()).textSelection(.enabled)
                        if let issue = remotes.issues[pairing.id] {
                            Text(issue).font(.caption).foregroundStyle(ConchPalette.statusWaiting)
                        }
                    }
                    Spacer()
                    Button("Remove") { remotes.remove(pairing) }.disabled(busy)
                }
            }
            if adding {
                TextField("Host, e.g. 192.168.1.10 or mac.local", text: $host)
                HStack {
                    TextField("Port", text: $port).frame(width: 90)
                    TextField("Six-digit code", text: $code)
                }
                .onSubmit { pair() }
                HStack {
                    Button("Add Mac", action: pair).disabled(busy)
                    Button("Cancel") { adding = false; code = "" }.disabled(busy)
                    if busy { ProgressView().controlSize(.small) }
                }
            } else {
                Button("Add another Mac…") { adding = true }
            }
            if let error = remotes.pairingError {
                Text(error).font(.callout).foregroundStyle(ConchPalette.statusWaiting)
            }
        }
        .textFieldStyle(.roundedBorder)
    }

    private func pair() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await remotes.pair(host: host, port: port, code: code, localOwner: local.state?.ownerDeviceId ?? "")
                adding = false; host = ""; code = ""; port = "8674"
            } catch { remotes.pairingError = error.localizedDescription }
        }
    }
}

/// This group receives complete remote documents; none of its rows is passed
/// to SessionLedger's local actions or StateStore's ledger/transcript machinery.
struct RemoteMacGroups: View {
    @EnvironmentObject private var remotes: RemoteMacStore
    let onSelect: (RemoteSessionID) -> Void

    var body: some View {
        ForEach(remotes.pairings) { pairing in
            VStack(alignment: .leading, spacing: 8) {
                Divider().padding(.top, 12)
                Label(pairing.endpoint.title, systemImage: "desktopcomputer").font(.headline)
                if let issue = remotes.issues[pairing.id] {
                    Text(issue).font(.caption).foregroundStyle(ConchPalette.statusWaiting)
                } else if !remotes.online.contains(pairing.id) {
                    Text("Connecting…").font(.caption).foregroundStyle(ConchPalette.textDim)
                }
                let rows = remotes.documents[pairing.ownerDeviceId]?.rows ?? []
                if rows.isEmpty {
                    Text("No published sessions").font(.caption).foregroundStyle(ConchPalette.textDim)
                }
                ForEach(rows) { row in
                    let target = RemoteSessionID(ownerDeviceId: pairing.ownerDeviceId, localSessionKey: row.id)
                    Button { onSelect(target) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(row.label.isEmpty ? row.id : row.label).fontWeight(.medium)
                            Text("Owner: \(target.ownerDeviceId.prefix(8))")
                                .font(.caption.monospaced()).foregroundStyle(ConchPalette.brandCyan)
                            if let detail = row.detail ?? row.snippet {
                                Text(detail).font(.caption).foregroundStyle(ConchPalette.textDim).lineLimit(2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10).background(ConchPalette.raised, in: RoundedRectangle(cornerRadius: 7))
                    }
                    .buttonStyle(.plain)
                    .help("Owner: \(target.ownerDeviceId) · Session: \(target.localSessionKey)")
                }
            }
            .padding(.horizontal, 8).padding(.bottom, 8)
        }
    }
}

/// A remote session has a text-only composer. Local ComposerView, attachments,
/// mic, reveal and transcript readers are deliberately not part of this view.
struct RemoteSessionView: View {
    @EnvironmentObject private var remotes: RemoteMacStore
    @Environment(\.dismiss) private var dismiss
    let target: RemoteSessionID
    @State private var markdown = ""
    @State private var readError: String?
    @State private var sendStatus: String?
    @State private var sending = false
    @State private var previewURL: URL?
    @State private var downloading = false
    /// Only for its link door (A13); remote rows never reach the local store.
    @EnvironmentObject private var store: StateStore
    /// A web link from this session that would not open, in macOS's words.
    @State private var linkFailure: String?

    private var draft: Binding<String> {
        Binding(get: { remotes.drafts[target] ?? "" }, set: { remotes.drafts[target] = $0 })
    }
    private var row: SessionRow? { remotes.row(for: target) }
    private var host: String { remotes.pairings.first { $0.id == target.ownerDeviceId }?.endpoint.title ?? "Unpaired Mac" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row?.label ?? "Session no longer published").font(.title2)
                    Text("\(host) · Owner: \(target.ownerDeviceId.prefix(8))")
                        .font(.caption.monospaced()).foregroundStyle(ConchPalette.brandCyan)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Divider()
            if let issue = remotes.issues[target.ownerDeviceId] {
                Text(issue).font(.callout).foregroundStyle(ConchPalette.statusWaiting)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let conversation = remotes.conversation(for: target), !conversation.items.isEmpty {
                        if conversation.truncated { Text("Earlier messages not shown").font(.caption) }
                        ForEach(conversation.items) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.kind.rawValue.capitalized).font(.caption).foregroundStyle(ConchPalette.textDim)
                                remoteText(item.text)
                                if let result = item.tool?.result, !result.isEmpty { remoteText(result) }
                                if let material = item.material {
                                    Text(material.title).font(.headline)
                                    if let detail = material.detail { remoteText(detail) }
                                    if let path = material.path { fileButton(material.title, path: path) }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    } else if !markdown.isEmpty {
                        remoteText(markdown)
                    } else {
                        Text("Waiting for a reply…").foregroundStyle(ConchPalette.textDim)
                    }
                    if let review = row?.review, let link = review.link {
                        if let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                            Button(review.summary.isEmpty ? "Open review" : review.summary) { openWeb(url) }
                                .buttonStyle(.link)
                        } else {
                            fileButton(review.summary.isEmpty ? "Preview remote file" : review.summary, path: link)
                        }
                    }
                    if downloading { ProgressView("Loading remote file…") }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let readError { Text(readError).font(.callout).foregroundStyle(ConchPalette.statusWaiting) }
            LinkFailureLine(message: $linkFailure)
            Divider()
            TextField("Type a reply to \(host)…", text: draft, axis: .vertical)
                .lineLimit(2...6).textFieldStyle(.roundedBorder)
                .disabled(row == nil)
            HStack {
                Text(sendStatus ?? "Typed text goes to this session’s owner.")
                    .font(.caption).textSelection(.enabled)
                Spacer()
                Button(sending ? "Sending…" : "Send", action: send)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(sending || row == nil || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22).frame(minWidth: 580, idealWidth: 740, minHeight: 480, idealHeight: 650)
        .background(ConchPalette.bg)
        .task(id: target) {
            while !Task.isCancelled {
                do {
                    let text = try await remotes.reply(for: target)
                    try Task.checkCancellation()
                    markdown = text
                    readError = nil
                } catch { if !Task.isCancelled { readError = error.localizedDescription } }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
        .sheet(isPresented: Binding(get: { previewURL != nil }, set: { if !$0 { clearPreview() } })) {
            if let previewURL {
                VStack {
                    HStack { Text("File from \(host)"); Spacer(); Button("Close") { clearPreview() } }
                    RemoteFilePreview(url: previewURL)
                }.padding().frame(width: 680, height: 540)
            }
        }
        .onDisappear { clearPreview() }
    }

    private func remoteText(_ text: String) -> some View {
        Text(.init(text)).textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in
                // A markdown link to /Users/... belongs to A, never this Mac.
                if url.isFileURL || url.scheme == nil {
                    openFile(url.isFileURL ? url.path : url.relativeString)
                    return .handled
                }
                guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
                openWeb(url)
                return .handled
            })
    }

    /// A remote session's web link is a page this Mac opens itself, so it
    /// goes through the one door that reports (A13) — SwiftUI's `Link` and
    /// its system action dropped the answer. No row id: the session is the
    /// other Mac's, and this Mac's errors.jsonl has no row by that name.
    private func openWeb(_ url: URL) {
        linkFailure = nil
        store.openLink(url.absoluteString, cwd: nil, rowId: nil) { linkFailure = $0 }
    }

    private func fileButton(_ title: String, path: String) -> some View {
        Button { openFile(path) } label: { Label(title, systemImage: "doc") }.disabled(downloading)
    }

    private func openFile(_ path: String) {
        guard !downloading else { return }
        downloading = true
        Task {
            defer { downloading = false }
            do { clearPreview(); previewURL = try await remotes.download(path, for: target) }
            catch { readError = error.localizedDescription }
        }
    }

    private func clearPreview() {
        if let previewURL { try? FileManager.default.removeItem(at: previewURL) }
        previewURL = nil
    }

    private func send() {
        guard !sending else { return }
        let text = draft.wrappedValue
        sending = true
        sendStatus = nil
        Task {
            defer { sending = false }
            do {
                sendStatus = try await remotes.send(text, to: target)
                if draft.wrappedValue == text { draft.wrappedValue = "" }
            } catch {
                sendStatus = error.localizedDescription + " — check the session before retrying."
            }
        }
    }
}

private struct RemoteFilePreview: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> QLPreviewView { QLPreviewView(frame: .zero, style: .normal) }
    func updateNSView(_ view: QLPreviewView, context: Context) { view.previewItem = url as NSURL }
}
