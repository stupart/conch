import ConchDesign
import AVFoundation
import Speech

/// Where the outbox is kept between launches.
private let conchOutboxKey = "conch.outbox"

/// Thread-safe handoff between AVAudioEngine's render callback and MainActor.
///
/// A recognition task can end before its callback reaches MainActor. Every
/// buffer is therefore retained until a result establishes a safe replay
/// cursor; rollover installs the next request atomically and replays everything
/// after that cursor. The overlap is removed at the text boundary, never at the
/// audio boundary — duplicate audio is recoverable, missing audio is not.
private final class RecognitionAudioRelay: @unchecked Sendable {
    private struct BufferedAudio {
        let sequence: Int
        let duration: TimeInterval
        let buffer: AVAudioPCMBuffer
    }

    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var buffered: [BufferedAudio] = []
    private var nextSequence = 0

    func append(_ source: AVAudioPCMBuffer) {
        guard let copy = Self.copy(source) else { return }
        let duration = source.format.sampleRate > 0
            ? TimeInterval(source.frameLength) / source.format.sampleRate
            : 0
        lock.lock()
        nextSequence += 1
        request?.append(copy)
        buffered.append(BufferedAudio(
            sequence: nextSequence,
            duration: duration,
            buffer: copy
        ))
        lock.unlock()
    }

    func cursor() -> Int {
        lock.withLock { nextSequence }
    }

    /// Cursor just before an overlap window ending at `sequence`.
    func replayCursor(endingAt sequence: Int, overlapSeconds: TimeInterval = 1.5) -> Int {
        lock.withLock {
            var duration: TimeInterval = 0
            var first = sequence + 1
            for item in buffered.reversed() where item.sequence <= sequence {
                first = item.sequence
                duration += item.duration
                if duration >= overlapSeconds { break }
            }
            return max(0, first - 1)
        }
    }

    /// Install a request and replay every retained buffer after the safe cursor.
    func install(_ next: SFSpeechAudioBufferRecognitionRequest, replayAfter cursor: Int?) {
        lock.lock()
        request = next
        if let cursor {
            for item in buffered where item.sequence > cursor {
                next.append(item.buffer)
            }
        }
        lock.unlock()
    }

    /// Stop feeding the current request after every in-flight tap callback has
    /// left the lock. The caller may then call endAudio without racing append.
    func detach() {
        lock.withLock { request = nil }
    }

    func discard(through cursor: Int) {
        lock.lock()
        let removed = buffered.prefix { $0.sequence <= cursor }
        buffered.removeFirst(removed.count)
        lock.unlock()
    }

    func reset() {
        lock.lock()
        request = nil
        buffered.removeAll(keepingCapacity: false)
        lock.unlock()
    }

    private static func copy(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(
            pcmFormat: source.format,
            frameCapacity: source.frameLength
        ) else { return nil }
        copy.frameLength = source.frameLength
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        guard sourceBuffers.count == destinationBuffers.count else { return nil }
        for index in sourceBuffers.indices {
            let sourceBuffer = sourceBuffers[index]
            guard let sourceData = sourceBuffer.mData,
                  let destinationData = destinationBuffers[index].mData else { continue }
            let bytes = Int(sourceBuffer.mDataByteSize)
            memcpy(destinationData, sourceData, bytes)
            destinationBuffers[index].mDataByteSize = sourceBuffer.mDataByteSize
        }
        return copy
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}

/// Push-to-talk, transcribed ON the phone.
///
/// On-device SFSpeechRecognizer means no audio crosses the network, no
/// contention with the Mac's microphone, and words appear as you say them.
/// Tap to start, tap to send — a hold gesture fails exactly when this app is
/// needed most, one-handed mid-workout.
@MainActor
final class TalkController: NSObject, ObservableObject {
    /// Recognition hypotheses publish far more often than controller state.
    /// Keeping them on a child object lets the composer observe live words
    /// without making every TalkController observer redraw with them.
    @MainActor final class LivePartial: ObservableObject {
        @Published fileprivate(set) var text = ""
    }

    enum Phase: Equatable {
        case idle
        case denied(String)
        case listening
        case sending
    }

    @Published private(set) var phase = Phase.idle
    /// Everything said this session: finalised segments plus the live partial.
    var transcript: String {
        [committed, partial].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Unsent words for the session being talked to right now.
    ///
    /// Append-only and written to disk on every change. Exactly ONE thing may
    /// clear it: a send the Mac confirmed. Not starting a recording, not a
    /// failed finalisation, not a teardown, not a relaunch, not a crash.
    ///
    /// This is a policy, not an optimisation, and it is here because the
    /// alternative kept failing. Three separate bugs deleted this string —
    /// a view lifecycle, an audio-session collision, a re-entered start — and
    /// each fix only closed the path it knew about. Words that cannot be
    /// deleted cannot be deleted by the next path either.
    @Published private(set) var committed = "" {
        didSet { persistDrafts() }
    }

    /// A message on its way, or one that did not arrive.
    ///
    /// Its words stay where every unsent word lives — `committed` or `parked`,
    /// persisted — until the Mac confirms them; the composer only stops SHOWING
    /// them, and the conversation shows them as a bubble instead. Tyler: a sent
    /// message "dissapears and then u have to wait a long time for it to show
    /// up", with nothing saying whether it went.
    /// The shared type, so the phone and the Mac cannot disagree about what "sent" means.
    typealias Outgoing = ConchOutboxEntry

    /// Sends this phone has not accounted for yet — kept across launches.
    ///
    /// An outcome can arrive long after the request that carried the words was answered and
    /// closed: twenty seconds later, after a reconnect, or after the app was killed and
    /// reopened. The outbox is what is still here to receive it. Nothing in it retries by
    /// itself; an unresolved send stays visible and says so.
    @Published private(set) var outbox = ConchOutbox.decode(UserDefaults.standard.data(forKey: conchOutboxKey)) {
        didSet { UserDefaults.standard.set(outbox.encoded(), forKey: conchOutboxKey) }
    }
    var outgoing: [Outgoing] { outbox.entries }
    /// Each session's user messages at the last look (`reconcile`).
    private var seenUserItems: [String: Set<String>] = [:]
    /// Unsent words for every OTHER session.
    ///
    /// A draft belongs to a conversation, not to the app. One controller now
    /// serves every session, so without this an unsent draft would follow you
    /// into the next session and be injected there — and worse, tapping the
    /// button while another session held the mic would deliver ITS words to
    /// whatever you happened to be looking at.
    ///
    /// `@Published` because the composer ASKS for it: `canSend` calls `hasWords(for:)`, which
    /// reads this for every session that is not the mic's current target. Without the wrapper
    /// SwiftUI was never told a keystroke landed, so `canSend` stayed stale and the send button
    /// was never built — Tyler: "where did the send button on the mobile app go? I have to
    /// press the audio button for it to show". Pressing the mic calls `switchTarget`, which
    /// assigns the published `targetSessionId` AND copies these words into the published
    /// `committed`, which is what made the button appear.
    ///
    /// The trash and stop buttons read `canSend` too, so they were stale on the same rows.
    ///
    /// No `didSet` here: `setDraft` already persists this path explicitly, and adding one
    /// would write UserDefaults twice on every keystroke.
    @Published private var parked: [String: String] = [:]
    private static let draftKey = "conch.drafts"

    /// What the composer's field holds for `session`: typed and banked words.
    ///
    /// Not the live hypothesis: that is `livePartial`, drawn on its own line
    /// above the field. Typing into a string the recogniser keeps rewriting
    /// interleaved the two — "so anywayi t so anywayink". And not a message on
    /// its way, which is a bubble in the conversation.
    func draft(for session: String) -> String {
        let stored = session == targetSessionId ? committed : (parked[session] ?? "")
        guard let hidden = unconfirmed(session, in: stored) else { return stored }
        return String(stored.drop(while: \.isWhitespace).dropFirst(hidden.count).drop(while: \.isWhitespace))
    }

    /// Whether there is anything to send to `session`, words still being heard included.
    func hasWords(for session: String) -> Bool {
        !draft(for: session).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (session == targetSessionId && !partial.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    /// The words of `session`'s unconfirmed send, when `stored` still starts with them.
    private func unconfirmed(_ session: String, in stored: String) -> String? {
        guard let text = outbox.unsettled(for: session)?.text,
              stored.drop(while: \.isWhitespace).hasPrefix(text) else { return nil }
        return text
    }

    /// Open the mic pointed at `session`, keeping whatever draft it already has.
    ///
    /// Split out of `toggle` because the mic and send are separate controls now:
    /// tapping the mic must never deliver anything, and it must be possible to
    /// dictate ONTO text you typed. Switching sessions still parks the previous
    /// draft under its own session rather than carrying it across.
    func open(session: String) {
        if phase == .sending { return }
        if phase == .listening {
            if session == targetSessionId { return }
            commit(partial)
            cancel()
        }
        switchTarget(to: session)
        start()
    }

    /// Send this session's draft, however it got there.
    ///
    /// While the mic is open this IS the existing finish path, so a typed
    /// correction to a dictated sentence is sent by the same code that has
    /// learned not to lose the tail. With the mic closed it delivers the draft
    /// directly — the case that did not exist before, because there was no way
    /// to have a draft without speaking one.
    ///
    /// Clearing follows the same rule either way: only what was ACKNOWLEDGED is
    /// removed, and only the exact prefix that was sent, so anything typed or
    /// heard during the round trip survives.
    func send(session: String, deliver: @escaping (String, String) async -> BridgeClient.InjectOutcome) {
        if phase == .sending { return }
        if phase == .listening, session == targetSessionId {
            finish(deliver: deliver)
            return
        }
        switchTarget(to: session)
        let text = committed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        phase = .sending
        let message = beginOutgoing(text, session: session)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let delivered = await deliver(text, message)
            self.settleOutgoing(message, delivered)
            if delivered.confirmed {
                self.committed = delivered.remainingDraft(self.committed, sent: text)
            }
            self.phase = .idle
        }
    }

    /// Type into the same draft speech is dictating into.
    ///
    /// Tyler: "i had the option to type messages... and what i said showed as
    /// transcription in that input bar there. gives the ability to still work
    /// when i can't make noise talking". One draft, two ways in — so a bad
    /// transcription is fixed in place rather than re-dictated, and a room where
    /// you cannot speak is not a room where conch stops working.
    ///
    /// Writes to `committed`, the banked half, and leaves `partial` alone: an
    /// edit must not fight words still arriving from the recogniser mid-sentence.
    func setDraft(_ text: String, for session: String) {
        let current = session == targetSessionId ? committed : (parked[session] ?? "")
        // The field never showed an unconfirmed send's words; they stay in front.
        let stored = unconfirmed(session, in: current).map { text.isEmpty ? $0 : $0 + " " + text } ?? text
        if session == targetSessionId {
            committed = stored
        } else {
            if stored.isEmpty { parked.removeValue(forKey: session) } else { parked[session] = stored }
            persistDrafts()
        }
    }

    /// One unconfirmed message per session: its words head this draft, so a
    /// new send carries them again.
    /// A picture with no words, sent the same way words are.
    ///
    /// `send` exists to shepherd a DRAFT and rightly refuses an empty one, so an image-only
    /// message used to go straight to the bridge — which meant no outbox entry, no bubble, no
    /// operation id, and therefore nothing for a late receipt to settle. It was the one send
    /// that could fail invisibly.
    ///
    /// The body is not known until the pictures are uploaded (it is their paths), and the
    /// entry has to carry the text that will actually land or `reconcile` can never retire its
    /// bubble against the transcript. So the upload happens first, then the entry, then the
    /// send that quotes its id.
    func sendPictures(
        session: String,
        body: @escaping () async -> String?,
        deliver: @escaping (String, String) async -> BridgeClient.InjectOutcome,
        onFinish: @escaping () -> Void = {}
    ) {
        switchTarget(to: session)
        Task { @MainActor [weak self] in
            defer { onFinish() }
            guard let self, let text = await body(), !text.isEmpty else { return }
            let id = self.beginOutgoing(text, session: session)
            self.settleOutgoing(id, await deliver(text, id))
        }
    }

    private func beginOutgoing(_ text: String, session: String) -> String {
        outbox.begin(Outgoing(
            session: session,
            text: text,
            earlierUserItems: seenUserItems[session] ?? []
        )).id
    }

    /// Accepted settles to `.sent`, which is where the message already was: the Mac has the
    /// words and is still working, so it goes on waiting for the answer that follows.
    private func settleOutgoing(_ id: String, _ outcome: BridgeClient.InjectOutcome) {
        outbox.settle(id, outcome.deliveryState)
    }

    /// Outcomes the Mac published for sends this phone is still holding.
    ///
    /// This is the path that did not exist: the request carrying the words is answered and
    /// closed after twenty seconds, and the truth turns up afterwards. It arrives on the
    /// state channel instead, matched by the id that went out with the send.
    func apply(_ deliveries: [PublishedState.Delivery]) {
        for delivery in deliveries where !delivery.opId.isEmpty {
            guard let entry = outbox.entries.first(where: { $0.id == delivery.opId }),
                  !entry.state.isTerminal else { continue }
            outbox.settle(delivery.opId, delivery.receipt.deliveryState)
            // Proven at last, so now — and only now — the words may leave the draft.
            if delivery.receipt.confirmed { dropFromDraft(entry) }
        }
    }

    /// Retire bubbles the conversation now shows for itself.
    ///
    /// A NEW user message with the same words is the transcript's own copy, so
    /// the bubble gives way instead of the message appearing twice. A send
    /// reported failed that turns up anyway (a timeout on a slow link) was
    /// delivered after all: the transcript is the stronger evidence, so its
    /// words leave the draft too.
    func reconcile(session: String, items: [ConversationItem]) {
        let users = items.filter { $0.kind == "user" }
        seenUserItems[session] = Set(users.map(\.id))
        for message in outbox.entries(for: session) {
            // A video sent on its own comes back as a receipt, which has none of its words: it names the same file.
            guard users.contains(where: {
                !message.earlierUserItems.contains($0.id)
                    && (Self.sameMessage($0.text, message.text) || $0.receipt?.stands(for: message.text) == true)
            }) else { continue }
            // Your words in the transcript are the strongest evidence there is — stronger
            // than a receipt that said it failed, and enough on their own to let them go.
            if !message.state.clearsDraft { dropFromDraft(message) }
            outbox.remove(message.id)
        }
        // ponytail: a confirmed bubble the transcript never shows (no published
        // conversation, or words the agent rewrote) goes after ten minutes; match
        // on something sturdier than the text if that proves common.
        outbox.prune(confirmedBefore: Date().addingTimeInterval(-600))
    }

    /// Throw away a message that did not arrive, on purpose.
    func discardOutgoing(_ id: String) {
        guard let message = outgoing.first(where: { $0.id == id }) else { return }
        if !message.state.clearsDraft { dropFromDraft(message) }
        outbox.remove(id)
    }

    private func dropFromDraft(_ message: Outgoing) {
        func without(_ stored: String) -> String {
            let held = stored.drop(while: \.isWhitespace)
            guard held.hasPrefix(message.text) else { return stored }
            return String(held.dropFirst(message.text.count).drop(while: \.isWhitespace))
        }
        if message.session == targetSessionId {
            committed = without(committed)
        } else if let held = parked[message.session] {
            let rest = without(held)
            if rest.isEmpty { parked.removeValue(forKey: message.session) } else { parked[message.session] = rest }
            persistDrafts()
        }
    }

    /// The transcript's copy of a sent message: the same words give or take
    /// whitespace, or ending with them when a picture's path leads the line.
    static func sameMessage(_ transcript: String, _ sent: String) -> Bool {
        let squash = { (text: String) in text.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        let seen = squash(transcript)
        let words = squash(sent)
        return !words.isEmpty && (seen == words || seen.hasSuffix(words))
    }

    /// Throw a draft away, on purpose.
    ///
    /// Everything else in here refuses to delete your words; that only works
    /// as a promise if you have a way to delete them yourself. Deliberate and
    /// explicit is the whole distinction — the bug was words vanishing
    /// without anyone asking.
    func discard(session: String) {
        for message in outbox.entries(for: session) where !message.state.clearsDraft {
            outbox.remove(message.id)
        }
        if session == targetSessionId {
            if phase == .listening || starting { cancel() }
            partial = ""
            failure = nil
            committed = ""
        } else {
            parked.removeValue(forKey: session)
            persistDrafts()
        }
    }

    private func persistDrafts() {
        var all = parked
        if let target = targetSessionId {
            if committed.isEmpty { all.removeValue(forKey: target) } else { all[target] = committed }
        }
        UserDefaults.standard.set(all, forKey: Self.draftKey)
    }

    /// Park the current draft under its own session and adopt `session`'s.
    private func switchTarget(to session: String) {
        guard targetSessionId != session else { return }
        if let previous = targetSessionId {
            if committed.isEmpty { parked.removeValue(forKey: previous) }
            else { parked[previous] = committed }
        }
        targetSessionId = session
        partial = ""
        failure = nil
        committed = parked[session] ?? ""
    }
    let livePartial = LivePartial()
    private var partial: String {
        get { livePartial.text }
        set { livePartial.text = newValue }
    }
    @Published private(set) var failure: String?
    /// Which session this draft is being spoken to.
    ///
    /// One controller now serves every session, because a per-view one died
    /// with its view and took your words with it. The cost is that a draft
    /// could surface under a conversation you did not say it to — so it is
    /// stamped once, at the moment you start talking, and shown nowhere else.
    @Published private(set) var targetSessionId: String?

    override init() {
        super.init()
        // A relaunch or a crash mid-utterance is not a decision to discard
        // what you said. Whatever was unsent when the process died is still
        // unsent now, and it is still yours.
        parked = UserDefaults.standard.dictionary(forKey: Self.draftKey) as? [String: String] ?? [:]
    }

    private let engine = AVAudioEngine()
    private let audioRelay = RecognitionAudioRelay()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var starting = false

    // All recognition callbacks carry this identity. Advancing it makes every
    // callback from the old task inert before the replacement can be mutated.
    private var generation = 0
    private var replayAfterSequence = 0
    /// Called immediately before the mic opens, to silence anything speaking.
    ///
    /// The Mac has refused to open the mic while TTS speaks since day one.
    /// The phone only ever got the OTHER half — speaking was gated on
    /// capture, capture was never gated on speaking. So the mic opened on top
    /// of a live utterance, `.record` tore the playback route out from under
    /// the synthesizer, and it stalled without ever calling didFinish: the
    /// button sat showing "speaking", nothing was audible, and the mic was
    /// live. Stopping first makes both states true at once impossible.
    var silenceSpeech: () -> Void = {}
    /// Why recognition last died. Shown when finalisation fails, because "it
    /// couldn't finish" is undiagnosable from a treadmill — the underlying
    /// error is what distinguishes an audio-session collision from a stall.
    private var lastRecognitionError: String?

    // Send waits for recognition to flush its final result. A stalled/erroring
    // task gets one recovery pass fed entirely from the retained audio relay.
    private var finishingGeneration: Int?
    private var finalizationRecoveryRemaining = 0
    private var finalizationResolved = false
    private var finalizationSucceeded = false
    private var finalizationContinuation: CheckedContinuation<Void, Never>?
    private var finalizationTimeout: Task<Void, Never>?

    func toggle(session: String, deliver: @escaping (String, String) async -> BridgeClient.InjectOutcome) {
        if phase == .sending { return }
        // Send ONLY into the session the words were spoken to. `deliver` comes
        // from whichever screen is on top, so a tap here while another session
        // held the mic would have injected its words into this one.
        if phase == .listening, session == targetSessionId {
            finish(deliver: deliver)
            return
        }
        if phase == .listening {
            // Tapping Talk in a different session means "talk to this one
            // instead" — keep what was said to the other, do not send it.
            commit(partial)
            cancel()
        }
        switchTarget(to: session)
        start()
    }

    private func start() {
        guard !starting else { return }
        failure = nil
        starting = true
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor [weak self] in
                guard let self, self.starting else { return }
                guard status == .authorized else {
                    self.starting = false
                    self.phase = .denied("Speech recognition is off for conch — enable it in Settings.")
                    return
                }
                await self.beginCapture()
            }
        }
    }

    private func beginCapture() async {
        guard starting else { return }
        // Before the route changes, not after.
        silenceSpeech()
        guard await AVAudioApplication.requestRecordPermission() else {
            starting = false
            phase = .denied("Microphone access is off for conch — enable it in Settings.")
            return
        }
        guard starting else { return }
        let recognizer = SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else {
            starting = false
            phase = .denied("Speech recognition isn't available right now.")
            return
        }
        self.recognizer = recognizer

        // Deliberately NOT clearing `committed`: a start that lands on top of
        // unsent words is a continuation, not a reset. Re-entering start was
        // one of the three paths that ate the transcript — you tap what you
        // believe is Send, phase has fallen back to idle, and it begins afresh.
        partial = ""
        lastRecognitionError = nil
        audioRelay.reset()
        let request = makeRequest(for: recognizer)
        self.request = request
        generation += 1
        replayAfterSequence = audioRelay.cursor()
        audioRelay.install(request, replayAfter: nil)

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            let relay = audioRelay
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                relay.append(buffer)
            }
            tapInstalled = true
            phase = .listening
            startRecognition(on: recognizer, request: request, generation: generation)
            engine.prepare()
            try engine.start()
            starting = false
        } catch {
            starting = false
            stopCaptureHardware()
            invalidateRecognition()
            audioRelay.reset()
            phase = .denied("Couldn't open the microphone: \(error.localizedDescription)")
        }
    }

    private func makeRequest(
        for recognizer: SFSpeechRecognizer
    ) -> SFSpeechAudioBufferRecognitionRequest {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        // Punctuation, because these words are going to an AGENT, not into a
        // notes field. An unpunctuated wall of dictation changes how a model
        // reads an instruction — where a sentence ends is where a clause stops
        // applying.
        request.addsPunctuation = true
        // Dictation, not search or short commands: it tells the recogniser to
        // expect connected speech rather than a few keywords.
        request.taskHint = .dictation
        // Words this recogniser has no reason to know and every reason to meet.
        // Apple's on-device model mangles technical vocabulary — it has never
        // heard "Codex" as a proper noun, and "conch" it hears as "cotch",
        // "conk", or "conscious". Naming them costs nothing per utterance.
        request.contextualStrings = Self.vocabulary
        return request
    }

    /// Terms conch's own conversations are full of, plus whatever the sessions
    /// happen to be called right now. Session names matter most: they are how
    /// you address a session out loud, so mishearing one sends your words to
    /// the wrong agent — or to none.
    private static let baseVocabulary = [
        "conch", "Codex", "Claude", "tmux", "Kokoro", "whisper", "daemon",
        "TestFlight", "Xcode", "SwiftUI", "TypeScript", "repo", "commit",
        "diff", "merge", "branch", "PR", "linter", "telemetry",
    ]

    /// Rebuilt when the session list changes, so a newly named session is
    /// recognisable the moment it appears.
    static var vocabulary: [String] = baseVocabulary

    static func learnSessionNames(_ names: [String]) {
        // Split on non-letters: "client-dashboard" is two words to a speech
        // recogniser, and offering it whole helps neither half.
        let words = names
            .flatMap { $0.split(whereSeparator: { !$0.isLetter }) }
            .map(String.init)
            .filter { $0.count > 2 }
        vocabulary = Array(Set(baseVocabulary + names + words))
    }

    private func startRecognition(
        on recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest,
        generation: Int
    ) {
        let relay = audioRelay
        recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // Capture the audio boundary before hopping actors. Buffers appended
            // after this cursor are unambiguously part of the replacement task.
            let callbackCursor = relay.cursor()
            Task { @MainActor [weak self] in
                self?.handleRecognition(
                    result: result,
                    error: error,
                    generation: generation,
                    callbackCursor: callbackCursor
                )
            }
        }
    }

    private func handleRecognition(
        result: SFSpeechRecognitionResult?,
        error: Error?,
        generation callbackGeneration: Int,
        callbackCursor: Int
    ) {
        guard callbackGeneration == generation else { return }
        if let error { lastRecognitionError = error.localizedDescription }

        if let result {
            let text = result.bestTranscription.formattedString
            if result.isFinal {
                // A final can arrive SHORTER than the partial it replaces, or
                // be a new phrase entirely. Same decision as any other
                // hypothesis — then bank whatever survives it.
                absorbPartial(removingCommittedOverlap(from: text))
                commit(partial)
            } else {
                absorbPartial(removingCommittedOverlap(from: text))
                // Retain a short overlap, plus every buffer after this callback,
                // then release audio older than that safe replay boundary.
                replayAfterSequence = audioRelay.replayCursor(endingAt: callbackCursor)
                audioRelay.discard(through: replayAfterSequence)
            }
        }

        guard result?.isFinal == true || error != nil else { return }
        if result?.isFinal != true {
            // Preserve the best reported text. Unreported audio is still in the
            // relay and will be replayed into the replacement/recovery request.
            commit(partial)
        }

        if finishingGeneration == callbackGeneration {
            if result?.isFinal == true {
                resolveFinalization(succeeded: true)
            } else if finalizationRecoveryRemaining > 0 {
                startFinalizationRecovery()
            } else {
                resolveFinalization(succeeded: false)
            }
            return
        }

        guard phase == .listening else { return }
        let cursor = result?.isFinal == true
            ? audioRelay.replayCursor(endingAt: callbackCursor)
            : replayAfterSequence
        restartRecognition(after: cursor)
    }

    /// Fold a fresh hypothesis into the visible draft.
    ///
    /// Until a result goes final the words on screen live in `partial`, and a
    /// nonfinal SFSpeech result replaces that whole string. Apple is explicit
    /// that a nonfinal transcription may represent only part of the audio, so
    /// a pause makes the recogniser hand back something SHORTER for speech it
    /// already reported. Assigning it wholesale emptied the bubble mid-
    /// sentence; refusing every shorter hypothesis then froze the transcript
    /// at its high-water mark and it never grew again. Both are the same
    /// mistake — reading one string as the whole truth.
    ///
    /// Shorter means one of two different things, and they need opposite
    /// handling:
    ///
    ///   revision   held "tell Tyler I will arrive"  next "tell Tyler"
    ///              -> same phrase, less of it. Keep what we have.
    ///   resegment  held "tell Tyler I will arrive"  next "so anyway"
    ///              -> a NEW phrase. Bank the old one and carry on.
    ///
    /// A prefix match separates them: a revision of a phrase still starts like
    /// that phrase, and a new phrase almost never does.
    private func absorbPartial(_ candidate: String) {
        let next = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        let held = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        if held.isEmpty { partial = next; return }
        // Silence between words, not a retraction of what was already said.
        if next.isEmpty { return }

        // Word count, not length: "I'll" -> "I will" is longer in characters
        // and says no more. Ties go to the newer text so in-place corrections
        // still land.
        let nextWords = next.split(whereSeparator: { $0.isWhitespace }).count
        let heldWords = held.split(whereSeparator: { $0.isWhitespace }).count
        if nextWords >= heldWords { partial = next; return }

        if held.lowercased().hasPrefix(next.lowercased()) { return }
        commit(held)
        partial = next
    }

    /// Append a segment while removing only a proven multi-word audio overlap.
    /// A one-word repeat may be intentional; preserving it is safer than loss.
    private func commit(_ text: String) {
        let novel = removingCommittedOverlap(from: text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // The replayed prefix has now been absorbed; anything the user says
        guard !novel.isEmpty else { partial = ""; return }
        committed = committed.isEmpty ? novel : committed + " " + novel
        partial = ""
    }

    private func removingCommittedOverlap(from text: String) -> String {
        let candidate = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Scoping this to rollover windows only was a mistake, reverted: it
        // has a SECOND job. When a resegment banks a phrase and the final for
        // that same audio then arrives in full, this is what stops the phrase
        // being appended twice. Removing that duplicated ~40 words of Tyler's
        // message straight into the session, which is far worse than the
        // deliberate-repeat case it was meant to fix (Codex #6, still open).
        guard !committed.isEmpty, !candidate.isEmpty else { return candidate }
        let existingWords = committed.split(whereSeparator: { $0.isWhitespace })
        let candidateWords = candidate.split(whereSeparator: { $0.isWhitespace })
        let limit = min(16, min(existingWords.count, candidateWords.count))
        guard limit >= 2 else { return candidate }

        func normalized(_ word: Substring) -> String {
            word.lowercased().trimmingCharacters(in: .punctuationCharacters)
        }
        for count in stride(from: limit, through: 2, by: -1) {
            let suffix = existingWords.suffix(count).map(normalized)
            let prefix = candidateWords.prefix(count).map(normalized)
            if suffix == prefix {
                return candidateWords.dropFirst(count).joined(separator: " ")
            }
        }

        // RESTATEMENT, not continuation. A final result can report the whole
        // utterance again rather than only the part since the last final, and
        // the loop above cannot see it: that compares what we HAVE ended with
        // against what the candidate STARTS with, and a restatement starts at
        // the beginning. Observed live — the same sentence arrived twice in one
        // block, the second copy opening "Right" where the first said "All
        // right", so it was not even byte-identical to compare against.
        //
        // Matching TAILS is the tell. Two independent transcriptions of the
        // same audio converge at the end far more reliably than at the start,
        // where a dropped leading word is common. Six words is long enough that
        // ordinary speech does not collide by accident.
        let tailWords = min(8, min(existingWords.count, candidateWords.count))
        if tailWords >= 6 {
            let existingTail = existingWords.suffix(tailWords).map(normalized)
            let candidateTail = candidateWords.suffix(tailWords).map(normalized)
            if existingTail == candidateTail {
                // Anything the candidate adds beyond what we hold would sit
                // AFTER that shared tail, and there is nothing after it.
                return ""
            }
        }
        return candidate
    }

    private func restartRecognition(after cursor: Int) {
        guard phase == .listening, let recognizer else { return }
        let previousRequest = request
        let previousRecognition = recognition
        generation += 1
        let next = makeRequest(for: recognizer)
        request = next
        replayAfterSequence = cursor
        // The relay moves first. Any tap callback concurrent with rollover is
        audioRelay.install(next, replayAfter: cursor)
        previousRequest?.endAudio()
        previousRecognition?.cancel()
        startRecognition(on: recognizer, request: next, generation: generation)
    }

    private func finish(deliver: @escaping (String, String) async -> BridgeClient.InjectOutcome) {
        guard phase == .listening else { return }
        phase = .sending
        Task { @MainActor [weak self] in
            guard let self else { return }
            // A tap is delivered in audio-buffer-sized chunks. Give its final
            // chunk time to arrive before stopping the engine; stopping at the
            // button edge can otherwise discard the last phoneme before the
            // relay ever sees it.
            try? await Task.sleep(for: .milliseconds(120))

            self.finishingGeneration = self.generation
            self.finalizationRecoveryRemaining = 1
            self.finalizationResolved = false
            self.finalizationSucceeded = false
            self.stopCaptureHardware()

            let finishingRequest = self.request
            let finishingTask = self.recognition
            self.scheduleFinalizationTimeout(for: self.generation)
            finishingRequest?.endAudio()
            finishingTask?.finish()
            if finishingTask == nil { self.resolveFinalization(succeeded: false) }

            await waitForFinalization()
            self.finalizationTimeout?.cancel()
            self.finalizationTimeout = nil
            self.finishingGeneration = nil
            // Make every in-flight callback from this capture inert BEFORE we
            // await the Mac. Cleanup nilled the references but left the
            // generation intact, so a late same-generation result could still
            // append a tail during the await — and then be deleted by the
            // clear below, having never been sent.
            self.generation += 1
            self.recognition = nil
            self.request = nil
            self.audioRelay.reset()

            let text = self.committed.trimmingCharacters(in: .whitespacesAndNewlines)
            // Words in hand get sent, whether or not recognition signed off.
            // Refusing to send text we already have because the recogniser
            // failed to say "done" punishes you for its problem: you asked to
            // send, the words exist, send them. The only thing a failed
            // finalisation costs is the tail it never reported, and that is
            // worth saying out loud rather than swallowing the whole message.
            guard !text.isEmpty else {
                if !self.finalizationSucceeded {
                    let why = self.lastRecognitionError.map { " (\($0))" } ?? ""
                    self.failure = "Speech recognition couldn't finish\(why) — nothing was captured."
                }
                self.phase = .idle
                return
            }
            if !self.finalizationSucceeded {
                self.failure = "Recognition cut out at the end — sending what it caught."
            }
            let message = self.beginOutgoing(text, session: self.targetSessionId ?? "")
            let delivered = await deliver(text, message)
            self.settleOutgoing(message, delivered)
            // Keep failed text intact; a subsequent Talk starts only after the
            // user has had a chance to copy/retry it from the visible bubble.
            if delivered.confirmed {
                // Clear exactly what was acknowledged, never the whole buffer.
                // Assigning empty after an await deletes anything that arrived
                // during it — words that were never sent to anyone.
                self.committed = delivered.remainingDraft(self.committed, sent: text)
            }
            self.phase = .idle
        }
    }

    private func waitForFinalization() async {
        if finalizationResolved { return }
        await withCheckedContinuation { continuation in
            if finalizationResolved {
                continuation.resume()
            } else {
                finalizationContinuation = continuation
            }
        }
    }

    private func resolveFinalization(succeeded: Bool) {
        guard !finalizationResolved else { return }
        finalizationResolved = true
        finalizationSucceeded = succeeded
        finalizationTimeout?.cancel()
        finalizationTimeout = nil
        let continuation = finalizationContinuation
        finalizationContinuation = nil
        continuation?.resume()
    }

    private func scheduleFinalizationTimeout(for generation: Int) {
        finalizationTimeout?.cancel()
        finalizationTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled,
                  let self,
                  self.finishingGeneration == generation else { return }
            if self.finalizationRecoveryRemaining > 0 {
                self.startFinalizationRecovery()
            } else {
                self.commit(self.partial)
                self.resolveFinalization(succeeded: false)
            }
        }
    }

    private func startFinalizationRecovery() {
        guard finalizationRecoveryRemaining > 0, let recognizer else {
            resolveFinalization(succeeded: false)
            return
        }
        finalizationRecoveryRemaining -= 1
        recognition?.cancel()
        request?.endAudio()

        generation += 1
        let recoveryGeneration = generation
        finishingGeneration = recoveryGeneration
        let recovery = makeRequest(for: recognizer)
        request = recovery
        audioRelay.install(recovery, replayAfter: replayAfterSequence)
        startRecognition(
            on: recognizer,
            request: recovery,
            generation: recoveryGeneration
        )
        scheduleFinalizationTimeout(for: recoveryGeneration)
        recovery.endAudio()
        recognition?.finish()
    }

    private func invalidateRecognition() {
        generation += 1
        request?.endAudio()
        recognition?.cancel()
        request = nil
        recognition = nil
    }

    private func stopCaptureHardware() {
        engine.stop()
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        audioRelay.detach()
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    /// Close the mic without sending and without losing a word.
    ///
    /// There was no way to do this at all: the bottom button SENDS while
    /// listening, so an accidentally-opened mic could only be resolved by
    /// sending something you did not mean to. Tyler: "I don't think there's a
    /// way to close the mic on the iPhone app".
    ///
    /// `cancel()` alone would drop the in-flight `partial` — the words spoken
    /// since the last commit — so the partial is banked first. Closing the mic
    /// is a decision about the MICROPHONE, never about the transcript, which
    /// stays exactly where it was for the next time you open it.
    func closeMic() {
        guard phase == .listening || starting else { return }
        commit(partial)
        cancel()
    }

    #if DEBUG
    /// For the snapshot script, with no microphone and no Mac (needs
    /// `-conchFixtureSession`): `-conchFixtureHearing <words>` with
    /// `-conchFixtureTyped <words>` is the composer mid-dictation, and
    /// `-conchFixtureOutgoing sent|failed|delivered` a message in that state.
    func showFixture() {
        let defaults = UserDefaults.standard
        guard let session = defaults.string(forKey: "conchFixtureSession") else { return }
        switchTarget(to: session)
        if let hearing = defaults.string(forKey: "conchFixtureHearing") {
            committed = defaults.string(forKey: "conchFixtureTyped") ?? committed
            livePartial.text = hearing
            phase = .listening
        }
        guard let state = defaults.string(forKey: "conchFixtureOutgoing") else { return }
        let text = "Ship it once the tests pass, and update the changelog."
        let fixtureState: ConchDeliveryState = switch state {
        case "sending", "sent": .sent
        case "failed": .failed(ConchSendFailure.sentence(reason: "system-dialog-blocking"))
        case "unknown": .unknown("Not confirmed — your Mac didn't say what happened. Your words are kept.")
        default: .confirmed
        }
        // Assigned either way: drafts and the outbox both survive a launch now, so a previous
        // shot's words would otherwise sit in the next one's composer.
        committed = fixtureState.clearsDraft ? "" : text
        outbox = ConchOutbox(entries: [Outgoing(session: session, text: text, state: fixtureState, earlierUserItems: [])])
    }
    #endif

    func cancel() {
        guard phase == .listening || starting else { return }
        starting = false
        stopCaptureHardware()
        invalidateRecognition()
        audioRelay.reset()
        partial = ""
        failure = nil
        phase = .idle
    }
}
