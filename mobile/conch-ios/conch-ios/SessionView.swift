import ConchDesign
import SwiftUI
import PhotosUI

/// One session: its latest reply, its deliverable when it has one, and the
/// talk control. The mic button is the entire bottom edge — mid-workout the
/// thumb should not have to aim.
struct SessionView: View {
    @ObservedObject var bridge: BridgeClient
    @ObservedObject var speech: SpeechController
    /// Owned by the app, never by this view — see ConchApp.
    @ObservedObject var talk: TalkController
    let sessionId: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    #if DEBUG
    /// `-conchFixtureReview YES` opens the deliverable on arrival, for the snapshot script.
    @State private var showReview = UserDefaults.standard.bool(forKey: "conchFixtureReview")
    #else
    @State private var showReview = false
    #endif
    @State private var sendFailed = false
    @FocusState private var typing: Bool
    @State private var pickedPhoto: PhotosPickerItem?
    /// Prepared and waiting, NOT uploaded. Nothing leaves the phone until you
    /// press send — picking a picture is composing, not sending.
    @State private var attachments: [PendingAttachment] = []
    /// Whether the end of the conversation is on screen. Set by the anchor's
    /// own visibility, which is how iOS answers what NSScrollView answers on
    /// the Mac.
    @State private var pinnedToBottom = true
    /// This session's recorded history: everything above the live window, and the
    /// whole text behind anything the snapshot cut. Owned here because it follows
    /// whichever session is on screen, and one reader cannot hold two sessions' pages.
    @StateObject private var history = HistoryStore()

    private static let bottomAnchor = "conversation-bottom"

    /// What "the conversation changed" means, for following purposes: a new
    /// item, or the last one growing as a reply streams in. Keyed rather than
    /// counted so an edit to the final message still follows.
    private var conversationRevision: String {
        let conversation = bridge.state?.conversations[sessionId]
        let items = conversation?.items ?? []
        return "\(items.count)-\(items.last?.id ?? "")-\(items.last?.rev ?? 0)-\(talk.outgoing.count)"
    }

    private var conversationItems: [ConversationItem] {
        bridge.state?.conversations[sessionId]?.items ?? []
    }

    /// The conversation to draw, or nil when there is no conversation to draw.
    ///
    /// The daemon's live window when it publishes one with anything in it, and an
    /// EMPTY window of this session when it does not but the record holds the session
    /// anyway. Recorded history is drawn INSIDE the stack below, so gating the stack on
    /// the live window hid the history too: an older session the daemon no longer
    /// publishes a window for — which, with 224 recorded transcripts, is most of them —
    /// drew nothing at all. Not its recorded messages, not "Load earlier messages", not
    /// even the line saying why.
    private var liveWindow: Conversation? {
        let published = bridge.state?.conversations[sessionId]
        if let published, !published.items.isEmpty { return published }
        // Nothing recorded, or nothing recording: the screen below is the one that has
        // always been drawn for a session with no messages, and it stays that way.
        guard history.paging.hasAnythingToShow else { return nil }
        return published ?? Conversation(sessionId: sessionId)
    }

    /// Which branch of a shared transcript this window is (A8), for the record store to
    /// read the ancestry above.
    ///
    /// The live window is already one window's branch; this hands the same fact to the
    /// history drawn above it, so the two cannot disagree about whose conversation
    /// this is.
    private var branchTip: String? {
        let published = bridge.state?.conversations[sessionId]
        return HistorySnapshot.branchTip(
            forSnapshotItems: published?.items.map(\.id) ?? [],
            shared: published?.shared ?? false
        )
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        // After layout, not during it: scrolling to an anchor SwiftUI has not
        // placed yet silently does nothing.
        DispatchQueue.main.async {
            if animated {
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
        }
    }
    @State private var attaching = false
    @State private var attachError: String?
    /// iOS refusing to open Settings, said under the button (A13).
    @State private var settingsFailure: String?
    /// An image-only send in flight. TalkController's `.sending` phase covers
    /// only sends that carry words; this is the same signal for the send that
    /// carries none.
    @State private var sendingImagesOnly = false
    @State private var fetchedReply: String?
    @State private var loadingReply = false
    @State private var optionReplyInFlight = false
    /// Why an answer to a question or a permission prompt did not land, in the Mac's words.
    @State private var answerFailure: String?
    @State private var confirmingClose = false
    @State private var closingSession = false
    @State private var closeError: String?
    @State private var showingCloseError = false
    /// Four API-sized images put a 20 MB ceiling on retained upload payloads;
    /// without a count limit, the 5 MB per-image cap was not a memory bound.
    private static let attachmentLimit = 4
    /// The reply the fetched copy belongs to, so a new turn refetches instead
    /// of showing the previous answer in full and the current one in part.
    @State private var fetchedFor: String?

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
            // What a blocked session is asking, above everything. It reached
            // only the ledger's subtitle, so opening the session hid the one
            // thing it was waiting on.
            if row?.status == "needs", let detail = row?.detail, !detail.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: StatusMark.needs.symbol)
                        .font(Type.caption)
                        .foregroundStyle(Palette.needs)
                        .accessibilityHidden(true)
                    Text(detail)
                        .font(Type.summary)
                        .foregroundStyle(Palette.textPrimary)
                        .textSelection(.enabled)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Palette.raised)
            }
            ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // The whole conversation when the daemon has one for THIS
                    // session, which is what finally puts Codex sessions on the
                    // phone: their content never arrives as `reply`, because
                    // that carries only the last turn conch spoke, and conch
                    // does not speak for a session it merely observes.
                    if let conversation = liveWindow {
                        ConversationStack(
                            bridge: bridge,
                            history: history,
                            conversation: conversation,
                            optionReplyInFlight: optionReplyInFlight || isSending,
                            onAnswer: answerQuestion,
                            onFreeform: { typing = true },
                            noTerminal: row?.noTerminal,
                            onOpenInTerminal: row?.attachable == true ? openInTerminal : nil
                        )
                    } else if let replyText {
                        MarkdownView(text: replyText)
                            .foregroundStyle(Palette.textPrimary)
                            .textSelection(.enabled)
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

                    // No DRAFT bubble: the field holds what you are writing, and
                    // showing it twice read as a bug ("its also showing the
                    // preview in blue tho as I type so its kinda weird"). What
                    // is here is a message you SENT, the moment you send it,
                    // with what became of it; it gives way to the transcript's
                    // own copy when that arrives (TalkController.reconcile).
                    ForEach(talk.outgoing.filter { $0.session == sessionId }) { message in
                        YourTurnBubble(
                            message: message,
                            onRetry: sendWords,
                            onDiscard: { talk.discardOutgoing(message.id) }
                        )
                    }

                    // The permission prompt the session is showing, answered here rather
                    // than only marked red (#370). After everything it said, like the Mac.
                    if let approval = row?.approval {
                        ApprovalCard(
                            approval: approval,
                            noTerminal: row?.noTerminal,
                            inFlight: optionReplyInFlight || isSending,
                            onApprove: approve
                        )
                    }

                    // The artifact, where it happened rather than above
                    // everything. It used to sit at the TOP of this scroll — and
                    // once sessions started opening at the bottom it was never
                    // on screen at all, which is why Tyler could not find one he
                    // had just been sent. With one artifact per session, the end
                    // is where it happened: it is the latest thing produced.
                    if let review = row?.review {
                        ReviewCard(review: review) {
                            showReview = true
                        }
                    }

                    // The end of the conversation, and the way to know whether
                    // you are looking at it. iOS has no equivalent of the Mac's
                    // NSScrollView observer, but a zero-height marker that
                    // reports its own visibility answers the same question:
                    // are we at the bottom right now?
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchor)
                        .onAppear { pinnedToBottom = true }
                        .onDisappear { pinnedToBottom = false }
                }
                .padding(20)
                .padding(.bottom, 12)
            }
            .onAppear {
                // Everything above the live window, for this session. Before the
                // fixture's early return below: the snapshot script photographs the
                // TOP of a conversation, which is exactly where history is drawn.
                history.follow(session: sessionId, branchTip: branchTip, on: bridge)
                // The reported bug. A ScrollViewReader was already here and its
                // proxy was never used once — `scroller` appeared exactly at
                // its own declaration and nowhere else — so opening a session
                // left you at the TOP of the conversation. Tyler: "when I open
                // it up I often have to scroll back down to the bottom again."
                #if DEBUG
                // `-conchFixtureTop YES`: stay at the top, so the snapshot
                // script can photograph the start of a long conversation.
                if UserDefaults.standard.bool(forKey: "conchFixtureTop") { return }
                #endif
                scrollToBottom(scroller, animated: false)
            }
            .onChange(of: conversationRevision) { _, _ in
                talk.reconcile(session: sessionId, items: conversationItems)
                // Follow new messages only while already at the end, so
                // reading history is not yanked away by an arriving reply —
                // the same rule the Mac settled on.
                guard pinnedToBottom else { return }
                scrollToBottom(scroller, animated: true)
            }
            .onChange(of: sessionId) { _, _ in
                // A different session is a different conversation: start at its
                // end, and re-arm the follow. The recorded reader is told too —
                // anything still in flight for the old session is refused, not merged.
                history.follow(session: sessionId, branchTip: branchTip, on: bridge)
                pinnedToBottom = true
                scrollToBottom(scroller, animated: false)
            }
            // Older messages land ABOVE what you are reading and push it down. Putting
            // the row you were on back under the eye is the whole difference between
            // history arriving and the transcript jumping while you read it.
            .onChange(of: history.paging.items.count) { previous, next in
                // The FIRST page is not a prepend. It lands under a conversation
                // sitting at its end, and scrolling to it would throw the reader to
                // the top of a session they just opened.
                guard previous > 0, next > previous, let anchor = history.paging.anchor else { return }
                Task { @MainActor in
                    // After layout: the rows are only there to scroll to once they
                    // have been measured.
                    await Task.yield()
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) { scroller.scrollTo(anchor, anchor: .top) }
                }
            }
            // Focus used to be a trap: once the cursor entered the field there
            // was no way out short of sending or discarding, and the keyboard
            // sat over the conversation you wanted to re-read before deciding.
            // Tyler: "i want to be able to deselect the input box ... by
            // swiping down on it and or tapping outside of it so that i can
            // scroll and read the content before sending or if i change my
            // mind". Both escapes: a drag on the conversation walks the
            // keyboard out with the finger, and a tap on it drops focus
            // outright — controls in the conversation still win their tap, so
            // only inert content defocuses. Neither touches the draft: it
            // lives in TalkController per session, and losing focus is not on
            // the short list of things allowed to clear it.
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .onTapGesture { typing = false }
            }

            // Recognition partials arrive many times per sentence. Their own
            // observer redraws this composer closure without invalidating the
            // conversation and rebuilding every MarkdownView above it.
            ComposerUpdateScope(partial: talk.livePartial) {
                talkSurface
            }
        }
        .background(Palette.bg)
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            Task { await attach(item) }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The name, and under it the state. The state was a chip in the
            // trailing capsule, which clipped it to "! N" and "W…".
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    HStack(spacing: 7) {
                        Text(row?.label ?? "")
                            .font(Type.sessionName)
                            .foregroundStyle(Palette.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        AgentBadge(backend: row?.backend)
                    }
                    if let mark {
                        statusLine(mark)
                    }
                }
            }

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

            // Ending a resumable agent is the most expensive tap on this
            // screen. It lives behind an overflow item AND a confirmation,
            // never in the composer or a full-swipe gesture.
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // How full the context is, where you look for it on
                    // purpose. It was the first line of every conversation,
                    // and Tyler called it secondary.
                    if let context = row?.context, context.limitTokens > 0 {
                        Label(
                            "Context \(Int((context.proportion * 100).rounded()))% used",
                            systemImage: context.proportion >= 0.80 ? "exclamationmark.triangle" : "gauge.with.dots.needle.33percent"
                        )
                        Divider()
                    }
                    Button("End session…", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        confirmingClose = true
                    }
                    // A clean exit is typed into the terminal; a closed or
                    // app-server Codex thread has none. A background job is
                    // stopped by id, so it needs none.
                    .disabled(closingSession || !bridge.isConnected || (row?.noTerminal != nil && row?.attachable != true))
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("Session actions")
            }
        }
        .sheet(isPresented: $showReview) {
            if row?.review != nil {
                ReviewSheet(bridge: bridge, talk: talk, sessionId: sessionId)
            }
        }
        .confirmationDialog(
            "End this session cleanly?",
            isPresented: $confirmingClose,
            titleVisibility: .visible
        ) {
            Button("End session", role: .destructive, action: closeCleanly)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent exits normally and leaves this session resumable. Conch will never kill it.")
        }
        .alert("Couldn't end that session", isPresented: $showingCloseError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(closeError ?? "The Mac didn't confirm a clean exit, so conch left the agent running.")
        }
        .onAppear {
            talk.reconcile(session: sessionId, items: conversationItems)
            #if DEBUG
            // `-conchFixtureSend <words>`: send them through the real composer
            // path, so a simulator paired to a stand-in bridge shows a message
            // sending, delivered or failed without anyone typing.
            if let words = UserDefaults.standard.string(forKey: "conchFixtureSend") {
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    talk.setDraft(words, for: sessionId)
                    sendDraft()
                }
            }
            #endif
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
        .onChange(of: talk.failure) { _, failure in
            guard let failure else { return }
            Task {
                _ = await bridge.reportAppError(
                    operation: "speech-recognition",
                    message: failure,
                    sessionId: sessionId
                )
            }
        }
        .onChange(of: speech.speechFailure) { _, failure in
            guard let failure else { return }
            Task {
                _ = await bridge.reportAppError(
                    operation: "speech-playback",
                    message: failure,
                    sessionId: sessionId
                )
            }
        }
        // Keep asking while the session is producing.
        //
        // The Mac app re-reads the transcript file continuously, which is why
        // it grows in front of you. The phone fetched once per fingerprint
        // change, and a fingerprint built from the ROW only moves when the
        // session's status does — not as an answer is written. So the phone
        // held a stale snapshot of a turn that was still growing: "still not
        // getting your full messages written out like I do on desktop".
        //
        // Only while this session is on screen AND actually working, so a
        // ledger of idle sessions costs nothing. Task cancellation on
        // disappear stops it; there is no timer to leak.
        // Off screen it also stops: the connection is closed while backgrounded,
        // so every poll would be a request against a socket that is not there.
        // Including the phase in the id restarts it when you come back.
        .task(id: "poll|\(sessionId)|\(row?.status ?? "")|\(scenePhase == .active)") {
            while !Task.isCancelled, scenePhase == .active, row?.status == "working" {
                try? await Task.sleep(for: .milliseconds(1500))
                if Task.isCancelled { return }
                guard let whole = await bridge.fetchReply(sessionId: sessionId),
                      !whole.isEmpty else { continue }
                // Never let a shorter re-read replace a longer one: a tail read
                // that lands mid-write would otherwise make the answer flicker
                // backwards while you are reading it.
                if whole.count >= (fetchedReply?.count ?? 0) { fetchedReply = whole }
            }
        }
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

    /// The session's state under its name: this phone's mic, a dropped link,
    /// or what the row is waiting on.
    private func statusLine(_ mark: StatusMark) -> some View {
        HStack(spacing: 6) {
            if !bridge.isConnected {
                Circle().fill(Palette.needs).frame(width: 7, height: 7)
                    .accessibilityLabel("Disconnected")
            }
            // THIS phone's mic, not the daemon's. The published state describes
            // the Mac, so while the phone held the ear the indicator was
            // reporting a microphone on the other side of the room — the one
            // state you cannot afford to be wrong about.
            //
            // While this phone holds the mic, glyph and word become the way to
            // CLOSE it. Icon and label are one Button on purpose: a button's hit
            // area is its label's frame, so wrapping only the 12pt glyph would
            // leave a 12pt target beside inert text that looks like part of it.
            // Otherwise it is a plain status glyph: one that sometimes does
            // something is worse than one that never does.
            if isTalkingHere {
                Button { talk.closeMic() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 12))
                        Text("Mic open")
                            .font(Type.caption)
                    }
                    .foregroundStyle(Palette.micOpen)
                }
                .accessibilityLabel("Close the microphone")
                .accessibilityHint("Keeps what you have said")
            } else {
                Image(systemName: mark.symbol)
                    .font(.system(size: 12))
                    .foregroundStyle(mark.color)
            }
            // The word earns its place only when nothing else on screen
            // explains the glyph — a review card beneath saying the same
            // thing is clutter.
            if !isTalkingHere, mark != .review {
                Text(mark.caption)
                    .font(Type.caption)
                    .foregroundStyle(mark.color)
                    .lineLimit(1)
                    .accessibilityLabel(mark.meaning)
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
                    // Through the phone's door, so a refusal is said here and
                    // filed rather than a button that does nothing (A13).
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            settingsFailure = nil
                            bridge.openLink(url, sessionId: sessionId) { settingsFailure = $0 }
                        }
                    }
                    .font(Type.caption.weight(.medium))
                    .foregroundStyle(Palette.micOpen)
                    if let settingsFailure {
                        Text(settingsFailure)
                            .font(Type.caption)
                            .foregroundStyle(Palette.needs)
                    }
                }
                .padding(.horizontal, 20)
            }

            if let attachError {
                Text(attachError)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
            }

            if sendFailed {
                Text("Couldn't reach the Mac — try again.")
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
            }

            if let answerFailure {
                Text(answerFailure)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
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

            // What is attached, before it is sent. An attachment you cannot
            // see is one you cannot remove, and picking the wrong photo is the
            // most likely mistake at this step.
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments) { attachment in
                            ZStack(alignment: .topTrailing) {
                                Group {
                                    if let thumbnail = attachment.thumbnail {
                                        Image(uiImage: thumbnail)
                                            .resizable()
                                            .aspectRatio(contentMode: .fill)
                                    } else {
                                        Image(systemName: "photo")
                                            .foregroundStyle(Palette.textDim)
                                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                                    }
                                }
                                // ImageUpload retains only a 192 px first frame
                                // for this 64 pt tile, never the agent-sized data.
                                .frame(width: 64, height: 64)

                                Button {
                                    attachments.removeAll { $0.id == attachment.id }
                                    attachError = nil
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 16))
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .buttonStyle(.plain)
                                .padding(3)
                            }
                            .frame(width: 64, height: 64)
                            .background(Palette.raised)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }

            // One surface holding the field AND its controls, the shape
            // ChatGPT uses and Tyler asked for after two misses.
            //
            // The first attempt put three buttons beside the field and squeezed
            // it to half the screen; the second moved them to a row underneath,
            // which read as detached because it was a SEPARATE surface. The fix
            // is not where the buttons sit but what they sit on: inside the same
            // rounded container, the row is part of the composer rather than
            // chrome stacked beneath it.
            VStack(spacing: 10) {
                // What the recogniser hears right now, on its own line; it joins
                // the field when the phrase is final. In the field it was one
                // string you and the recogniser rewrote at once, and typing
                // mid-dictation garbled both: "so anywayi t so anywayink".
                if isTalkingHere, !talk.livePartial.text.isEmpty {
                    Text(talk.livePartial.text)
                        .font(Type.body)
                        .foregroundStyle(Palette.micOpen)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("Hearing: \(talk.livePartial.text)")
                }
                // The field says why Send is off on a row with no terminal.
                TextField(row?.noTerminal ?? "Type or talk…", text: draftBinding, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Type.body)
                    .foregroundStyle(Palette.textPrimary)
                    .lineLimit(1...7)
                    .focused($typing)
                    // `.return`, not `.send`: the field is multiline, so the key
                    // inserts a newline. Labelling it "send" made it say one
                    // thing and do another — and newlines matter, since an
                    // attached picture's path sits on its own line above what
                    // you are asking about.
                    .submitLabel(.return)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 14) {
                    // Plain glyphs on the left, weight reserved for the actions
                    // that send something.
                    PhotosPicker(selection: $pickedPhoto, matching: .images, photoLibrary: .shared()) {
                        Image(systemName: "plus")
                            .font(.system(size: 19, weight: .medium))
                            .frame(width: 30, height: 30)
                            .foregroundStyle(Palette.textPrimary)
                    }
                    .disabled(attaching)
                    .accessibilityLabel("Attach a picture")

                    // A background job no window is attached to: open one on
                    // the Mac, beside the field that says why Send is off.
                    if row?.attachable == true {
                        Button(action: openInTerminal) {
                            Label("Open in Terminal", systemImage: "terminal")
                                .font(Type.caption)
                                .foregroundStyle(Palette.textPrimary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens this session in a Terminal window on your Mac")
                    }

                    if canSend, !isSending {
                        // Deliberate deletion, kept. Everything else in the draft
                        // machinery refuses to lose your words, and that only
                        // works as a promise if you can throw them away yourself.
                        Button {
                            talk.discard(session: sessionId)
                            attachments = []
                            sendFailed = false
                        } label: {
                            Image(systemName: "trash")
                                .font(.system(size: 16, weight: .medium))
                                .frame(width: 30, height: 30)
                                .foregroundStyle(Palette.textFaint)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Discard what you have written")
                    }

                    Spacer(minLength: 0)

                    // The mic stays a mic and stays blue. It used to BECOME send
                    // as soon as you typed, which quietly broke the point of a
                    // shared draft: you could no longer dictate onto typed text.
                    Button(action: toggleTalk) {
                        Image(systemName: isTalkingHere ? "stop.fill" : "mic.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 38, height: 38)
                            .background(Palette.micOpen, in: Circle())
                            .foregroundStyle(Palette.bg)
                    }
                    .buttonStyle(.plain)
                    .disabled(isSending)
                    .accessibilityLabel(isTalkingHere ? "Close the microphone" : "Open the microphone")

                    // Stop sits where send would be, but only while the agent
                    // is mid-turn and you have nothing written. Noticing an
                    // agent has gone the wrong way while away from the desk
                    // used to mean watching it keep going.
                    if isWorking, !canSend, !isSending, row?.noTerminal == nil {
                        Button(action: stopTurn) {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 15, weight: .bold))
                                .frame(width: 38, height: 38)
                                .background(Palette.waiting, in: Circle())
                                .foregroundStyle(Palette.bg)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Stop this turn")
                        .transition(.scale.combined(with: .opacity))
                    }

                    if canSend || isSending {
                        Button(action: sendDraft) {
                            Group {
                                if isSending {
                                    ProgressView().controlSize(.small).tint(Palette.bg)
                                } else {
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 17, weight: .bold))
                                }
                            }
                            .frame(width: 38, height: 38)
                            .background(Palette.textPrimary, in: Circle())
                            .foregroundStyle(Palette.bg)
                        }
                        .buttonStyle(.plain)
                        .disabled(isSending || row?.noTerminal != nil)
                        .accessibilityLabel("Send")
                        .transition(.scale.combined(with: .opacity))
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .animation(.easeOut(duration: 0.16), value: canSend)
            .animation(.easeOut(duration: 0.16), value: talk.phase)
            .animation(.easeOut(duration: 0.16), value: sendingImagesOnly)
        }
        .padding(.top, 10)
        .background(.ultraThinMaterial.opacity(0.06))
    }

    /// The draft, editable. Reading and writing the same string speech uses is
    /// what makes typing and talking one surface rather than two.
    private var draftBinding: Binding<String> {
        Binding(
            get: { talk.draft(for: sessionId) },
            set: { talk.setDraft($0, for: sessionId) }
        )
    }

    /// Mid-turn, which is the only time stopping means anything.
    private var isWorking: Bool {
        row?.status == "working"
    }

    private func openInTerminal() {
        Task { _ = await bridge.send(sessionCommand: .attach, sessionId: sessionId) }
    }

    private func stopTurn() {
        let label = row?.label ?? ""
        Task { await bridge.interrupt(sessionId: sessionId, label: label) }
    }

    /// Answer the question that is on screen — and prove, at the moment of sending, that it
    /// is still the one being asked.
    ///
    /// The row disables itself once a question is no longer active, but that is the VIEW's
    /// state: a tap already in flight, or a screen that has not caught up, could still send an
    /// answer to a question the agent had moved on from, and the reply carried nothing that
    /// said which question it was for. It carries the question's own item id now, and is
    /// checked against the live conversation by the same rule the row is drawn by.
    ///
    /// The answers travel as `answers`, one per question, which the Mac types as the agent's
    /// picker keys; `summary` is only what the send is called. The option's label, sent as
    /// words, is what this used to send — and Claude Code's picker records option 1 for any
    /// typed words, so a phone answer was usually the wrong one.
    private func answerQuestion(_ summary: String, answers: [QuestionAnswer], questionID: String) {
        guard !summary.isEmpty, !answers.isEmpty, !optionReplyInFlight, row?.noTerminal == nil else { return }
        guard isStillAsking(questionID) else { return }
        optionReplyInFlight = true
        sendFailed = false
        answerFailure = nil
        let sessionLabel = row?.label ?? ""
        Task {
            let delivered = await bridge.inject(
                sessionId: sessionId,
                label: sessionLabel,
                text: summary,
                answers: answers,
                // The question these answers are for: refused by the Mac if another is up now.
                questionId: questionID
            )
            optionReplyInFlight = false
            // An option tap has no bubble to correct later, so only a refusal is reported.
            if case let .failed(reason) = delivered { answerFailure = reason }
        }
    }

    /// Allow ("once") or Deny ("deny") the permission prompt on screen, by its id: the Mac
    /// presses the dialog's keys only while that same prompt is still the one up.
    private func approve(_ kind: String) {
        guard let approval = row?.approval, approval.answerable != false,
              row?.noTerminal == nil, !optionReplyInFlight else { return }
        optionReplyInFlight = true
        sendFailed = false
        answerFailure = nil
        let sessionLabel = row?.label ?? ""
        Task {
            let delivered = await bridge.inject(
                sessionId: sessionId,
                label: sessionLabel,
                text: "\(kind == "deny" ? "Deny" : "Allow") \(approval.name)",
                approve: (kind: kind, id: approval.id)
            )
            optionReplyInFlight = false
            if case let .failed(reason) = delivered { answerFailure = reason }
        }
    }

    /// Whether the agent is still waiting on this exact question, by the same rule the row
    /// uses to enable itself: its tool call is still running.
    private func isStillAsking(_ questionID: String) -> Bool {
        guard let item = bridge.state?.conversations[sessionId]?.items.first(where: { $0.id == questionID }) else {
            return false
        }
        return item.question != nil && item.tool?.status == "running"
    }

    private func closeCleanly() {
        guard !closingSession else { return }
        closingSession = true
        Task {
            let closed = await bridge.closeSession(sessionId: sessionId)
            closingSession = false
            if closed { dismiss() }
            else {
                closeError = bridge.lastError
                showingCloseError = true
            }
        }
    }

    private var canSend: Bool {
        !attachments.isEmpty || talk.hasWords(for: sessionId)
    }

    /// A send in flight on either path — the controller's, or the direct one
    /// an image-only message takes.
    private var isSending: Bool {
        talk.phase == .sending || sendingImagesOnly
    }

    /// Prepare a picked photo and hold it. Nothing is sent yet.
    ///
    /// Tyler: "it shouldnt send right away anyways it should just add it to the
    /// input box and then I hit send after adding any text that I want". He is
    /// right, and it is also more robust — uploading at pick time meant a
    /// network failure surfaced while you were still composing, with nothing to
    /// retry. Now the picture rides the send, which already knows how to fail
    /// and keep your words.
    private func attach(_ item: PhotosPickerItem) async {
        guard attachments.count < Self.attachmentLimit else {
            attachError = "You can attach up to 4 pictures at a time."
            pickedPhoto = nil
            return
        }
        attaching = true
        attachError = nil
        defer { attaching = false; pickedPhoto = nil }

        guard let raw = try? await item.loadTransferable(type: Data.self) else {
            attachError = "Couldn't read that picture."
            return
        }
        // Sized for the agent that will actually read it — the ceiling differs
        // between Claude and Codex.
        guard let prepared = await ImageUpload.prepare(
            data: raw,
            type: item.supportedContentTypes.first,
            backend: row?.backend
        ) else {
            attachError = "That picture is too large to send."
            return
        }
        // A picker task should be serial, but enforce the bound again after
        // suspension so two overlapping callbacks can never exceed it.
        guard attachments.count < Self.attachmentLimit else {
            attachError = "You can attach up to 4 pictures at a time."
            return
        }
        attachments.append(PendingAttachment(
            data: prepared.data,
            ext: prepared.ext,
            thumbnail: prepared.previewData.flatMap(UIImage.init(data:))
        ))
    }

    private func sendDraft() {
        sendFailed = false
        attachError = nil
        let label = row?.label ?? ""
        let pending = attachments
        // A picture with no words is an ordinary message — "look at this". It
        // cannot go through the controller: TalkController.send exists to
        // shepherd a DRAFT through delivery and rightly refuses an empty one,
        // which made an image-only send a silent no-op. With no words to
        // protect there is nothing for it to guard, so this send goes direct,
        // its own flag standing in for the controller's `.sending`.
        if !talk.hasWords(for: sessionId) {
            guard !pending.isEmpty, !isSending else { return }
            sendingImagesOnly = true
            // Through the outbox, like any other message: it gets a bubble, an id its outcome
            // comes back with, and a late receipt that can still settle it.
            talk.sendPictures(
                session: sessionId,
                body: { await uploadBody(pending) },
                deliver: { body, opId in
                    await bridge.inject(sessionId: sessionId, label: label, text: body, opId: opId)
                },
                onFinish: { sendingImagesOnly = false }
            )
            return
        }
        sendWords()
    }

    /// Route through the controller so a typed message takes exactly the path a
    /// spoken one does: the mic closes, the draft is cleared only on a
    /// CONFIRMED delivery, and a failure leaves your words on a bubble to retry.
    /// Retry is this same call: an unconfirmed send's words head the draft.
    private func sendWords() {
        sendFailed = false
        let label = row?.label ?? ""
        let pending = attachments
        talk.send(session: sessionId) { text, opId in
            await deliver(text: text, opId: opId, pending: pending, label: label)
        }
    }

    /// Pictures first, because the message references their paths. If one
    /// fails the whole send fails, which keeps the words AND the images —
    /// half a message is worse than none.
    /// The pictures, uploaded, as the body a picture-only message actually sends. Nil when one
    /// fails: half a message is worse than none, and the attachments stay for the retry.
    private func uploadBody(_ pending: [PendingAttachment]) async -> String? {
        guard let paths = await uploadPaths(pending) else { return nil }
        return paths.joined(separator: "\n")
    }

    private func uploadPaths(_ pending: [PendingAttachment]) async -> [String]? {
        var paths: [String] = []
        for attachment in pending {
            guard let path = await bridge.uploadImage(
                data: attachment.data,
                ext: attachment.ext
            ) else {
                attachError = "Couldn't send the picture — try again."
                return nil
            }
            paths.append(path)
        }
        return paths
    }

    private func deliver(
        text: String,
        opId: String? = nil,
        pending: [PendingAttachment],
        label: String
    ) async -> BridgeClient.InjectOutcome {
        guard let paths = await uploadPaths(pending) else {
            return .failed("Not delivered — the picture didn't upload.")
        }
        let body = (paths + [text]).filter { !$0.isEmpty }.joined(separator: "\n")
        let delivered = await bridge.inject(sessionId: sessionId, label: label, text: body, opId: opId)
        // The WORDS follow the strict rule — only proof lets them go — and that is handled by
        // the outbox. The pictures are already uploaded to the Mac, so only a known failure
        // keeps them here for the retry that re-sends them.
        switch delivered {
        case .failed:
            // Words say this on their own bubble; pictures alone have nowhere else.
            if text.isEmpty { sendFailed = true }
        case .unknown:
            // Uncertainty keeps them too. Clearing the pictures here would make the retry
            // send words without them, for a message that may never have arrived.
            break
        default:
            attachments = []
        }
        return delivered
    }

    /// Open the mic, or close it. Never send — that is the other button now.
    ///
    /// It used to send on the second tap, because the mic WAS the send button.
    /// With them separated, tapping the mic again has to mean "stop listening",
    /// and closing it keeps every word for the send that follows.
    private func toggleTalk() {
        sendFailed = false
        typing = false
        if isTalkingHere {
            talk.closeMic()
        } else {
            talk.open(session: sessionId)
        }
    }
}

/// The hot recognition hypothesis has its own invalidation boundary. The
/// stable controller still belongs to the app and SessionView still observes
/// phase, failures, target and committed text; only the many-times-per-second
/// partial publication stops at the composer.
private struct ComposerUpdateScope<Content: View>: View {
    @ObservedObject private var partial: TalkController.LivePartial
    private let content: () -> Content

    init(
        partial: TalkController.LivePartial,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.partial = partial
        self.content = content
    }

    var body: some View {
        _ = partial.text
        return content()
    }
}

/// A message you sent, until the conversation shows it for itself.
///
/// Drawn like the conversation's own user row, so the handover is a caption
/// going away rather than a bubble jumping.
private struct YourTurnBubble: View {
    let message: TalkController.Outgoing
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack {
                Spacer(minLength: 40)
                Text(message.text)
                    .font(Type.body)
                    .foregroundStyle(Palette.textPrimary)
                    .multilineTextAlignment(.leading)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14))
            }
            status
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .transition(.opacity)
        .contextMenu {
            if message.state.isTerminal == false || message.state == .staged {
                Button("Try again", systemImage: "arrow.clockwise", action: onRetry)
                Button("Discard", systemImage: "trash", role: .destructive, action: onDiscard)
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch message.state {
        // Optimistic, immediate, and honest: it says the action went through, never that
        // anything has been delivered. A send stays here for as long as the Mac is still
        // working on it — which can be well past the twenty seconds it takes to answer.
        case .sent:
            Text("Sent")
                .font(Type.caption)
                .foregroundStyle(Palette.textFaint)
        // The quiet mark: still "Sent", now with proof next to it. Tyler asked for exactly
        // this — "a confirmed icon but still show as sent", so nothing jumps when it lands.
        case .confirmed:
            Label("Sent", systemImage: "checkmark")
                .font(Type.caption)
                .foregroundStyle(Palette.textFaint)
                .accessibilityLabel("Sent, and confirmed by your Mac")
        case .staged:
            Text("Staged — not submitted")
                .font(Type.caption)
                .foregroundStyle(Palette.needs)
        // Not a failure and not a confirmation: conch could not tell. It says so, keeps the
        // words, and stays open to the answer the Mac publishes afterwards.
        case let .unknown(reason):
            HStack(spacing: 10) {
                Text(reason)
                    .font(Type.caption)
                    .foregroundStyle(Palette.waiting)
                    .multilineTextAlignment(.trailing)
                Button("Retry", action: onRetry)
                    .font(Type.caption.weight(.semibold))
                    .foregroundStyle(Palette.micOpen)
                    .buttonStyle(.plain)
            }
            .accessibilityHint("Long press to discard it")
        case let .failed(reason):
            HStack(spacing: 10) {
                Text(reason)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
                    .multilineTextAlignment(.trailing)
                Button("Retry", action: onRetry)
                    .font(Type.caption.weight(.semibold))
                    .foregroundStyle(Palette.micOpen)
                    .buttonStyle(.plain)
            }
            .accessibilityHint("Long press to discard it")
        }
    }
}

/// The permission prompt: what it wants, and Allow / Deny — the Mac's card (#370). Where
/// conch can't press keys at the dialog, it says so instead of offering buttons that would fail.
private struct ApprovalCard: View {
    let approval: PublishedState.Row.PendingApproval
    let noTerminal: String?
    let inFlight: Bool
    let onApprove: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Wants to use \(approval.name)")
                .font(Type.caption.weight(.semibold))
                .foregroundStyle(Palette.needs)
            Text(approval.summary)
                .font(Type.mono)
                .foregroundStyle(Palette.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if approval.answerable == false {
                Text("conch can't answer this agent's permission prompt — answer it in its terminal.")
                    .font(Type.caption)
                    .foregroundStyle(Palette.textDim)
            } else if let noTerminal {
                Text(noTerminal)
                    .font(Type.caption)
                    .foregroundStyle(Palette.textDim)
            } else {
                // No "Always allow": Claude Code's second option grants something different
                // per tool (for a Bash command, "always allow access to <folder> from this
                // project"), and a button cannot say what it would grant.
                HStack(spacing: 10) {
                    button("Allow", kind: "once", primary: true)
                    button("Deny", kind: "deny", primary: false)
                }
                .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.needs.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Palette.needs.opacity(0.35)))
    }

    private func button(_ title: String, kind: String, primary: Bool) -> some View {
        Button { onApprove(kind) } label: {
            Text(title)
                .font(Type.caption.weight(.semibold))
                .foregroundStyle(primary ? Palette.bg : Palette.textPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(primary ? Palette.needs : Palette.raised, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(inFlight)
        .accessibilityHint(kind == "deny" ? "Denies it; tell it what to do instead below" : "Allows this once")
    }
}

private struct ReviewCard: View {
    let review: PublishedState.Row.Review
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // The check, matching the Mac and the lab (`ic('check')` on `--ready`).
                // The phone and the Mac must not name the same state differently.
                Image(systemName: "checkmark.circle.fill")
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

/// A picture chosen but not yet sent: already converted and sized for the agent
/// that will read it, waiting for the send that carries it.
private struct PendingAttachment: Identifiable {
    let id = UUID()
    let data: Data
    let ext: String
    let thumbnail: UIImage?
}

/// A reply to the session whose work is on the review screen, so looking at
/// the work is not a dead end. It is the composer's own path: the session's
/// draft, `talk.send` clearing it only on a confirmed delivery, and the same
/// Sending, Delivered and Not delivered line with Retry.
struct ReviewReplyBar: View {
    @ObservedObject var bridge: BridgeClient
    @ObservedObject var talk: TalkController
    let sessionId: String

    private var row: PublishedState.Row? {
        bridge.state?.rows.first { $0.id == sessionId }
    }

    private var isSending: Bool {
        talk.phase == .sending && talk.targetSessionId == sessionId
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if let latest = talk.outgoing.last(where: { $0.session == sessionId }) {
                YourTurnBubble(
                    message: latest,
                    onRetry: send,
                    onDiscard: { talk.discardOutgoing(latest.id) }
                )
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField(
                    row?.noTerminal ?? "Reply to \(row?.label ?? "this session")…",
                    text: Binding(
                        get: { talk.draft(for: sessionId) },
                        set: { talk.setDraft($0, for: sessionId) }
                    ),
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(Type.body)
                .foregroundStyle(Palette.textPrimary)
                .lineLimit(1...4)
                .padding(.vertical, 9)
                Button(action: send) {
                    Group {
                        if isSending {
                            ProgressView().controlSize(.small).tint(Palette.bg)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 17, weight: .bold))
                        }
                    }
                    .frame(width: 38, height: 38)
                    .background(Palette.textPrimary, in: Circle())
                    .foregroundStyle(Palette.bg)
                }
                .buttonStyle(.plain)
                .disabled(isSending || row?.noTerminal != nil)
                .accessibilityLabel("Send reply")
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .padding(.vertical, 3)
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    /// An empty draft is refused by the controller itself.
    private func send() {
        let label = row?.label ?? ""
        talk.send(session: sessionId) { text, opId in
            await bridge.inject(sessionId: sessionId, label: label, text: text, opId: opId)
        }
    }
}
