import CoreGraphics
import CoreText
import Foundation
import ImageIO

// Annotate: Tyler's notes on a deliverable, pinned to what he pointed at in conch's own pane, and sent to the session that
// published it as one message. Tyler: "let's add annotate on the deliverables plane like u can do in codex". The design
// note is docs/annotate.md. This is its data, the message it sends, its pictures and the script that finds what he points
// at in a page, pure, so the Mac's pane and the tests run the very same thing.
//
// The anchors are agent ink's (`AgentInk`, `scene.marks`): an element by `{selector}`, words by `{quote}`, part of a
// picture by `{image}` and a rect or a spot in its fractions. So what Tyler points at arrives in terms an agent can act
// on, and can answer in: a mark it publishes on the same selector is drawn where his note was.

// MARK: - A note

/// What a note is pinned to.
public enum AnnotationAnchor: Equatable, Sendable {
    /// An element of a page.
    case element(AnnotationElement)
    /// Words in a page or a document: `quote` is one line of them, as agent ink's finder looks for a quote (the page's
    /// own text, as it is, the first place it shows), at most `AnnotationAnchor.frameMax` characters; `selected` is all
    /// that was selected, spaces collapsed, when it was more than the quote.
    case quote(String, selected: String?)
    /// Part of a picture: `rect` in fractions of it, from the top left.
    case region(image: String, rect: CGRect)
    /// A spot on a picture, in fractions of it.
    case spot(image: String, at: CGPoint)

    /// How long a selector or a quote may be and still be a mark's frame (`REVIEW_MARK_FRAME_MAX`).
    public static let frameMax = 120

    /// The frame an agent's mark takes to point at the same thing, as its key and value: `selector`, `quote`, `image`.
    public var frame: (key: String, value: String) {
        switch self {
        case let .element(element): ("selector", element.selector)
        case let .quote(quote, _): ("quote", quote)
        case let .region(image, _), let .spot(image, _): ("image", image)
        }
    }

    /// The frame written as the message writes it: `{selector: "section.hero > a.cta"}`, the value JSON-quoted.
    public var frameText: String {
        "{\(frame.key): \(AnnotationPrompt.quoted(frame.value))}"
    }

    /// What the pane calls it, short: the element's tag and classes, the words, or "a box on the picture".
    public var name: String {
        switch self {
        case let .element(element): element.name
        case let .quote(quote, _): "“\(AnnotationPrompt.clipped(quote, to: 48))”"
        case .region: "A box on the picture"
        case .spot: "A spot on the picture"
        }
    }

    /// Words and a picture are what a page's pin is on; a document's words have no picture.
    public var isOnPicture: Bool {
        switch self {
        case .region, .spot: true
        case .element, .quote: false
        }
    }
}

/// An element Tyler clicked: the selector conch made for it, and what it is, for the agent to find it in its source.
public struct AnnotationElement: Equatable, Sendable {
    /// The shortest selector that names it alone in the page (`AnnotationScript`).
    public let selector: String
    /// Its tag, lower case.
    public let tag: String
    /// The start of its words, spaces collapsed; nil when it has none.
    public let text: String?
    /// The attributes that say what it is (id, class, href, src, alt, aria-label, role, type, name, placeholder, title,
    /// data-testid), as the page has them, each cut to 80 characters, in that order.
    public let attributes: [(name: String, value: String)]

    public init(selector: String, tag: String, text: String?, attributes: [(name: String, value: String)] = []) {
        self.selector = selector
        self.tag = tag
        let words = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.text = words.isEmpty ? nil : words
        self.attributes = attributes
    }

    public static func == (a: AnnotationElement, b: AnnotationElement) -> Bool {
        a.selector == b.selector && a.tag == b.tag && a.text == b.text
            && a.attributes.map(\.name) == b.attributes.map(\.name) && a.attributes.map(\.value) == b.attributes.map(\.value)
    }

    /// As the hover chip and the tray name it: the selector's own last step, cut short.
    public var name: String {
        let last = selector.components(separatedBy: " > ").last ?? selector
        return AnnotationPrompt.clipped(last, to: 40)
    }

    /// As the message describes it: `the <a> "Start free trial"`.
    public var described: String {
        var words = "the <\(tag)>"
        if let text { words += " \(AnnotationPrompt.quoted(AnnotationPrompt.clipped(text, to: 60)))" }
        return words
    }
}

/// One note: what it is pinned to, what Tyler said, and the picture conch took of it when it was pinned.
public struct AnnotationNote: Equatable, Identifiable, Sendable {
    public let id: String
    public let anchor: AnnotationAnchor
    public var text: String
    /// What it is on: the page's address, or the file's path. A folder's notes are each on the file that was picked.
    public let on: String
    /// Whether its anchor was there the last time conch looked for it on its page or in its file. False once a reload,
    /// or the agent's next change, took its element or its words away: it is still sent, with the picture taken when it
    /// was pinned, and the message says it wasn't there.
    public var found: Bool
    /// Its picture, as a PNG, taken from conch's own view of the deliverable when it was pinned; nil where there is none
    /// (a document's words).
    public var picture: Data?

    public init(id: String = UUID().uuidString, anchor: AnnotationAnchor, text: String = "", on: String, found: Bool = true, picture: Data? = nil) {
        self.id = id
        self.anchor = anchor
        self.text = text
        self.on = on
        self.found = found
        self.picture = picture
    }

    /// What Tyler said, one line: a note's line breaks are spaces in the message.
    public var words: String {
        text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    public var hasWords: Bool { !words.isEmpty }
}

/// The notes on one deliverable, in the order they were pinned, which is their numbering. Only notes with words are kept:
/// one being written is the pane's until it is saved (`DeliverableAnnotator.draft`).
public struct AnnotationBatch: Equatable, Sendable {
    /// Names the folder its pictures are written to when it is sent.
    public let id: String
    public private(set) var notes: [AnnotationNote] = []

    public init(id: String = UUID().uuidString, notes: [AnnotationNote] = []) {
        self.id = id
        self.notes = notes.filter(\.hasWords)
    }

    public var isEmpty: Bool { notes.isEmpty }
    public var count: Int { notes.count }

    /// Kept, or put back in its place when it is already here; a note with no words is let go instead.
    public mutating func save(_ note: AnnotationNote) {
        guard note.hasWords else { return remove(note.id) }
        if let index = notes.firstIndex(where: { $0.id == note.id }) {
            notes[index] = note
        } else {
            notes.append(note)
        }
    }

    public mutating func remove(_ id: AnnotationNote.ID) {
        notes.removeAll { $0.id == id }
    }

    public func note(_ id: AnnotationNote.ID) -> AnnotationNote? {
        notes.first { $0.id == id }
    }

    /// Its number on its pin, 1 up; a note not yet kept is the next one.
    public func number(of id: AnnotationNote.ID) -> Int {
        (notes.firstIndex { $0.id == id } ?? notes.count) + 1
    }

    /// Conch looked for the notes on `on` (a page's address, a file's path) and found `found` there: each of them is
    /// found or not as it was this time. Notes on anything else are as they were.
    public mutating func looked(on place: String, found: Set<AnnotationNote.ID>) {
        for index in notes.indices where AnnotationPlace.same(notes[index].on, place) {
            notes[index].found = found.contains(notes[index].id)
        }
    }

    /// A page's script looked: the ones it found are found, the ones it looked for and didn't find aren't. A note it
    /// wasn't asked about yet (saved a moment ago) is as it was.
    public mutating func mark(found: Set<AnnotationNote.ID>, missing: Set<AnnotationNote.ID>) {
        for index in notes.indices {
            if found.contains(notes[index].id) { notes[index].found = true } else if missing.contains(notes[index].id) { notes[index].found = false }
        }
    }

    /// Its picture, once it is taken: a note's picture comes a moment after it is pinned.
    public mutating func setPicture(_ picture: Data?, of id: AnnotationNote.ID) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        notes[index].picture = picture
    }

    /// The ones that weren't where conch last looked, for the tray to say.
    public var missing: [AnnotationNote] { notes.filter { !$0.found } }
}

/// Whether two places a note can be on are the same: the same file, or the same address but for its fragment and a
/// trailing slash (`AgentInkController.showsReview`'s rule).
public enum AnnotationPlace {
    public static func same(_ a: String, _ b: String) -> Bool {
        key(a) == key(b)
    }

    static func key(_ place: String) -> String {
        if let url = URL(string: place), url.isFileURL { return url.standardizedFileURL.path }
        if place.hasPrefix("/") || place.hasPrefix("~") { return URL(fileURLWithPath: (place as NSString).expandingTildeInPath).standardizedFileURL.path }
        let bare = String(place.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        return bare.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}

// MARK: - A document's words

/// Words selected in a document (a Markdown or text deliverable, as the pane draws it), as a note's quote: the page's rule
/// (`AnnotationScript`'s `quoteOf`) in Swift. One line of the selection, its longest, cut at a space to a frame's length;
/// grown a word at a time from the words round it, within their line, while the same words come earlier in the document,
/// so the first place they show is the place they were selected.
public enum AnnotationQuote {
    /// The quote and, when it is less than all that was selected, the selection with its spaces collapsed; nil for a
    /// selection of nothing but space.
    public static func make(in text: String, selected range: NSRange) -> (quote: String, selected: String?)? {
        let whole = text as NSString
        guard range.location != NSNotFound, NSMaxRange(range) <= whole.length, range.length > 0 else { return nil }
        let picked = whole.substring(with: range)
        let collapsed = picked.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        let lines = picked.components(separatedBy: .controlCharacters).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var quote = lines.max { $0.count < $1.count } ?? collapsed
        if quote.count > AnnotationAnchor.frameMax {
            quote = String(quote.prefix(AnnotationAnchor.frameMax))
            if let space = quote.lastIndex(of: " "), quote.distance(from: quote.startIndex, to: space) > AnnotationAnchor.frameMax / 2 {
                quote = String(quote[..<space])
            }
        }
        // Where the quote is in the selection, and so in the document.
        let inside = (picked as NSString).range(of: quote)
        let there = NSRange(location: range.location + (inside.location == NSNotFound ? 0 : inside.location), length: (quote as NSString).length)
        if whole.range(of: quote).location != there.location {
            let line = whole.lineRange(for: NSRange(location: there.location, length: 0))
            var a = there.location, b = NSMaxRange(there)
            let space = CharacterSet.whitespaces
            func isSpace(_ index: Int) -> Bool { space.contains(UnicodeScalar(whole.character(at: index)) ?? " ") }
            for step in 0..<24 {
                let left = step % 2 == 0 ? a > line.location : b >= NSMaxRange(line)
                if left {
                    guard a > line.location else { break }
                    a -= 1
                    while a > line.location, !isSpace(a - 1) { a -= 1 }
                } else {
                    guard b < NSMaxRange(line) else { break }
                    b += 1
                    while b < NSMaxRange(line), !isSpace(b) { b += 1 }
                }
                let piece = whole.substring(with: NSRange(location: a, length: b - a))
                guard piece.rangeOfCharacter(from: .newlines) == nil else { break }
                let grown = piece.trimmingCharacters(in: .whitespaces)
                guard grown.count <= AnnotationAnchor.frameMax else { break }
                let start = a + ((piece as NSString).range(of: grown).location)
                if whole.range(of: grown).location == start {
                    quote = grown
                    break
                }
            }
        }
        return (quote, collapsed == quote ? nil : AnnotationPrompt.clipped(collapsed, to: 500))
    }

    /// Where a quote is in a document: the first place it is.
    public static func find(_ quote: String, in text: String) -> NSRange? {
        let found = (text as NSString).range(of: quote)
        return found.location == NSNotFound ? nil : found
    }
}

// MARK: - Where it goes

/// Where Send goes: always the session that published the deliverable, never a guess. Nil, and Send is off, with that
/// session gone from conch's list; the notes stay, and the tray says so and offers to copy them.
public struct AnnotationRoute: Equatable, Sendable {
    public let session: String
    public let label: String
    /// Nothing can be sent there: the session is gone from conch's list, or listed with no way in (`unavailable`). A
    /// session that is busy is still sent to, as any message is.
    public let ended: Bool
    /// Why a listed session can't take a message, in the daemon's words (the composer's own reason); nil when it can,
    /// or when it is gone.
    public let unavailable: String?

    public init(session: String, label: String, ended: Bool = false, unavailable: String? = nil) {
        self.session = session
        self.label = label
        self.ended = ended || unavailable != nil
        self.unavailable = unavailable
    }

    /// The session with this id among `sessions` (id, label, and why it can't take a message, if it can't), or an ended
    /// route with the label it had.
    public static func resolve(owner: String, label: String, sessions: [(id: String, label: String, unavailable: String?)]) -> AnnotationRoute {
        guard let row = sessions.first(where: { $0.id == owner }) else { return AnnotationRoute(session: owner, label: label, ended: true) }
        return AnnotationRoute(session: row.id, label: row.label, unavailable: row.unavailable)
    }
}

// MARK: - The message

/// What a batch says when it is sent: one message through the composer's own path (the canvas's `CanvasPrompt` shape).
/// The overview's path comes first, on its own line: both agents read an image whose path is in the message, and a
/// leading path isn't skimmed past. Then what was annotated, each note by its number with its frame in agent ink's
/// words, what Tyler said, and its picture; then where the rest is and how to answer on it.
public enum AnnotationPrompt {
    /// Where a sent batch's files were written.
    public struct Files: Equatable, Sendable {
        /// The deliverable as it showed, the notes on it numbered; nil where there is no picture (a document).
        public var overview: String?
        /// Each note's picture, by its id.
        public var pictures: [String: String]
        /// The notes as JSON.
        public var json: String

        public init(overview: String? = nil, pictures: [String: String] = [:], json: String) {
            self.overview = overview
            self.pictures = pictures
            self.json = json
        }
    }

    /// The message. `summary` and `link` are the deliverable's, as its agent filed it; `shown` what the overview shows
    /// ("page" or "picture").
    public static func text(for batch: AnnotationBatch, about summary: String, link: String?, files: Files, shown: String = "page") -> String {
        var lines: [String] = []
        if let overview = files.overview { lines.append(overview) }
        let count = batch.count == 1 ? "1 note" : "\(batch.count) notes"
        let source = link.map { " (\($0))" } ?? ""
        lines.append("[annotate] Tyler left \(count) on your deliverable \(quoted(clipped(summary, to: 80)))\(source).")
        for note in batch.notes {
            lines.append(line(for: note, number: batch.number(of: note.id), deliverable: link))
            if let picture = files.pictures[note.id] { lines.append("   Picture: \(picture)") }
        }
        if let overview = files.overview {
            lines.append("The \(shown) with the notes numbered: \(overview). Everything above as JSON: \(files.json)")
        } else {
            lines.append("Everything above as JSON: \(files.json)")
        }
        lines.append(answer)
        return lines.joined(separator: "\n")
    }

    /// How an agent answers on the same things.
    public static let answer = "To point back at any of these, publish marks with the same frame (review_to_front scene.marks)."

    /// One note: `1. {selector: "a.cta"}, the <a> "Start free trial": "make this bigger"`, where it is when that isn't the
    /// deliverable itself (a file in a folder, another page), and when it wasn't found.
    public static func line(for note: AnnotationNote, number: Int, deliverable: String?) -> String {
        var where_ = note.anchor.frameText
        switch note.anchor {
        case let .element(element):
            where_ += ", \(element.described)"
        case let .quote(_, selected):
            if let selected { where_ += " (selected: \(quoted(clipped(selected, to: 200))))" }
        case let .region(_, rect):
            where_ += " rect [\(fraction(rect.minX)), \(fraction(rect.minY)), \(fraction(rect.width)), \(fraction(rect.height))]"
        case let .spot(_, at):
            where_ += " at [\(fraction(at.x)), \(fraction(at.y))]"
        }
        if deliverable.map({ !AnnotationPlace.same($0, note.on) }) ?? true, !note.anchor.isOnPicture {
            where_ += note.on.hasPrefix("/") ? " in \(note.on)" : " on \(note.on)"
        }
        var line = "\(number). \(where_): \(quoted(note.words))"
        if !note.found {
            line += note.on.hasPrefix("/") && !note.anchor.isOnPicture
                ? " (not in the file when sent: it changed after this was pinned)"
                : " (not on the page when sent: it changed after this was pinned)"
        }
        return line
    }

    /// A fraction as the message writes it: three places, as agent ink's numbers are asked for.
    static func fraction(_ value: CGFloat) -> String {
        String(format: "%.3f", Double(min(max(value, 0), 1)))
    }

    /// JSON's own quoting, so a quote or a selector with quotes in it reads back exactly.
    public static func quoted(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes]),
              let array = String(data: data, encoding: .utf8) else { return "\"\(text)\"" }
        return String(array.dropFirst().dropLast())
    }

    /// Cut to `limit` characters, at a space where there is one near, with an ellipsis.
    public static func clipped(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        var cut = String(text.prefix(limit - 1))
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > limit / 2 { cut = String(cut[..<space]) }
        return cut.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The batch as JSON, for notes.json: each note's number, frame, geometry, words and picture, in agent ink's terms.
    public static func json(for batch: AnnotationBatch, about summary: String, link: String?, files: Files) -> Data {
        let notes: [[String: Any]] = batch.notes.map { note in
            var entry: [String: Any] = [
                "n": batch.number(of: note.id),
                "frame": [note.anchor.frame.key: note.anchor.frame.value],
                "note": note.words,
                "on": note.on,
                "found": note.found,
            ]
            switch note.anchor {
            case let .element(element):
                var described: [String: Any] = ["tag": element.tag]
                if let text = element.text { described["text"] = text }
                if !element.attributes.isEmpty {
                    described["attributes"] = Dictionary(element.attributes.map { ($0.name, $0.value) }, uniquingKeysWith: { first, _ in first })
                }
                entry["element"] = described
            case let .quote(_, selected):
                if let selected { entry["selected"] = selected }
            case let .region(_, rect):
                entry["rect"] = [rect.minX, rect.minY, rect.width, rect.height].map { Double(fraction($0))! }
            case let .spot(_, at):
                entry["at"] = [at.x, at.y].map { Double(fraction($0))! }
            }
            if let picture = files.pictures[note.id] { entry["picture"] = picture }
            return entry
        }
        var root: [String: Any] = ["v": 1, "deliverable": ["summary": summary], "notes": notes]
        if let link { root["deliverable"] = ["summary": summary, "link": link] }
        if let overview = files.overview { root["overview"] = overview }
        return (try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data()
    }
}

// MARK: - Where things go on screen

/// The pane's geometry, in the view's own points from its top left.
public enum AnnotationGeometry {
    /// A drag that moved less than this, in points, is a click: a spot rather than a box.
    public static let dragThreshold: CGFloat = 6
    /// Round what a note's picture shows, in points of the view it was taken from.
    public static let pictureMargin: CGFloat = 24
    /// A spot's picture: this much of the picture's shorter side, round the spot.
    public static let spotShare: CGFloat = 0.24

    /// Where a pin's spot goes on what it marks: on its top right corner, the badge rising from it, kept inside `bounds`
    /// (agent ink's pin, `AgentInk.mark(on:)`). A spot's pin is on the spot itself.
    public static func pinSpot(on rect: CGRect, in bounds: CGSize, side: CGFloat = CanvasInk.pinSide) -> CGPoint {
        let x = min(max(rect.maxX, 0), max(bounds.width - side, 0))
        let y = min(max(rect.minY, side), max(bounds.height, side))
        return CGPoint(x: x, y: y)
    }

    /// What a picture of `rect` takes: it and `margin` round it, within `bounds`, on whole points.
    public static func pictureRect(around rect: CGRect, margin: CGFloat = pictureMargin, in bounds: CGRect) -> CGRect {
        rect.insetBy(dx: -margin, dy: -margin).intersection(bounds).integral
    }

    /// A rect in a view as fractions of `frame`, the picture's rect in the same view, kept to the picture.
    public static func unit(_ rect: CGRect, of frame: CGRect) -> CGRect {
        guard frame.width > 0, frame.height > 0 else { return .null }
        let kept = rect.standardized.intersection(frame)
        guard !kept.isNull else { return .null }
        return CGRect(x: (kept.minX - frame.minX) / frame.width, y: (kept.minY - frame.minY) / frame.height,
                      width: kept.width / frame.width, height: kept.height / frame.height)
    }

    /// A point in a view as fractions of `frame`; nil off the picture.
    public static func unit(_ point: CGPoint, of frame: CGRect) -> CGPoint? {
        guard frame.width > 0, frame.height > 0, frame.contains(point) else { return nil }
        return CGPoint(x: (point.x - frame.minX) / frame.width, y: (point.y - frame.minY) / frame.height)
    }

    /// Fractions of the picture back in the view, where `frame` is the picture now.
    public static func place(_ unit: CGRect, in frame: CGRect) -> CGRect {
        CGRect(x: frame.minX + unit.minX * frame.width, y: frame.minY + unit.minY * frame.height, width: unit.width * frame.width, height: unit.height * frame.height)
    }

    public static func place(_ unit: CGPoint, in frame: CGRect) -> CGPoint {
        CGPoint(x: frame.minX + unit.x * frame.width, y: frame.minY + unit.y * frame.height)
    }

    /// Where the note's editor goes, its top left, never over what the note is about (`target`) when there is room
    /// elsewhere: right of the badge, level with it; else under the target, from its left edge; else over it (and over
    /// the badge); else as low as fits. Inside `bounds` with `inset` to spare.
    public static func editorOrigin(pin: CGPoint, target: CGRect, size: CGSize, in bounds: CGSize, side: CGFloat = CanvasInk.pinSide, inset: CGFloat = 10) -> CGPoint {
        let gap: CGFloat = 8
        func x(_ wanted: CGFloat) -> CGFloat { min(max(wanted, inset), max(bounds.width - inset - size.width, inset)) }
        func y(_ wanted: CGFloat) -> CGFloat { min(max(wanted, inset), max(bounds.height - inset - size.height, inset)) }
        let right = pin.x + side + gap
        if right + size.width <= bounds.width - inset { return CGPoint(x: right, y: y(pin.y - side)) }
        let below = target.maxY + gap
        if below + size.height <= bounds.height - inset { return CGPoint(x: x(target.minX), y: below) }
        let above = min(target.minY, pin.y - side) - gap - size.height
        if above >= inset { return CGPoint(x: x(target.minX), y: above) }
        return CGPoint(x: x(pin.x - gap - size.width), y: y(pin.y - side))
    }
}

// MARK: - The pictures

/// A note's picture and the overview, drawn by the canvas's own path builder in Tyler's ink, so a note looks the same in
/// the picture an agent reads as on his canvas. Pixels, top left, y down.
public enum AnnotationPicture {
    /// The overview's long edge, at most: the phone uploads' and the canvas's rule.
    public static let longEdge: CGFloat = 1568

    /// How a note is drawn: round an element or a region, a box; over words, the highlighter's wash; a spot, its pin alone.
    public enum Outline: Equatable, Sendable {
        case box(CGRect)
        case words(CGRect)
        case spot(CGPoint)
    }

    /// `rect` of `image` (both in its pixels), with `outline` (in the same pixels) drawn over it: a note's picture. `scale`
    /// is the image's pixels per point, so the ink is as thick as on screen.
    public static func crop(_ image: CGImage, to rect: CGRect, outline: Outline?, scale: CGFloat) -> CGImage? {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let kept = rect.integral.intersection(bounds)
        guard !kept.isNull, kept.width >= 1, kept.height >= 1, let piece = image.cropping(to: kept) else { return nil }
        let shifted: Outline? = outline.map { outline in
            switch outline {
            case let .box(box): .box(box.offsetBy(dx: -kept.minX, dy: -kept.minY))
            case let .words(words): .words(words.offsetBy(dx: -kept.minX, dy: -kept.minY))
            case let .spot(spot): .spot(CGPoint(x: spot.x - kept.minX, y: spot.y - kept.minY))
            }
        }
        return draw(piece, size: kept.size, notes: shifted.map { [(nil, $0)] } ?? [], scale: scale)
    }

    /// `image` with each note on it outlined and numbered on its pin, no longer than `longEdge`. The notes' outlines are
    /// in the image's own pixels.
    public static func overview(_ image: CGImage, notes: [(number: Int, outline: Outline)], scale: CGFloat) -> CGImage? {
        let source = CGSize(width: image.width, height: image.height)
        let fit = min(1, longEdge / max(source.width, source.height, 1))
        let size = CGSize(width: (source.width * fit).rounded(), height: (source.height * fit).rounded())
        let scaled: [(Int?, Outline)] = notes.map { note in
            switch note.outline {
            case let .box(box): (note.number, .box(box.applying(CGAffineTransform(scaleX: fit, y: fit))))
            case let .words(words): (note.number, .words(words.applying(CGAffineTransform(scaleX: fit, y: fit))))
            case let .spot(spot): (note.number, .spot(CGPoint(x: spot.x * fit, y: spot.y * fit)))
            }
        }
        return draw(image, size: size, notes: scaled, scale: scale * fit)
    }

    /// `image` drawn to fill `size`, then each note's outline over it and, numbered, its pin.
    static func draw(_ image: CGImage, size: CGSize, notes: [(number: Int?, outline: Outline)], scale: CGFloat) -> CGImage? {
        guard size.width >= 1, size.height >= 1,
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(origin: .zero, size: size))
        // The outlines are kept y down; a bitmap context is y up.
        context.translateBy(x: 0, y: size.height)
        context.scaleBy(x: 1, y: -1)
        let ink = max(scale, 0.5)
        for note in notes {
            let mark: CanvasMark
            let spot: CGPoint
            switch note.outline {
            case let .box(box):
                let padded = box.insetBy(dx: -4 * ink, dy: -4 * ink)
                mark = CanvasMark(kind: .box, points: corners(padded, in: size))
                spot = AnnotationGeometry.pinSpot(on: padded, in: size, side: CanvasInk.pinSide * ink)
            case let .words(words):
                let over = words.insetBy(dx: -3 * ink, dy: -2 * ink)
                mark = CanvasMark(kind: .area, points: corners(over, in: size))
                spot = AnnotationGeometry.pinSpot(on: over, in: size, side: CanvasInk.pinSide * ink)
            case let .spot(at):
                mark = CanvasMark(kind: .note, points: [CanvasPoint(x: Double(at.x / size.width), y: Double(at.y / size.height))])
                spot = at
            }
            if mark.kind != .note { fill(mark, in: context, size: size, scale: ink) }
            guard note.number != nil || mark.kind == .note else { continue }
            let pin = CanvasMark(kind: .note, points: [CanvasPoint(x: Double(spot.x / size.width), y: Double(spot.y / size.height))])
            fill(pin, in: context, size: size, scale: ink)
            if let number = note.number {
                let side = CanvasInk.pinSide * ink
                CanvasInk.label("\(number)", centredIn: CGRect(x: spot.x, y: spot.y - side, width: side, height: side), size: 12 * ink, colour: CanvasInk.onYou, in: context)
            }
        }
        return context.makeImage()
    }

    /// One mark filled as the canvas fills it: a box's wash under its outline, a highlight laid over what is under it.
    private static func fill(_ mark: CanvasMark, in context: CGContext, size: CGSize, scale: CGFloat) {
        let shape = CanvasInk.shape(of: mark, in: size, scale: scale)
        let colour = CanvasInk.fill(of: mark)
        context.saveGState()
        if let wash = shape.wash {
            context.addPath(wash)
            context.setFillColor(colour.cgColor.copy(alpha: CanvasInk.washOpacity) ?? colour.cgColor)
            context.fillPath()
        }
        if CanvasInk.multiplies(mark) { context.setBlendMode(.multiply) }
        context.addPath(shape.ink)
        context.setFillColor(colour.cgColor)
        context.fillPath()
        context.restoreGState()
    }

    private static func corners(_ rect: CGRect, in size: CGSize) -> [CanvasPoint] {
        [CanvasPoint(x: Double(rect.minX / size.width), y: Double(rect.minY / size.height)),
         CanvasPoint(x: Double(rect.maxX / size.width), y: Double(rect.maxY / size.height))]
    }

    /// The picture file's own pixels, whole: what a region's picture is cut from, rather than the decode the pane draws.
    public static func load(_ path: String) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    /// A region's or a spot's picture, from the picture file's own pixels.
    public static func crop(image: CGImage, anchor: AnnotationAnchor) -> CGImage? {
        let size = CGSize(width: image.width, height: image.height)
        // Points of the picture as the pane draws it are not these pixels: the ink is drawn as it would be on a 2x screen
        // showing the picture at its own size, so a big picture's outline isn't a hairline.
        let scale = max(1, min(size.width, size.height) / 900)
        switch anchor {
        case let .region(_, unit):
            let box = AnnotationGeometry.place(unit, in: CGRect(origin: .zero, size: size))
            let margin = max(AnnotationGeometry.pictureMargin * scale, min(box.width, box.height) * 0.15)
            return crop(image, to: box.insetBy(dx: -margin, dy: -margin), outline: .box(box), scale: scale)
        case let .spot(_, unit):
            let at = AnnotationGeometry.place(unit, in: CGRect(origin: .zero, size: size))
            let half = max(min(size.width, size.height) * AnnotationGeometry.spotShare / 2, 48 * scale)
            return crop(image, to: CGRect(x: at.x - half, y: at.y - half, width: 2 * half, height: 2 * half), outline: .spot(at), scale: scale)
        case .element, .quote:
            return nil
        }
    }
}

// MARK: - The page's side

/// What finds what Tyler points at in a page, and where his notes are on it as it scrolls, run in conch's own content
/// world in the pane's web view (`AnnotationScript.world`), so the page never sees its names. It reads the page and
/// changes nothing on it: no element, attribute or style is touched. While annotating it holds back the page's own clicks
/// (a click names an element, it doesn't follow a link) and clears the selection it turns into a quote; otherwise it only
/// listens.
///
/// What it tells the pane, through the `conchAnnotate` message handler:
/// - `ready`, as a page loads, for the pane to hand it the notes on that page.
/// - `element`: the element clicked, with the selector made for it and what it is.
/// - `words`: the words selected, as a quote and a rect.
/// - `placed`: where each note is now, and what is under the pointer while annotating; on every scroll, resize and
///   change to the page, at most once a frame (a change to the page, at most every 150 ms).
///
/// A note's words are found the way agent ink's finder finds a quote (`AgentInk.finder`): the page's text as it is, the
/// first place they show. So a quote Tyler made is one an agent can mark, and conch finds both in the same place.
public enum AnnotationScript {
    /// conch's content world for it, apart from the page's and from agent ink's.
    public static let world = "conch-annotate"
    /// The message handler it talks to.
    public static let handler = "conchAnnotate"

    /// Installed at document end in every main-frame page of the pane, and evaluated once into a page already loaded.
    /// Only the first copy in a page takes.
    public static let source = """
        (() => {
        if (globalThis.conchAnnotate) return;
        const post = (body) => { try { window.webkit.messageHandlers.\(handler).postMessage(body); } catch (_) {} };
        const box = (r) => [r.left, r.top, r.width, r.height];
        const viewport = () => { const vv = window.visualViewport; return { left: vv ? vv.offsetLeft : 0, top: vv ? vv.offsetTop : 0, scale: vv ? vv.scale : 1, width: window.innerWidth }; };
        const hidden = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
        const control = /[\\u0000-\\u001f\\u007f-\\u009f]+/;
        // A class or an id a tool made rather than a person (css-1x2y3z, sc-AxjAm, Button_root__3xk9P, a hash): never in a
        // selector. A person's (btn-primary, w-64, card--featured) stays.
        const machine = (name) => /^(css|sc|jsx|emotion|svelte|astro|chakra|mui|tw)[-_]/i.test(name) || name.startsWith("_") || /[0-9]{4,}/.test(name)
            || name.split(/[-_]+/).some((part) => part.length >= 5 && /[0-9]/.test(part) && /[a-z]/i.test(part));
        let on = false, notes = [], hovered = null, frame = 0, late = 0, settle = 0, listening = false, found = new Map();

        // MARK: finding a note again
        function texts() {
            const root = document.body || document.documentElement;
            if (!root) return null;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => hidden.test(node.parentNode ? node.parentNode.nodeName : "") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
            });
            const nodes = [];
            let text = "";
            for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push([node, text.length]); text += node.data; }
            return { nodes, text };
        }
        // The first place `quote` shows, as a Range: agent ink's finder's rule (AgentInk.finder).
        function words(quote, all) {
            all = all || texts();
            if (!all || !all.nodes.length) return null;
            const { nodes, text } = all;
            const at = (offset, end) => { let i = nodes.length - 1; while (i > 0 && (end ? nodes[i][1] >= offset : nodes[i][1] > offset)) i--; return [nodes[i][0], offset - nodes[i][1]]; };
            for (let from = text.indexOf(quote), tries = 0; from >= 0 && tries < 20; from = text.indexOf(quote, from + 1), tries++) {
                const range = document.createRange();
                const [startNode, startOffset] = at(from, false), [endNode, endOffset] = at(from + quote.length, true);
                range.setStart(startNode, startOffset);
                range.setEnd(endNode, endOffset);
                const rect = range.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return range;
            }
            return null;
        }
        // A selector that names an element by its place among its siblings finds whatever is in that place now: after
        // the agent takes the Team plan out, the second card is Pro. So such an element is only found while it still
        // starts with the words it had when it was pinned.
        const positional = /:nth-(of-type|child)\\(/;
        const still = (el, expect) => !expect || (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().startsWith(expect.replace(/…$/, "").slice(0, 32));
        function locate(note) {
            const [id, how, what, expect] = note;
            let target = found.get(id);
            if (target && (how === "selector" ? target.isConnected : target.startContainer.isConnected)) return target;
            target = null;
            try { target = how === "selector" ? document.querySelector(what) : words(what); } catch (_) {}
            if (target && how === "selector" && positional.test(what) && !still(target, expect)) target = null;
            if (target) found.set(id, target); else found.delete(id);
            return target;
        }

        // MARK: naming what was pointed at
        const quoted = (value) => '"' + value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"';
        function unique(selector) { try { return document.querySelectorAll(selector).length === 1; } catch (_) { return false; } }
        function own(el) {
            const tag = el.localName;
            if (el.id && !machine(el.id)) { const s = "#" + CSS.escape(el.id); if (unique(s)) return [s, true]; }
            for (const name of ["data-testid", "data-test", "data-qa", "data-cy"]) {
                const value = el.getAttribute(name);
                if (value && value.length <= 40 && !control.test(value)) { const s = "[" + name + "=" + quoted(value) + "]"; if (unique(s)) return [s, true]; }
            }
            let s = tag + [...el.classList].filter((c) => !machine(c) && c.length <= 24).slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
            const parent = el.parentElement;
            if (parent) {
                const kin = [...parent.children].filter((child) => child.localName === tag);
                if (kin.length > 1 && [...parent.children].filter((child) => child.matches(s)).length > 1) s += ":nth-of-type(" + (kin.indexOf(el) + 1) + ")";
            }
            return [s, false];
        }
        // The shortest selector that names `el` alone: its own step, then its parents', until only it matches; the steps
        // from the nearest id instead, when the whole path is too long to be a mark's frame.
        function selector(el) {
            const steps = [];
            for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
                steps.unshift(own(node)[0]);
                const path = steps.join(" > ");
                if (unique(path)) {
                    if (path.length <= \(AnnotationAnchor.frameMax)) return path;
                    const short = steps[0] + " " + steps[steps.length - 1];
                    return unique(short) && short.length < path.length ? short : path;
                }
            }
            return steps.join(" > ");
        }
        const clip = (text, n) => text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
        function describe(el) {
            const attributes = [];
            for (const name of ["id", "class", "href", "src", "alt", "aria-label", "role", "type", "name", "placeholder", "title", "data-testid"]) {
                const value = el.getAttribute(name);
                if (value) attributes.push([name, clip(value.replace(/\\s+/g, " ").trim(), 80)]);
            }
            const text = clip((el.innerText || el.textContent || el.getAttribute("alt") || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim(), 80);
            return { selector: selector(el), tag: el.localName, text, attributes };
        }
        // What a pointer at (x, y) names: a control it is inside, an svg rather than its parts, never the page itself.
        function pickable(el) {
            if (!el || el === document.documentElement || el === document.body) return null;
            const svg = el.closest("svg");
            if (svg) el = svg;
            const inside = el.closest("a, button, label, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem]");
            return inside && inside !== document.body ? inside : el;
        }
        function label(el) {
            const step = own(el)[0];
            return step.length > 40 ? el.localName : step;
        }

        // MARK: words
        // One line of the selection, as the page has it, which agent ink's finder finds: its longest line, cut at a
        // space to the frame's length; grown from the words round it when the same words show earlier on the page.
        function quoteOf(range) {
            const raw = range.toString();
            const selected = raw.replace(/\\s+/g, " ").trim();
            if (!selected) return null;
            let quote = raw.split(control).map((line) => line.trim()).filter(Boolean).reduce((a, b) => b.length > a.length ? b : a, "");
            if (quote.length > \(AnnotationAnchor.frameMax)) {
                quote = quote.slice(0, \(AnnotationAnchor.frameMax));
                const space = quote.lastIndexOf(" ");
                if (space > \(AnnotationAnchor.frameMax / 2)) quote = quote.slice(0, space);
            }
            const there = range.getBoundingClientRect();
            const all = texts();
            const lands = (q) => { const r = words(q, all); if (!r) return false; const b = r.getBoundingClientRect(); return b.right > there.left && b.left < there.right && b.bottom > there.top && b.top < there.bottom; };
            if (!lands(quote) && range.startContainer.nodeType === 3) {
                // A word at a time, before then after, within the words' own line.
                const data = range.startContainer.data;
                let a = range.startOffset, b = range.endContainer === range.startContainer ? range.endOffset : data.length;
                for (let step = 0; step < 24 && (a > 0 || b < data.length); step++) {
                    if (step % 2 === 0 ? a > 0 : b >= data.length) { a--; while (a > 0 && !/\\s/.test(data[a - 1])) a--; }
                    else { b++; while (b < data.length && !/\\s/.test(data[b])) b++; }
                    const piece = data.slice(a, b);
                    if (control.test(piece)) break;
                    const q = piece.trim();
                    if (q.length > \(AnnotationAnchor.frameMax)) break;
                    if (lands(q)) { quote = q; break; }
                }
            }
            return { quote, selected: selected === quote ? null : clip(selected, 500) };
        }

        // MARK: telling the pane
        function placed() {
            cancelAnimationFrame(frame);
            clearTimeout(late);
            frame = 0;
            const at = {};
            const missing = [];
            for (const note of notes) {
                const target = locate(note);
                const rect = target ? target.getBoundingClientRect() : null;
                if (rect && (rect.width > 0 || rect.height > 0)) at[note[0]] = box(rect); else missing.push(note[0]);
            }
            const under = on && hovered && hovered.isConnected ? { rect: box(hovered.getBoundingClientRect()), label: label(hovered) } : null;
            post({ kind: "placed", url: location.href, loaded: document.readyState === "complete", viewport: viewport(), found: at, missing, hover: under });
        }
        // Once a frame; and a tenth of a second at most, for a window WebKit isn't drawing frames for (behind others, or
        // off screen), whose notes still have to be found.
        function moved() { if (!frame) { frame = requestAnimationFrame(placed); late = setTimeout(placed, 100); } }
        function changed() {
            found = new Map();
            if (!settle) settle = setTimeout(() => { settle = 0; moved(); }, 150);
        }
        function listen() {
            if (listening) return;
            listening = true;
            addEventListener("scroll", moved, { capture: true, passive: true });
            addEventListener("resize", moved, { passive: true });
            if (window.visualViewport) { visualViewport.addEventListener("resize", moved, { passive: true }); visualViewport.addEventListener("scroll", moved, { passive: true }); }
            new MutationObserver(changed).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
            addEventListener("mousemove", (event) => {
                if (!on) return;
                const el = pickable(document.elementFromPoint(event.clientX, event.clientY));
                if (el !== hovered) { hovered = el; moved(); }
            }, { capture: true, passive: true });
            document.documentElement.addEventListener("mouseleave", () => { if (hovered) { hovered = null; moved(); } });
            // A click names what it lands on, and does nothing else: no link followed, no button pressed.
            addEventListener("click", (event) => {
                if (!on) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                const selection = getSelection();
                if (selection && !selection.isCollapsed && selection.toString().trim()) return;
                const el = pickable(event.target && event.target.nodeType === 1 ? event.target : document.elementFromPoint(event.clientX, event.clientY));
                if (!el) return;
                post({ kind: "element", url: location.href, viewport: viewport(), rect: box(el.getBoundingClientRect()), ...describe(el) });
            }, { capture: true });
            addEventListener("mouseup", (event) => {
                if (!on || event.button !== 0) return;
                setTimeout(() => {
                    const selection = getSelection();
                    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
                    const range = selection.getRangeAt(0);
                    const picked = quoteOf(range);
                    if (!picked) return;
                    const rect = range.getBoundingClientRect();
                    selection.removeAllRanges();
                    post({ kind: "words", url: location.href, viewport: viewport(), rect: box(rect), quote: picked.quote, selected: picked.selected });
                }, 0);
            }, { capture: true });
        }

        globalThis.conchAnnotate = {
            // Annotating or not, and the notes on this page as [id, "selector" | "quote", what, the element's words].
            set(next, list) {
                on = !!next;
                notes = Array.isArray(list) ? list : [];
                found = new Map();
                if (!on) hovered = null;
                if (on || notes.length) listen();
                moved();
                return true;
            },
        };
        post({ kind: "ready", url: location.href });
        })();
        """

    /// What the page said, read.
    public enum Message: Equatable, Sendable {
        /// A page loaded with the script in it.
        case ready(url: String)
        /// Tyler clicked an element: `rect` its client rect.
        case element(AnnotationElement, rect: CGRect, viewport: AgentInk.Viewport, url: String)
        /// Tyler selected words.
        case words(quote: String, selected: String?, rect: CGRect, viewport: AgentInk.Viewport, url: String)
        /// Where each note on the page is (client rects), the ones it looked for and didn't find, whether the page has
        /// finished loading, and what is under the pointer while annotating.
        case placed(found: [String: CGRect], missing: [String], loaded: Bool, hover: Hover?, viewport: AgentInk.Viewport, url: String)

        public struct Hover: Equatable, Sendable {
            public let rect: CGRect
            public let label: String
        }

        /// A message body as WebKit hands it over; nil for anything that isn't one of these, whole.
        public static func read(_ body: Any) -> Message? {
            guard let body = body as? [String: Any], let kind = body["kind"] as? String, let url = body["url"] as? String else { return nil }
            if kind == "ready" { return .ready(url: url) }
            guard let viewport = viewport(body["viewport"]) else { return nil }
            switch kind {
            case "element":
                guard let rect = rect(body["rect"]), let selector = body["selector"] as? String, !selector.isEmpty,
                      let tag = body["tag"] as? String else { return nil }
                let attributes = (body["attributes"] as? [[Any]] ?? []).compactMap { pair -> (name: String, value: String)? in
                    guard pair.count == 2, let name = pair[0] as? String, let value = pair[1] as? String else { return nil }
                    return (name, value)
                }
                return .element(AnnotationElement(selector: selector, tag: tag, text: body["text"] as? String, attributes: attributes), rect: rect, viewport: viewport, url: url)
            case "words":
                guard let rect = rect(body["rect"]), let quote = body["quote"] as? String, !quote.isEmpty else { return nil }
                return .words(quote: quote, selected: body["selected"] as? String, rect: rect, viewport: viewport, url: url)
            case "placed":
                let found = (body["found"] as? [String: Any] ?? [:]).compactMapValues(rect)
                let hover = (body["hover"] as? [String: Any]).flatMap { hover -> Hover? in
                    guard let rect = rect(hover["rect"]), let label = hover["label"] as? String else { return nil }
                    return Hover(rect: rect, label: label)
                }
                return .placed(found: found, missing: body["missing"] as? [String] ?? [], loaded: body["loaded"] as? Bool ?? true, hover: hover, viewport: viewport, url: url)
            default:
                return nil
            }
        }

        static func rect(_ value: Any?) -> CGRect? {
            guard let xywh = value as? [Any], xywh.count == 4 else { return nil }
            let numbers = xywh.compactMap { ($0 as? NSNumber)?.doubleValue }
            guard numbers.count == 4, numbers.allSatisfy(\.isFinite) else { return nil }
            return CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
        }

        static func viewport(_ value: Any?) -> AgentInk.Viewport? {
            guard let view = value as? [String: Any] else { return nil }
            func number(_ key: String) -> CGFloat? { (view[key] as? NSNumber).map { CGFloat($0.doubleValue) } }
            guard let width = number("width") else { return nil }
            return AgentInk.Viewport(left: number("left") ?? 0, top: number("top") ?? 0, scale: number("scale") ?? 1, width: width)
        }
    }

    /// The notes on `page` as the script takes them: [id, "selector" | "quote", what], and an element's words as it was
    /// pinned, which a selector by position has to still find. Pictures' notes aren't on a page.
    public static func anchors(_ notes: [AnnotationNote], on page: String) -> [[String]] {
        notes.compactMap { note in
            guard AnnotationPlace.same(note.on, page) else { return nil }
            switch note.anchor {
            case let .element(element): return [note.id, "selector", element.selector, element.text ?? ""]
            case let .quote(quote, _): return [note.id, "quote", quote]
            case .region, .spot: return nil
            }
        }
    }
}
