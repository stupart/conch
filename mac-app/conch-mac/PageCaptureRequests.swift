import AppKit
import ConchDesign

/// The Mac app's half of `conch_capture` (src/page-capture.ts `PageCaptures`): the daemon names a page it wants drawn on
/// the sessions file (`captureRequests`), and this says at once that it has it, draws it (`PageCapturer`), and answers
/// over the socket with the PNG it wrote, or why there is none. The same shape as a window snapshot (`WindowPreviewer`).
///
/// Only ever from this Mac's own sessions file: the daemon never puts these on the state the phone or another Mac is
/// sent, since each names an address to draw with the review pane's sign-ins.
@MainActor
final class PageCaptureRequests {
    private let socket: ConchSocketClient
    /// Requests already taken in hand; one is drawn once, however many polls name it.
    private var handled: Set<String> = []

    init(socket: ConchSocketClient) {
        self.socket = socket
    }

    func handle(_ requests: [PublishedState.CaptureRequest]) {
        // A request gone from the state is answered or expired, and its id never comes back.
        handled.formIntersection(requests.map(\.id))
        for request in requests where !handled.contains(request.id) {
            handled.insert(request.id)
            let socket = socket
            Task { @MainActor in
                // Said first: it is how the daemon tells an app that isn't running from a page that is slow.
                _ = await socket.request(PageCaptureAnswer(request: request.id, ack: true), timeout: 5)
                // A napping app draws a page slowly and answers late; an agent is waiting on this one.
                let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "drawing a page an agent asked conch to capture")
                let answer = await Self.take(request)
                ProcessInfo.processInfo.endActivity(activity)
                _ = await socket.request(answer, timeout: 5)
            }
        }
    }

    /// The page drawn and written, as the daemon's answer.
    static func take(_ request: PublishedState.CaptureRequest) async -> PageCaptureAnswer {
        func refuse(_ why: String) -> PageCaptureAnswer { PageCaptureAnswer(request: request.id, error: why) }
        guard let folder = PageCapture.folder(request.folder, home: NSHomeDirectory()),
              let name = PageCapture.fileName(request: request.id),
              let seenName = PageCapture.fileName(request: request.id, seen: true)
        else { return refuse("the daemon named a folder that isn't conch's capture folder") }
        guard let url = request.pageURL else { return refuse("the page's address couldn't be read") }
        let spec = PageCapturer.Spec(
            url: url,
            target: request.target?.capturerTarget,
            viewport: CGSize(width: request.viewport.width, height: request.viewport.height),
            fullPage: request.fullPage,
            deadline: Date(timeIntervalSince1970: request.deadline / 1000)
        )
        switch await PageCapturer.capture(spec) {
        case let .success(shot):
            let path = (folder as NSString).appendingPathComponent(name)
            guard write(shot.png, to: path) else { return refuse("the capture couldn't be written") }
            return PageCaptureAnswer(
                request: request.id,
                path: path,
                devicePixelRatio: shot.scale,
                element: shot.element.map { PageCaptureAnswer.Box(x: $0.minX, y: $0.minY, w: $0.width, h: $0.height) },
                finalUrl: shot.finalURL,
                title: shot.title,
                loginWall: shot.loginWall,
                clipped: shot.clipped,
                settled: shot.settled
            )
        case let .failure(failure):
            let seenPath = (folder as NSString).appendingPathComponent(seenName)
            let seen = failure.seen.map { write($0.png, to: seenPath) } ?? false
            return PageCaptureAnswer(
                request: request.id,
                path: seen ? seenPath : nil,
                finalUrl: failure.finalURL,
                title: failure.title,
                loginWall: failure.loginWall,
                error: failure.message,
                headings: failure.headings.isEmpty ? nil : failure.headings
            )
        }
    }

    /// Its owner's alone, as the daemon requires of it.
    private static func write(_ data: Data, to path: String) -> Bool {
        FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
    }
}

/// What the daemon is told (`page-capture-answer` on the socket): `ack` first, then the file and what goes with it, or why
/// not with what was seen instead.
struct PageCaptureAnswer: Encodable, Sendable {
    let kind = "page-capture-answer"
    let request: String
    var ack: Bool?
    var path: String?
    var devicePixelRatio: Double?
    var element: Box?
    var finalUrl: String?
    var title: String?
    var loginWall: Bool?
    var clipped: Bool?
    var settled: Bool?
    var error: String?
    var headings: [String]?

    /// The target's box in the PNG's pixels.
    struct Box: Encodable, Sendable {
        let x: Double
        let y: Double
        let w: Double
        let h: Double
    }
}

extension PublishedState.CaptureRequest {
    /// An http(s) address as given, or a local page's path as a file URL; nil for anything else.
    var pageURL: URL? {
        if url.hasPrefix("/") { return URL(fileURLWithPath: url) }
        guard let parsed = URL(string: url), parsed.scheme == "http" || parsed.scheme == "https", parsed.host != nil else { return nil }
        return parsed
    }
}

extension PublishedState.CaptureRequest.Target {
    var capturerTarget: PageCapturer.Target? {
        if let selector { return .selector(selector) }
        if let quote { return .quote(quote) }
        return nil
    }
}
