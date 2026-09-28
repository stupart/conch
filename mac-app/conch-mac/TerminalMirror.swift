import AppKit
import ConchDesign
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import SwiftUI

// The session's own terminal, from the strip.
//
// Normal use: the strip's Terminal is a button. A press asks the daemon to bring the session's real terminal forward
// (`terminal-focus`: its Terminal window and tab, out of the Dock; or its tmux window and pane in the terminal attached to
// it) and changes nothing in conch — the pane stays, nothing is read, no permission is asked. Tyler: "it is no use having
// an image of the terminal lol. Maybe we just make that button bring you to the terminal session instead."
//
// The Terminal Mirror: the session's own Claude Code or Codex, live, as its terminal shows it. View-only. A DEBUG view,
// off unless Debug › Show Terminal Mirror is on or Option is held on the button (`ConchTerminalStrip`): "We could keep it
// as a debugging feature tho, cause it is useful for u to make sure the terminal matches conch in one image." Agents get
// that as one picture from `conch parity` (src/parity.ts), which asks nothing of this file.
//
// Where the picture comes from, best first (src/terminal-mirror.ts finds which):
//  - a tmux pane: the daemon's `capture-pane -e` of it, re-read every 300 ms and drawn as text in its own colours
//    (`ConchTerminalScreenView`). Exact, selectable, copyable, and no permission.
//  - a Terminal window: ScreenCaptureKit, that one window, at up to 5 frames a second and only frames that changed. The
//    colours and the TUI's layout are the point, and Terminal's own text (`contents of tab`) has neither — so that text is
//    what shows only while the picture can't be taken: Screen Recording not yet allowed, the window in the Dock, or
//    another tab in front of the session's.
//
// It costs nothing unseen, and nothing at all while it is off. Every read and the stream stop the moment the mirror's tab
// is left or the debug view turned off, conch's window is minimised, hidden or covered, or the Mac sleeps
// (`ConchTerminalMirrorGate`), and start again when it can be seen.

struct ConchTerminalScreenRequest: Encodable, Sendable {
    let kind = "terminal-screen"
    let sessionId: String
    /// Also Terminal's own text for the tab. Omitted when nil.
    var text: Bool? = nil
}

/// The Terminal button: bring the session's own terminal forward. Sent only on a press (`StateStore.openAgentTerminal`).
struct ConchTerminalFocusRequest: Encodable, Sendable {
    let kind = "terminal-focus"
    let sessionId: String
}

struct ConchTerminalFocusReply: Decodable {
    let kind: String
    let focused: Bool
    let reason: String?
}

/// Debug › Show Terminal Mirror, off by default.
enum TerminalMirrorDebug {
    static let key = ConchTerminalStrip.mirrorDefaultsKey

    static var isOn: Bool { UserDefaults.standard.bool(forKey: key) }
}

/// The menu item, a view so it can hold the setting itself.
struct TerminalMirrorMenuToggle: View {
    @AppStorage(TerminalMirrorDebug.key) private var isOn = false

    var body: some View {
        Toggle("Show Terminal Mirror", isOn: $isOn)
    }
}

/// A press that opened the mirror this launch (its tab, or Option on the Terminal button): the one moment Screen
/// Recording is asked for, the first time a Terminal window needs it, and only while the debug view is on
/// (`ConchMirrorPermissionAsk`). Restoring the mirror on launch is not a press; the Terminal button itself never asks.
@MainActor
enum TerminalMirrorAsk {
    private static var ask = ConchMirrorPermissionAsk()

    static func mirrorOpened() { ask.press() }

    /// True once: after a press, the first time the picture needs the permission, with the mirror still on.
    static func shouldAsk() -> Bool { ask.shouldAsk(mirrorOn: TerminalMirrorDebug.isOn) }
}

/// The Terminal Mirror's reader for one session: a debug view.
@MainActor
final class AgentTerminalMirror: ObservableObject {
    @Published private(set) var state: ConchAgentTerminalState = .finding
    /// Where it is, for the mirror's line.
    @Published private(set) var place: String?
    /// The latest frame of a Terminal window.
    @Published private(set) var frame: IOSurfaceRef?
    /// PermissionCenter's one door, for Screen Recording: the tab's button, and the first-time ask. Given by the view,
    /// which holds the store it needs.
    var permission: ((ConchPermissionAction) -> Void)?

    let sessionId: String
    private let socket: ConchSocketClient
    private var gate = ConchTerminalMirrorGate()
    private var reading: Task<Void, Never>?
    private var stream: TerminalWindowStream?
    /// Where Screen Recording stood at the last Terminal-window read; tmux never asks.
    private var screenRecording: ConchPermissionStatus
    /// What ScreenCaptureKit said when the last picture stopped, until the tab is opened again.
    private var pictureFailure: String?
    private var lastScreen: String?

    init(sessionId: String, socket: ConchSocketClient = ConchSocketClient()) {
        self.sessionId = sessionId
        self.socket = socket
        screenRecording = Self.screenRecordingNow()
    }

    var isLive: Bool { gate.isLive }

    func set(tabShown: Bool) { update { $0.tabShown = tabShown } }
    func set(windowVisible: Bool) { update { $0.windowVisible = windowVisible } }
    func set(asleep: Bool) { update { $0.asleep = asleep } }

    private func update(_ change: (inout ConchTerminalMirrorGate) -> Void) {
        let wasLive = gate.isLive
        change(&gate)
        guard gate.isLive != wasLive else { return }
        if gate.isLive { start() } else { stop() }
    }

    private func start() {
        guard reading == nil else { return }
        // Opening the tab again is a fresh try at the picture.
        pictureFailure = nil
        reading = Task { [weak self] in
            while !Task.isCancelled {
                guard let pause = await self?.read() else { return }
                try? await Task.sleep(for: pause)
            }
        }
    }

    /// Nothing runs while it can't be seen: no timer, no stream, no reads.
    private func stop() {
        reading?.cancel()
        reading = nil
        stopPicture()
    }

    /// One read of the session's terminal, and how long until the next.
    private func read() async -> Duration {
        let wantsText = ConchAgentTerminalState.wantsText(after: state, screenRecording: screenRecording)
        let outcome = await socket.request(ConchTerminalScreenRequest(sessionId: sessionId, text: wantsText ? true : nil), timeout: 2)
        // Left while the daemon answered: what it said is for nobody.
        guard gate.isLive, !Task.isCancelled else { return .zero }
        let location: ConchTerminalLocation
        switch outcome {
        case let .reply(data):
            if let decoded = try? JSONDecoder().decode(ConchTerminalLocation.self, from: data) {
                location = decoded
            } else {
                let refusal = (try? JSONDecoder().decode(ConchSessionErrorReply.self, from: data))?.error
                return show(.unavailable(refusal ?? "conch's background service answered in a way this app doesn't understand. Updating conch fixes it."))
            }
        case .connectFailed, .timeout:
            return show(.unavailable("conch's background service isn't answering, so it can't show this terminal."))
        }
        // A tmux screen that hasn't changed, cursor and size included, is not drawn again.
        let seen = location.host == .tmux
            ? "\(location.columns ?? 0)x\(location.rows ?? 0) \(location.cursor.map { "\($0.x),\($0.y)" } ?? "-")\n\(location.screen ?? "")"
            : nil
        if let seen, case .screen = state, seen == lastScreen {
            return state.nextRead
        }
        lastScreen = seen
        if location.host == .terminal { screenRecording = Self.screenRecordingNow() }
        place = Self.place(location)
        let next = ConchAgentTerminalState.deciding(location, screenRecording: screenRecording, pictureFailure: pictureFailure)
        if case let .text(_, .needsScreenRecording(status)) = next, status == .denied || status == .notAsked, TerminalMirrorAsk.shouldAsk() {
            permission?(.ask)
        }
        if case let .window(id) = next {
            startPicture(CGWindowID(id))
            stream?.fit(to: id)
        }
        return show(next)
    }

    private func show(_ next: ConchAgentTerminalState) -> Duration {
        if !next.showsPicture { stopPicture() }
        if next != state { state = next }
        return next.nextRead
    }

    static func place(_ location: ConchTerminalLocation) -> String? {
        switch location.host {
        case .tmux:
            guard let pane = location.pane else { return "tmux" }
            if let columns = location.columns, let rows = location.rows { return "tmux \(pane) · \(columns)×\(rows)" }
            return "tmux \(pane)"
        case .terminal:
            return location.tty.map { "Terminal · \($0)" } ?? "Terminal"
        case .none:
            return nil
        }
    }

    /// This process's own grant, which is the one a picture needs; else what the permission list last read.
    static func screenRecordingNow() -> ConchPermissionStatus {
        if CGPreflightScreenCaptureAccess() { return .granted }
        let listed = PermissionCenter.shared.statuses[.screenRecording]
        return listed == nil || listed == .granted ? .denied : listed!
    }

    // MARK: The picture

    private func startPicture(_ window: CGWindowID) {
        if let stream, stream.windowID == window { return }
        stopPicture()
        let stream = TerminalWindowStream(windowID: window)
        stream.onFrame = { [weak self] surface in
            guard let self, self.stream === stream else { return }
            self.frame = surface
        }
        stream.onStop = { [weak self] why in
            guard let self, self.stream === stream else { return }
            self.pictureFailure = why
            self.stopPicture()
            if case .window = self.state { self.state = .text(nil, .pictureFailed(why)) }
        }
        self.stream = stream
        Task {
            do {
                try await stream.start()
            } catch {
                stream.onStop?(error.localizedDescription)
            }
        }
    }

    private func stopPicture() {
        stream?.stop()
        stream = nil
        if frame != nil { frame = nil }
    }

}

/// One Terminal window, streamed by ScreenCaptureKit while the mirror shows it.
///
/// That window alone (`desktopIndependentWindow`), so it is pictured behind other windows and nothing else on screen is
/// taken. At most five frames a second, and ScreenCaptureKit sends one only when the window changed, so an idle terminal
/// costs next to nothing. Frames are shown as the IOSurfaces they arrive in, never copied.
@MainActor
final class TerminalWindowStream: NSObject {
    static let framesPerSecond: Int32 = 5

    let windowID: CGWindowID
    var onFrame: ((IOSurfaceRef) -> Void)?
    var onStop: ((String) -> Void)?
    private var stream: SCStream?
    private var stopped = false
    private var size: CGSize = .zero
    private var scale: CGFloat = 2
    private let output = TerminalFrameOutput()

    init(windowID: CGWindowID) {
        self.windowID = windowID
        super.init()
        output.stream = self
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard !stopped else { return }
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "the window has gone"])
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        scale = CGFloat(filter.pointPixelScale)
        size = window.frame.size
        let stream = SCStream(filter: filter, configuration: configuration(), delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
        try await stream.startCapture()
        if stopped {
            try? await stream.stopCapture()
            return
        }
        self.stream = stream
    }

    private func configuration() -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = max(2, Int(size.width * scale))
        configuration.height = max(2, Int(size.height * scale))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: Self.framesPerSecond)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.ignoreShadowsSingleWindow = true
        return configuration
    }

    /// The window was resized: frames at its new size, rather than stretched from the old one. Read from the window list,
    /// which needs no permission and is one call.
    func fit(to window: UInt32) {
        guard let stream,
              let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window)) as? [[String: Any]])?.first,
              let bounds = info[kCGWindowBounds as String] as? [String: CGFloat],
              let width = bounds["Width"], let height = bounds["Height"] else { return }
        let now = CGSize(width: width, height: height)
        guard abs(now.width - size.width) > 1 || abs(now.height - size.height) > 1 else { return }
        size = now
        stream.updateConfiguration(configuration()) { _ in }
    }

    func stop() {
        stopped = true
        guard let stream else { return }
        self.stream = nil
        Task { try? await stream.stopCapture() }
    }

    fileprivate func delivered(_ surface: IOSurfaceRef) {
        guard !stopped else { return }
        onFrame?(surface)
    }

    fileprivate func ended(_ why: String) {
        guard !stopped else { return }
        onStop?(why)
    }
}

/// ScreenCaptureKit's side, off the main thread: complete frames only, handed over as their surfaces.
private final class TerminalFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "conch.terminal-mirror.frames", qos: .userInitiated)
    weak var stream: TerminalWindowStream?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pixels = sampleBuffer.imageBuffer,
              let surface = CVPixelBufferGetIOSurface(pixels)?.takeUnretainedValue() else { return }
        let frame = TerminalFrame(surface: surface)
        Task { @MainActor [weak self] in self?.stream?.delivered(frame.surface) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let why = error.localizedDescription
        Task { @MainActor [weak self] in self?.stream?.ended(why) }
    }
}

/// An IOSurface crossing to the main thread. The stream never writes a surface it has handed out until the next one
/// arrives, which is the moment this one stops being shown.
private struct TerminalFrame: @unchecked Sendable {
    let surface: IOSurfaceRef
}

/// The latest frame, drawn as the layer's contents: no copy, scaled to fit, the terminal's own aspect kept.
struct TerminalPictureView: NSViewRepresentable {
    let surface: IOSurfaceRef?

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.contentsGravity = .resizeAspect
        view.layer?.backgroundColor = NSColor.clear.cgColor
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        view.layer?.contents = surface
    }
}

/// Whether conch's window can be seen at all, and whether the Mac is awake: the two things besides the tab itself that
/// decide whether the mirror reads anything. Notifications only, so watching costs nothing either.
struct TerminalMirrorVisibility: NSViewRepresentable {
    let changed: (_ windowVisible: Bool, _ asleep: Bool) -> Void

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.changed = changed
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.changed = changed
    }

    final class ProbeView: NSView {
        var changed: ((Bool, Bool) -> Void)?
        private var windowObservers: [NSObjectProtocol] = []
        private var sleepObservers: [NSObjectProtocol] = []
        private var asleep = false

        /// Observers live exactly as long as the view is in a window, so a tab opened a hundred times leaves none behind.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            windowObservers.forEach(NotificationCenter.default.removeObserver)
            windowObservers = []
            guard let window else {
                sleepObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
                sleepObservers = []
                return
            }
            if sleepObservers.isEmpty { watchSleep() }
            // Occlusion covers minimised, hidden, on another Space, and fully covered by other windows.
            windowObservers.append(NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main
            ) { [weak self] _ in MainActor.assumeIsolated { self?.report() } })
            report()
        }

        private func watchSleep() {
            let center = NSWorkspace.shared.notificationCenter
            for (name, sleeping) in [
                (NSWorkspace.willSleepNotification, true), (NSWorkspace.didWakeNotification, false),
                (NSWorkspace.screensDidSleepNotification, true), (NSWorkspace.screensDidWakeNotification, false),
            ] {
                sleepObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.asleep = sleeping
                        self?.report()
                    }
                })
            }
        }

        private func report() {
            let visible = window.map { $0.isVisible && $0.occlusionState.contains(.visible) } ?? false
            changed?(visible, asleep)
        }
    }
}

extension SessionRow {
    /// Whether this session has a terminal of its own, for the Terminal button (and the mirror): a process the daemon knows
    /// (`revealable`) and no reason it has none (`noTerminal`: the practice session, a closed or app-server Codex thread, a
    /// background job no window is attached to). A subagent runs in its session's terminal, which that session's button
    /// brings forward. A remote Mac's sessions are drawn by `RemoteSessionView`, which has no strip.
    var hasAgentTerminal: Bool {
        revealable && noTerminal == nil && parentSessionId == nil
    }
}

/// The Terminal Mirror's content for one session: only while Debug › Show Terminal Mirror is on.
struct AgentTerminalPaneView: View {
    let row: SessionRow
    @StateObject private var mirror: AgentTerminalMirror
    @EnvironmentObject private var store: StateStore

    init(row: SessionRow) {
        self.row = row
        _mirror = StateObject(wrappedValue: AgentTerminalMirror(sessionId: row.id))
    }

    /// Screen Recording's one door, PermissionCenter's `perform`: the button, and the first-time ask.
    private func permission(_ action: ConchPermissionAction) {
        PermissionCenter.shared.perform(action, for: .screenRecording, store: store)
    }

    var body: some View {
        ConchAgentTerminalPane(
            agent: ConchTerminalAgent.name(backend: row.backend),
            state: mirror.state,
            place: mirror.place,
            // The Terminal button's own press: its failure lands on the row, as the button's does.
            onOpen: canOpen ? { store.openAgentTerminal(row) } : nil,
            onPermission: permission,
            picture: { TerminalPictureView(surface: mirror.frame) }
        )
        .background(TerminalMirrorVisibility { visible, asleep in
            mirror.set(windowVisible: visible)
            mirror.set(asleep: asleep)
        })
        .onAppear {
            mirror.permission = permission
            mirror.set(tabShown: true)
        }
        .onDisappear { mirror.set(tabShown: false) }
    }

    /// "Open in Terminal" is offered once there is a terminal found to bring forward.
    private var canOpen: Bool {
        switch mirror.state {
        case .screen, .window, .text: true
        case .finding, .unavailable: false
        }
    }
}
