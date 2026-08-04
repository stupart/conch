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
    @Published private(set) var transcript = ""

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
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            phase = .denied("Couldn't open the microphone: \(error.localizedDescription)")
            return
        }

        transcript = ""
        phase = .listening
        recognition = recognizer.recognitionTask(with: request) { [weak self] result, _ in
            Task { @MainActor [weak self] in
                guard let self, self.phase == .listening else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
            }
        }
    }

    private func finish(deliver: @escaping (String) async -> Bool) {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        recognition?.finish()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            phase = .idle
            return
        }
        phase = .sending
        Task { @MainActor in
            let delivered = await deliver(text)
            // Keep the words on screen briefly on failure so they aren't lost.
            if delivered {
                self.transcript = ""
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
        transcript = ""
        phase = .idle
    }
}
