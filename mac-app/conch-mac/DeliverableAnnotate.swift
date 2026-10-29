import AppKit
import Combine
import ConchDesign
import SwiftUI
import WebKit

/// Annotate (docs/annotate.md). Tyler: "let's add annotate on the deliverables plane like u can do in codex". In the
/// deliverables pane, where conch draws the deliverable itself, Tyler pins notes to what he points at — an element of a
/// page, words in it or in a document, part of a picture — and sends them, as one message, to the session that published
/// it. The notes are anchored as agent ink's marks are (`AgentInkController`): a selector, a quote, an image and its
/// fractions. So the agent is told exactly what he meant, in terms it can act on, and can answer with marks on the very
/// same things.
///
/// Not the canvas (Canvas.swift), which is ink on a glass over the whole screen, anchored to the display and pictured by
/// Screen Recording, routed to whoever owns what is on screen. A note here follows what it is pinned to as the pane
/// scrolls, zooms and reloads; its picture is conch's own (no permission); and it goes to the deliverable's own session,
/// never a guess.
///
/// One annotator per pane showing a deliverable (`InlineReviewView`), told which deliverable as it changes; the notes
/// themselves are kept per deliverable for as long as conch runs (`AnnotationDrafts`), so moving to another tab and back
/// keeps them. Whatever the pane draws registers itself as it appears: a page's web view (`AnnotateWebBridge`), a
/// picture's scroll view, a document's text view. Each places the notes on it in its own top-left points, which is
/// where the layer drawn over it (`AnnotateLayer`) puts their pins.
@MainActor
final class DeliverableAnnotator: ObservableObject {
    enum Kind: Equatable {
        case page, picture, document
    }

    /// What is under the pointer while annotating: the element a click would pin to, or the box being dragged.
    enum Pointer: Equatable {
        case element(CGRect, String)
        case dragging(CGRect)
    }

    private(set) var item: ReviewItem?
    private weak var store: StateStore?
    @Published private(set) var annotating = false
    @Published private(set) var batch = AnnotationBatch() {
        didSet { if let item { AnnotationDrafts.shared.keep(batch, for: item) } }
    }

    /// The note being written: a new one, not yet in the batch, or a copy of one being edited.
    @Published private(set) var draft: AnnotationNote?
    @Published var draftText = ""
    @Published private(set) var draftIsNew = false
    /// Where each note on what the pane shows is now, and the draft, in the shown view's own top-left points.
    @Published private(set) var placed: [AnnotationNote.ID: CGRect] = [:]
    @Published private(set) var pointer: Pointer?
    @Published var listOpen = false
    @Published private(set) var sending = false
    @Published private(set) var notice: AnnotationTray.Notice?
    /// What the pane shows that can be annotated, and what its notes are on (a page's address, a file's path); nil for a
    /// film, a PDF, a folder with nothing picked, or anything conch can't preview.
    @Published private(set) var kind: Kind?
    @Published private(set) var place: String?

    private(set) weak var host: NSView?
    private(set) weak var web: WKWebView?
    private weak var webBridge: AnnotateWebBridge?
    private(set) weak var pictureView: NSView?
    private(set) weak var textView: NSTextView?
    private var dragFrom: CGPoint?
    private var watching: [NSObjectProtocol] = []
    private var escape: Any?
    private var quiet: Task<Void, Never>?
    private var listing: AnyCancellable?
    /// When this pane was last told what it shows, for the harness to find the pane in front.
    private(set) var shownAt = Date.distantPast

    init() {
        if AnnotateHarness.running { AnnotateHarness.annotators.append(Weak(self)) }
    }

    deinit {
        watching.forEach(NotificationCenter.default.removeObserver)
        if let escape { NSEvent.removeMonitor(escape) }
    }

    // MARK: Which deliverable

    /// The deliverable this pane shows, as it changes: its notes come back, and annotating stops with the last one.
    func show(_ item: ReviewItem, store: StateStore) {
        if self.store !== store {
            self.store = store
            // A session that ends takes its row, and the deliverable with it, out of conch's list: notes left on it are
            // gathered as the list changes, for every pane's tray to say (`AnnotationDrafts.orphans`).
            listing = store.$state.receive(on: RunLoop.main).sink { state in
                MainActor.assumeIsolated { AnnotationDrafts.shared.gather(listed: state.map { Set($0.rows.map(\.id)) }) }
            }
        }
        shownAt = Date()
        guard item.id != self.item?.id else {
            self.item = item
            return
        }
        commitDraft()
        self.item = item
        setAnnotating(false)
        batch = AnnotationDrafts.shared.batch(for: item.id)
        notice = nil
        listOpen = false
    }

    /// What the tray says: this pane's own word (Sent, why not), else notes a session left behind when it ended.
    var said: AnnotationTray.Notice? {
        notice ?? AnnotationDrafts.shared.orphans.first.map { .orphaned($0.item.label, notes: $0.batch.count) }
    }

    /// Where Send goes: the session that published it, as conch lists it now, or ended.
    var route: AnnotationRoute? {
        guard let item else { return nil }
        let rows = store?.state?.rows ?? []
        return AnnotationRoute.resolve(owner: item.rowID, label: store?.state?.row(item.rowID)?.label ?? item.label,
                                       sessions: rows.map { ($0.id, $0.label, $0.messageUnavailableReason) })
    }

    /// What pointing does in what the pane shows, for the tray while there are no notes yet.
    var hint: String {
        switch kind {
        case .page: "Click anything to pin a note to it, or select words"
        case .picture: "Drag a box on the picture, or click a spot"
        case .document: "Select words to pin a note to them"
        case nil: "Pick a file to annotate it"
        }
    }

    /// Whether what the pane shows takes notes: a page, a picture or a document, or a folder whose picked file is one.
    var canAnnotate: Bool { kind != nil }

    // MARK: Annotating

    func toggle() { setAnnotating(!annotating) }

    func setAnnotating(_ on: Bool) {
        guard on != annotating || (!on && pointer != nil) else { return }
        if on, kind == nil { return }
        if !on { commitDraft() }
        annotating = on
        pointer = nil
        dragFrom = nil
        if on { notice = nil }
        pushToPage()
        watchEscape()
    }

    /// Esc while annotating, in the pane's window: a note being written puts itself back (its own field's Esc), else
    /// annotating stops and the notes stay.
    private func watchEscape() {
        if let escape { NSEvent.removeMonitor(escape) }
        escape = nil
        guard annotating else { return }
        escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return event }
            return MainActor.assumeIsolated {
                guard let self, self.annotating, self.draft == nil, event.window === self.host?.window else { return event }
                self.setAnnotating(false)
                return nil
            }
        }
    }

    // MARK: What the pane shows

    /// A page's web view showing this deliverable (or a page browsed to from it).
    func attachPage(_ webView: WKWebView, bridge: AnnotateWebBridge) {
        detachAll()
        web = webView
        webBridge = bridge
        host = webView
        kind = .page
        place = webView.url?.absoluteString
        pushToPage()
    }

    /// A picture's scroll view (`host`, what the layer is drawn over) and the picture's own view in it.
    func attachPicture(host: NSView, picture: NSView, path: String) {
        detachAll()
        self.host = host
        pictureView = picture
        kind = .picture
        place = path
        watch(host, picture)
        placeNatively()
    }

    /// A document's scroll view and its text.
    func attachDocument(host: NSView, text: NSTextView, path: String) {
        detachAll()
        self.host = host
        textView = text
        kind = .document
        place = path
        watch(host, text)
        placeNatively()
    }

    /// Whatever registered `view` is gone: nothing is placed until the next thing appears.
    func detach(_ view: NSView) {
        guard view === host || view === web || view === pictureView || view === textView else { return }
        detachAll()
    }

    private func detachAll() {
        watching.forEach(NotificationCenter.default.removeObserver)
        watching = []
        host = nil
        web = nil
        webBridge = nil
        pictureView = nil
        textView = nil
        kind = nil
        place = nil
        placed = [:]
        pointer = nil
        dragFrom = nil
    }

    /// A picture or a document moves under its notes as it scrolls, zooms or resizes: placed again on each.
    private func watch(_ host: NSView, _ content: NSView) {
        let center = NotificationCenter.default
        if let scroll = host as? NSScrollView {
            scroll.contentView.postsBoundsChangedNotifications = true
            watching.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.placeNatively() }
            })
        }
        for view in [host, content] {
            view.postsFrameChangedNotifications = true
            watching.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: view, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.placeNatively() }
            })
        }
    }

    /// `rect` in `view`'s points, in the host's top-left points: what the layer over the host draws in.
    private func inHost(_ rect: CGRect, from view: NSView) -> CGRect? {
        guard let host, view.window != nil else { return nil }
        let converted = view.convert(rect, to: host)
        return host.isFlipped ? converted : CGRect(x: converted.minX, y: host.bounds.height - converted.maxY, width: converted.width, height: converted.height)
    }

    /// The notes on this picture or document, and the draft, where they are now; a document's words no longer in it are
    /// missing.
    private func placeNatively() {
        guard let place else { return }
        var at: [AnnotationNote.ID: CGRect] = [:]
        var found = Set<AnnotationNote.ID>()
        for note in batch.notes + [draft].compactMap({ $0 }) where AnnotationPlace.same(note.on, place) {
            guard let located = locate(note.anchor) else { continue }
            found.insert(note.id)
            if let shown = located.shown { at[note.id] = shown }
        }
        placed = at
        if kind == .document { batch.looked(on: place, found: found) }
    }

    /// An anchor found in this picture or document, and where it shows in the host, if it does.
    private struct Located {
        let shown: CGRect?
    }

    /// Where an anchor is in this picture or document; nil when it isn't in it.
    private func locate(_ anchor: AnnotationAnchor) -> Located? {
        switch anchor {
        case let .region(_, unit):
            guard let pictureView else { return nil }
            return Located(shown: inHost(AnnotationGeometry.place(unit, in: pictureView.bounds), from: pictureView))
        case let .spot(_, unit):
            guard let pictureView else { return nil }
            let spot = AnnotationGeometry.place(unit, in: pictureView.bounds)
            return Located(shown: inHost(CGRect(origin: spot, size: .zero), from: pictureView))
        case let .quote(quote, _):
            guard let textView, let range = AnnotationQuote.find(quote, in: textView.string) else { return nil }
            return Located(shown: textRect(range, in: textView).flatMap { inHost($0, from: textView) })
        case .element:
            return nil
        }
    }

    /// Where a document's characters are drawn, in its text view's points.
    private func textRect(_ range: NSRange, in textView: NSTextView) -> CGRect? {
        guard let layout = textView.layoutManager, let container = textView.textContainer else { return nil }
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        let origin = textView.textContainerOrigin
        return rect.offsetBy(dx: origin.x, dy: origin.y)
    }

    // MARK: A page

    /// The page's script told what to look for: annotating or not, and the notes on this page with the draft.
    func pushToPage() {
        guard let web, let webBridge else { return }
        let page = web.url?.absoluteString ?? place ?? ""
        webBridge.push(annotating, AnnotationScript.anchors(batch.notes + [draft].compactMap { $0 }, on: page))
    }

    /// What the page said.
    func heard(_ message: AnnotationScript.Message) {
        guard let web else { return }
        switch message {
        case let .ready(url):
            place = url
            pushToPage()
        case let .element(element, rect, viewport, url):
            guard annotating else { return }
            place = url
            let shown = AgentInk.viewRect(client: rect, viewport: viewport, viewWidth: web.bounds.width)
            begin(.element(element), on: url, at: shown)
            picture(of: shown, outline: .box, in: web, for: draft?.id)
        case let .words(quote, selected, rect, viewport, url):
            guard annotating else { return }
            place = url
            let shown = AgentInk.viewRect(client: rect, viewport: viewport, viewWidth: web.bounds.width)
            begin(.quote(quote, selected: selected), on: url, at: shown)
            picture(of: shown, outline: .words, in: web, for: draft?.id)
        case let .placed(found, missing, loaded, hover, viewport, url):
            place = url
            placed = found.mapValues { AgentInk.viewRect(client: $0, viewport: viewport, viewWidth: web.bounds.width) }
            pointer = annotating ? hover.map { .element(AgentInk.viewRect(client: $0.rect, viewport: viewport, viewWidth: web.bounds.width), $0.label) } : nil
            // Only once the page has loaded: a page still building has not lost anything yet.
            if loaded { batch.mark(found: Set(found.keys), missing: Set(missing)) }
        }
    }

    private enum Outline { case box, words }

    /// The page as it shows round `rect` (the web view's points), outlined: the note's picture, taken as it is pinned.
    private func picture(of rect: CGRect, outline: Outline, in web: WKWebView, for id: AnnotationNote.ID?) {
        guard let id else { return }
        let area = AnnotationGeometry.pictureRect(around: rect, in: web.bounds)
        guard area.width >= 1, area.height >= 1 else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = area
        web.takeSnapshot(with: configuration) { [weak self] image, _ in
            MainActor.assumeIsolated {
                guard let self, let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
                let scale = CGFloat(cg.width) / area.width
                let local = rect.offsetBy(dx: -area.minX, dy: -area.minY).applying(CGAffineTransform(scaleX: scale, y: scale))
                let drawn = AnnotationPicture.crop(cg, to: CGRect(x: 0, y: 0, width: cg.width, height: cg.height),
                                                   outline: outline == .box ? .box(local) : .words(local), scale: scale)
                self.setPicture(drawn.flatMap(CanvasInk.png), of: id)
            }
        }
    }

    // MARK: A picture

    /// A press on the picture while annotating: a drag is a box, a click a spot. `point` is in the picture's own points.
    func pictureDrag(_ phase: NSEvent.EventType, at point: CGPoint) {
        guard annotating, let pictureView, let path = place else { return }
        switch phase {
        case .leftMouseDown:
            dragFrom = point
        case .leftMouseDragged:
            guard let from = dragFrom else { return }
            let box = CGRect(x: min(from.x, point.x), y: min(from.y, point.y), width: abs(point.x - from.x), height: abs(point.y - from.y))
            pointer = inHost(box.intersection(pictureView.bounds), from: pictureView).map(Pointer.dragging)
        default:
            guard let from = dragFrom else { return }
            dragFrom = nil
            pointer = nil
            let box = CGRect(x: min(from.x, point.x), y: min(from.y, point.y), width: abs(point.x - from.x), height: abs(point.y - from.y))
            let anchor: AnnotationAnchor
            if max(box.width, box.height) < AnnotationGeometry.dragThreshold {
                guard let unit = AnnotationGeometry.unit(from, of: pictureView.bounds) else { return }
                anchor = .spot(image: path, at: unit)
            } else {
                let unit = AnnotationGeometry.unit(box, of: pictureView.bounds)
                guard !unit.isNull, unit.width > 0, unit.height > 0 else { return }
                anchor = .region(image: path, rect: unit)
            }
            begin(anchor, on: path, at: locate(anchor)?.shown ?? .zero)
            guard let id = draft?.id else { return }
            Task.detached(priority: .userInitiated) {
                let drawn = AnnotationPicture.load(path).flatMap { AnnotationPicture.crop(image: $0, anchor: anchor) }.flatMap(CanvasInk.png)
                await MainActor.run { [weak self] in self?.setPicture(drawn, of: id) }
            }
        }
    }

    // MARK: A document

    /// Words selected in the document while annotating.
    func documentSelected() {
        guard annotating, let textView, let path = place else { return }
        let range = textView.selectedRange()
        guard range.length > 0, let made = AnnotationQuote.make(in: textView.string, selected: range) else { return }
        let anchor = AnnotationAnchor.quote(made.quote, selected: made.selected)
        textView.setSelectedRange(NSRange(location: range.location, length: 0))
        begin(anchor, on: path, at: locate(anchor)?.shown ?? .zero)
    }

    // MARK: Notes

    /// A new note, pinned to `anchor` on `on`, its field open; the one being written before it is kept if it has words.
    private func begin(_ anchor: AnnotationAnchor, on: String, at shown: CGRect) {
        commitDraft()
        let note = AnnotationNote(anchor: anchor, on: on)
        draft = note
        draftText = ""
        draftIsNew = true
        listOpen = false
        notice = nil
        placed[note.id] = shown
        pushToPage()
    }

    /// The note `id` opened to edit; on the page, its words are its own until saved.
    func edit(_ id: AnnotationNote.ID) {
        guard draft?.id != id, let note = batch.note(id) else { return }
        commitDraft()
        draft = note
        draftText = note.text
        draftIsNew = false
        listOpen = false
    }

    /// Return, or Save: kept with its words; a new one with none is let go.
    func saveDraft() {
        guard var note = draft else { return }
        note.text = draftText
        if note.hasWords {
            batch.save(note)
        } else if !draftIsNew {
            batch.remove(note.id)
        }
        draft = nil
        draftText = ""
        afterNotesChanged()
    }

    /// Esc in the field: a new note goes, an edited one stays as it was.
    func cancelDraft() {
        draft = nil
        draftText = ""
        afterNotesChanged()
    }

    func deleteDraft() {
        if let draft { batch.remove(draft.id) }
        draft = nil
        draftText = ""
        afterNotesChanged()
    }

    func remove(_ id: AnnotationNote.ID) {
        batch.remove(id)
        if draft?.id == id { draft = nil }
        afterNotesChanged()
    }

    /// The tray's ×: every note gone, nothing sent.
    func clear() {
        batch = AnnotationBatch()
        draft = nil
        draftText = ""
        listOpen = false
        afterNotesChanged()
    }

    /// A draft with words is kept as the next thing happens; one without is let go.
    private func commitDraft() {
        guard draft != nil else { return }
        if draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !draftIsNew { return cancelDraft() }
        saveDraft()
    }

    private func setPicture(_ picture: Data?, of id: AnnotationNote.ID) {
        if draft?.id == id { draft?.picture = picture }
        batch.setPicture(picture, of: id)
    }

    private func afterNotesChanged() {
        if kind == .page { pushToPage() } else { placeNatively() }
        if batch.isEmpty { listOpen = false }
    }

    // MARK: Send

    /// Send: the notes, their pictures and the deliverable as it shows, to the session that published it, as one
    /// message through the composer's own path (`StateStore.send`). The pins clear once the daemon takes it; refused
    /// after all, they come back, and the tray says why.
    func send() {
        commitDraft()
        guard !batch.isEmpty, !sending, let item, let store else { return }
        guard let route = self.route, !route.ended else {
            return say(.ended(self.route ?? AnnotationRoute(session: item.rowID, label: item.label, ended: true)))
        }
        sending = true
        listOpen = false
        Task { @MainActor in
            let sent = batch
            guard let message = await write(sent, item: item) else {
                sending = false
                return say(.notSent(to: route.label, because: "conch couldn't save the notes' pictures"))
            }
            let event = ConchDaemonEvent.inject(sessionId: route.session, label: route.label, text: message)
            let taken = await store.send(event).value
            sending = false
            guard taken else { return say(.notSent(to: route.label, because: nil)) }
            if self.item?.id == item.id {
                batch = AnnotationBatch()
                draft = nil
                setAnnotating(false)
                afterNotesChanged()
                say(.sent(to: route.label), lasting: AnnotationTray.Notice.sentFor)
            } else {
                AnnotationDrafts.shared.keep(AnnotationBatch(), for: item)
            }
            // Taken isn't landed: refused after all, the notes come back to the deliverable they were on, ahead of any
            // pinned there since, whichever deliverable the pane has moved on to.
            guard let failure = await CanvasController.failure(of: event.opId, in: store) else { return }
            let back = AnnotationBatch(id: UUID().uuidString, notes: sent.notes + AnnotationDrafts.shared.batch(for: item.id).notes)
            AnnotationDrafts.shared.keep(back, for: item)
            guard self.item?.id == item.id else { return }
            batch = back
            afterNotesChanged()
            say(.notSent(to: route.label, because: failure))
        }
    }

    /// The tray's Copy notes: the message, written as Send writes it, on the clipboard, for a session that has ended.
    func copy() {
        guard !batch.isEmpty, let item else { return }
        copy(batch, item: item, overview: true)
    }

    private func copy(_ batch: AnnotationBatch, item: ReviewItem, overview: Bool) {
        Task { @MainActor in
            guard let message = await write(batch, item: item, overview: overview) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message, forType: .string)
            say(AnnotationTray.Notice("Copied. The pictures are in ~/.cache/conch/annotations.", tone: .done), lasting: AnnotationTray.Notice.sentFor)
        }
    }

    /// The batch's folder written (`AnnotationFolder`) and its message: each note's picture, the deliverable as it
    /// shows now with the notes on it numbered, and the notes as JSON.
    private func write(_ batch: AnnotationBatch, item: ReviewItem, overview drawn: Bool = true) async -> String? {
        let overview = drawn ? await overview(of: batch) : nil
        let summary = item.summary, link = item.link
        let shown = kind == .picture ? "picture" : "page"
        return try? await Task.detached(priority: .userInitiated) {
            let files = try AnnotationFolder.write(batch, overview: overview, about: summary, link: link)
            return AnnotationPrompt.text(for: batch, about: summary, link: link, files: files, shown: shown)
        }.value
    }

    /// What the pane shows now with the notes on it numbered, as a PNG: a page's view, or the picture's own pixels.
    /// None for a document, whose words are the content.
    private func overview(of batch: AnnotationBatch) async -> Data? {
        guard let place else { return nil }
        let here = batch.notes.filter { AnnotationPlace.same($0.on, place) }
        guard !here.isEmpty else { return nil }
        switch kind {
        case .page:
            guard let web else { return nil }
            let image: NSImage? = await withCheckedContinuation { continuation in
                web.takeSnapshot(with: WKSnapshotConfiguration()) { image, _ in continuation.resume(returning: image) }
            }
            guard let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil), web.bounds.width > 0 else { return nil }
            let scale = CGFloat(cg.width) / web.bounds.width
            let notes: [(number: Int, outline: AnnotationPicture.Outline)] = here.compactMap { note in
                guard let rect = placed[note.id], rect.intersects(web.bounds) else { return nil }
                let pixels = rect.applying(CGAffineTransform(scaleX: scale, y: scale))
                if case .quote = note.anchor { return (batch.number(of: note.id), .words(pixels)) }
                return (batch.number(of: note.id), .box(pixels))
            }
            return AnnotationPicture.overview(cg, notes: notes, scale: scale).flatMap(CanvasInk.png)
        case .picture:
            return await Task.detached(priority: .userInitiated) {
                guard let image = AnnotationPicture.load(place) else { return nil }
                let size = CGRect(x: 0, y: 0, width: image.width, height: image.height)
                let notes: [(number: Int, outline: AnnotationPicture.Outline)] = here.compactMap { note in
                    switch note.anchor {
                    case let .region(_, unit): (batch.number(of: note.id), .box(AnnotationGeometry.place(unit, in: size)))
                    case let .spot(_, unit): (batch.number(of: note.id), .spot(AnnotationGeometry.place(unit, in: size)))
                    case .element, .quote: nil
                    }
                }
                return AnnotationPicture.overview(image, notes: notes, scale: max(1, min(size.width, size.height) / 900)).flatMap(CanvasInk.png)
            }.value
        case .document, nil:
            return nil
        }
    }

    private func say(_ notice: AnnotationTray.Notice, lasting: Duration? = nil) {
        quiet?.cancel()
        self.notice = notice
        guard let lasting else { return }
        quiet = Task { @MainActor [weak self] in
            try? await Task.sleep(for: lasting)
            guard !Task.isCancelled, self?.notice == notice else { return }
            self?.notice = nil
        }
    }

    /// The notice's buttons. With nothing of this pane's own said, they are about the notes a session left behind.
    func act(_ action: AnnotationTray.Notice.Action) {
        let orphan = notice == nil ? AnnotationDrafts.shared.orphans.first : nil
        switch action {
        case .copy:
            guard let orphan else { return copy() }
            AnnotationDrafts.shared.letGo(orphan)
            copy(orphan.batch, item: orphan.item, overview: false)
        case .discard:
            if let orphan { AnnotationDrafts.shared.letGo(orphan) }
            notice = nil
        }
    }

    // MARK: For the harness

    /// What the annotator holds, for scripts/annotate-e2e.ts to check (`AnnotateHarness`).
    var described: [String: Any] {
        var state: [String: Any] = [
            "annotating": annotating,
            "kind": kind.map { "\($0)" } ?? NSNull(),
            "place": place ?? NSNull(),
            "notes": batch.notes.map { ["id": $0.id, "n": batch.number(of: $0.id), "frame": $0.anchor.frameText, "words": $0.words, "found": $0.found, "picture": $0.picture != nil, "placed": placed[$0.id] != nil] as [String: Any] },
            "sending": sending,
            "notice": said?.text ?? NSNull(),
            "route": route.map { ["session": $0.session, "label": $0.label, "ended": $0.ended] as [String: Any] } ?? NSNull(),
        ]
        if let draft { state["draft"] = ["id": draft.id, "frame": draft.anchor.frameText, "text": draftText, "new": draftIsNew, "picture": draft.picture != nil] }
        if let pointer, case let .element(_, label) = pointer { state["hover"] = label }
        return state
    }
}

/// The notes on each deliverable, kept while conch runs, by the deliverable's id: the pane that shows it reads them back
/// (`DeliverableAnnotator.show`).
@MainActor
final class AnnotationDrafts: ObservableObject {
    static let shared = AnnotationDrafts()
    private var batches: [ReviewItem.ID: (item: ReviewItem, batch: AnnotationBatch)] = [:]

    /// Notes on a deliverable whose session ended before they were sent: its row, and the deliverable with it, left
    /// conch's list, so there is no pane to send them from. Every pane's tray says so, with Copy and Discard, until one
    /// is pressed (`AnnotationTray.Notice.orphaned`), so the words are never lost without a word.
    struct Orphan: Identifiable {
        let item: ReviewItem
        let batch: AnnotationBatch
        var id: ReviewItem.ID { item.id }
    }

    @Published private(set) var orphans: [Orphan] = []

    func batch(for id: ReviewItem.ID) -> AnnotationBatch { batches[id]?.batch ?? AnnotationBatch() }

    func keep(_ batch: AnnotationBatch, for item: ReviewItem) {
        batches[item.id] = batch.isEmpty ? nil : (item, batch)
    }

    /// The notes on deliverables whose session `listed` no longer has, taken up as orphans. Nil, a list not read yet,
    /// takes nothing: a daemon starting lists no one, and that is not everyone ending.
    func gather(listed: Set<SessionRow.ID>?) {
        guard let listed, !listed.isEmpty else { return }
        let left = batches.values.filter { !listed.contains($0.item.rowID) }.sorted { $0.item.id < $1.item.id }
        guard !left.isEmpty else { return }
        for each in left { batches[each.item.id] = nil }
        orphans += left.map { Orphan(item: $0.item, batch: $0.batch) }
    }

    func letGo(_ orphan: Orphan) {
        orphans.removeAll { $0.id == orphan.id }
    }
}

/// Where a sent batch is kept: `~/.cache/conch/annotations/<id>/`, beside the canvas's, for Tyler alone (0700, its files
/// 0600), cleared after 14 days. `CONCH_ANNOTATIONS_DIR` names another root, for the harness.
enum AnnotationFolder {
    static var root: URL {
        if let named = ProcessInfo.processInfo.environment["CONCH_ANNOTATIONS_DIR"], !named.isEmpty {
            return URL(fileURLWithPath: named, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/conch/annotations", isDirectory: true)
    }

    static let kept = CanvasFolder.kept

    /// Each note's picture as `<n>.png`, the overview, and notes.json; the paths, for the message.
    static func write(_ batch: AnnotationBatch, overview: Data?, about summary: String, link: String?) throws -> AnnotationPrompt.Files {
        let files = FileManager.default
        let root = root
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        prune(files, root: root)
        let folder = root.appendingPathComponent(batch.id, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        func save(_ data: Data, _ name: String) throws -> String {
            let url = folder.appendingPathComponent(name)
            try? files.removeItem(at: url)
            guard files.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
            return url.path
        }
        var result = AnnotationPrompt.Files(json: folder.appendingPathComponent("notes.json").path)
        for note in batch.notes {
            guard let picture = note.picture else { continue }
            result.pictures[note.id] = try save(picture, "\(batch.number(of: note.id)).png")
        }
        if let overview { result.overview = try save(overview, "overview.png") }
        result.json = try save(AnnotationPrompt.json(for: batch, about: summary, link: link, files: result), "notes.json")
        return result
    }

    static func prune(_ files: FileManager, root: URL) {
        let old = Date().addingTimeInterval(-kept)
        for folder in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let changed = try? folder.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, changed < old {
                try? files.removeItem(at: folder)
            }
        }
    }
}

// MARK: - The page's side

/// The pane's web view's half of annotate: the page script (`AnnotationScript`) in conch's own content world, installed
/// in every page the view loads, and what it says handed to the annotator. Held by the web view's coordinator; WebKit
/// holds only a weak hop to it, so a page closing lets it go.
final class AnnotateWebBridge: NSObject, WKScriptMessageHandler {
    weak var annotator: DeliverableAnnotator?
    weak var webView: WKWebView?

    /// Installed into a web view's configuration before the view is made.
    static func install(in configuration: WKWebViewConfiguration) -> AnnotateWebBridge {
        let bridge = AnnotateWebBridge()
        let world = WKContentWorld.world(name: AnnotationScript.world)
        let content = configuration.userContentController
        content.addUserScript(WKUserScript(source: AnnotationScript.source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        content.add(WeakScriptHandler(bridge), contentWorld: world, name: AnnotationScript.handler)
        return bridge
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let read = AnnotationScript.Message.read(message.body) else { return }
        MainActor.assumeIsolated { annotator?.heard(read) }
    }

    /// The script told whether Tyler is annotating and which notes are on this page.
    func push(_ on: Bool, _ notes: [[String]]) {
        webView?.callAsyncJavaScript(
            "return globalThis.conchAnnotate ? conchAnnotate.set(on, notes) : false",
            arguments: ["on": on, "notes": notes], in: nil, in: .world(name: AnnotationScript.world), completionHandler: nil
        )
    }

    /// WebKit keeps its handlers; this keeps the bridge only as long as the web view's coordinator does.
    private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
        weak var bridge: AnnotateWebBridge?
        init(_ bridge: AnnotateWebBridge) { self.bridge = bridge }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            bridge?.userContentController(controller, didReceive: message)
        }
    }
}

/// A document's text view that says when a press over it has ended: a drag's selection is whole only once the mouse is
/// up, which `mouseDown` returns at (NSTextView tracks the drag itself).
final class AnnotatingTextView: NSTextView {
    var onPressEnded: () -> Void = {}

    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        onPressEnded()
    }
}

// MARK: - Drawn over the deliverable

/// Over whatever the pane draws: the edge while annotating, what a click would pin to, each note's pin (its box or its
/// words' wash where it has them), and the note being written in its field beside its pin. Lets every press through but
/// those on a pin or the field.
struct AnnotateLayer: View {
    @ObservedObject var annotator: DeliverableAnnotator
    let kind: DeliverableAnnotator.Kind

    /// Kept clear at the foot, for the tray (`AnnotateTrayHost`): its 32 point bar, its padding, and room.
    static let trayRoom: CGFloat = 64

    var body: some View {
        GeometryReader { proxy in
            if annotator.kind == kind {
                ZStack(alignment: .topLeading) {
                    // The marks, kept to what they are drawn over: a pin scrolled out of sight goes with it.
                    ZStack(alignment: .topLeading) {
                        // A page's edge is its own, under its address line; a picture's or a document's is the pane's
                        // (`AnnotateEdge`), outside the picture's margin and round the corner buttons.
                        if annotator.annotating, kind == .page { AnnotateEdge() }
                        if annotator.annotating, let pointer = annotator.pointer, annotator.draft == nil {
                            switch pointer {
                            case let .element(rect, name): outline(.hover(name), rect)
                            case let .dragging(rect): outline(.dragging, rect)
                            }
                        }
                        ForEach(annotator.batch.notes) { note in
                            if let rect = annotator.placed[note.id], note.id != annotator.draft?.id {
                                marks(for: note, at: rect, in: proxy.size, lifted: false)
                            }
                        }
                        if let draft = annotator.draft, let rect = annotator.placed[draft.id] {
                            marks(for: draft, at: rect, in: proxy.size, lifted: true)
                        }
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                    .clipped()
                    // The field is not: in a narrow column it may reach past it, over the folder's tree, rather than be
                    // cut off.
                    if let draft = annotator.draft, let rect = annotator.placed[draft.id] {
                        editor(for: draft, at: rect, in: proxy.size)
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            }
        }
    }

    private func outline(_ kind: AnnotationOutline.Kind, _ rect: CGRect) -> some View {
        AnnotationOutline(kind)
            .frame(width: max(rect.width, 1), height: max(rect.height, 1))
            .offset(x: rect.minX, y: rect.minY)
            .allowsHitTesting(false)
    }

    /// A note's outline, where it has one, and its pin. An element shows its box only while its note is open: on a
    /// busy page a box round every note would hide what they are about.
    @ViewBuilder
    private func marks(for note: AnnotationNote, at rect: CGRect, in size: CGSize, lifted: Bool) -> some View {
        switch note.anchor {
        case .region: outline(.box, rect.insetBy(dx: -2, dy: -2))
        case .quote: outline(.words, rect.insetBy(dx: -3, dy: -2))
        case .element: if lifted { outline(.box, rect.insetBy(dx: -4, dy: -4)) }
        case .spot: EmptyView()
        }
        let spot = spot(of: note, at: rect, in: size)
        Button { annotator.edit(note.id) } label: {
            AnnotationPin(number: annotator.batch.number(of: note.id), lifted: lifted)
        }
        .buttonStyle(.plain)
        .help(note.words.isEmpty ? "The note you're writing" : note.words)
        .position(x: spot.x + CanvasInk.pinSide / 2, y: spot.y - CanvasInk.pinSide / 2)
    }

    private func spot(of note: AnnotationNote, at rect: CGRect, in size: CGSize) -> CGPoint {
        if case .spot = note.anchor { return CGPoint(x: rect.minX, y: rect.minY) }
        return AnnotationGeometry.pinSpot(on: rect, in: size)
    }

    /// Beside its pin, never over what it is about where there is room elsewhere, and clear of the tray.
    private func editor(for draft: AnnotationNote, at rect: CGRect, in size: CGSize) -> some View {
        let width = AnnotationEditor.width(in: size.width)
        let room = CGSize(width: size.width, height: max(size.height - Self.trayRoom, 140))
        let origin = AnnotationGeometry.editorOrigin(pin: spot(of: draft, at: rect, in: size), target: rect.insetBy(dx: -4, dy: -4),
                                                     size: CGSize(width: width, height: 112), in: room)
        return AnnotationEditor(
            number: annotator.batch.number(of: draft.id),
            name: draft.anchor.name,
            text: $annotator.draftText,
            isNew: annotator.draftIsNew,
            width: width,
            onSave: annotator.saveDraft,
            onCancel: annotator.cancelDraft,
            onDelete: annotator.deleteDraft
        )
        // In a column narrower than the field, it reaches left, over what is beside it, and never past the right edge.
        .offset(x: width > size.width - 20 ? size.width - 10 - width : origin.x, y: origin.y)
        .transition(.opacity)
    }
}

/// The edge round what is being annotated, in Tyler's ink: the one sign, besides the tray, that a click pins a note.
struct AnnotateEdge: View {
    var body: some View {
        Rectangle()
            .strokeBorder(CanvasInk.you.color.opacity(0.85), lineWidth: 2)
            .allowsHitTesting(false)
    }
}

/// The tray along the foot of the pane, while annotating or while notes wait (`AnnotationTray`).
struct AnnotateTrayHost: View {
    @ObservedObject var annotator: DeliverableAnnotator
    @ObservedObject private var drafts = AnnotationDrafts.shared

    var body: some View {
        if annotator.annotating || !annotator.batch.isEmpty || annotator.said != nil {
            AnnotationTray(
                rows: annotator.batch.notes.map { AnnotationTray.Row($0, number: annotator.batch.number(of: $0.id)) },
                annotating: annotator.annotating,
                hint: annotator.hint,
                route: annotator.route,
                sending: annotator.sending,
                notice: annotator.said,
                listOpen: $annotator.listOpen,
                onSend: annotator.send,
                onClear: annotator.clear,
                onDone: { annotator.setAnnotating(false) },
                onEdit: annotator.edit,
                onRemove: annotator.remove,
                onNotice: annotator.act
            )
            .padding(.bottom, 12)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }
}

private struct DeliverableAnnotatorKey: EnvironmentKey {
    static let defaultValue: DeliverableAnnotator? = nil
}

extension EnvironmentValues {
    /// The annotator of the pane this deliverable is shown in; nil where nothing is annotated (the Files tab, a
    /// comparison's two sides).
    var deliverableAnnotator: DeliverableAnnotator? {
        get { self[DeliverableAnnotatorKey.self] }
        set { self[DeliverableAnnotatorKey.self] = newValue }
    }
}
