import AppKit
import ConchDesign
import ScreenCaptureKit
import WebKit

/// The annotate journey, driven by file, in a conch launched for it alone: scripts/annotate-e2e.ts starts this build
/// with `CONCH_HARNESS=<dir>` against a daemon of its own, writes one request at a time to `<dir>/request.json`, and
/// reads what happened from `<dir>/result.json`. Never in a conch anyone launched to use: without the variable nothing
/// here runs.
///
/// A request does what a person's hand would, through the same path: a click or a hover is a mouse event dispatched on
/// the page (the page script hears it as it hears Tyler's), words are a selection let go, a box is the picture's own
/// press, drag and release. Only typing is set straight into the note's field. A picture of the window is conch's own,
/// through ScreenCaptureKit's current-process content, which needs no permission and takes no one else's screen.
@MainActor
enum AnnotateHarness {
    /// This conch was launched for the harness: only then is anything here kept or done.
    static let running = ProcessInfo.processInfo.environment["CONCH_HARNESS"]?.isEmpty == false
    /// Every annotator made, for the request to find the one showing a deliverable.
    static var annotators: [Weak<DeliverableAnnotator>] = []
    private static var folder: URL?
    private static var lastSeq = 0
    private static var timer: Timer?
    private static weak var store: StateStore?
    /// The window was asked for: once, as it takes a moment to register.
    private static var opened = false

    static func startIfAsked(store: StateStore) {
        guard running, let named = ProcessInfo.processInfo.environment["CONCH_HARNESS"], timer == nil else { return }
        folder = URL(fileURLWithPath: named, isDirectory: true)
        self.store = store
        let timer = Timer(timeInterval: 0.15, repeats: true) { _ in MainActor.assumeIsolated { poll() } }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        NSLog("conch: annotate harness reading %@", named)
    }

    /// The session the last `select` showed.
    private static var selected: String?

    /// The annotator of the pane showing the selected session's deliverable: one on screen, else the newest of its.
    private static var annotator: DeliverableAnnotator? {
        annotators.removeAll { $0.value == nil }
        let ours = annotators.compactMap(\.value).filter { $0.item != nil && (selected == nil || $0.item?.rowID == selected) }
            .sorted { $0.shownAt < $1.shownAt }
        let onScreen = ours.filter { annotator in
            guard let host = annotator.host, host.window != nil else { return false }
            return !host.isHiddenOrHasHiddenAncestor && host.visibleRect.width > 0
        }
        return onScreen.last ?? ours.last
    }

    /// conch's window: the dashboard, as it registers itself, while it is on screen; else the largest window titled
    /// conch, as the dashboard can miss registering (it looks for its window one turn after it is made).
    private static var window: NSWindow? {
        if let dashboard = ReviewNotifications.shared.reviewWindow, dashboard.isVisible, dashboard.windowNumber > 0 { return dashboard }
        return NSApp.windows.filter { window in
            window.isVisible && !(window is FloatingPanel) && window.title == "conch" && window.frame.height > 200
                && CGWindowID(exactly: window.windowNumber) != nil && window.windowNumber > 0
        }.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    private static func poll() {
        guard let folder, let data = try? Data(contentsOf: folder.appendingPathComponent("request.json")),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let seq = request["seq"] as? Int, seq > lastSeq, let what = request["do"] as? String else { return }
        lastSeq = seq
        Task { @MainActor in
            // In front, without bringing conch forward: WebKit stops drawing a page whose window is covered, and a
            // note's picture and the window's are what it draws.
            if let window, !window.occlusionState.contains(.visible) {
                window.orderFrontRegardless()
                try? await Task.sleep(for: .milliseconds(600))
            }
            var result: [String: Any] = ["seq": seq]
            do {
                if let more = try await perform(what, request) { result.merge(more) { $1 } }
                result["ok"] = true
            } catch {
                result["ok"] = false
                result["error"] = "\(error)"
            }
            result["state"] = annotator?.described ?? NSNull()
            if let window { result["window"] = ["number": window.windowNumber, "width": window.frame.width, "height": window.frame.height] }
            result["windows"] = NSApp.windows.map { "\(type(of: $0)) \($0.windowNumber) \($0.isVisible ? "visible" : "hidden") \(Int($0.frame.width))x\(Int($0.frame.height)) \($0.title)" }
            let out = (try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            try? out.write(to: folder.appendingPathComponent("result.json"), options: .atomic)
        }
    }

    struct Refused: Error, CustomStringConvertible {
        let description: String
    }

    private static func string(_ request: [String: Any], _ key: String) throws -> String {
        guard let value = request[key] as? String else { throw Refused(description: "\(key) is missing") }
        return value
    }

    private static func live() throws -> DeliverableAnnotator {
        guard let annotator else { throw Refused(description: "no deliverable is showing") }
        return annotator
    }

    private static func note(_ request: [String: Any]) throws -> AnnotationNote.ID {
        let annotator = try live()
        guard let n = request["n"] as? Int, n >= 1, n <= annotator.batch.count else { throw Refused(description: "no note \(request["n"] ?? "")") }
        return annotator.batch.notes[n - 1].id
    }

    /// Script run in the page's own world, as the page's own would be.
    private static func page(_ js: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        guard let web = try live().web else { throw Refused(description: "no page is showing") }
        return try await web.callAsyncJavaScript(js, arguments: arguments, in: nil, contentWorld: .page)
    }

    private static func perform(_ what: String, _ request: [String: Any]) async throws -> [String: Any]? {
        switch what {
        case "select":
            // As picking its row in the sidebar.
            selected = try string(request, "session")
            NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: selected)
        case "open":
            // conch's window, as a Dock click opens it (`applicationShouldHandleReopen`), without bringing conch forward:
            // launched in the background, it has none.
            if window == nil, !opened {
                opened = true
                _ = NSApp.delegate?.applicationOpenUntitledFile?(NSApp)
            }
        case "window":
            size = CGSize(width: request["width"] as? Double ?? 1280, height: request["height"] as? Double ?? 820)
            try place()
        case "stage":
            // As ⌘1, ⌘2 and the stage buttons set it: the conversation, side by side, or the deliverable alone.
            guard let mode = StageMode(rawValue: try string(request, "mode")) else { throw Refused(description: "no such stage") }
            NotificationCenter.default.post(name: .setStage, object: mode)
        case "appearance":
            NSApp.appearance = NSAppearance(named: request["dark"] as? Bool == true ? .darkAqua : .aqua)
        case "annotate":
            try live().setAnnotating(request["on"] as? Bool ?? true)
        case "hover":
            try await page("""
                const r = document.querySelector(selector).getBoundingClientRect();
                document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window }));
                """, ["selector": try string(request, "selector")])
        case "click":
            try await page("""
                const el = document.querySelector(selector);
                const r = el.getBoundingClientRect();
                const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
                for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, at));
                """, ["selector": try string(request, "selector")])
        case "words":
            try await page("""
                const el = document.querySelector(selector);
                const node = [...el.childNodes].find((n) => n.nodeType === 3);
                const range = document.createRange();
                range.setStart(node, from);
                range.setEnd(node, length == null ? node.data.length : from + length);
                getSelection().removeAllRanges();
                getSelection().addRange(range);
                document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: window }));
                """, ["selector": try string(request, "selector"), "from": request["from"] as? Int ?? 0, "length": request["length"] ?? NSNull()])
        case "js":
            return ["value": "\(try await page(try string(request, "js")) ?? "")"]
        case "reload":
            try live().web?.reload()
        case "doc-select":
            let annotator = try live()
            guard let text = annotator.textView else { throw Refused(description: "no document is showing") }
            let range = (text.string as NSString).range(of: try string(request, "text"))
            guard range.location != NSNotFound else { throw Refused(description: "not in the document") }
            text.setSelectedRange(range)
            annotator.documentSelected()
        case "drag":
            let annotator = try live()
            guard let picture = annotator.pictureView, let from = request["from"] as? [Double], let to = request["to"] as? [Double], from.count == 2, to.count == 2 else {
                throw Refused(description: "no picture, or no from and to")
            }
            let a = AnnotationGeometry.place(CGPoint(x: from[0], y: from[1]), in: picture.bounds)
            let b = AnnotationGeometry.place(CGPoint(x: to[0], y: to[1]), in: picture.bounds)
            annotator.pictureDrag(.leftMouseDown, at: a)
            annotator.pictureDrag(.leftMouseDragged, at: CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2))
            annotator.pictureDrag(.leftMouseDragged, at: b)
            if request["hold"] as? Bool != true { annotator.pictureDrag(.leftMouseUp, at: b) }
        case "type":
            try live().draftText = try string(request, "text")
        case "save":
            try live().saveDraft()
        case "cancel":
            try live().cancelDraft()
        case "edit":
            try live().edit(try note(request))
        case "remove":
            try live().remove(try note(request))
        case "list":
            try live().listOpen = request["open"] as? Bool ?? true
        case "send":
            try live().send()
        case "discard":
            try live().act(.discard)
        case "clear":
            try live().clear()
        case "shot":
            return ["path": try await shoot(try string(request, "path"))]
        case "state":
            break
        default:
            throw Refused(description: "no such request: \(what)")
        }
        return nil
    }

    /// conch's own window, as the window server composites it (a page's web view and all), through ScreenCaptureKit's
    /// current-process content: no Screen Recording permission, and nothing but this window.
    /// The window's size for every picture, once asked for.
    private static var size: CGSize?

    /// The window at its asked size, on a Retina display, so every picture is drawn at the same size and scale. True
    /// when it had to be moved there.
    @discardableResult
    private static func place() throws -> Bool {
        guard let window else { throw Refused(description: "no window") }
        guard let size else { return false }
        let screen = NSScreen.screens.first { $0.backingScaleFactor >= 2 } ?? window.screen ?? NSScreen.main
        guard let area = screen?.visibleFrame else { return false }
        let wanted = NSRect(x: area.minX + 40, y: area.maxY - 40 - size.height, width: size.width, height: size.height)
        guard window.frame != wanted || window.backingScaleFactor < 2 else { return false }
        window.setFrame(wanted, display: true)
        return true
    }

    private static func shoot(_ path: String) async throws -> String {
        // Moved, the window server and WebKit take a moment to draw it there.
        if try place() { try await Task.sleep(for: .milliseconds(500)) }
        guard path.hasSuffix(".png"), let number = window.flatMap({ CGWindowID(exactly: $0.windowNumber) }) else {
            throw Refused(description: "a .png path, and a window on screen")
        }
        guard #available(macOS 14.4, *) else { throw Refused(description: "needs macOS 14.4") }
        let content = try await SCShareableContent.currentProcess
        guard let shared = content.windows.first(where: { $0.windowID == number }) else {
            throw Refused(description: "the window isn't shareable")
        }
        let filter = SCContentFilter(desktopIndependentWindow: shared)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard let png = CanvasInk.png(image) else { throw Refused(description: "no PNG") }
        try png.write(to: URL(fileURLWithPath: path))
        return path
    }
}

/// A weak hold, for a list of things that may go.
final class Weak<T: AnyObject> {
    weak var value: T?
    init(_ value: T) { self.value = value }
}
