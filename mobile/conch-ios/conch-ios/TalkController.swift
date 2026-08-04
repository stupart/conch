import AVFoundation
import Speech

/// Owns every captured PCM buffer exactly once, across immutable phrases.
///
/// Speech only permits one live recognition task at a time. When phrase A ends,
/// phrase B therefore has to accumulate while A reaches a terminal callback.
/// The audio tap cannot safely coordinate that handoff through MainActor, so one
/// lock assigns every whole buffer to A or B and creates B before exposing A's
/// boundary. No buffer is replayed into two phrases and no text overlap needs to
/// be guessed away later.
private final class PhraseAudioRouter: @unchecked Sendable {
    static let silenceThreshold: Float = 0.02
    static let trailingSilence: TimeInterval = 0.8
    static let maximumPhraseDuration: TimeInterval = 40

    enum BoundaryReason: Sendable {
        case silence
        case recognizerFinal
        case maximumDuration
        case send
    }

    struct Boundary: Sendable {
        let phraseID: Int
        let nextPhraseID: Int?
        let reason: BoundaryReason
    }

    enum InstallResult {
        case live
        case sealed
        case missing
    }

    private struct BufferedAudio {
        let sequence: Int
        let duration: TimeInterval
        let buffer: AVAudioPCMBuffer
    }

    private final class BufferedPhrase {
        let id: Int
        var buffers: [BufferedAudio] = []
        var deliveredCount = 0
        var request: SFSpeechAudioBufferRecognitionRequest?
        var installing = false
        var sealed = false
        var hasVoicedAudio = false
        var trailingSilenceDuration: TimeInterval = 0
        var totalDuration: TimeInterval = 0

        init(id: Int) { self.id = id }
    }

    private let lock = NSLock()
    private let onBoundary: @Sendable (Boundary) -> Void
    private var phrases: [Int: BufferedPhrase] = [:]
    private var pendingPhrases: [Int] = []
    private var activePhraseID: Int?
    private var nextPhraseID = 1
    private var nextSequence = 0
    private var accepting = false

    init(onBoundary: @escaping @Sendable (Boundary) -> Void) {
        self.onBoundary = onBoundary
    }

    /// Begin a fresh capture. Existing finalized text lives outside this router.
    func start() -> Int {
        lock.lock()
        phrases.removeAll(keepingCapacity: false)
        pendingPhrases.removeAll(keepingCapacity: false)
        activePhraseID = nil
        nextSequence = 0
        accepting = true
        let id = createPhraseLocked()
        lock.unlock()
        return id
    }

    /// Called by AVAudioEngine's tap. Copying and assignment happen under the
    /// same lock as sealing, so a callback is wholly before or after a boundary.
    func append(_ source: AVAudioPCMBuffer) {
        var boundary: Boundary?
        lock.lock()
        guard accepting,
              let phraseID = activePhraseID,
              let phrase = phrases[phraseID],
              let copy = Self.copy(source) else {
            lock.unlock()
            return
        }

        nextSequence += 1
        let duration = source.format.sampleRate > 0
            ? TimeInterval(source.frameLength) / source.format.sampleRate
            : 0
        let item = BufferedAudio(sequence: nextSequence, duration: duration, buffer: copy)
        phrase.buffers.append(item)
        phrase.totalDuration += duration

        if let request = phrase.request, !phrase.installing {
            request.append(copy)
            phrase.deliveredCount = phrase.buffers.count
        }

        let voiced = Self.rootMeanSquare(source) >= Self.silenceThreshold
        if voiced {
            phrase.hasVoicedAudio = true
            phrase.trailingSilenceDuration = 0
        } else if phrase.hasVoicedAudio {
            phrase.trailingSilenceDuration += duration
        }

        let reason: BoundaryReason?
        if phrase.hasVoicedAudio,
           phrase.trailingSilenceDuration >= Self.trailingSilence {
            reason = .silence
        } else if phrase.totalDuration >= Self.maximumPhraseDuration {
            reason = .maximumDuration
        } else {
            reason = nil
        }

        if let reason {
            boundary = sealLocked(phraseID: phraseID, reason: reason, createSuccessor: true)
        }
        lock.unlock()

        if let boundary { onBoundary(boundary) }
    }

    /// Atomically seal the current phrase and, while capture continues, make a
    /// successor its owner. The triggering buffer remains in the ending phrase.
    func sealCurrentPhrase(
        expectedPhraseID: Int? = nil,
        reason: BoundaryReason,
        createSuccessor: Bool = true
    ) -> Boundary? {
        lock.lock()
        guard let phraseID = activePhraseID,
              expectedPhraseID == nil || expectedPhraseID == phraseID else {
            lock.unlock()
            return nil
        }
        let boundary = sealLocked(
            phraseID: phraseID,
            reason: reason,
            createSuccessor: createSuccessor && accepting
        )
        lock.unlock()
        return boundary
    }

    /// Stop accepting tap buffers and seal the exact last phrase. No successor
    /// is created because capture hardware is already stopping for the barrier.
    func closeAndSeal(reason: BoundaryReason) -> Boundary? {
        lock.lock()
        accepting = false
        guard let phraseID = activePhraseID else {
            lock.unlock()
            return nil
        }
        let boundary = sealLocked(phraseID: phraseID, reason: reason, createSuccessor: false)
        lock.unlock()
        return boundary
    }

    /// If Speech or the system finalizes a task before our RMS boundary fires,
    /// rotate synchronously on the delegate callback so the tap never keeps
    /// appending to a phrase which its recognizer has already finalized.
    func recognizerDidFinalize(_ phraseID: Int) {
        var boundary: Boundary?
        lock.lock()
        if accepting, activePhraseID == phraseID {
            boundary = sealLocked(
                phraseID: phraseID,
                reason: .recognizerFinal,
                createSuccessor: true
            )
        }
        lock.unlock()
        if let boundary { onBoundary(boundary) }
    }

    /// Feed a phrase's retained prefix without blocking the tap lock. While a
    /// batch is appended, new buffers only join the phrase FIFO. The empty-FIFO
    /// check and transition to direct/live delivery are one locked operation,
    /// so a new buffer can neither overtake the prefix nor be sent twice.
    func install(_ request: SFSpeechAudioBufferRecognitionRequest, for phraseID: Int) -> InstallResult {
        lock.lock()
        guard let phrase = phrases[phraseID] else {
            lock.unlock()
            return .missing
        }
        phrase.installing = true
        phrase.request = nil
        lock.unlock()

        while true {
            lock.lock()
            guard let phrase = phrases[phraseID] else {
                lock.unlock()
                return .missing
            }
            let start = phrase.deliveredCount
            let batch = start < phrase.buffers.count
                ? Array(phrase.buffers[start...])
                : []
            phrase.deliveredCount = phrase.buffers.count
            if batch.isEmpty {
                phrase.installing = false
                if phrase.sealed {
                    phrase.request = nil
                    lock.unlock()
                    return .sealed
                }
                phrase.request = request
                lock.unlock()
                return .live
            }
            lock.unlock()
            for item in batch { request.append(item.buffer) }
        }
    }

    /// A terminal task error may retry the same phrase from byte zero. Its PCM
    /// is retained until a final succeeds; this is not cross-phrase replay.
    func prepareRetry(for phraseID: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let phrase = phrases[phraseID] else { return false }
        phrase.request = nil
        phrase.installing = false
        phrase.deliveredCount = 0
        return true
    }

    func complete(_ phraseID: Int) {
        lock.lock()
        phrases.removeValue(forKey: phraseID)
        if pendingPhrases.first == phraseID {
            pendingPhrases.removeFirst()
        } else if let index = pendingPhrases.firstIndex(of: phraseID) {
            pendingPhrases.remove(at: index)
        }
        lock.unlock()
    }

    var firstPendingPhraseID: Int? {
        lock.withLock { pendingPhrases.first }
    }

    var pendingPhraseCount: Int {
        lock.withLock { pendingPhrases.count }
    }

    func hasVoicedAudio(_ phraseID: Int) -> Bool {
        lock.withLock { phrases[phraseID]?.hasVoicedAudio == true }
    }

    func reset() {
        lock.lock()
        accepting = false
        phrases.removeAll(keepingCapacity: false)
        pendingPhrases.removeAll(keepingCapacity: false)
        activePhraseID = nil
        lock.unlock()
    }

    private func createPhraseLocked() -> Int {
        let id = nextPhraseID
        nextPhraseID += 1
        phrases[id] = BufferedPhrase(id: id)
        pendingPhrases.append(id)
        activePhraseID = id
        return id
    }

    private func sealLocked(
        phraseID: Int,
        reason: BoundaryReason,
        createSuccessor: Bool
    ) -> Boundary? {
        guard let phrase = phrases[phraseID], !phrase.sealed else { return nil }
        phrase.sealed = true
        phrase.request = nil
        let successor = createSuccessor ? createPhraseLocked() : nil
        if successor == nil { activePhraseID = nil }
        return Boundary(phraseID: phraseID, nextPhraseID: successor, reason: reason)
    }

    private static func rootMeanSquare(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channels = buffer.floatChannelData else {
            // Unknown PCM is treated as voiced: a fixed detector may fail to
            // split, but it must never discard quiet/unsupported audio.
            return 1
        }
        let channelCount = Int(buffer.format.channelCount)
        let frameCount = Int(buffer.frameLength)
        guard channelCount > 0, frameCount > 0 else { return 0 }
        var sum: Float = 0
        for channel in 0..<channelCount {
            let samples = channels[channel]
            for frame in 0..<frameCount {
                let sample = samples[frame]
                sum += sample * sample
            }
        }
        return sqrt(sum / Float(channelCount * frameCount))
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
                  let destinationData = destinationBuffers[index].mData else { return nil }
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

/// Aggregates one task's final before reporting terminal completion. A successor
/// is not started merely because `didFinishRecognition` fired; Apple can still
/// consider the task active until `didFinishSuccessfully`.
private final class PhraseRecognitionDelegate: NSObject, SFSpeechRecognitionTaskDelegate,
    @unchecked Sendable {
    typealias PartialHandler = @Sendable (Int, Int, Int, String) -> Void
    typealias FinalDetectedHandler = @Sendable (Int) -> Void
    typealias FinishedHandler = @Sendable (Int, Int, Int, Bool, String?, String?) -> Void

    private let phraseID: Int
    private let token: Int
    private let epoch: Int
    private let onPartial: PartialHandler
    private let onFinalDetected: FinalDetectedHandler
    private let onFinished: FinishedHandler
    private let lock = NSLock()
    private var finalText: String?

    init(
        phraseID: Int,
        token: Int,
        epoch: Int,
        onPartial: @escaping PartialHandler,
        onFinalDetected: @escaping FinalDetectedHandler,
        onFinished: @escaping FinishedHandler
    ) {
        self.phraseID = phraseID
        self.token = token
        self.epoch = epoch
        self.onPartial = onPartial
        self.onFinalDetected = onFinalDetected
        self.onFinished = onFinished
    }

    func speechRecognitionTask(
        _ task: SFSpeechRecognitionTask,
        didHypothesizeTranscription transcription: SFTranscription
    ) {
        onPartial(phraseID, token, epoch, transcription.formattedString)
    }

    func speechRecognitionTask(
        _ task: SFSpeechRecognitionTask,
        didFinishRecognition recognitionResult: SFSpeechRecognitionResult
    ) {
        lock.withLock { finalText = recognitionResult.bestTranscription.formattedString }
        onFinalDetected(phraseID)
    }

    func speechRecognitionTask(
        _ task: SFSpeechRecognitionTask,
        didFinishSuccessfully successfully: Bool
    ) {
        let text = lock.withLock { finalText }
        onFinished(phraseID, token, epoch, successfully, text, task.error?.localizedDescription)
    }
}

/// Push-to-talk, transcribed ON the phone as discrete immutable final phrases.
@MainActor
final class TalkController: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case denied(String)
        case listening
        case sending
    }

    @Published private(set) var phase = Phase.idle

    /// Immutable final phrases are truth; the revisable hypothesis is display only.
    var transcript: String {
        [segments.joined(separator: " "), partial]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    @Published private(set) var segments: [String] = [] {
        didSet { persistDrafts() }
    }
    @Published private(set) var partial = ""
    @Published private(set) var failure: String?
    @Published private(set) var targetSessionId: String?

    private var parked: [String: [String]] = [:]
    private var pendingLegacyDraft: String?
    private static let draftKey = "conch.drafts"
    private static let legacyDraftKey = "conch.draft.committed"

    override init() {
        let defaults = UserDefaults.standard
        let newSchemaExists = defaults.object(forKey: Self.draftKey) != nil
        if let stored = defaults.dictionary(forKey: Self.draftKey) {
            for (session, value) in stored {
                if let savedSegments = value as? [String] {
                    parked[session] = savedSegments.filter { !$0.isEmpty }
                } else if let joined = value as? String, !joined.isEmpty {
                    // Migrate the first per-session String schema in place.
                    parked[session] = [joined]
                }
            }
        }
        if !newSchemaExists,
           let legacy = defaults.string(forKey: Self.legacyDraftKey),
           !legacy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // The legacy value has no owner. Adopt it only when the user next
            // chooses a session; a newer schema is authoritative if it exists.
            pendingLegacyDraft = legacy
        } else if newSchemaExists {
            defaults.removeObject(forKey: Self.legacyDraftKey)
        }
        super.init()
        if newSchemaExists { defaults.set(parked, forKey: Self.draftKey) }
    }

    /// What is waiting for one conversation, including only this capture's live hypothesis.
    func draft(for session: String) -> String {
        if session == targetSessionId { return transcript }
        return (parked[session] ?? []).joined(separator: " ")
    }

    /// The only user-directed destructive operation. It is unavailable while a
    /// send acknowledgement is in flight, so failure can always leave a retry.
    func discard(session: String) {
        guard phase != .sending else { return }
        if session == targetSessionId {
            if phase == .listening || starting { cancel() }
            audioRouter.reset()
            partial = ""
            failure = nil
            segments.removeAll()
        } else {
            parked.removeValue(forKey: session)
            persistDrafts()
        }
    }

    private func persistDrafts() {
        var all = parked
        if let target = targetSessionId {
            if segments.isEmpty { all.removeValue(forKey: target) }
            else { all[target] = segments }
        }
        UserDefaults.standard.set(all, forKey: Self.draftKey)
    }

    private func switchTarget(to session: String) {
        guard targetSessionId != session else { return }
        if let previous = targetSessionId {
            if segments.isEmpty { parked.removeValue(forKey: previous) }
            else { parked[previous] = segments }
        }
        targetSessionId = session
        partial = ""
        failure = nil
        if let existing = parked[session] {
            segments = existing
        } else if let legacy = pendingLegacyDraft {
            segments = [legacy]
            pendingLegacyDraft = nil
            UserDefaults.standard.removeObject(forKey: Self.legacyDraftKey)
        } else {
            segments = []
        }
    }

    /// Called immediately before the mic opens, to silence anything speaking.
    /// The Mac has refused to open the mic while TTS speaks since day one; the
    /// phone only ever got the other half of that invariant.
    var silenceSpeech: () -> Void = {}

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var recognitionDelegate: PhraseRecognitionDelegate?
    private var tapInstalled = false
    private var starting = false

    /// Capture-wide invalidation, distinct from each phrase's identity/token.
    private var captureEpoch = 0
    private var taskToken = 0
    private var processingPhraseID: Int?
    private var finishingPhraseID: Int?
    private var retryCount: [Int: Int] = [:]
    private var phraseWallTask: Task<Void, Never>?
    private var phraseFinalizationTask: Task<Void, Never>?
    private var phraseCancellationGraceTask: Task<Void, Never>?

    private var finalBarrierResolved = false
    private var finalBarrierSucceeded = false
    private var finalBarrierContinuation: CheckedContinuation<Void, Never>?
    private var finalBarrierTimeout: Task<Void, Never>?

    private lazy var audioRouter = PhraseAudioRouter { [weak self] boundary in
        Task { @MainActor [weak self] in self?.phraseDidSeal(boundary) }
    }

    func toggle(session: String, deliver: @escaping (String) async -> Bool) {
        if phase == .sending { return }
        if phase == .listening {
            // Another session cannot cancel or inherit a volatile live phrase.
            // Finish/discard the owner first; its button remains the only Send.
            guard session == targetSessionId else { return }
            finish(deliver: deliver)
            return
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
        // Before the route changes, but only once we know we are opening it:
        // an aborted start must not stop audio for nothing.
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
        captureEpoch += 1
        partial = ""
        retryCount.removeAll()

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let firstPhraseID = audioRouter.start()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            let router = audioRouter
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                router.append(buffer)
            }
            tapInstalled = true
            phase = .listening
            startRecognition(for: firstPhraseID)
            scheduleWallLimit(for: firstPhraseID)
            engine.prepare()
            try engine.start()
            starting = false
        } catch {
            starting = false
            stopCaptureHardware()
            invalidateRecognition()
            audioRouter.reset()
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

    private func startRecognition(for phraseID: Int) {
        guard processingPhraseID == nil, let recognizer else { return }
        taskToken += 1
        let token = taskToken
        let epoch = captureEpoch
        let request = makeRequest(for: recognizer)
        let delegate = PhraseRecognitionDelegate(
            phraseID: phraseID,
            token: token,
            epoch: epoch,
            onPartial: { [weak self] phraseID, token, epoch, text in
                Task { @MainActor [weak self] in
                    self?.receivePartial(text, phraseID: phraseID, token: token, epoch: epoch)
                }
            },
            onFinalDetected: { [audioRouter] phraseID in
                audioRouter.recognizerDidFinalize(phraseID)
            },
            onFinished: { [weak self] phraseID, token, epoch, succeeded, finalText, error in
                Task { @MainActor [weak self] in
                    self?.recognitionFinished(
                        phraseID: phraseID,
                        token: token,
                        epoch: epoch,
                        succeeded: succeeded,
                        finalText: finalText,
                        error: error
                    )
                }
            }
        )
        processingPhraseID = phraseID
        self.request = request
        recognitionDelegate = delegate
        recognition = recognizer.recognitionTask(with: request, delegate: delegate)

        switch audioRouter.install(request, for: phraseID) {
        case .live:
            break
        case .sealed:
            endRecognitionInput(for: phraseID)
        case .missing:
            recognition?.cancel()
            clearRecognitionReferences()
            startNextPhraseIfNeeded()
        }
    }

    private func receivePartial(_ text: String, phraseID: Int, token: Int, epoch: Int) {
        guard epoch == captureEpoch,
              token == taskToken,
              phraseID == processingPhraseID else { return }
        // Revisions may grow, shrink, or empty. They are display only and can
        // never mutate the immutable final segment buffer.
        partial = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func recognitionFinished(
        phraseID: Int,
        token: Int,
        epoch: Int,
        succeeded: Bool,
        finalText: String?,
        error: String?
    ) {
        guard epoch == captureEpoch,
              token == taskToken,
              phraseID == processingPhraseID else { return }
        cancelPhraseFinalizationTimers()
        clearRecognitionReferences(keepProcessingID: true)

        let immutableFinal = finalText?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let phraseContainedVoice = audioRouter.hasVoicedAudio(phraseID)
        if !immutableFinal.isEmpty || (succeeded && !phraseContainedVoice) {
            if !immutableFinal.isEmpty { appendFinalSegment(immutableFinal) }
            partial = ""
            retryCount.removeValue(forKey: phraseID)
            audioRouter.complete(phraseID)
            processingPhraseID = nil
            startNextPhraseIfNeeded()
            checkFinalBarrier()
            return
        }

        if retryCount[phraseID, default: 0] < 1,
           audioRouter.prepareRetry(for: phraseID) {
            retryCount[phraseID, default: 0] += 1
            processingPhraseID = nil
            startRecognition(for: phraseID)
            return
        }

        failure = "Speech recognition couldn't finalize a phrase"
            + (error.map { ": \($0)" } ?? ". Finalized phrases are still kept.")
        stopCaptureHardware()
        if let boundary = audioRouter.closeAndSeal(reason: .send),
           boundary.phraseID != phraseID {
            phraseDidSeal(boundary)
        }
        resolveFinalBarrier(succeeded: false)
        if phase == .listening { phase = .idle }
    }

    /// Append exactly one terminal transcription. Repeated identical phrases
    /// remain distinct, just as DictationReducer preserves discrete Whisper rows.
    private func appendFinalSegment(_ text: String) {
        let final = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !final.isEmpty else { return }
        segments.append(final)
    }

    /// Used by the wall watchdog and Send. Rollover never stops or reinstalls
    /// the audio tap; the router swaps phrase ownership before `endAudio()`.
    private func sealCurrentPhrase(
        expectedPhraseID: Int? = nil,
        reason: PhraseAudioRouter.BoundaryReason,
        createSuccessor: Bool = true
    ) {
        guard let boundary = audioRouter.sealCurrentPhrase(
            expectedPhraseID: expectedPhraseID,
            reason: reason,
            createSuccessor: createSuccessor
        ) else { return }
        if boundary.phraseID == processingPhraseID {
            request?.endAudio()
            recognition?.finish()
            finishingPhraseID = boundary.phraseID
            schedulePhraseFinalizationTimeout(phraseID: boundary.phraseID, token: taskToken)
        }
        phraseDidSeal(boundary, recognitionAlreadyEnded: true)
    }

    private func phraseDidSeal(
        _ boundary: PhraseAudioRouter.Boundary,
        recognitionAlreadyEnded: Bool = false
    ) {
        if let nextPhraseID = boundary.nextPhraseID {
            scheduleWallLimit(for: nextPhraseID)
        } else {
            phraseWallTask?.cancel()
            phraseWallTask = nil
        }
        if boundary.phraseID == processingPhraseID, !recognitionAlreadyEnded {
            endRecognitionInput(for: boundary.phraseID)
        } else if processingPhraseID == nil {
            startNextPhraseIfNeeded()
        }
    }

    private func endRecognitionInput(for phraseID: Int) {
        guard processingPhraseID == phraseID, finishingPhraseID != phraseID else { return }
        finishingPhraseID = phraseID
        request?.endAudio()
        recognition?.finish()
        schedulePhraseFinalizationTimeout(phraseID: phraseID, token: taskToken)
    }

    private func startNextPhraseIfNeeded() {
        guard processingPhraseID == nil else { return }
        guard let next = audioRouter.firstPendingPhraseID else {
            checkFinalBarrier()
            return
        }
        startRecognition(for: next)
    }

    private func scheduleWallLimit(for phraseID: Int) {
        phraseWallTask?.cancel()
        phraseWallTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(PhraseAudioRouter.maximumPhraseDuration))
            guard !Task.isCancelled, let self, self.phase == .listening else { return }
            self.sealCurrentPhrase(expectedPhraseID: phraseID, reason: .maximumDuration)
        }
    }

    private func schedulePhraseFinalizationTimeout(phraseID: Int, token: Int) {
        phraseFinalizationTask?.cancel()
        phraseFinalizationTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled,
                  let self,
                  self.processingPhraseID == phraseID,
                  self.taskToken == token else { return }
            self.recognition?.cancel()
            self.phraseCancellationGraceTask?.cancel()
            self.phraseCancellationGraceTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled,
                      let self,
                      self.processingPhraseID == phraseID,
                      self.taskToken == token else { return }
                self.failure = "Speech recognition stalled. Finalized phrases are still kept."
                self.resolveFinalBarrier(succeeded: false)
                self.stopCaptureHardware()
                if self.phase == .listening { self.phase = .idle }
            }
        }
    }

    private func finish(deliver: @escaping (String) async -> Bool) {
        guard phase == .listening else { return }
        phase = .sending
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .milliseconds(120))

            self.armFinalBarrier()
            self.stopCaptureHardware()
            if let boundary = self.audioRouter.closeAndSeal(reason: .send) {
                self.phraseDidSeal(boundary)
            }
            self.checkFinalBarrier()
            await self.waitForAllFinalSegments()

            self.finalBarrierTimeout?.cancel()
            self.finalBarrierTimeout = nil
            let allPhrasesFinal = self.finalBarrierSucceeded

            // Every callback from this capture becomes inert before the network
            // await. Phrase identity handles FIFO; this epoch handles lifetime.
            self.captureEpoch += 1
            self.cancelPhraseFinalizationTimers()
            self.request?.endAudio()
            self.recognition?.cancel()
            self.clearRecognitionReferences()
            self.audioRouter.reset()

            let sentSegments = self.segments
            let text = sentSegments.joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                if !allPhrasesFinal {
                    self.failure = "Speech recognition couldn't finalize this phrase — nothing final was sent."
                }
                self.phase = .idle
                return
            }
            if !allPhrasesFinal {
                self.failure = "The last phrase did not finalize — sending only the finalized phrases."
            }

            let delivered = await deliver(text)
            if delivered {
                // Consume the exact immutable prefix acknowledged by this send.
                // Later segments, if any, are not text-prefix compared or cleared.
                if self.segments.starts(with: sentSegments) {
                    self.segments.removeFirst(sentSegments.count)
                }
            }
            self.phase = .idle
        }
    }

    private func armFinalBarrier() {
        finalBarrierResolved = false
        finalBarrierSucceeded = false
        finalBarrierTimeout?.cancel()
        finalBarrierTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(12))
            guard !Task.isCancelled, let self, !self.finalBarrierResolved else { return }
            self.resolveFinalBarrier(succeeded: false)
        }
    }

    private func checkFinalBarrier() {
        guard phase == .sending,
              audioRouter.pendingPhraseCount == 0,
              processingPhraseID == nil else { return }
        resolveFinalBarrier(succeeded: true)
    }

    private func waitForAllFinalSegments() async {
        if finalBarrierResolved { return }
        await withCheckedContinuation { continuation in
            if finalBarrierResolved {
                continuation.resume()
            } else {
                finalBarrierContinuation = continuation
            }
        }
    }

    private func resolveFinalBarrier(succeeded: Bool) {
        guard !finalBarrierResolved else { return }
        finalBarrierResolved = true
        finalBarrierSucceeded = succeeded
        let continuation = finalBarrierContinuation
        finalBarrierContinuation = nil
        continuation?.resume()
    }

    private func clearRecognitionReferences(keepProcessingID: Bool = false) {
        request = nil
        recognition = nil
        recognitionDelegate = nil
        finishingPhraseID = nil
        if !keepProcessingID { processingPhraseID = nil }
    }

    private func cancelPhraseFinalizationTimers() {
        phraseFinalizationTask?.cancel()
        phraseFinalizationTask = nil
        phraseCancellationGraceTask?.cancel()
        phraseCancellationGraceTask = nil
    }

    private func invalidateRecognition() {
        captureEpoch += 1
        phraseWallTask?.cancel()
        phraseWallTask = nil
        cancelPhraseFinalizationTimers()
        finalBarrierTimeout?.cancel()
        finalBarrierTimeout = nil
        request?.endAudio()
        recognition?.cancel()
        clearRecognitionReferences()
    }

    private func stopCaptureHardware() {
        engine.stop()
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
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
        audioRouter.reset()
        partial = ""
        failure = nil
        phase = .idle
    }
}
