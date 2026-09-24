import AppKit
import ConchDesign
import ScreenCaptureKit

/// The Mac app's half of a snapshot for the phone (review-preview.ts `WindowPreviews`): the daemon names a window it
/// wants on the published state (`previewRequests`), and this takes it and answers over the socket with the file it
/// wrote. Tyler (09-25): "it will also need other materials sent to it if there's not an equivalent on the phone".
///
/// Only ever the deliverable's own window: the app a session built into its own folder, the one running app whose
/// bundle is inside the session's folders (`PreviewOwner`). None, or two, is a guess, and nothing is taken. Only while
/// Screen Recording is already granted: this never asks for it, since a phone asking is not Tyler asking.
@MainActor
final class WindowPreviewer {
    private let socket: ConchSocketClient
    /// Requests already taken in hand; one is answered once, however many snapshots name it.
    private var handled: Set<String> = []

    init(socket: ConchSocketClient) {
        self.socket = socket
    }

    func handle(_ requests: [PublishedState.PreviewRequest], rows: [SessionRow]) {
        // A request gone from the state is answered or expired, and its id never comes back.
        handled.formIntersection(requests.map(\.id))
        for request in requests where !handled.contains(request.id) {
            handled.insert(request.id)
            let row = rows.first { $0.id == request.sessionId }
            let roots = [row?.cwd].compactMap { $0 } + (row?.workDirs ?? [])
            let socket = socket
            Task {
                let answer = await Self.take(request, roots: roots)
                _ = await socket.request(answer, timeout: 5)
            }
        }
    }

    /// The deliverable's window, taken, as the daemon's answer.
    static func take(_ request: PublishedState.PreviewRequest, roots: [String]) async -> ReviewPreviewReport {
        func refuse(_ why: String) -> ReviewPreviewReport { ReviewPreviewReport(request: request.id, path: nil, error: why) }
        // Checked, never asked for: asking would put a system dialog in front of Tyler because a phone wanted a picture.
        guard CGPreflightScreenCaptureAccess() else {
            return refuse("conch's Mac app hasn't been allowed Screen Recording, so it can't take a snapshot of a window. Allow it in System Settings › Privacy & Security › Screen Recording.")
        }
        guard let folder = PreviewOwner.folder(request.folder, temp: [NSTemporaryDirectory(), "/tmp"]) else {
            return refuse("the daemon named a folder that isn't conch's snapshot folder")
        }
        let apps = NSWorkspace.shared.runningApplications.compactMap { app in
            app.bundleURL.map { (pid: app.processIdentifier, bundle: $0.path) }
        }
        guard let owner = PreviewOwner.pick(apps, roots: roots, own: ProcessInfo.processInfo.processIdentifier, home: NSHomeDirectory()) else {
            return refuse("conch snapshots an app this session built into its own folder, and there isn't exactly one of those running")
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            // Its own windows only, the ordinary kind, on screen; the largest is the one it is about.
            guard let window = content.windows
                .filter({ $0.owningApplication?.processID == owner && $0.windowLayer == 0 && $0.isOnScreen })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
            else { return refuse("the app's window isn't on screen") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            configuration.width = Int(window.frame.width * CGFloat(filter.pointPixelScale))
            configuration.height = Int(window.frame.height * CGFloat(filter.pointPixelScale))
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            guard let png = CanvasInk.png(image) else { return refuse("the snapshot couldn't be written") }
            let file = URL(fileURLWithPath: folder).appendingPathComponent("\(request.id.filter { $0.isLetter || $0.isNumber || $0 == "-" }).png")
            // Its owner's alone, as the daemon requires of it.
            guard FileManager.default.createFile(atPath: file.path, contents: png, attributes: [.posixPermissions: 0o600]) else {
                return refuse("the snapshot couldn't be written")
            }
            return ReviewPreviewReport(request: request.id, path: file.path, error: nil)
        } catch {
            return refuse("the window couldn't be taken: \(error.localizedDescription)")
        }
    }
}

/// What the daemon is told (`review-preview` on the socket).
struct ReviewPreviewReport: Encodable, Sendable {
    let kind = "review-preview"
    let request: String
    let path: String?
    let error: String?
}

/// Which running app is a deliverable's own, and where its snapshot may go. Foundation only, so the bun test runs it
/// under `swift`.
enum PreviewOwner {
    /// The one app whose bundle is inside the session's folders: it built it there. The home folder and `/` are no
    /// session's own (a session started in home would own every app under it), and conch itself is never one.
    static func pick(_ apps: [(pid: Int32, bundle: String)], roots: [String], own: Int32, home: String) -> Int32? {
        func real(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
        let skipped = Set(["/", real(home)])
        let folders = roots.map(real).filter { !$0.isEmpty && !skipped.contains($0) }
        let owned = apps.filter { app in
            let bundle = real(app.bundle)
            return app.pid != own && folders.contains { bundle.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }
        }
        return owned.count == 1 ? owned[0].pid : nil
    }

    /// The daemon's snapshot folder, when it is one: `conch-previews` directly under a temp root. Nil for anything else,
    /// which is never written to.
    static func folder(_ named: String, temp: [String]) -> String? {
        func real(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
        let folder = real(named)
        let parent = (folder as NSString).deletingLastPathComponent
        guard (folder as NSString).lastPathComponent == "conch-previews", temp.map(real).contains(parent) else { return nil }
        return folder
    }
}
