import AVFoundation
import UIKit
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
    /// Reports this phone's speech to the Mac, so the ledger can show which
    /// session is being read. Set by the app, which owns the bridge.
    var reportSpeaking: (Bool, String) -> Void = { _, _ in }
    /// The label most recently read, so the stop report names the same row.
    private var speakingLabel = ""
    /// Why the phone could not read aloud, when it could not.
    ///
    /// Silence with no explanation is indistinguishable from a bug in the
    /// text, the network, or the agent — this says which one it was.
    @Published private(set) var speechFailure: String?
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
    /// Clears a "reading aloud" state the synthesizer never reports finishing.
    private var speechWatchdog: Timer?
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
        // Off screen, a reply WAITS rather than being read or discarded.
        //
        // Tyler: "new ones are queued and dont start until I open it". Not
        // marking it spoken is what makes that a queue instead of a silent
        // drop — the same state republishes when the app comes forward, and it
        // is read then. Only the newest per session survives, which is the
        // right amount of catch-up: hearing a backlog recited from the top is
        // what the priming guard above already exists to prevent.
        guard UIApplication.shared.applicationState == .active else { return }
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
        // Both of these were `try?`. When activation failed the synthesizer
        // spoke into a dead session — didStart still fires, so the button
        // flipped to "stop" and the row said reading, with no sound. Tyler:
        // "it was the phone app claiming to read while silent."
        guard configureSession() else { return }
        let spokenText = Self.speakable(markdown)
        guard !spokenText.isEmpty else { return }
        let utterance = AVSpeechUtterance(
            string: label.map { "\($0): \(spokenText)" } ?? spokenText
        )
        utterance.voice = Self.bestVoice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.08
        utterance.postUtteranceDelay = 0.1
        isSpeaking = true
        speakingLabel = label ?? ""
        reportSpeaking(true, speakingLabel)
        armSpeechWatchdog(for: spokenText)
        synthesizer.speak(utterance)
    }

    /// Bound how long this app will claim to be reading.
    ///
    /// `isSpeaking` is cleared by the synthesizer's didFinish/didCancel
    /// delegate, which is the honest signal — but if an utterance never
    /// actually starts, neither callback ever fires and the toolbar sits on
    /// "Reading aloud" with a stop button and nothing playing. That is what
    /// Tyler photographed. A synthesizer that silently declines to speak is
    /// exactly the case a delegate cannot report.
    ///
    /// Generous on purpose: this must never cut a real reading short, only
    /// notice one that never began.
    private func armSpeechWatchdog(for text: String) {
        speechWatchdog?.invalidate()
        // ~6 characters per second is well under real speaking pace.
        let bound = min(180, 8 + Double(text.count) / 6)
        speechWatchdog = Timer.scheduledTimer(withTimeInterval: bound, repeats: false) {
            [weak self] _ in
            Task { @MainActor in
                guard let self, self.isSpeaking, !self.synthesizer.isSpeaking else { return }
                self.isSpeaking = false
                self.reportSpeaking(false, self.speakingLabel)
                self.releaseSession()
                self.speechFailure = "That didn't play — the phone never started reading."
            }
        }
    }

    private func clearSpeechWatchdog() {
        speechWatchdog?.invalidate()
        speechWatchdog = nil
    }

    func stop() {
        clearSpeechWatchdog()
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        reportSpeaking(false, speakingLabel)
        releaseSession()
    }

    /// Hand the audio route back.
    ///
    /// Only `didFinish` did this, so stopping a reading by hand, cancelling
    /// one, or having the watchdog notice one never started all left an active
    /// `.playback` session behind. Silent and cheap next to recording, but it
    /// keeps other apps' audio ducked and — now that conch declares background
    /// audio — needlessly prolongs the app's eligibility to keep running.
    private func releaseSession() {
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    /// Duck rather than interrupt: a workout has music playing, and conch
    /// talking over it briefly is far better than killing it.
    @discardableResult
    private func configureSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        let take = {
            // .duckOthers ONLY. `.allowBluetoothA2DP` is valid solely with
            // .playAndRecord — with .playback it is both redundant (A2DP is
            // already the default route) and rejected, and it was throwing
            // OSStatus -50 (paramErr) on every single call. Under `try?` that
            // was invisible, so the synthesizer spoke into a session that had
            // never been configured and only made sound when something else
            // had happened to leave the session usable. That is the
            // intermittent "claiming to read while silent".
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        }
        do {
            try take()
            speechFailure = nil
            return true
        } catch {
            // Almost always the capture session still holding the route: you
            // just finished talking and the recording session has not been
            // released yet. Release it and take the route once more.
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            do {
                try take()
                speechFailure = nil
                return true
            } catch {
                speechFailure = "Couldn't take the audio to read aloud — \(error.localizedDescription)"
                return false
            }
        }
    }

    /// The best voice actually installed on this phone.
    ///
    /// Nothing set a voice at all, so every utterance used the system default —
    /// the *compact* voice, which is the robotic one everybody recognises. iOS
    /// ships far better neural voices under the same API; they just have to be
    /// asked for by name, and Apple will not pick them for you.
    ///
    /// Resolved once. `speechVoices()` walks every installed voice and this is
    /// on the path of every reply.
    ///
    /// Premium beats enhanced beats default, and among equals the shortest
    /// identifier wins — Apple's own voices have plain identifiers while
    /// third-party and novelty ones are longer, so this lands on Ava or Samantha
    /// rather than something comic.
    static let bestVoice: AVSpeechSynthesisVoice? = {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { voice in
            // Same language family, not the same region: an en-GB phone should
            // still find en-US premium voices rather than fall back to compact.
            voice.language.prefix(2) == language.prefix(2)
        }
        func rank(_ voice: AVSpeechSynthesisVoice) -> Int {
            switch voice.quality {
            case .premium: return 3
            case .enhanced: return 2
            default: return 1
            }
        }
        return candidates.max { a, b in
            rank(a) != rank(b)
                ? rank(a) < rank(b)
                : a.identifier.count > b.identifier.count
        }
    }()

    /// True when the phone has nothing better than the compact voice installed.
    ///
    /// Worth surfacing rather than silently sounding bad: the better voices are
    /// a free download, but they live in Settings under Accessibility where
    /// nobody would think to look for them.
    var usingCompactVoice: Bool {
        (Self.bestVoice?.quality ?? .default) == .default
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
    /// The synthesizer is the truth, not our flag. Setting `isSpeaking` only
    /// where we call speak() left the toolbar showing "read aloud" while conch
    /// was mid-sentence — the button lied until you tapped it.
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didStart utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.isSpeaking = true }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            // speak() QUEUES: a second reply arriving mid-sentence does not
            // interrupt the first. Treating this callback as "done speaking"
            // therefore ended the read while audio was still playing — and
            // opened the mic on top of it, which is how the loop hears itself.
            guard !synthesizer.isSpeaking else { return }
            self.clearSpeechWatchdog()
            self.isSpeaking = false
            self.reportSpeaking(false, self.speakingLabel)
            // Hand audio back FIRST, so music returns to full volume and the
            // session is free. Opening the mic before releasing it meant this
            // deactivation could land on the recording session that
            // `onFinishedReading` had just started — killing the utterance on
            // the auto-open path, the one the whole loop rests on.
            //
            // Released on every path, including in the background.
            //
            // An earlier version held the session off screen so iOS would keep
            // conch alive and reading from a pocket. Tyler chose the opposite:
            // "make sure it like pauses or what not the phone app when I
            // background it and new ones are queued and dont start until I
            // open it". Holding an audio session to stay resident is the single
            // most expensive thing a phone app can do, and backgrounding
            // already hands the audio lease back so the Mac reads instead.
            //
            // The background-audio entitlement stays: it is what lets an
            // utterance ALREADY under way finish when the screen locks, rather
            // than being cut mid-sentence. Starting a new one is the part that
            // waits for you to come back.
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
        Task { @MainActor in
            self.clearSpeechWatchdog()
            self.isSpeaking = false
            self.reportSpeaking(false, self.speakingLabel)
            self.releaseSession()
        }
    }
}
