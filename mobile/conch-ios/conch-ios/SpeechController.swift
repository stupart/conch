import AVFoundation
import SwiftUI

/// Reads finished turns aloud ON THE PHONE.
///
/// Synthesis has always happened on the Mac, which is right when you are at the
/// Mac and useless when you are not — the whole point of the phone is being
/// away from it, and audio coming out of a laptop in another room is not a
/// voice loop. This speaks locally instead: no audio crosses the network, it
/// follows your AirPods, and it works while the Mac sits muted.
@MainActor
final class SpeechController: NSObject, ObservableObject {
    @Published private(set) var isSpeaking = false
    /// Fired when a reply finishes being read, so the mic can open by itself.
    var onFinishedReading: (() -> Void)?
    /// Which session was just read, so the mic opens pointed at the right one.
    private(set) var lastSpokenSessionId: String?
    /// Whether the capture side still owns the audio route.
    ///
    /// Speaking and recording share one AVAudioSession singleton. Speaking
    /// flips it to `.playback` and reactivates it; doing that while capture
    /// owns the route tears down recognition, and the words you watched appear
    /// are thrown away. The Mac has refused to open the mic while TTS speaks
    /// since day one; the phone grew a second audio owner and never inherited
    /// the invariant.
    ///
    /// "Still owns it" outlasts the mic being open. Sending ends the audio but
    /// then waits up to three seconds for recognition to flush its final
    /// result — a window that gated on `.listening` alone left wide open, and
    /// tapping send is precisely when a queue of unread replies is released to
    /// pounce on it. That was the remaining loss.
    var captureOwnsAudio: () -> Bool = { false }
    private let synthesizer = AVSpeechSynthesizer()
    /// What has already been read, per session, so a re-published state — which
    /// arrives at 10Hz — cannot make it read the same reply over and over.
    private var spoken: [String: String] = [:]
    private var primed = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Called on every published state. Speaks a session's reply once.
    ///
    /// Whether it speaks is ACTIVE mode, not a second preference: one switch,
    /// the dot in the toolbar. "Speak on this phone" as its own setting could
    /// not even be read unambiguously — does it mean the phone talks to you, or
    /// that you talk to it? Tapping Talk always works regardless; that is a
    /// deliberate act, and mode only governs what happens on its own.
    func consider(state: PublishedState?) {
        guard let state, let reply = state.reply, !reply.sessionId.isEmpty else { return }
        let passive = state.mode.paused || state.mode.muted
        let text = reply.displayText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        // The first state after launch is history, not news. Speaking it would
        // narrate whatever happened while you were away, from the top.
        guard primed else {
            spoken[reply.sessionId] = text
            primed = true
            return
        }
        guard spoken[reply.sessionId] != text else { return }
        // Defer rather than drop, and deliberately do NOT mark it spoken: this
        // same state republishes, so the reply is read the moment you send.
        guard !captureOwnsAudio() else { return }
        spoken[reply.sessionId] = text
        guard !passive else { return }

        let label = state.rows.first { $0.id == reply.sessionId }?.label
        lastSpokenSessionId = reply.sessionId
        speak(text, from: label)
    }

    func speak(_ markdown: String, from label: String?) {
        // Backstop for every caller, not just `consider`: touching the audio
        // session while recording is what destroys the utterance.
        guard !captureOwnsAudio() else { return }
        configureSession()
        let spokenText = Self.speakable(markdown)
        guard !spokenText.isEmpty else { return }
        let utterance = AVSpeechUtterance(
            string: label.map { "\($0): \(spokenText)" } ?? spokenText
        )
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.08
        utterance.postUtteranceDelay = 0.1
        isSpeaking = true
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    /// Duck rather than interrupt: a workout has music playing, and conch
    /// talking over it briefly is far better than killing it.
    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playback,
            mode: .spokenAudio,
            options: [.duckOthers, .allowBluetoothA2DP]
        )
        try? session.setActive(true)
    }

    /// Markdown is written to be read, not spoken. Strip what would be recited
    /// as punctuation soup — the Mac's TTS does the same before it speaks.
    static func speakable(_ markdown: String) -> String {
        var text = markdown
        // fenced code: say that it exists rather than reciting it
        text = text.replacingOccurrences(
            of: "```[\\s\\S]*?```",
            with: " (code) ",
            options: .regularExpression
        )
        text = text.replacingOccurrences(of: "!?\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: "https?://\\S+", with: "a link", options: .regularExpression)
        text = text.replacingOccurrences(of: "^\\s*[-*+]\\s+", with: "", options: [.regularExpression])
        text = text.replacingOccurrences(of: "[`*#>|_~]", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension SpeechController: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            self.isSpeaking = false
            // Hand audio back FIRST, so music returns to full volume and the
            // session is free. Opening the mic before releasing it meant this
            // deactivation could land on the recording session that
            // `onFinishedReading` had just started — killing the utterance on
            // the auto-open path, the one the whole loop rests on.
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            // The loop's whole shape: it finishes reading, then listens. Making
            // you tap Talk after every reply is the difference between a voice
            // loop and a dictation box — and on a treadmill it is the
            // difference between usable and not.
            self.onFinishedReading?()
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
