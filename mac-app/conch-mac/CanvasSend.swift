import AppKit
import ConchDesign
import ScreenCaptureKit

/// Send (the canvas's phase 2). Tyler: "can send an image of the screen when the prompt is sent if there is content on the
/// canvas". What is under the ink is captured without conch's own windows, the marks are drawn over it by the same path
/// builder as the glass, the lot is packed into a folder, and one message goes to the session that owns what is on
/// screen, through the composer's own path. Nothing is ever captured but here, on an explicit Send; and nothing is ever
/// sent, or sent as less than it looks, without the pill saying so: where it went, why it didn't, and what Screen
/// Recording still needs.
extension CanvasController {
    /// Where a canvas goes (`CanvasRouting`): Tyler's pick from Send's menu; else the session that owns what is on screen,
    /// when the screen context is sure of it (`CanvasRouting.sureEnough`); else the conversation panel's own session (the
    /// panel's rule, `WorkspaceFocus`), which is a guess, and Send asks; else nowhere. The canvas only reads `showing`; it
    /// never looks at the screen to decide.
    static func route(_ state: PublishedState?, panel staged: SessionRow.ID?, picked: SessionRow.ID? = nil) -> (row: SessionRow, sure: Bool)? {
        guard let state else { return nil }
        let choice = CanvasRouting.choice(
            picked: picked,
            onScreen: state.showing?.sessionId,
            confidence: state.showing?.confidence ?? 0,
            panel: WorkspaceFocus.viewed(in: Workspace(state), pinned: staged),
            sessions: state.rows.map(\.id)
        )
        guard let choice, let row = state.row(choice.id) else { return nil }
        return (row, choice.sure)
    }

    /// Send's menu: every session but a sub-agent, most likely first (`CanvasRouting.ranked`), each saying why it is near
    /// the top.
    static func destinations(_ state: PublishedState?, panel staged: SessionRow.ID?, picked: SessionRow.ID?) -> [CanvasToolPill.Destination] {
        guard let state else { return [] }
        let onScreen = state.showing?.sessionId, panel = WorkspaceFocus.viewed(in: Workspace(state), pinned: staged)
        let ranked = CanvasRouting.ranked(picked: picked, onScreen: onScreen, confidence: state.showing?.confidence ?? 0, panel: panel, sessions: state.rows.map(\.id))
        return ranked.compactMap { id in
            guard let row = state.row(id), row.parentSessionId == nil else { return nil }
            return CanvasToolPill.Destination(id: id, label: row.label, why: id == onScreen ? "on screen" : id == panel ? "in the panel" : nil)
        }
    }

    /// Send: capture, pack, deliver, and a clear canvas, "Sent to …" on the pill. Only once Tyler has drawn: an agent's
    /// marks alone are what he is answering, not an answer. With nowhere to send it, nothing is captured and the pill says
    /// why; to a guess, Send asks where; without the Screen Recording grant it asks first, and `marksOnly` is his answer.
    func send(marksOnly: Bool = false) {
        if let recorder { return sendShow(recorder) }
        guard let document, document.has(.you), !sending, let store else { return }
        let state = store.state
        guard let route = Self.route(state, panel: FloatingPanels.installed?.staged, picked: picked) else {
            return say(.nowhere)
        }
        // A guess isn't sent to: a localhost page at 0.7 went to the panel's session without a word.
        guard route.sure else {
            routeMenu = .sendTo
            return
        }
        // Never the marks alone without saying so: the agent was told, Tyler wasn't.
        guard marksOnly || CanvasCapture.granted() else {
            // The pen comes up, so the system's own prompt, when it asks, isn't under the glass.
            lift()
            return say(settingsOpened ? .reopen(marks: true) : .noScreen(marks: true))
        }
        let row = route.row
        notice = nil
        routeMenu = nil
        // The glass lets clicks through while this runs.
        sending = true
        apply()
        let label = Self.label(of: row, showing: state?.showing)
        // conch's floating windows are left out of the picture, the glass with them: its marks are drawn over it again.
        let conch = Self.leftOut(keepingGlass: false)
        Task { @MainActor in
            let screen = marksOnly ? nil : await CanvasCapture.still(of: document.anchor.id, leavingOut: conch)
            let files: CanvasFolder.Files
            do {
                files = try await Task.detached(priority: .userInitiated) { try CanvasFolder.write(document, screen: screen) }.value
            } catch {
                sending = false
                NSLog("conch: couldn't save the canvas: %@", error.localizedDescription)
                return say(.noPicture)
            }
            let prompt = CanvasPrompt.text(for: document, about: label, picture: files.flat.path, clean: files.raw?.path, marks: files.json.path)
            // From over the app under the glass, pen down or up: the store hands it the front back once delivered.
            let event = ConchDaemonEvent.inject(sessionId: row.id, label: row.label, text: prompt)
            let delivery = store.send(event, overApp: true)
            // Taken — a line on the daemon's socket, a moment — before the ink goes, so the pill goes straight from Send
            // to "Sent to …" rather than sinking and rising again, and a Send the daemon never took leaves the ink be.
            let taken = await delivery.value
            sending = false
            revealing = files.flat.deletingLastPathComponent()
            guard taken else {
                apply()
                return say(.notSent(to: row.label, sentence: nil))
            }
            clear()
            lift()
            say(.sent(to: row.label), lasting: CanvasToolPill.Notice.sentFor)
            // Taken isn't landed. Refused after all, the ink comes back, unless something new was drawn meanwhile, and the
            // pill says why, with the picture a click away.
            guard let failure = await Self.failure(of: event.opId, in: store) else { return }
            let back = restore(document)
            say(.notSent(to: row.label, sentence: failure, kept: back ? "Your marks are still here." : "The picture is kept."))
        }
    }

    /// What became of a send the daemon took: taken is not landed, and the daemon's outcome comes back against the send's
    /// own id, in `StateStore.outbox`. The sentence it failed with; nil once it landed, was left staged, or retired, or
    /// after two minutes with no word.
    // ponytail: polled twice a second; the outbox's publisher, raced against a timeout, if two minutes of polling ever shows.
    static func failure(of opId: String?, in store: StateStore) async -> String? {
        guard let opId else { return nil }
        for _ in 0..<240 {
            guard let entry = store.outbox.entries.first(where: { $0.id == opId }) else { return nil }
            if case let .failed(sentence) = entry.state { return sentence }
            if entry.state.isTerminal { return nil }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return nil
    }

    /// One of the pill's notice's buttons. Settings and Finder open through the store's one door (`openLink`), which
    /// files a failure; the pill says it in its own words, never the system's or a path.
    func act(_ action: CanvasToolPill.Notice.Action) {
        switch action {
        case .openSettings:
            settingsOpened = true
            say(.reopen(marks: recorder == nil && document?.has(.you) == true))
            store?.openLink(CanvasCapture.settings.absoluteString, cwd: nil, rowId: nil) { [weak self] _ in
                self?.say(CanvasToolPill.Notice("Couldn't open System Settings. It is under Privacy & Security › Screen Recording."))
            }
        case .sendMarksOnly:
            send(marksOnly: true)
        case .reopen:
            CanvasCapture.reopen(store) { [weak self] in self?.say(.reopenFailed) }
        case .showInFinder:
            guard let revealing else { return }
            store?.openLink(revealing.path, cwd: nil, rowId: nil, reveal: true) { [weak self] _ in
                self?.say(CanvasToolPill.Notice("Couldn't show it in Finder: it has gone."))
            }
        }
    }

    /// The windows a picture of the screen leaves out: conch's floating ones — the tools, the control bar, Show's ring, the
    /// glass unless it is what is shown (`keepingGlass`, a Show's ink) — but never the conversation panel while it fills
    /// the screen, when it is what was marked up (`FloatingPanels.coveringWindow`). Nor conch's own window, which may be.
    static func leftOut(keepingGlass: Bool) -> [Int] {
        let covering = FloatingPanels.installed?.coveringWindow
        return NSApp.windows.filter { window in
            window is FloatingPanel && window !== covering && !(keepingGlass && window.contentView is CanvasInkView)
        }.map(\.windowNumber)
    }

    /// What was marked up, for the prompt's first line: the deliverable on screen when the screen context knows it for this
    /// session, else the app in front; with where it is, when the screen context says.
    static func label(of row: SessionRow, showing: PublishedState.Showing?) -> String {
        let sure = showing.flatMap { $0.confidence >= CanvasRouting.sureEnough && $0.sessionId == row.id ? $0 : nil }
        let item = sure?.reviewId.flatMap { id in row.held.first { ReviewItem(row: row, review: $0).id == id }?.summary }
        let name = item ?? NSWorkspace.shared.frontmostApplication?.localizedName ?? "the screen"
        return (sure?.surface.url ?? sure?.surface.path).map { "\(name) (\($0))" } ?? name
    }
}

/// A still of a display, never of conch's floating windows over it; and the Screen Recording grant both a still and a
/// Show need.
@MainActor
enum CanvasCapture {
    /// Asked for once a launch at most, on a Send or a Show.
    private static var asked = false

    /// The Screen Recording grant, checked silently; the first time a launch it is missing, asked for — which is also
    /// what puts conch in System Settings' list, to be turned on. macOS asks only once ever: after that, nothing appears,
    /// which is why the pill says so itself (`Notice.noScreen`).
    static func granted() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        if !asked {
            asked = true
            CGRequestScreenCaptureAccess()
        }
        return false
    }

    /// System Settings at Privacy & Security › Screen Recording.
    static let settings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!

    /// conch reopened, as a grant only reaches a new process: the store's own relaunch (a new instance up before this one
    /// quits). `failed` when it didn't happen.
    static func reopen(_ store: StateStore?, failed: @escaping @MainActor () -> Void) {
        guard let store else { return failed() }
        store.relaunchForNewBuild()
        Task { @MainActor in
            // The failure is set from the open's own completion: a moment is plenty, and a reopen that worked has quit.
            try? await Task.sleep(for: .seconds(5))
            if store.relaunchFailure != nil { failed() }
        }
    }

    /// What is on `display` now, without the windows `leavingOut`; nil without the Screen Recording grant, which Send has
    /// already asked about (`granted`).
    static func still(of display: CGDirectDisplayID, leavingOut windows: [Int]) async -> CGImage? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        let start = CACurrentMediaTime()
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let screen = content.displays.first(where: { $0.displayID == display }) else { return nil }
            let filter = SCContentFilter(display: screen, excludingWindows: content.windows.filter { windows.contains(Int($0.windowID)) })
            let image: CGImage?
            if #available(macOS 26.0, *) {
                let configuration = SCScreenshotConfiguration()
                configuration.showsCursor = false
                image = try await SCScreenshotManager.captureScreenshot(contentFilter: filter, configuration: configuration).sdrImage
            } else {
                let configuration = SCStreamConfiguration()
                configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
                configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
                configuration.showsCursor = false
                image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            }
            // The research left this to be measured here: a still's cost on a real display.
            NSLog("conch: canvas still %dx%d in %.0f ms", image?.width ?? 0, image?.height ?? 0, (CACurrentMediaTime() - start) * 1000)
            return image
        } catch {
            NSLog("conch: canvas capture failed, sending the marks alone: %@", error.localizedDescription)
            return nil
        }
    }
}

/// Where a canvas is kept: `~/.cache/conch/canvas/<id>/`, beside the phone's uploads, for Tyler alone (0700, its
/// files 0600).
enum CanvasFolder {
    static let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/conch/canvas", isDirectory: true)
    /// Older canvases go when a new one is written.
    static let kept: TimeInterval = 14 * 24 * 3600

    struct Files: Sendable {
        /// The screen with the marks over it, no longer than 1568 px on the long edge.
        let flat: URL
        /// The screen as it was, at the display's own size; nil without a screen.
        let raw: URL?
        /// The document.
        let json: URL
    }

    static func write(_ document: CanvasDocument, screen: CGImage?) throws -> Files {
        let files = FileManager.default
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        prune(files)
        let folder = root.appendingPathComponent(document.id, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        func save(_ data: Data?, _ name: String) throws -> URL {
            let url = folder.appendingPathComponent(name)
            guard let data, files.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
            return url
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return Files(
            flat: try save(CanvasInk.render(document, over: screen).flatMap(CanvasInk.png), "flat.png"),
            raw: try screen.map { try save(CanvasInk.png($0), "raw.png") },
            json: try save(try encoder.encode(document), "canvas.json")
        )
    }

    /// Where a canvas Tyler sent was drawn, for an agent's marks framed `{canvas: id}` to be drawn back on it. The id is the
    /// agent's to pass back, so only a UUID conch minted names a folder: nothing it says can reach anywhere else.
    static func anchor(of id: String) -> CanvasAnchor? {
        guard let uuid = UUID(uuidString: id), uuid.uuidString == id.uppercased() else { return nil }
        let file = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("canvas.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        return (try? JSONDecoder().decode(CanvasDocument.self, from: data))?.anchor
    }

    static func prune(_ files: FileManager) {
        let old = Date().addingTimeInterval(-kept)
        for folder in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let changed = try? folder.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, changed < old {
                try? files.removeItem(at: folder)
            }
        }
    }
}
