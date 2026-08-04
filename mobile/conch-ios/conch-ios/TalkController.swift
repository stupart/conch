import AVFoundation
import Speech

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

    /// SFSpeechRecognizer finalises a segment and STARTS OVER — on a pause, or
    /// around a minute of speech. `formattedString` then describes only the
    /// newest segment, so overwriting on every result threw away everything
    /// said before the last pause. Finalised text is banked here.
    @Published private(set) var committed = ""
    @Published private(set) var partial = ""

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?

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
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard status == .authorized else {
                    self.phase = .denied("Speech recognition is off for conch — enable it in Settings.")
                    return
                }
                await self.beginCapture()
            }
        }
    }

    private func beginCapture() async {
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .denied("Microphone access is off for conch — enable it in Settings.")
            return
        }
        let recognizer = SFSpeechRecognizer()
        guard let recognizer, recognizer.isAvailable else {
            phase = .denied("Speech recognition isn't available right now.")
            return
        }
        self.recognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On-device when the model supports it: private and offline-tolerant.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            // Reads self.request each time: a restarted segment swaps it, and a
            // tap holding the OLD request would feed audio into a dead task.
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            phase = .denied("Couldn't open the microphone: \(error.localizedDescription)")
            return
        }

        committed = ""
        partial = ""
        phase = .listening
        startRecognition(on: recognizer, request: request)
    }

    private func startRecognition(
        on recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest
    ) {
        recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self, self.phase == .listening else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        // Bank it and clear the partial: the next callback is a
                        // NEW segment starting from empty, not a continuation.
                        self.commit(text)
                    } else {
                        self.partial = text
                    }
                }
                if result?.isFinal == true || error != nil {
                    // The engine is still running and the user is still talking;
                    // a finished task just means this segment ended. Start the
                    // next one or the rest of the sentence is never heard.
                    self.restartRecognition()
                }
            }
        }
    }

    private func commit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { partial = ""; return }
        committed = committed.isEmpty ? trimmed : committed + " " + trimmed
        partial = ""
    }

    private func restartRecognition() {
        guard phase == .listening, let recognizer else { return }
        recognition = nil
        request?.endAudio()
        let next = SFSpeechAudioBufferRecognitionRequest()
        next.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            next.requiresOnDeviceRecognition = true
        }
        request = next
        startRecognition(on: recognizer, request: next)
    }

    private func finish(deliver: @escaping (String) async -> Bool) {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        recognition?.finish()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        commit(partial)
        let text = committed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            phase = .idle
            return
        }
        phase = .sending
        Task { @MainActor in
            let delivered = await deliver(text)
            // Keep the words on screen briefly on failure so they aren't lost.
            if delivered {
                self.committed = ""
                self.partial = ""
            }
            self.phase = .idle
        }
    }

    func cancel() {
        guard phase == .listening else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        recognition?.cancel()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        committed = ""
        partial = ""
        phase = .idle
    }
}
