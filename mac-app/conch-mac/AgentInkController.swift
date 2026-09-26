import AppKit
import Combine
import ConchDesign
import SwiftUI
import WebKit

/// Agent ink on the Mac: the marks an agent published with a review (`scene.marks`, `features.deliverables` 3), drawn over
/// it where Tyler is looking, into the canvas's one document (`CanvasController`) in the agent's colour. The review is the
/// one brought forward last: by the Ready pill, the panel's Previous, Next or switcher, or opened in the side panel or
/// inside the full-screen panel. Where each mark goes depends on its frame:
///
/// - `{selector}` and `{quote}`: found in conch's own web view while the review shows there, by a read-only script run in
///   its own content world. Staged in a browser or Figma, conch can't see the page, so they are left out.
/// - `{image}`: on the image while conch shows it; else left out.
/// - `{canvas}`: on the display of the canvas Tyler sent, by the id the prompt gave the agent.
///
/// Nothing is drawn at a guessed position: a mark that can't be placed is skipped, logged, and counted on the pill's chip
/// ("2 marks couldn't be shown here", their labels on hover). A page or an image can move
/// under its marks (a scroll, a resize, the window moving or going behind another), and following it frame by frame would
/// mean running script in the page every frame; so conch looks five times a second, fades the marks out while it moves,
/// and brings them back where it is once it is still. The glass stays click-through throughout: agent ink never puts the
/// pen down or takes the keys.
@MainActor
final class AgentInkController {
    static let shared = AgentInkController()

    /// A place conch shows a review itself: a page's web view, or an image's view.
    private struct Surface {
        weak var view: NSView?
        let item: ReviewItem
        /// The image's path, for an image.
        let image: String?
    }

    /// The marks placed, in one display's 0-1 space.
    struct Placement: Equatable {
        let display: CGDirectDisplayID
        let frame: CGRect
        let marks: [CanvasMark]
    }

    private weak var store: StateStore?
    private var surfaces: [Surface] = []
    /// The review whose marks are shown.
    private var shown: ReviewItem?
    private var watching: Task<Void, Never>?
    /// What is drawn, and what was seen last time: marks move only once what they are on is still.
    private var drawn: Placement?
    private var seen: Placement?
    /// Canvases by id, read from disk once.
    private var canvases: [String: CanvasAnchor] = [:]
    private var subscriptions: Set<AnyCancellable> = []
    private var escape: Any?
    /// How often a page or an image is looked at while its marks show.
    static let look: Duration = .milliseconds(200)

    func install(store: StateStore) {
        guard self.store == nil else { return }
        self.store = store
        // The Ready pill, Previous and Next, the switcher: the review brought forward, on the very pair the canvas starts a
        // clear canvas on (`CanvasController.install`), a turn later, so every clear is followed by these marks. The pill
        // sets the review at the click and pins the panel to its session a hop later: the pair changes twice, and on the
        // review alone the second clear wiped the marks the first change had just drawn.
        if let panels = FloatingPanels.installed {
            panels.$staged.combineLatest(panels.queue.$lastStaged)
                .dropFirst()
                .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
                .receive(on: RunLoop.main)
                .sink { [weak self] session, key in MainActor.assumeIsolated { self?.staged(key, in: session) } }
                .store(in: &subscriptions)
        }
        // Esc on what the marks are drawn over — conch's own page or image of the review, with the keyboard — clears them,
        // and lets the Esc go on to whatever else it does. Esc anywhere else in conch (a field, a sheet, the panel) is
        // someone else's, and used to clear them too; the chip's × is for that. Only conch's own keys: seeing Esc in other
        // apps would need the Accessibility grant, and taking the keys to get it would steal focus.
        escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 {
                MainActor.assumeIsolated { AgentInkController.shared.escaped(in: event.window) }
            }
            return event
        }
    }

    // MARK: What is shown

    /// The review the queue brought forward, found by its key in what is published, while the panel is on its session.
    /// Between the pill's click and its staging the pair names the session the panel was on, and a pick in conch's window
    /// (`FloatingPanels.picked`) names none: neither is where this review is.
    private func staged(_ key: ReviewItem.ID?, in session: SessionRow.ID?) {
        guard let key, let row = store?.state?.row(session),
              let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == key }) else { return }
        show(ReviewItem(row: row, review: review))
    }

    /// `item`'s marks, in place of the last review's. One with none clears them.
    func show(_ item: ReviewItem) {
        guard item != shown else { return }
        shown = item
        drawn = nil
        seen = nil
        watch()
    }

    /// A page or an image showing `item` in conch: its marks can be found there now.
    func appeared(_ view: NSView, image: String? = nil, showing item: ReviewItem) {
        surfaces.removeAll { $0.view == nil || $0.view === view }
        surfaces.append(Surface(view: view, item: item, image: image))
        if item == shown { watch() } else { show(item) }
    }

    /// A page or an image gone: marks found there go at the next look.
    func gone(_ view: NSView) {
        surfaces.removeAll { $0.view == nil || $0.view === view }
    }

    /// Nothing shown any more: the canvas cleared (Esc on the glass, a new item, a Send).
    func stop() {
        watching?.cancel()
        watching = nil
        shown = nil
        drawn = nil
        seen = nil
    }

    /// The chip's ×, or Esc where they are: the agent's marks go, and stay gone for this review; Tyler's stay.
    func dismiss() {
        guard CanvasController.shared.document?.has(.agent) == true else { return }
        stop()
        CanvasController.shared.clearAgent()
    }

    /// Esc in `window`: the marks go only when what they are drawn over has the keyboard there.
    private func escaped(in window: NSWindow?) {
        guard let shown, let focus = window?.firstResponder as? NSView,
              surfaces.contains(where: { surface in
                  guard surface.item.id == shown.id, let view = surface.view, view.window === window else { return false }
                  return focus === view || focus.isDescendant(of: view)
              })
        else { return }
        dismiss()
    }

    // MARK: Placing

    /// Place the shown review's marks; again every `look` while a page or an image of it is on screen, which is all that
    /// can move under them.
    private func watch() {
        watching?.cancel()
        guard let item = shown, !item.marks.isEmpty else {
            watching = nil
            return CanvasController.shared.clearAgent()
        }
        watching = Task { [weak self] in
            while !Task.isCancelled, let self {
                let (placement, missed) = await place(item)
                guard !Task.isCancelled else { return }
                let watched = surfaces.contains { $0.view != nil && $0.item.id == item.id }
                settle(placement, by: item, lasting: !watched)
                // Said on the chip while some are drawn; with none drawn there is no chip, and nothing to say it on.
                CanvasController.shared.setAgentMissed(placement == nil ? nil : AgentInk.Missed(missed))
                guard watched else { return }
                try? await Task.sleep(for: Self.look)
            }
        }
    }

    /// Marks move only once what they are on is still: while it moves they fade out, and still again they come back where
    /// it is. With nothing placeable now (scrolled away, covered), what is drawn fades out and waits — unless nothing is
    /// left to watch (`lasting`), when it goes.
    private func settle(_ placement: Placement?, by item: ReviewItem, lasting: Bool) {
        defer { seen = placement }
        let canvas = CanvasController.shared
        guard let placement, !placement.marks.isEmpty else { return lasting ? canvas.clearAgent() : canvas.hideAgent(true) }
        if placement == drawn { return canvas.hideAgent(false) }
        guard drawn == nil || placement == seen else { return canvas.hideAgent(true) }
        drawn = placement
        let codex = store?.state?.row(item.rowID)?.backend?.lowercased() == "codex"
        canvas.showAgent(placement.marks, on: placement.display, frame: placement.frame, by: codex ? "Codex" : "Claude")
    }

    /// Every mark of `item` that can be placed right now, on one display: the first a mark lands on. Ids are the review's
    /// and the agent's, so another review's marks are new marks and this one's keep theirs. And the marks that can't be
    /// placed here at all, by kind and label, for the chip — not ones merely scrolled away or covered, which come back.
    private func place(_ item: ReviewItem) async -> (Placement?, [(kind: String, label: String?)]) {
        var screen: NSScreen?
        var marks: [CanvasMark] = []
        var missed: [(kind: String, label: String?)] = []
        func miss(_ agent: AgentMark, _ why: String) {
            NSLog("conch: agent mark %@ %@; skipped", agent.id, why)
            missed.append((agent.kind.rawValue, agent.label))
        }
        func add(_ mark: CanvasMark?, on display: NSScreen, _ agent: AgentMark) {
            guard let mark else { return miss(agent, "has no geometry to draw") }
            guard screen == nil || screen === display else { return miss(agent, "is on another display than the rest") }
            screen = display
            marks.append(mark)
        }
        let page = surfaces.first { $0.item.id == item.id && $0.image == nil }?.view as? WKWebView
        var found: [String: Found] = [:]
        // Only while its window is in sight: a page behind other windows or minimised places nothing anyway (`visible`),
        // and asking it five times a second woke its web process for as long as it stayed open.
        let asked = page?.window?.occlusionState.contains(.visible) == true
        if let page, asked {
            found = await Self.find(item.marks, in: page, link: item.link)
        }
        for agent in item.marks {
            guard let kind = AgentInk.Kind(rawValue: agent.kind.rawValue) else {
                miss(agent, "is a kind this build doesn't draw")
                continue
            }
            let id = "\(item.id)/\(agent.id)"
            switch agent.frame {
            case let .canvas(canvas):
                guard let anchor = anchor(of: canvas), let display = NSScreen.screens.first(where: { $0.displayID == anchor.id }) else {
                    miss(agent, "is on canvas \(canvas), which isn't on this Mac's displays")
                    continue
                }
                let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
                add(AgentInk.mark(id: id, kind: kind, label: agent.label, at: agent.at, to: agent.to, rect: agent.rect, pts: agent.pts, in: whole), on: display, agent)
            case let .image(path):
                // On the image while conch shows it, where it is on screen now; each mark only where the image shows.
                guard let view = surfaces.first(where: { $0.item.id == item.id && $0.image.map(Self.same(path)) == true })?.view else {
                    miss(agent, "is on an image conch isn't showing")
                    continue
                }
                guard let (display, rect) = Self.onScreen(view.bounds, of: view),
                      let mark = AgentInk.mark(id: id, kind: kind, label: agent.label, at: agent.at, to: agent.to, rect: agent.rect, pts: agent.pts, in: rect),
                      Self.visible(Self.middle(of: mark, on: display), in: view)
                else { continue }
                add(mark, on: display, agent)
            case .selector, .quote:
                // Only in conch's own page of this review: anywhere else conch can't see what it names. On a page it
                // asked that hasn't got it, it isn't there; on one out of sight, it may be.
                guard let page else {
                    miss(agent, "names part of a page conch isn't showing")
                    continue
                }
                guard let client = found[agent.id] else {
                    // `find` has logged it, selector and all.
                    if asked, !page.isLoading, item.link.map({ Self.showsReview(page.url, link: $0) }) == true { missed.append((agent.kind.rawValue, agent.label)) }
                    continue
                }
                let local = AgentInk.viewRect(client: client.rect, viewport: client.viewport, viewWidth: page.bounds.width)
                let flipped = page.isFlipped ? local : CGRect(x: local.minX, y: page.bounds.height - local.maxY, width: local.width, height: local.height)
                guard let (display, rect) = Self.onScreen(flipped, of: page),
                      Self.visible(NSPoint(x: display.frame.minX + rect.midX * display.frame.width, y: display.frame.maxY - rect.midY * display.frame.height), in: page)
                else { continue }
                add(AgentInk.mark(id: id, kind: kind, label: agent.label, on: rect, size: display.frame.size), on: display, agent)
            }
        }
        guard let screen, let display = screen.displayID else { return (nil, missed) }
        return (Placement(display: display, frame: screen.frame, marks: marks), missed)
    }

    private func anchor(of canvas: String) -> CanvasAnchor? {
        if let known = canvases[canvas] { return known }
        let anchor = CanvasFolder.anchor(of: canvas)
        if let anchor { canvases[canvas] = anchor }
        return anchor
    }

    /// `rect`, in `view`'s own coordinates, as 0-1 of the display it is on.
    private static func onScreen(_ rect: CGRect, of view: NSView) -> (NSScreen, CGRect)? {
        guard let window = view.window else { return nil }
        let global = window.convertToScreen(view.convert(rect, to: nil))
        guard let display = NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: global.midX, y: global.midY)) }) else { return nil }
        return (display, AgentInk.unit(global, on: display.frame))
    }

    /// Where a mark's middle is, in AppKit's screen coordinates.
    private static func middle(of mark: CanvasMark, on display: NSScreen) -> NSPoint {
        let points = mark.points.map { $0.point(in: CGSize(width: 1, height: 1)) }
        let xs = points.map(\.x), ys = points.map(\.y)
        let x = ((xs.min() ?? 0) + (xs.max() ?? 0)) / 2, y = ((ys.min() ?? 0) + (ys.max() ?? 0)) / 2
        return NSPoint(x: display.frame.minX + x * display.frame.width, y: display.frame.maxY - y * display.frame.height)
    }

    /// Whether `point` on screen shows `view`: inside the part of it that is scrolled into sight, in a window on screen,
    /// and that window the one there under the glass — not covered by another app's, nor by conch's own panel.
    private static func visible(_ point: NSPoint, in view: NSView) -> Bool {
        guard let window = view.window, window.isVisible, window.occlusionState.contains(.visible) else { return false }
        guard window.convertToScreen(view.convert(view.visibleRect, to: nil)).contains(point) else { return false }
        let display = NSScreen.screens.first { $0.frame.contains(point) }?.displayID
        let glass = display.flatMap { CanvasController.shared.glassNumber(on: $0) } ?? 0
        return NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: glass) == window.windowNumber
    }

    private static func same(_ path: String) -> (String) -> Bool {
        { URL(fileURLWithPath: $0).standardizedFileURL.path == URL(fileURLWithPath: path).standardizedFileURL.path }
    }

    // MARK: Finding what a mark names

    /// Where a selector's element or a quote's words are in the page, in client pixels, with the viewport they are in.
    struct Found {
        let rect: CGRect
        let viewport: AgentInk.Viewport
    }

    /// The one script both apps find a selector or a quote with (`AgentInk.finder`).
    static let finder = AgentInk.finder

    /// Each selector and quote mark's place in `page`, by the agent's id; only while the page is still the review's own,
    /// not one browsed to since.
    private static func find(_ marks: [AgentMark], in page: WKWebView, link: String?) async -> [String: Found] {
        guard let link, Self.showsReview(page.url, link: link), !page.isLoading else { return [:] }
        let asked: [[String]] = marks.compactMap { mark in
            switch mark.frame {
            case let .selector(selector): [mark.id, "selector", selector]
            case let .quote(quote): [mark.id, "quote", quote]
            case .canvas, .image: nil
            }
        }
        guard !asked.isEmpty else { return [:] }
        guard let answer = try? await page.callAsyncJavaScript(finder, arguments: ["marks": asked], in: nil, contentWorld: .defaultClient) as? [String: Any],
              let view = answer["viewport"] as? [String: Double], let found = answer["found"] as? [String: [Double]]
        else { return [:] }
        let viewport = AgentInk.Viewport(left: view["left"] ?? 0, top: view["top"] ?? 0, scale: view["scale"] ?? 1, width: view["width"] ?? 0)
        for mark in asked where found[mark[0]] == nil {
            NSLog("conch: agent mark %@ names %@ \"%@\", which isn't on the page; skipped", mark[0], mark[1], mark[2])
        }
        return found.compactMapValues { xywh in
            xywh.count == 4 ? Found(rect: CGRect(x: xywh[0], y: xywh[1], width: xywh[2], height: xywh[3]), viewport: viewport) : nil
        }
    }

    /// Whether the page is the review's own link: the same file, or the same address but for its fragment.
    static func showsReview(_ url: URL?, link: String) -> Bool {
        guard let url else { return false }
        if url.isFileURL { return url.standardizedFileURL.path == URL(fileURLWithPath: link).standardizedFileURL.path || url.absoluteString == link }
        func key(_ text: String) -> String { String(text.split(separator: "#", maxSplits: 1).first ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        return key(url.absoluteString) == key(link)
    }
}

private struct AgentInkItemKey: EnvironmentKey {
    static let defaultValue: ReviewItem? = nil
}

extension EnvironmentValues {
    /// The review a pane shows, for the page or image in it to say so (`AgentInkController.appeared`).
    var agentInkItem: ReviewItem? {
        get { self[AgentInkItemKey.self] }
        set { self[AgentInkItemKey.self] = newValue }
    }
}
