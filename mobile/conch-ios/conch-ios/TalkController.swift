import AVFoundation
import Speech

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
    /// Unsent words for every OTHER session.
    ///
    /// A draft belongs to a conversation, not to the app. One controller now
    /// serves every session, so without this an unsent draft would follow you
    /// into the next session and be injected there — and worse, tapping the
    /// button while another session held the mic would deliver ITS words to
    /// whatever you happened to be looking at.
    private var parked: [String: String] = [:]
    private static let draftKey = "conch.drafts"

    /// What is waiting to be sent to `session`, active or parked.
    func draft(for session: String) -> String {
        session == targetSessionId ? transcript : (parked[session] ?? "")
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
    func send(session: String, deliver: @escaping (String) async -> Bool) {
        if phase == .sending { return }
        if phase == .listening, session == targetSessionId {
            finish(deliver: deliver)
            return
        }
        switchTarget(to: session)
        let text = committed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        phase = .sending
        Task { @MainActor [weak self] in
            guard let self else { return }
            let delivered = await deliver(text)
            if delivered {
                let held = self.committed.trimmingCharacters(in: .whitespacesAndNewlines)
                self.committed = held.hasPrefix(text)
                    ? String(held.dropFirst(text.count))
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    : ""
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
        if session == targetSessionId {
            committed = text
        } else {
            if text.isEmpty { parked.removeValue(forKey: session) } else { parked[session] = text }
            persistDrafts()
        }
    }

    /// Throw a draft away, on purpose.
    ///
    /// Everything else in here refuses to delete your words; that only works
    /// as a promise if you have a way to delete them yourself. Deliberate and
    /// explicit is the whole distinction — the bug was words vanishing
    /// without anyone asking.
    func discard(session: String) {
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
    @Published private(set) var partial = ""
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

    func toggle(session: String, deliver: @escaping (String) async -> Bool) {
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
        return request
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

    private func finish(deliver: @escaping (String) async -> Bool) {
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
            let delivered = await deliver(text)
            // Keep failed text intact; a subsequent Talk starts only after the
            // user has had a chance to copy/retry it from the visible bubble.
            if delivered {
                // Clear exactly what was acknowledged, never the whole buffer.
                // Assigning empty after an await deletes anything that arrived
                // during it — words that were never sent to anyone.
                let held = self.committed.trimmingCharacters(in: .whitespacesAndNewlines)
                self.committed = held.hasPrefix(text)
                    ? String(held.dropFirst(text.count))
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    : ""
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
