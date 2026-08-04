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

    @Published private(set) var committed = ""
    @Published private(set) var partial = ""
    @Published private(set) var failure: String?

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

    // Send waits for recognition to flush its final result. A stalled/erroring
    // task gets one recovery pass fed entirely from the retained audio relay.
    private var finishingGeneration: Int?
    private var finalizationRecoveryRemaining = 0
    private var finalizationResolved = false
    private var finalizationSucceeded = false
    private var finalizationContinuation: CheckedContinuation<Void, Never>?
    private var finalizationTimeout: Task<Void, Never>?

    func toggle(deliver: @escaping (String) async -> Bool) {
        switch phase {
        case .listening:
            finish(deliver: deliver)
        case .idle, .denied:
            start()
        case .sending:
            break
        }
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

        committed = ""
        partial = ""
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

        if let result {
            let text = result.bestTranscription.formattedString
            if result.isFinal {
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    commit(partial)
                } else {
                    commit(text)
                }
            } else {
                partial = removingCommittedOverlap(from: text)
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

    /// Append a segment while removing only a proven multi-word audio overlap.
    /// A one-word repeat may be intentional; preserving it is safer than loss.
    private func commit(_ text: String) {
        let novel = removingCommittedOverlap(from: text)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !novel.isEmpty else { partial = ""; return }
        committed = committed.isEmpty ? novel : committed + " " + novel
        partial = ""
    }

    private func removingCommittedOverlap(from text: String) -> String {
        let candidate = text.trimmingCharacters(in: .whitespacesAndNewlines)
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
        // serialized onto the new request, and retained audio fills its prefix.
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
            self.recognition = nil
            self.request = nil
            self.audioRelay.reset()

            let text = self.committed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard self.finalizationSucceeded else {
                self.failure = "Speech recognition couldn't finish — your recognized words are kept above."
                self.phase = .idle
                return
            }
            guard !text.isEmpty else {
                self.phase = .idle
                return
            }
            let delivered = await deliver(text)
            // Keep failed text intact; a subsequent Talk starts only after the
            // user has had a chance to copy/retry it from the visible bubble.
            if delivered {
                self.committed = ""
                self.partial = ""
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

    func cancel() {
        guard phase == .listening || starting else { return }
        starting = false
        stopCaptureHardware()
        invalidateRecognition()
        audioRelay.reset()
        committed = ""
        partial = ""
        failure = nil
        phase = .idle
    }
}
