import SwiftUI

/// One session: its latest reply, its deliverable when it has one, and the
/// talk control. The mic button is the entire bottom edge — mid-workout the
/// thumb should not have to aim.
struct SessionView: View {
    @ObservedObject var bridge: BridgeClient
    let sessionId: String

    @StateObject private var talk = TalkController()
    @State private var showReview = false
    @State private var sendFailed = false

    private var row: PublishedState.Row? {
        bridge.state?.rows.first { $0.id == sessionId }
    }

    private var mark: StatusMark? {
        row.map(StatusMark.init(row:))
    }

    /// The reply belongs in this view only when it is this session's.
    private var replyText: String? {
        guard let reply = bridge.state?.reply, reply.sessionId == sessionId,
              !reply.displayText.isEmpty else { return nil }
        return reply.displayText
    }

    var body: some View {
        VStack(spacing: 0) {
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
                    } else if row?.review == nil {
                        Text("No reply yet — talk to it below.")
                            .font(Type.summary)
                            .foregroundStyle(Palette.textFaint)
                            .padding(.top, 32)
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(20)
                .padding(.bottom, 12)
            }

            talkSurface
        }
        .background(Palette.bg)
        .navigationTitle(row?.label ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let mark {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        Image(systemName: mark.symbol)
                            .font(.system(size: 12))
                        Text(mark.meaning)
                            .font(Type.caption)
                    }
                    .foregroundStyle(mark.color)
                }
            }
        }
        .sheet(isPresented: $showReview) {
            if let review = row?.review {
                DeliverableSheet(bridge: bridge, review: review)
            }
        }
        .onDisappear { talk.cancel() }
    }

    // MARK: - Talk

    private var talkSurface: some View {
        VStack(spacing: 12) {
            if case let .denied(reason) = talk.phase {
                Text(reason)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }

            if talk.phase == .listening {
                Text(talk.transcript.isEmpty ? "Listening…" : talk.transcript)
                    .font(Type.body)
                    .foregroundStyle(
                        talk.transcript.isEmpty ? Palette.textFaint : Palette.textPrimary
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .transition(.opacity)
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
