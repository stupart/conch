import AppKit
import ConchDesign
import ScreenCaptureKit

/// Send (the canvas's phase 2). Tyler: "can send an image of the screen when the prompt is sent if there is content on the
/// canvas". What is under the ink is captured without conch's own windows, the marks are drawn over it by the same path
/// builder as the glass, the lot is packed into a folder, and one message goes to the session that owns what is on
/// screen, through the composer's own path. Nothing is ever captured but here, on an explicit Send.
extension CanvasController {
    /// How sure the screen context has to be to route a canvas: 0.8 and up is conch having staged it, a held
    /// deliverable's link, or the session's own terminal. Below that, a folder match can't say whose it is.
    static let sureEnough = 0.8

    /// Where a canvas goes: the session that owns what is on screen, when the screen context is sure of it; else the
    /// conversation panel's own session (the panel's rule, `WorkspaceFocus`); else nowhere. The canvas only reads
    /// `showing`; it never looks at the screen to decide.
    static func route(_ state: PublishedState?, panel staged: SessionRow.ID?) -> SessionRow? {
        if let showing = state?.showing, showing.confidence >= sureEnough, let owner = state?.row(showing.sessionId) {
            return owner
        }
        return state?.row(WorkspaceFocus.viewed(in: Workspace(state), pinned: staged))
    }

    /// Send: capture, pack, deliver, and a clear canvas. With nowhere to send it, nothing is captured and the pill says why.
    /// Only once Tyler has drawn: an agent's marks alone are what he is answering, not an answer.
    func send() {
        if let recorder { return sendShow(recorder) }
        guard let document, document.has(.you), !sending, let store else { return }
        let state = store.state
        guard let row = Self.route(state, panel: FloatingPanels.installed?.staged) else {
            message = "Nothing to send this to: no session owns what is on screen, and the panel has none."
            return
        }
        message = nil
        // The glass lets clicks through while this runs, so the Screen Recording prompt can be answered.
        sending = true
        apply()
        let label = Self.label(of: row, showing: state?.showing)
        // conch's floating windows are left out of the picture, the glass with them: its marks are drawn over it again.
        let conch = Self.leftOut(keepingGlass: false)
        Task { @MainActor in
            let screen = await CanvasCapture.still(of: document.anchor.id, leavingOut: conch)
            let files: CanvasFolder.Files
            do {
                files = try await Task.detached(priority: .userInitiated) { try CanvasFolder.write(document, screen: screen) }.value
            } catch {
                sending = false
                message = "Couldn't save the picture: \(error.localizedDescription)"
                return apply()
            }
            let prompt = CanvasPrompt.text(for: document, about: label, picture: files.flat.path, clean: files.raw?.path, marks: files.json.path)
            // From over the app under the glass, pen down or up: the store hands it the front back once delivered.
            let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: prompt), overApp: true)
            sending = false
            clear()
            lift()
            guard !(await delivery.value) else { return }
            // It didn't get there: the ink comes back, unless something new was drawn meanwhile, and the files stay.
            restore(document)
            message = "That didn't reach \(row.label). The picture is in \(files.flat.deletingLastPathComponent().path)."
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
        let sure = showing.flatMap { $0.confidence >= sureEnough && $0.sessionId == row.id ? $0 : nil }
        let item = sure?.reviewId.flatMap { id in row.held.first { ReviewItem(row: row, review: $0).id == id }?.summary }
        let name = item ?? NSWorkspace.shared.frontmostApplication?.localizedName ?? "the screen"
        return (sure?.surface.url ?? sure?.surface.path).map { "\(name) (\($0))" } ?? name
    }
}

/// A still of a display, never of conch's floating windows over it.
@MainActor
enum CanvasCapture {
    /// Asked for once a launch at most, on a Send.
    private static var asked = false

    /// What is on `display` now, without the windows `leavingOut`; nil without the Screen Recording grant. The grant is
    /// checked silently, and asked for on the first Send without it — the Send still goes, as the marks alone.
    static func still(of display: CGDirectDisplayID, leavingOut windows: [Int]) async -> CGImage? {
        guard CGPreflightScreenCaptureAccess() else {
            if !asked {
                asked = true
                CGRequestScreenCaptureAccess()
            }
            return nil
        }
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
