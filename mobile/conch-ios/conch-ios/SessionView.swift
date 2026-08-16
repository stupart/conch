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
    @Environment(\.scenePhase) private var scenePhase
    @State private var showReview = false
    @State private var sendFailed = false
    @FocusState private var typing: Bool
    @State private var pickedPhoto: PhotosPickerItem?
    /// Prepared and waiting, NOT uploaded. Nothing leaves the phone until you
    /// press send — picking a picture is composing, not sending.
    @State private var attachments: [PendingAttachment] = []
    @State private var attaching = false
    @State private var attachError: String?
    /// An image-only send in flight. TalkController's `.sending` phase covers
    /// only sends that carry words; this is the same signal for the send that
    /// carries none.
    @State private var sendingImagesOnly = false
    @State private var fetchedReply: String?
    @State private var loadingReply = false
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
            ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let review = row?.review {
                        ReviewCard(review: review) {
                            showReview = true
                        }
                    }

                    // The whole conversation when the daemon has one for THIS
                    // session, which is what finally puts Codex sessions on the
                    // phone: their content never arrives as `reply`, because
                    // that carries only the last turn conch spoke, and conch
                    // does not speak for a session it merely observes.
                    if let conversation = bridge.state?.conversations[sessionId],
                       !conversation.items.isEmpty {
                        ConversationStack(conversation: conversation)
                    } else if let replyText {
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

                    // No draft bubble here any more. It existed because the
                    // input bar did not — there was nowhere else to watch your
                    // words arrive. Now the field holds them, and showing the
                    // same sentence twice while you type reads as a bug.
                    // Tyler: "its also showing the preview in blue tho as I
                    // type so its kinda weird".
                }
                .padding(20)
                .padding(.bottom, 12)
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
                        // While this phone holds the mic, the whole glyph-and-
                        // word chip becomes the way to CLOSE it — which the app
                        // had no way to do at all, since the bottom button
                        // sends. Icon and label are one Button on purpose: a
                        // button's hit area is its label's frame, so wrapping
                        // only the 12pt glyph would leave a 12pt target sitting
                        // next to inert text that looks like part of it.
                        //
                        // It is otherwise a plain status glyph. A status glyph
                        // that sometimes does something is worse than one that
                        // never does.
                        if isTalkingHere {
                            Button { talk.closeMic() } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "mic.fill")
                                        .font(.system(size: 12))
                                    Text("Mic open")
                                        .font(Type.caption)
                                }
                                .foregroundStyle(Palette.micOpen)
                                // The trailing inset goes here, matching this
                                // HStack's own spacing so the gap at the screen
                                // edge equals the gap between glyph and word.
                                .padding(.trailing, 6)
                            }
                            .accessibilityLabel("Close the microphone")
                            .accessibilityHint("Keeps what you have said")
                        } else {
                            // THIS phone's mic, not the daemon's. The published
                            // state describes the Mac, so while the phone held
                            // the ear the indicator was reporting a microphone
                            // on the other side of the room — the one state you
                            // cannot afford to be wrong about.
                            Image(systemName: mark.symbol)
                                .font(.system(size: 12))
                                .foregroundStyle(mark.color)
                        }
                        // The word earns its place only when nothing else on
                        // screen explains the glyph — a review card directly
                        // beneath saying the same thing is clutter.
                        if !isTalkingHere, row?.review == nil {
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

            if let attachError {
                Text(attachError)
                    .font(Type.caption)
                    .foregroundStyle(Palette.needs)
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
                TextField("Type or talk…", text: draftBinding, axis: .vertical)
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
                    if isWorking, !canSend, !isSending {
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
                        .disabled(isSending)
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

    private func stopTurn() {
        let label = row?.label ?? ""
        Task { await bridge.interrupt(sessionId: sessionId, label: label) }
    }

    private var canSend: Bool {
        !attachments.isEmpty
            || !talk.draft(for: sessionId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
        if talk.draft(for: sessionId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard !pending.isEmpty, !isSending else { return }
            sendingImagesOnly = true
            Task {
                _ = await deliver(text: "", pending: pending, label: label)
                sendingImagesOnly = false
            }
            return
        }
        // Route through the controller so a typed message takes exactly the
        // path a spoken one does: the mic closes, the draft is cleared only on
        // a CONFIRMED delivery, and a failure leaves your words on screen.
        talk.send(session: sessionId) { text in
            await deliver(text: text, pending: pending, label: label)
        }
    }

    /// Pictures first, because the message references their paths. If one
    /// fails the whole send fails, which keeps the words AND the images —
    /// half a message is worse than none.
    private func deliver(text: String, pending: [PendingAttachment], label: String) async -> Bool {
        var paths: [String] = []
        for attachment in pending {
            guard let path = await bridge.uploadImage(
                data: attachment.data,
                ext: attachment.ext
            ) else {
                attachError = "Couldn't send the picture — try again."
                return false
            }
            paths.append(path)
        }
        let body = (paths + [text]).filter { !$0.isEmpty }.joined(separator: "\n")
        let delivered = await bridge.inject(sessionId: sessionId, label: label, text: body)
        if delivered { attachments = [] } else { sendFailed = true }
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

/// A picture chosen but not yet sent: already converted and sized for the agent
/// that will read it, waiting for the send that carries it.
private struct PendingAttachment: Identifiable {
    let id = UUID()
    let data: Data
    let ext: String
    let thumbnail: UIImage?
}
