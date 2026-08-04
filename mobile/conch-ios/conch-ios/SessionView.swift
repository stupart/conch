import SwiftUI

/// One session: its latest reply, its deliverable when it has one, and the
/// talk control. The mic button is the entire bottom edge — mid-workout the
/// thumb should not have to aim.
struct SessionView: View {
    @ObservedObject var bridge: BridgeClient
    @ObservedObject var speech: SpeechController
    let sessionId: String

    @StateObject private var talk = TalkController()
    @State private var showReview = false
    @State private var sendFailed = false
    @State private var fetchedReply: String?
    @State private var loadingReply = false

    private static let draftAnchor = "conch.draft"

    private var row: PublishedState.Row? {
        bridge.state?.rows.first { $0.id == sessionId }
    }

    private var mark: StatusMark? {
        row.map(StatusMark.init(row:))
    }

    /// The live reply when this session owns it, else whatever we fetched.
    private var replyText: String? {
        if let reply = bridge.state?.reply, reply.sessionId == sessionId,
           !reply.displayText.isEmpty {
            return reply.displayText
        }
        return fetchedReply
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let review = row?.review {
                        ReviewCard(review: review) {
                            showReview = true
                        }
                    }

                    if let replyText {
                        MarkdownView(text: replyText)
                            .foregroundStyle(Palette.textPrimary)
                    } else if loadingReply {
                        ProgressView()
                            .padding(.top, 32)
                            .frame(maxWidth: .infinity)
                    } else if row?.review == nil {
                        Text("No reply yet — talk to it below.")
                            .font(Type.summary)
                            .foregroundStyle(Palette.textFaint)
                            .padding(.top, 32)
                            .frame(maxWidth: .infinity)
                    }

                    // Your words belong in the thread, under what you are
                    // answering — not stacked on top of the button. It reads as
                    // a conversation, and you can see the whole utterance grow.
                    if talk.phase == .listening || talk.phase == .sending {
                        YourTurnBubble(
                            text: talk.transcript,
                            isSending: talk.phase == .sending
                        )
                        .id(Self.draftAnchor)
                    }
                }
                .padding(20)
                .padding(.bottom, 12)
            }
            .onChange(of: talk.transcript) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    scroller.scrollTo(Self.draftAnchor, anchor: .bottom)
                }
            }
            }

            talkSurface
        }
        .background(Palette.bg)
        .navigationTitle(row?.label ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Read it to me. The Mac and terminal have always had `recite`;
            // without it the phone could only speak replies that happened to
            // arrive while you were watching, which is the opposite of the
            // case the phone exists for.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if speech.isSpeaking {
                        speech.stop()
                    } else if let replyText {
                        speech.speak(replyText, from: row?.label)
                    }
                } label: {
                    Image(systemName: speech.isSpeaking ? "stop.fill" : "speaker.wave.2.fill")
                        .foregroundStyle(speech.isSpeaking ? Palette.needs : Palette.textDim)
                        .contentTransition(.symbolEffect(.replace))
                }
                .disabled(replyText == nil)
                .accessibilityLabel(speech.isSpeaking ? "Stop reading" : "Read this aloud")
            }

            if let mark {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        if !bridge.isConnected {
                            Circle().fill(Palette.needs).frame(width: 7, height: 7)
                                .accessibilityLabel("Disconnected")
                        }
                        Image(systemName: mark.symbol)
                            .font(.system(size: 12))
                            .foregroundStyle(mark.color)
                        // The word earns its place only when nothing else on
                        // screen explains the glyph — a review card directly
                        // beneath saying the same thing is clutter.
                        if row?.review == nil {
                            Text(mark.meaning)
                                .font(Type.caption)
                                .foregroundStyle(mark.color)
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showReview) {
            if let review = row?.review {
                DeliverableSheet(bridge: bridge, review: review)
            }
        }
        .task(id: sessionId) {
            guard fetchedReply == nil else { return }
            loadingReply = true
            fetchedReply = await bridge.fetchReply(sessionId: sessionId)
            loadingReply = false
        }
        .onDisappear { talk.cancel() }
    }

    // MARK: - Talk

    private var talkSurface: some View {
        VStack(spacing: 12) {
            if case let .denied(reason) = talk.phase {
                VStack(spacing: 6) {
                    Text(reason)
                        .font(Type.caption)
                        .foregroundStyle(Palette.needs)
                        .multilineTextAlignment(.center)
                    // Mid-workout, nobody navigates Settings by hand.
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    .font(Type.caption.weight(.medium))
                    .foregroundStyle(Palette.micOpen)
                }
                .padding(.horizontal, 20)
            }

            if sendFailed {
                Text("Couldn't reach the Mac — your words are kept above.")
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
            }

            Button(action: toggleTalk) {
                HStack(spacing: 10) {
                    Image(systemName: talk.phase == .listening ? "arrow.up.circle.fill" : "mic.fill")
                        .font(.system(size: 20, weight: .semibold))
                    Text(talkLabel)
                        .font(Type.label(17, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .background(
                    talk.phase == .listening ? Palette.micOpen : Palette.raised,
                    in: RoundedRectangle(cornerRadius: 16)
                )
                .foregroundStyle(talk.phase == .listening ? Palette.bg : Palette.textPrimary)
            }
            .buttonStyle(.plain)
            .disabled(talk.phase == .sending)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .animation(.easeOut(duration: 0.18), value: talk.phase)
        }
        .padding(.top, 10)
        .background(.ultraThinMaterial.opacity(0.06))
    }

    private var talkLabel: String {
        switch talk.phase {
        case .listening: "Send"
        case .sending: "Sending…"
        case .idle, .denied: "Talk"
        }
    }

    private func toggleTalk() {
        sendFailed = false
        let label = row?.label ?? ""
        talk.toggle { text in
            let delivered = await bridge.inject(
                sessionId: sessionId,
                label: label,
                text: text
            )
            if !delivered { sendFailed = true }
            return delivered
        }
    }
}

/// What you are saying, as a turn in the conversation.
private struct YourTurnBubble: View {
    let text: String
    let isSending: Bool

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .leading, spacing: 6) {
                Text(text.isEmpty ? "Listening…" : text)
                    .font(Type.body)
                    .foregroundStyle(text.isEmpty ? Palette.textFaint : Palette.bg)
                    .multilineTextAlignment(.leading)
                if isSending {
                    Text("Sending…")
                        .font(Type.caption)
                        .foregroundStyle(Palette.bg.opacity(0.7))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Palette.micOpen, in: RoundedRectangle(cornerRadius: 16))
        }
        .padding(.top, 8)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

private struct ReviewCard: View {
    let review: PublishedState.Row.Review
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "star.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.review)
                VStack(alignment: .leading, spacing: 4) {
                    Text(review.summary)
                        .font(Type.label(15, weight: .medium))
                        .foregroundStyle(Palette.textPrimary)
                        .multilineTextAlignment(.leading)
                    if review.link != nil {
                        Text("View the work")
                            .font(Type.caption)
                            .foregroundStyle(Palette.micOpen)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(review.link == nil)
    }
}
