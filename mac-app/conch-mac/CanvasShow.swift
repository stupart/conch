import AppKit
import AVFoundation
import Combine
import ConchDesign
import Darwin
import ScreenCaptureKit

/// Show (the canvas's phase 3). Tyler: "or we could also have like a 'show' and that's recording it via video instead of
/// only an image." The display under the glass is recorded with the ink on it, conch's other floating windows — the
/// tools, the conversation panel, the control bar — left out; Send stops it and sends a storyboard of frames from it
/// (`CanvasStoryboard`), since agents can't watch video; Esc throws it away. Nothing is ever recorded but here, on an
/// explicit Show: the pill's record button, or R with the pen down.
///
/// The app never opens the mic. The mic must not be open while conch speaks, and the reservation that keeps it so lives
/// inside the daemon; so with the pill's mic on, a Show asks the DAEMON to narrate (`CanvasNarration`, `src/narration.ts`):
/// it holds the mic as it holds a dictation's, records into the Show's folder, and at the end hands back what was said and
/// when, which places frames and words in the storyboard. Refused — the phone has the audio, conch is speaking, the mic
/// is open — the pill says why, and the Show goes on silent.
extension CanvasController {
    /// Show records through `SCRecordingOutput`, macOS 15's; below it the pill has no record button.
    static var canShow: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    /// The record button, and R with the pen down: a Show starts on the display with the ink on it, else the one under the
    /// pointer. While one records, it stops and waits for Send or Esc.
    func toggleShow() {
        guard !sending else { return }
        if let recorder {
            Task { await stopShow(recorder) }
            return
        }
        guard #available(macOS 15.0, *), !CanvasRecorder.starting else { return }
        guard CanvasRecorder.granted() else {
            message = "Show needs Screen Recording: allow conch in System Settings › Privacy & Security, then quit and reopen it."
            return
        }
        let pointer = NSEvent.mouseLocation
        guard let display = document?.anchor.id ?? NSScreen.screens.first(where: { $0.frame.contains(pointer) })?.displayID else { return }
        message = nil
        Task { @MainActor in
            let recorder: CanvasRecorder
            do {
                recorder = try await CanvasRecorder.start(on: display)
            } catch {
                message = "Couldn't start recording: \(error.localizedDescription)"
                return
            }
            recorder.watch($document, from: document)
            self.recorder = recorder
            apply()
            // Narration only with the pill's mic on; the recording doesn't wait for it.
            if narrate { Task { await startNarration(for: recorder) } }
            // Two minutes at most, the last fifteen seconds counted down on the pill; then it stops and waits.
            try? await Task.sleep(for: .seconds(CanvasStoryboard.longest))
            await stopShow(recorder)
        }
    }

    /// Tyler's voice over this Show, asked of the daemon. Taken, it is the recorder's until the Show stops; refused, the
    /// pill says why and the Show goes on silent.
    private func startNarration(for recorder: CanvasRecorder) async {
        switch await CanvasNarration.start(recorder.folder.lastPathComponent) {
        case let .narrating(narration):
            // Stopped or thrown away while it was asked for: it ends now.
            guard recorder.isRecording, self.recorder === recorder else { return narration.cancel() }
            recorder.narration = narration
        case let .refused(reason):
            guard self.recorder === recorder else { return }
            message = "Recording without narration: \(reason)."
        }
    }

    /// A Show stopped, by its button or at the cap, and kept for Send or Esc.
    private func stopShow(_ recorder: CanvasRecorder) async {
        guard case .since = recorder.phase else { return }
        let length = await recorder.stop()
        guard self.recorder === recorder, !sending else { return }
        message = "Stopped at \(CanvasStoryboard.clock(length)). Send it, or Esc to throw it away."
    }

    /// Esc while there is a Show: it stops and is thrown away, and nothing is sent. The ink and the pen stay as they were.
    func cancelShow() {
        guard let recorder, !sending else { return }
        self.recorder = nil
        message = "Recording thrown away. Nothing was sent."
        apply()
        Task { await recorder.discard() }
    }

    /// Send while there is a Show: to where a still would go; stopped, its storyboard pulled, and one message through the
    /// composer's path; then a clear canvas. With nowhere to send it, it keeps recording and the pill says why.
    func sendShow(_ recorder: CanvasRecorder) {
        guard !sending, let store else { return }
        let state = store.state
        guard let row = Self.route(state, panel: FloatingPanels.installed?.staged) else {
            message = "Nothing to send this to: no session owns what is on screen, and the panel has none."
            return
        }
        message = nil
        sending = true
        apply()
        let label = Self.label(of: row, showing: state?.showing)
        let document = document
        Task { @MainActor in
            await recorder.stop()
            // What Tyler said over it, once the daemon has read it: before the folder moves, since it reads the WAV there.
            let said = await recorder.said?.value ?? []
            // The canvas it is of names its folder, as a still's does, so an agent can answer it with marks framed
            // {canvas: id} (`CanvasFolder.anchor`).
            let canvas = recorder.canvas(document)
            let prompt: String
            do {
                try recorder.file(under: canvas.id)
                let ends = recorder.ends, video = recorder.video
                prompt = try await Task.detached(priority: .userInitiated) { try await CanvasRecorder.storyboard(video, ends: ends, said: said, canvas: canvas, about: label) }.value
            } catch {
                sending = false
                self.recorder = nil
                message = "Couldn't read the recording: \(error.localizedDescription). It is in \(recorder.folder.path)."
                return apply()
            }
            let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: prompt))
            sending = false
            self.recorder = nil
            clear()
            lift()
            apply()
            guard !(await delivery.value) else { return }
            message = "That didn't reach \(row.label). The recording is in \(recorder.folder.path)."
        }
    }
}

/// One Show's recording: an `SCStream` of a display into `SCRecordingOutput`'s MP4 — never frame by frame through an
/// asset writer — the red ring round that display while it runs, and when each of Tyler's marks on it was finished.
@MainActor
final class CanvasRecorder: NSObject {
    /// Starting takes a moment (the window list, the stream); a second press meanwhile is dropped.
    private(set) static var starting = false
    /// Asked for once a launch at most, on a Show.
    private static var asked = false
    /// Recorded no wider than this, in pixels: sharper than the frames need (1568) and within what H.264 encodes.
    static let widest: CGFloat = 2560

    /// `~/.cache/conch/canvas/<id>/`: a new id while it records, the canvas's once it is sent (`file(under:)`).
    private(set) var folder: URL
    var video: URL { folder.appendingPathComponent("show.mp4") }
    /// On the pill. It watches the controller, so a change is said there.
    private(set) var phase: CanvasToolPill.Recording { willSet { CanvasController.shared.objectWillChange.send() } }
    /// Each of Tyler's marks on the recorded display, and when it was finished, in seconds into the recording: a note
    /// when its last word was typed.
    private(set) var ends: [(at: Double, mark: CanvasMark)] = []
    /// Tyler's narration while it records, when the pill's mic was on and the daemon took it.
    var narration: CanvasNarration?
    /// What he said, once it stopped, in seconds into the recording; nil without a narration.
    private(set) var said: Task<[CanvasStoryboard.Said], Never>?
    private let display: CGDirectDisplayID
    /// The recorded display, as a canvas on it is anchored.
    private let anchor: CanvasAnchor
    private let ring: FloatingPanel
    private var began = Date()
    private var stream: SCStream?
    /// The `SCRecordingOutput` (macOS 15's), held while it writes.
    private var output: NSObject?
    private var watching: AnyCancellable?
    /// Marks already drawn when it started: not its.
    private var before: Set<CanvasMark.ID> = []
    /// The file is finished, or failed; and who is waiting for that.
    private var written = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    private init(display: CGDirectDisplayID, folder: URL, ring: FloatingPanel) {
        self.display = display
        anchor = CanvasAnchor(id: display, frame: ring.frame)
        self.folder = folder
        self.ring = ring
        phase = .since(Date())
    }

    /// Recording now, rather than stopped and waiting.
    var isRecording: Bool {
        if case .since = phase { return true }
        return false
    }

    /// The canvas a Show is of: the one on the recorded display as it ended, Tyler's ink and any agent's; else that
    /// display bare, named by this Show's own folder.
    func canvas(_ document: CanvasDocument?) -> CanvasDocument {
        if let document, document.anchor.id == display { return document }
        return CanvasDocument(anchor: anchor, id: folder.lastPathComponent)
    }

    /// The recording moved into the folder of the canvas `id` — the still's folder, if that canvas was sent as one too.
    func file(under id: String) throws {
        let named = try CanvasFolder.make(id)
        guard named.path != folder.path else { return }
        let files = FileManager.default
        try? files.removeItem(at: named.appendingPathComponent("show.mp4"))
        try files.moveItem(at: video, to: named.appendingPathComponent("show.mp4"))
        // The narration the daemon recorded here goes with it.
        let voice = folder.appendingPathComponent(CanvasNarration.file)
        if files.fileExists(atPath: voice.path) {
            try? files.removeItem(at: named.appendingPathComponent(CanvasNarration.file))
            try files.moveItem(at: voice, to: named.appendingPathComponent(CanvasNarration.file))
        }
        try? files.removeItem(at: folder)
        folder = named
    }

    /// The Screen Recording grant, checked silently, and asked for on the first Show without it.
    static func granted() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        if !asked {
            asked = true
            CGRequestScreenCaptureAccess()
        }
        return false
    }

    /// A Show recording `display` into a new canvas folder, the ring round it once it is.
    @available(macOS 15.0, *)
    static func start(on display: CGDirectDisplayID) async throws -> CanvasRecorder {
        guard let screen = NSScreen.screens.first(where: { $0.displayID == display }) else { throw CocoaError(.featureUnsupported) }
        starting = true
        defer { starting = false }
        let recorder = CanvasRecorder(display: display, folder: try CanvasFolder.make(UUID().uuidString), ring: ring(on: screen))
        do {
            try await recorder.record()
        } catch {
            recorder.ring.orderOut(nil)
            try? FileManager.default.removeItem(at: recorder.folder)
            throw error
        }
        return recorder
    }

    @available(macOS 15.0, *)
    private func record() async throws {
        // In the window list before it is read, so the recording can leave it out; seen only once it records.
        ring.alphaValue = 0
        ring.orderFrontRegardless()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let screen = content.displays.first(where: { $0.displayID == display }) else { throw CocoaError(.featureUnsupported) }
        // conch's floating windows are left out — the tools, the conversation panel, the control bar, this ring — but
        // not the glass: the ink is what is being shown. Nor conch's own window, which may be what is.
        let hidden = NSApp.windows.filter { $0 is FloatingPanel && !($0.contentView is CanvasInkView) }.map(\.windowNumber)
        let filter = SCContentFilter(display: screen, excludingWindows: content.windows.filter { hidden.contains(Int($0.windowID)) })
        let configuration = SCStreamConfiguration()
        let pixels = CGSize(width: filter.contentRect.width * CGFloat(filter.pointPixelScale), height: filter.contentRect.height * CGFloat(filter.pointPixelScale))
        let fit = min(1, Self.widest / max(pixels.width, pixels.height, 1))
        configuration.width = Int(pixels.width * fit / 2) * 2
        configuration.height = Int(pixels.height * fit / 2) * 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        // The pointer and its clicks are part of showing.
        configuration.showsCursor = true
        configuration.showMouseClicks = true
        // Silent (see the top): no mic, and none of what the Mac is playing.
        configuration.captureMicrophone = false
        configuration.capturesAudio = false
        let settings = SCRecordingOutputConfiguration()
        settings.outputURL = video
        settings.outputFileType = .mp4
        settings.videoCodecType = .h264
        let output = SCRecordingOutput(configuration: settings, delegate: self)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        try stream.addRecordingOutput(output)
        began = Date()
        try await stream.startCapture()
        self.stream = stream
        self.output = output
        phase = .since(began)
        let ring = ring
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.16
            ring.animator().alphaValue = 1
        }, completionHandler: nil)
    }

    /// Tyler's marks as they are finished, from the canvas's document: each new one on this display, with the time into
    /// the recording; a note again each time its words change, so its frame has them.
    func watch(_ documents: Published<CanvasDocument?>.Publisher, from current: CanvasDocument?) {
        before = Set(current?.marks.map(\.id) ?? [])
        watching = documents.sink { [weak self] document in MainActor.assumeIsolated { self?.saw(document) } }
    }

    private func saw(_ document: CanvasDocument?) {
        guard case .since = phase, let document, document.anchor.id == display else { return }
        let now = Date().timeIntervalSince(began)
        for mark in document.marks where mark.author == .you && !before.contains(mark.id) {
            if let index = ends.firstIndex(where: { $0.mark.id == mark.id }) {
                if ends[index].mark != mark { ends[index] = (now, mark) }
            } else {
                ends.append((now, mark))
            }
        }
    }

    /// Stopped, once, however many ask; each waits for the file to be finished. How long it ran.
    @discardableResult
    func stop() async -> TimeInterval {
        if case let .stopped(length) = phase {
            await finished()
            return length
        }
        let length = Date().timeIntervalSince(began)
        phase = .stopped(length)
        // The mic closes with the recording, not at Send; the daemon starts on the words now.
        if let narration {
            self.narration = nil
            let began = began
            said = Task { await narration.stop(from: began) }
        }
        // The pen's edge light, hidden while it recorded, back if the pen is down.
        CanvasController.shared.apply()
        watching = nil
        let ring = ring
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.16
            ring.animator().alphaValue = 0
        }, completionHandler: { ring.orderOut(nil) })
        try? await stream?.stopCapture()
        stream = nil
        await finished()
        output = nil
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: video.path)
        return length
    }

    /// Esc: stopped, and its folder gone. A narration is cancelled, not read, and the daemon deletes what it recorded.
    func discard() async {
        narration?.cancel()
        narration = nil
        await stop()
        try? FileManager.default.removeItem(at: folder)
    }

    /// Until the recording output says the file is finished, or five seconds, for one that never says.
    private func finished() async {
        guard !written else { return }
        let timeout = Task { @MainActor in
            try await Task.sleep(for: .seconds(5))
            wrote()
        }
        await withCheckedContinuation { waiting.append($0) }
        timeout.cancel()
    }

    fileprivate func wrote() {
        written = true
        let waiting = waiting
        self.waiting = []
        for each in waiting { each.resume() }
    }

    /// The recording failed partway: it stops where it got to, and the pill says so.
    fileprivate func failed(_ error: Error) {
        NSLog("conch: Show's recording failed: %@", error.localizedDescription)
        wrote()
        guard case .since = phase else { return }
        Task { await stop() }
        if CanvasController.shared.recorder === self {
            CanvasController.shared.message = "The recording stopped: \(error.localizedDescription). Send what there is, or Esc."
        }
    }

    /// The red ring round the recorded screen while it records (panel-lab's `body.recording #frameGlow`): its own window,
    /// left out of the recording, that every click goes through. It breathes, but not under Reduce Motion.
    private static func ring(on screen: NSScreen) -> FloatingPanel {
        let panel = FloatingPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.setFrame(screen.frame, display: false)
        // The glass's level and spaces.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
        panel.ignoresMouseEvents = true
        panel.isExcludedFromWindowsMenu = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        let bounds = CGRect(origin: .zero, size: screen.frame.size)
        let view = NSView(frame: bounds)
        view.wantsLayer = true
        guard let edge = view.layer else { return panel }
        let red = CanvasStoryboard.red.cgColor
        edge.masksToBounds = true
        edge.borderWidth = 2
        edge.borderColor = red.copy(alpha: 0.7)
        // The glow is the shadow of a frame just outside the screen, falling inward, as the glass's edge light is.
        let glow = CAShapeLayer()
        let frame = CGMutablePath()
        frame.addRect(bounds.insetBy(dx: -80, dy: -80))
        frame.addLines(between: [CGPoint(x: bounds.minX, y: bounds.minY), CGPoint(x: bounds.minX, y: bounds.maxY), CGPoint(x: bounds.maxX, y: bounds.maxY), CGPoint(x: bounds.maxX, y: bounds.minY)])
        frame.closeSubpath()
        glow.frame = bounds
        glow.path = frame
        glow.fillColor = red
        glow.shadowPath = frame
        glow.shadowColor = red
        glow.shadowOpacity = 0.35
        glow.shadowRadius = 28
        glow.shadowOffset = .zero
        edge.addSublayer(glow)
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let breathe = CABasicAnimation(keyPath: "opacity")
            breathe.fromValue = 1
            breathe.toValue = 0.55
            breathe.duration = ConchMotion.breathPeriod / 2
            breathe.autoreverses = true
            breathe.repeatCount = .infinity
            breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            edge.add(breathe, forKey: "breathe")
        }
        panel.contentView = view
        return panel
    }
}

@available(macOS 15.0, *)
extension CanvasRecorder: SCRecordingOutputDelegate {
    nonisolated func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        Task { @MainActor in wrote() }
    }

    nonisolated func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        Task { @MainActor in failed(error) }
    }
}

// MARK: - The storyboard

extension CanvasRecorder {
    /// A finished recording, as an agent can read it: its frames at the storyboard's moments (`CanvasStoryboard`), no
    /// longer than 1568 px, then `storyboard.md` and `canvas.json` (the canvas it is of, whose id the folder has), beside
    /// `show.mp4`. The message that points at them.
    nonisolated static func storyboard(_ video: URL, ends: [(at: Double, mark: CanvasMark)], said: [CanvasStoryboard.Said], canvas: CanvasDocument, about label: String) async throws -> String {
        let asset = AVURLAsset(url: video)
        let length = try await asset.load(.duration).seconds
        let folder = video.deletingLastPathComponent()
        func frames(_ side: CGFloat) -> AVAssetImageGenerator {
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            generator.maximumSize = CGSize(width: side, height: side)
            return generator
        }
        // Small first, to tell the moments apart; then full size, for the frames kept alone.
        let small = frames(160), full = frames(CanvasStoryboard.longEdge)
        var moments: [CanvasStoryboard.Moment] = [], prints: [[UInt8]] = []
        for moment in CanvasStoryboard.moments(ends: ends, said: CanvasStoryboard.moments(of: said), length: length) {
            guard let image = try? await small.image(at: CMTime(seconds: moment.at, preferredTimescale: 600)).image else { continue }
            moments.append(moment)
            prints.append(CanvasStoryboard.thumbprint(image))
        }
        var kept: [(moment: CanvasStoryboard.Moment, file: URL)] = []
        for moment in CanvasStoryboard.keep(moments, prints: prints) {
            guard let image = try? await full.image(at: CMTime(seconds: moment.at, preferredTimescale: 600)).image else { continue }
            kept.append((moment, try CanvasFolder.save(CanvasInk.png(image), String(format: "frame-%02d.png", kept.count + 1), in: folder)))
        }
        guard !kept.isEmpty else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: video.path]) }
        let storyboard = try CanvasFolder.save(Data(CanvasStoryboard.storyboard(kept.map { ($0.moment, $0.file.lastPathComponent) }, said: said, about: label, length: length).utf8), "storyboard.md", in: folder)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        _ = try CanvasFolder.save(try encoder.encode(canvas), "canvas.json", in: folder)
        return CanvasStoryboard.prompt(kept.map { ($0.moment, $0.file.path) }, said: said, about: label, length: length, storyboard: storyboard.path, video: video.path, canvas: canvas)
    }
}

// MARK: - Narration

/// Tyler's voice over a Show, as the daemon records it (`src/narration.ts`). The app never opens the mic: the daemon holds
/// it as it holds a dictation's, so conch can't speak over it or hear itself, and the phone holding the audio keeps it
/// shut. The connection that started it is its lease, held open here until it ends: an app that crashes or quits takes
/// its narration with it, and the daemon ends one that outlives the Show's cap on its own.
@MainActor
final class CanvasNarration {
    /// Beside `show.mp4` in the Show's folder: what the daemon records.
    static let file = "narration.wav"
    /// Reading two minutes of voice: the warm server, else the cold one once.
    private static let reading: TimeInterval = 150

    let canvasId: String
    /// When the daemon's recorder started; what it says is timed from here.
    let startedAt: Date
    private var lease: Int32?

    private init(canvasId: String, startedAt: Date, lease: Int32) {
        self.canvasId = canvasId
        self.startedAt = startedAt
        self.lease = lease
    }

    enum Started {
        case narrating(CanvasNarration)
        case refused(String)
    }

    /// Asked of the daemon for the Show whose folder is `canvasId`: taken, or why not.
    static func start(_ canvasId: String) async -> Started {
        guard let opened = await ConchSocketClient().open(["kind": "narration-start", "canvasId": canvasId], timeout: 5) else {
            return .refused("conch isn't answering")
        }
        let lease = opened.descriptor
        let answer = (try? JSONSerialization.jsonObject(with: opened.reply)) as? [String: Any]
        guard answer?["kind"] as? String == "narration-started", let at = answer?["startedAt"] as? Double else {
            Darwin.close(lease)
            return .refused(answer?["reason"] as? String ?? answer?["error"] as? String ?? "conch couldn't start it")
        }
        return .narrating(CanvasNarration(canvasId: canvasId, startedAt: Date(timeIntervalSince1970: at / 1000), lease: lease))
    }

    /// Stopped: the daemon closes the mic, then reads what it recorded. What was said, in seconds into the recording that
    /// `began` then; nothing, if it couldn't be read.
    func stop(from began: Date) async -> [CanvasStoryboard.Said] {
        let outcome = await ConchSocketClient().request(["kind": "narration-stop", "canvasId": canvasId], timeout: Self.reading)
        end()
        guard case let .reply(data) = outcome, let stopped = try? JSONDecoder().decode(Stopped.self, from: data) else { return [] }
        let offset = startedAt.timeIntervalSince(began)
        return stopped.segments.map { CanvasStoryboard.Said(start: $0.start + offset, end: $0.end + offset, text: $0.text) }
    }

    /// Esc: the daemon closes the mic and deletes what it recorded.
    func cancel() {
        let canvasId = canvasId
        Task {
            _ = await ConchSocketClient().request(["kind": "narration-cancel", "canvasId": canvasId], timeout: 5)
            end()
        }
    }

    /// The lease let go. After a stop or a cancel the daemon has closed its end already.
    private func end() {
        guard let lease else { return }
        self.lease = nil
        Darwin.close(lease)
    }

    private struct Stopped: Decodable {
        struct Segment: Decodable {
            let start: Double
            let end: Double
            let text: String
        }

        let segments: [Segment]
    }
}

extension CanvasFolder {
    /// A new canvas's folder, as `write` makes one: for Tyler alone (0700), the old ones pruned.
    static func make(_ id: String) throws -> URL {
        let files = FileManager.default
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        prune(files)
        let folder = root.appendingPathComponent(id, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return folder
    }

    /// A file in a canvas folder, for Tyler alone (0600).
    static func save(_ data: Data?, _ name: String, in folder: URL) throws -> URL {
        let url = folder.appendingPathComponent(name)
        guard let data, FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        return url
    }
}
