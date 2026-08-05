import SwiftUI

/// One session: its latest reply, its deliverable when it has one, and the
/// talk control. The mic button is the entire bottom edge — mid-workout the
/// thumb should not have to aim.
struct SessionView: View {
    @ObservedObject var bridge: BridgeClient
    @ObservedObject var speech: SpeechController
    /// Owned by the app, never by this view — see ConchApp.
    @ObservedObject var talk: TalkController
    let sessionId: String
    @State private var showReview = false
    @State private var sendFailed = false
    @State private var fetchedReply: String?
    @State private var loadingReply = false
    /// The reply the fetched copy belongs to, so a new turn refetches instead
    /// of showing the previous answer in full and the current one in part.
    @State private var fetchedFor: String?

    private static let draftAnchor = "conch.draft"

    /// Whether the mic is open FOR THIS SESSION. One controller serves them
    /// all, so `phase` alone would light up the mic and relabel the button in
    /// a session that is merely being looked at while another one listens.
    private var isTalkingHere: Bool {
        talk.targetSessionId == sessionId && talk.phase == .listening
    }

    private var row: PublishedState.Row? {
        bridge.state?.rows.first { $0.id == sessionId }
    }

    private var mark: StatusMark? {
        row.map(StatusMark.init(row:))
    }

    /// The live reply when this session owns it, else whatever we fetched.
    private var replyText: String? {
        guard let reply = bridge.state?.reply, reply.sessionId == sessionId,
              !reply.displayText.isEmpty else { return fetchedReply }
        // Whichever actually holds more of the answer.
        //
        // Gating this on `truncated` was not enough: the live reply is often
        // the short spoken ANNOUNCE, which is complete and therefore not
        // marked truncated, so it beat the full turn fetched from /reply and
        // you got a fragment of an older message while a new one streamed in.
        // Length is the honest comparison — the live copy is for immediacy,
        // /reply is authoritative, and once the live one genuinely overtakes
        // it (a longer turn arriving) it wins on its own merits.
        guard let whole = fetchedReply, whole.count > reply.displayText.count else {
            return reply.displayText
        }
        return whole
    }

    /// What must change before this session's reply is worth refetching.
    ///
    /// `state.reply` is ONE globally-latest reply across every session, not a
    /// reply per session. So a session that is not the most recent to speak
    /// gets no live text at all, and keying the refetch on it meant those
    /// sessions fetched once, ever — you opened conch and read a sentence
    /// belonging to dayloop. This session's own ROW still moves whenever it
    /// produces a turn, which is the signal that actually tracks it.
    private var replyFingerprint: String? {
        if let reply = bridge.state?.reply, reply.sessionId == sessionId {
            return "live:\(reply.text.count):\(reply.displayText.suffix(48))"
        }
        guard let row else { return nil }
        return "row:\(Int(row.at)):\(row.status):\(row.review?.summary ?? "")"
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
                    if isTalkingHere || !talk.draft(for: sessionId).isEmpty {
                        YourTurnBubble(
                            text: talk.draft(for: sessionId),
                            isSending: isTalkingHere && talk.phase == .sending,
                            onDiscard: {
                                talk.discard(session: sessionId)
                                sendFailed = false
                            }
                        )
                        .id(Self.draftAnchor)
                    }
                }
                .padding(20)
                .padding(.bottom, 12)
            }
            .onChange(of: talk.draft(for: sessionId)) { _, _ in
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
                .disabled(replyText == nil || isTalkingHere)
                .accessibilityLabel(speech.isSpeaking ? "Stop reading" : "Read this aloud")
            }

            if let mark {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        if !bridge.isConnected {
                            Circle().fill(Palette.needs).frame(width: 7, height: 7)
                                .accessibilityLabel("Disconnected")
                        }
                        // THIS phone's mic, not the daemon's. The published
                        // state describes the Mac, so while the phone held the
                        // ear the indicator was reporting a microphone on the
                        // other side of the room — the one state you cannot
                        // afford to be wrong about.
                        Image(systemName: isTalkingHere ? "mic.fill" : mark.symbol)
                            .font(.system(size: 12))
                            .foregroundStyle(isTalkingHere ? Palette.micOpen : mark.color)
                        // The word earns its place only when nothing else on
                        // screen explains the glyph — a review card directly
                        // beneath saying the same thing is clutter.
                        // The trailing inset goes on the TEXT, not the HStack:
                        // the capsule pads its leading edge but hugs the last
                        // glyph, so the label sat flush against the right wall
                        // while everything else breathed. Padding the HStack
                        // would fix that and push the icon off-centre in the
                        // icon-only case, where there is no text at all.
                        // 6pt is this HStack's own spacing, so the gap at the
                        // edge matches the gap between the glyph and the word.
                        if isTalkingHere {
                            Text("Mic open")
                                .font(Type.caption)
                                .foregroundStyle(Palette.micOpen)
                                .padding(.trailing, 6)
                        } else if row?.review == nil {
                            Text(mark.meaning)
                                .font(Type.caption)
                                .foregroundStyle(mark.color)
                                .padding(.trailing, 6)
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
        .onAppear {
            // Auto-open the mic when a reply for THIS session finishes reading.
            // Only while the session is on screen: a phone in your pocket must
            // not silently start recording.
            speech.onFinishedReading = {
                guard talk.phase == .idle,
                      talk.transcript.isEmpty,
                      speech.lastSpokenSessionId == sessionId else { return }
                toggleTalk()
            }
        }
        .onDisappear { speech.onFinishedReading = nil }
        // Keyed on the REPLY, not the session: fetching once per session meant
        // the first answer was whole and every one after it was a tail.
        .task(id: "\(sessionId)|\(replyFingerprint ?? "")") {
            let wanted = replyFingerprint
            if fetchedReply != nil, fetchedFor == wanted { return }
            loadingReply = fetchedReply == nil
            let whole = await bridge.fetchReply(sessionId: sessionId)
            loadingReply = false
            guard !Task.isCancelled else { return }
            if let whole, !whole.isEmpty {
                fetchedReply = whole
                fetchedFor = wanted
            }
        }
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

            // The phone going quiet with no explanation is indistinguishable
            // from a broken agent, a dead network, or an empty reply.
            if let failure = speech.speechFailure {
                Text(failure)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }

            if let failure = talk.failure {
                Text(failure)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }

            Button(action: toggleTalk) {
                HStack(spacing: 10) {
                    Image(systemName: isTalkingHere ? "arrow.up.circle.fill" : "mic.fill")
                        .font(.system(size: 20, weight: .semibold))
                    Text(talkLabel)
                        .font(Type.label(17, weight: .semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 58)
                .background(
                    isTalkingHere ? Palette.micOpen : Palette.raised,
                    in: RoundedRectangle(cornerRadius: 16)
                )
                .foregroundStyle(isTalkingHere ? Palette.bg : Palette.textPrimary)
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
        if isTalkingHere { return "Send" }
        if talk.targetSessionId == sessionId, talk.phase == .sending { return "Sending…" }
        return "Talk"
    }

    private func toggleTalk() {
        sendFailed = false
        let label = row?.label ?? ""
        talk.toggle(session: sessionId) { text in
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
    let onDiscard: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .leading, spacing: 6) {
                Text(text.isEmpty ? "Listening…" : text)
                    .font(Type.body)
                    .foregroundStyle(text.isEmpty ? Palette.textFaint : Palette.bg)
                    .multilineTextAlignment(.leading)
                    .textSelection(.enabled)
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
        .contextMenu {
            Button("Discard draft", systemImage: "trash", role: .destructive, action: onDiscard)
        }
        .accessibilityHint("Long press to discard this draft")
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
