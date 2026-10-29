import CoreGraphics
import ImageIO
import XCTest
@testable import ConchDesign

/// Annotate's data, message and pictures (docs/annotate.md): what a batch keeps, what the agent is sent for each kind of
/// anchor, where things go in the pane, and the pictures drawn in Tyler's ink.
final class AnnotateTests: XCTestCase {
    private let page = "http://localhost:5173/"
    private let cta = AnnotationAnchor.element(AnnotationElement(
        selector: "section.hero > a.cta", tag: "a", text: "Start free trial",
        attributes: [(name: "class", value: "cta"), (name: "href", value: "/signup")]
    ))

    private func note(_ anchor: AnnotationAnchor, _ text: String, on: String? = nil, found: Bool = true) -> AnnotationNote {
        AnnotationNote(anchor: anchor, text: text, on: on ?? page, found: found)
    }

    // MARK: - The batch

    func testABatchKeepsOnlyNotesWithWordsInTheOrderTheyWerePinned() {
        var batch = AnnotationBatch()
        let one = note(cta, "make this bigger")
        let blank = note(.quote("Ship faster", selected: nil), "   \n ")
        let two = note(.quote("Ship faster", selected: nil), "too long")
        batch.save(one)
        batch.save(blank)
        batch.save(two)
        XCTAssertEqual(batch.notes.map(\.id), [one.id, two.id])
        XCTAssertEqual(batch.number(of: two.id), 2)
        // A note not yet kept is the next one.
        XCTAssertEqual(batch.number(of: "draft"), 3)

        // Saved again, it keeps its place; saved with no words, it goes.
        var edited = one
        edited.text = "make this much bigger"
        batch.save(edited)
        XCTAssertEqual(batch.notes.first?.text, "make this much bigger")
        XCTAssertEqual(batch.number(of: one.id), 1)
        edited.text = ""
        batch.save(edited)
        XCTAssertEqual(batch.notes.map(\.id), [two.id])
        XCTAssertEqual(batch.number(of: two.id), 1)
    }

    func testLookingForNotesMarksOnlyThoseOnThatPlace() {
        let here = note(cta, "a")
        let gone = note(.quote("Old words", selected: nil), "b")
        let elsewhere = note(.quote("x", selected: nil), "c", on: "/tmp/other.md")
        var batch = AnnotationBatch(notes: [here, gone, elsewhere])
        // The same page, but for its fragment and a trailing slash.
        batch.looked(on: "http://localhost:5173#pricing", found: [here.id])
        XCTAssertEqual(batch.notes.map(\.found), [true, false, true])
        XCTAssertEqual(batch.missing.map(\.id), [gone.id])
        // Back again: found once more.
        batch.looked(on: page, found: [here.id, gone.id])
        XCTAssertTrue(batch.missing.isEmpty)
    }

    // MARK: - Where it goes

    func testSendGoesToTheSessionThatPublishedItAndIsOffOnceThatSessionHasEnded() {
        let live = AnnotationRoute.resolve(owner: "s1", label: "old name", sessions: [("s0", "other", nil), ("s1", "landing page", nil)])
        XCTAssertEqual(live, AnnotationRoute(session: "s1", label: "landing page"))
        XCTAssertFalse(live.ended)
        let gone = AnnotationRoute.resolve(owner: "s1", label: "landing page", sessions: [("s0", "other", nil)])
        XCTAssertTrue(gone.ended)
        XCTAssertEqual(gone.label, "landing page")
        XCTAssertEqual(AnnotationTray.Notice.ended(gone).text, "landing page has ended, so there is nowhere to send these. Your notes are kept here.")
        // Listed, but with no way in: as the composer is off, so is Send, with the daemon's reason.
        let closed = AnnotationRoute.resolve(owner: "s1", label: "x", sessions: [("s1", "landing page", "Its terminal has closed.")])
        XCTAssertTrue(closed.ended)
        XCTAssertEqual(AnnotationTray.Notice.ended(closed).text, "Can't send to landing page: Its terminal has closed. Your notes are kept here.")
        XCTAssertEqual(AnnotationTray.Notice.ended(closed).actions, [.copy])
    }

    // MARK: - The message

    func testTheMessageGivesEachNoteItsFrameInAgentInksWordsWithItsPicture() {
        var batch = AnnotationBatch(id: "B")
        let one = note(cta, "make this bigger")
        let two = note(.quote("Ship faster with", selected: "Ship faster with fewer meetings"), "too long,\nfive words at most")
        batch.save(one)
        batch.save(two)
        let files = AnnotationPrompt.Files(overview: "/c/B/overview.png", pictures: [one.id: "/c/B/1.png", two.id: "/c/B/2.png"], json: "/c/B/notes.json")
        let text = AnnotationPrompt.text(for: batch, about: "Landing page", link: page, files: files)
        XCTAssertEqual(text, """
            /c/B/overview.png
            [annotate] Tyler left 2 notes on your deliverable "Landing page" (http://localhost:5173/).
            1. {selector: "section.hero > a.cta"}, the <a> "Start free trial": "make this bigger"
               Picture: /c/B/1.png
            2. {quote: "Ship faster with"} (selected: "Ship faster with fewer meetings"): "too long, five words at most"
               Picture: /c/B/2.png
            The page with the notes numbered: /c/B/overview.png. Everything above as JSON: /c/B/notes.json
            To point back at any of these, publish marks with the same frame (review_to_front scene.marks).
            """)
    }

    func testAPicturesNotesCarryTheFractionsAMarkTakes() {
        let image = "/Users/t/shots/hero.png"
        var batch = AnnotationBatch()
        batch.save(note(.region(image: image, rect: CGRect(x: 0.12, y: 0.4, width: 0.3, height: 0.18)), "this blurs", on: image))
        batch.save(note(.spot(image: image, at: CGPoint(x: 0.5, y: 0.25)), "a logo here", on: image))
        let lines = AnnotationPrompt.text(for: batch, about: "Hero", link: image, files: .init(overview: "/c/o.png", json: "/c/n.json"), shown: "picture")
            .components(separatedBy: "\n")
        XCTAssertEqual(lines[2], #"1. {image: "/Users/t/shots/hero.png"} rect [0.120, 0.400, 0.300, 0.180]: "this blurs""#)
        XCTAssertEqual(lines[3], #"2. {image: "/Users/t/shots/hero.png"} at [0.500, 0.250]: "a logo here""#)
        XCTAssertTrue(lines[4].hasPrefix("The picture with the notes numbered: /c/o.png."))
    }

    func testANoteOnAFileInAFolderSaysWhichFileAndADocumentHasNoOverview() {
        var batch = AnnotationBatch()
        batch.save(note(.quote("npm run dev", selected: nil), "it's bun now", on: "/work/module/README.md"))
        let text = AnnotationPrompt.text(for: batch, about: "The module", link: "/work/module", files: .init(json: "/c/n.json"))
        let lines = text.components(separatedBy: "\n")
        // No picture: the header comes first.
        XCTAssertEqual(lines[0], #"[annotate] Tyler left 1 note on your deliverable "The module" (/work/module)."#)
        XCTAssertEqual(lines[1], #"1. {quote: "npm run dev"} in /work/module/README.md: "it's bun now""#)
        XCTAssertEqual(lines[2], "Everything above as JSON: /c/n.json")
    }

    func testANoteWhoseAnchorWentAwayIsStillSentAndSaysSo() {
        let page = note(cta, "highlight this", found: false)
        let file = note(.quote("gone words", selected: nil), "fix", on: "/w/a.md", found: false)
        XCTAssertEqual(AnnotationPrompt.line(for: page, number: 3, deliverable: self.page),
                       #"3. {selector: "section.hero > a.cta"}, the <a> "Start free trial": "highlight this" (not on the page when sent: it changed after this was pinned)"#)
        XCTAssertTrue(AnnotationPrompt.line(for: file, number: 1, deliverable: "/w/a.md").hasSuffix("(not in the file when sent: it changed after this was pinned)"))
    }

    func testQuotesInsideAFrameAreQuotedAsJSONSoTheyReadBackExactly() {
        let anchor = AnnotationAnchor.element(AnnotationElement(selector: #"[data-testid="buy \"now\""]"#, tag: "button", text: nil))
        XCTAssertEqual(anchor.frameText, #"{selector: "[data-testid=\"buy \\\"now\\\"\"]"}"#)
        let back = try? JSONSerialization.jsonObject(with: Data("[\(AnnotationPrompt.quoted(#"[data-testid="buy \"now\""]"#))]".utf8)) as? [String]
        XCTAssertEqual(back, [#"[data-testid="buy \"now\""]"#])
        XCTAssertEqual(AnnotationPrompt.quoted("/a/b"), #""/a/b""#)
    }

    func testTheJSONHasEachNotesFrameAndGeometry() throws {
        var batch = AnnotationBatch()
        let one = note(cta, "bigger")
        let two = note(.region(image: "/i.png", rect: CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4)), "blur", on: "/i.png", found: false)
        batch.save(one)
        batch.save(two)
        let data = AnnotationPrompt.json(for: batch, about: "S", link: page, files: .init(overview: "/o.png", pictures: [one.id: "/1.png"], json: "/n.json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let notes = try XCTUnwrap(root["notes"] as? [[String: Any]])
        XCTAssertEqual(notes[0]["frame"] as? [String: String], ["selector": "section.hero > a.cta"])
        XCTAssertEqual((notes[0]["element"] as? [String: Any])?["tag"] as? String, "a")
        XCTAssertEqual(((notes[0]["element"] as? [String: Any])?["attributes"] as? [String: String])?["href"], "/signup")
        XCTAssertEqual(notes[0]["picture"] as? String, "/1.png")
        XCTAssertEqual(notes[1]["rect"] as? [Double], [0.1, 0.2, 0.3, 0.4])
        XCTAssertEqual(notes[1]["found"] as? Bool, false)
        XCTAssertEqual((root["deliverable"] as? [String: String])?["link"], page)
    }

    // MARK: - Where things go in the pane

    func testAPinSitsOnItsTopRightCornerInsideThePane() {
        let bounds = CGSize(width: 400, height: 300)
        XCTAssertEqual(AnnotationGeometry.pinSpot(on: CGRect(x: 40, y: 80, width: 100, height: 30), in: bounds), CGPoint(x: 140, y: 80))
        // At the right edge, it stays a badge's width in; at the top, a badge's height down.
        XCTAssertEqual(AnnotationGeometry.pinSpot(on: CGRect(x: 300, y: 2, width: 100, height: 30), in: bounds), CGPoint(x: 376, y: 24))
    }

    func testFractionsOfAPictureGoAndComeBackWhereverItIsDrawn() throws {
        let frame = CGRect(x: 18, y: 18, width: 600, height: 400)
        let unit = AnnotationGeometry.unit(CGRect(x: 78, y: 58, width: 120, height: 80), of: frame)
        XCTAssertEqual(unit.minX, 0.1, accuracy: 1e-9)
        XCTAssertEqual(unit.minY, 0.1, accuracy: 1e-9)
        XCTAssertEqual(unit.width, 0.2, accuracy: 1e-9)
        // Zoomed to twice the size and scrolled, the same fractions land on the same part.
        let zoomed = CGRect(x: -200, y: -100, width: 1200, height: 800)
        let back = AnnotationGeometry.place(unit, in: zoomed)
        XCTAssertEqual(back.minX, -80, accuracy: 1e-9)
        XCTAssertEqual(back.width, 240, accuracy: 1e-9)
        // A drag past the picture's edge is kept to the picture; a spot off it is no spot.
        let past = AnnotationGeometry.unit(CGRect(x: 500, y: 300, width: 400, height: 400), of: frame)
        XCTAssertEqual(past.maxX, 1, accuracy: 1e-9)
        XCTAssertEqual(past.maxY, 1, accuracy: 1e-9)
        XCTAssertNil(AnnotationGeometry.unit(CGPoint(x: 5, y: 5), of: frame))
        XCTAssertEqual(try XCTUnwrap(AnnotationGeometry.unit(CGPoint(x: 318, y: 218), of: frame)), CGPoint(x: 0.5, y: 0.5))
    }

    func testTheEditorOpensBesideItsPinAndNeverOverWhatTheNoteIsAbout() {
        let size = CGSize(width: AnnotationEditor.width, height: 120)
        let bounds = CGSize(width: 860, height: 600)
        // Room to the right: right of the badge, level with it.
        let button = CGRect(x: 40, y: 200, width: 60, height: 40)
        XCTAssertEqual(AnnotationGeometry.editorOrigin(pin: CGPoint(x: 100, y: 200), target: button, size: size, in: bounds), CGPoint(x: 132, y: 176))
        // No room to the right: under the button, from its left edge, so the button and its pin still show.
        let right = CGRect(x: 600, y: 200, width: 160, height: 50)
        let under = AnnotationGeometry.editorOrigin(pin: CGPoint(x: 760, y: 200), target: right, size: size, in: bounds)
        XCTAssertEqual(under, CGPoint(x: 562, y: 258))
        XCTAssertFalse(CGRect(origin: under, size: size).intersects(right))
        // Nor under it, near the foot: over it.
        let low = CGRect(x: 600, y: 500, width: 160, height: 50)
        let over = AnnotationGeometry.editorOrigin(pin: CGPoint(x: 760, y: 500), target: low, size: size, in: bounds)
        XCTAssertEqual(over.y, 500 - 24 - 8 - 120)
        XCTAssertFalse(CGRect(origin: over, size: size).intersects(low))
        // A target filling the pane leaves nowhere else: as low as fits, left of the badge.
        let whole = CGRect(x: 0, y: 0, width: 860, height: 600)
        XCTAssertEqual(AnnotationGeometry.editorOrigin(pin: CGPoint(x: 836, y: 24), target: whole, size: size, in: bounds).x, 836 - 8 - size.width)
    }

    // MARK: - Pictures

    private func swatch(width: Int, height: Int) -> CGImage {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }

    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        // The pixel at (x, y) from the top, drawn into the one-pixel context.
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (Int(bytes[0]), Int(bytes[1]), Int(bytes[2]))
    }

    func testANotesPictureIsTheThingAndItsMarginOutlinedInTylersInk() throws {
        let page = swatch(width: 800, height: 600)
        let element = CGRect(x: 200, y: 100, width: 120, height: 40)
        let crop = try XCTUnwrap(AnnotationPicture.crop(page, to: AnnotationGeometry.pictureRect(around: element, margin: 24, in: CGRect(x: 0, y: 0, width: 800, height: 600)), outline: .box(element), scale: 1))
        XCTAssertEqual(crop.width, 168)
        XCTAssertEqual(crop.height, 88)
        // The outline's left edge, 4 out from the element: orange; the middle stays the page's white wash.
        let edge = pixel(crop, 24 - 4, 44)
        XCTAssertGreaterThan(edge.r, 200)
        XCTAssertLessThan(edge.b, 120)
        let middle = pixel(crop, 84, 44)
        XCTAssertGreaterThan(middle.g, 230)
    }

    func testARegionsPictureIsCutFromThePicturesOwnPixels() throws {
        let image = swatch(width: 2000, height: 1000)
        let crop = try XCTUnwrap(AnnotationPicture.crop(image: image, anchor: .region(image: "/x.png", rect: CGRect(x: 0.25, y: 0.25, width: 0.25, height: 0.5))))
        // 500 x 500 pixels, a margin of 15% of its shorter side (75) all round, within the picture.
        XCTAssertEqual(crop.width, 650)
        XCTAssertEqual(crop.height, 650)
        let spot = try XCTUnwrap(AnnotationPicture.crop(image: image, anchor: .spot(image: "/x.png", at: CGPoint(x: 0.01, y: 0.5))))
        XCTAssertLessThan(spot.width, 240)
        XCTAssertEqual(spot.height, 240)
    }

    func testTheOverviewIsNoLongerThanAnUploadAndNumbersEachNote() throws {
        let page = swatch(width: 3000, height: 2000)
        let overview = try XCTUnwrap(AnnotationPicture.overview(page, notes: [(1, .box(CGRect(x: 300, y: 300, width: 600, height: 200))), (2, .words(CGRect(x: 1200, y: 1200, width: 400, height: 40)))], scale: 2))
        XCTAssertEqual(overview.width, 1568)
        XCTAssertEqual(overview.height, 1045)
        // Note 1's pin, on the box's top right corner (scaled), is orange.
        let fit = 1568.0 / 3000
        let pin = pixel(overview, Int((904 * fit).rounded()) + 6, Int((296 * fit).rounded()) - 6)
        XCTAssertGreaterThan(pin.r, 200)
        XCTAssertLessThan(pin.b, 140)
    }

    // MARK: - What the page says

    func testAPagesMessagesAreReadWholeOrNotAtAll() throws {
        let viewport: [String: Any] = ["left": 0, "top": 0, "scale": 1, "width": 1024]
        let element = AnnotationScript.Message.read([
            "kind": "element", "url": page, "viewport": viewport, "rect": [10, 20, 30, 40],
            "selector": "a.cta", "tag": "a", "text": "Start", "attributes": [["href", "/signup"], ["class", "cta"]],
        ] as [String: Any])
        guard case let .element(found, rect, _, url) = element else { return XCTFail("not an element: \(String(describing: element))") }
        XCTAssertEqual(found.selector, "a.cta")
        XCTAssertEqual(found.attributes.map(\.name), ["href", "class"])
        XCTAssertEqual(rect, CGRect(x: 10, y: 20, width: 30, height: 40))
        XCTAssertEqual(url, page)

        let placed = AnnotationScript.Message.read([
            "kind": "placed", "url": page, "viewport": viewport, "found": ["n1": [1, 2, 3, 4]], "missing": ["n2"], "loaded": true,
            "hover": ["rect": [0, 0, 5, 5], "label": "h1"],
        ] as [String: Any])
        XCTAssertEqual(placed, .placed(found: ["n1": CGRect(x: 1, y: 2, width: 3, height: 4)], missing: ["n2"], loaded: true,
                                       hover: .init(rect: CGRect(x: 0, y: 0, width: 5, height: 5), label: "h1"),
                                       viewport: AgentInk.Viewport(width: 1024), url: page))
        XCTAssertNil(AnnotationScript.Message.read(["kind": "element", "url": page, "viewport": viewport, "rect": [1, 2, 3]] as [String: Any]))
        XCTAssertNil(AnnotationScript.Message.read(["kind": "words", "url": page, "viewport": viewport, "rect": [1, 2, 3, 4], "quote": ""] as [String: Any]))
        XCTAssertNil(AnnotationScript.Message.read("hello"))
    }

    func testTheScriptIsHandedOnlyTheNotesOnItsOwnPage() {
        let one = note(cta, "a")
        let two = note(.quote("Ship", selected: nil), "b", on: "http://localhost:5173/#top")
        let other = note(.quote("x", selected: nil), "c", on: "http://localhost:5173/pricing")
        let image = note(.region(image: "/i.png", rect: .zero), "d", on: page)
        XCTAssertEqual(AnnotationScript.anchors([one, two, other, image], on: page), [[one.id, "selector", "section.hero > a.cta", "Start free trial"], [two.id, "quote", "Ship"]])
    }

    // MARK: - A document's words

    func testADocumentsSelectionBecomesOneLineOfItThatIsFoundWhereItWas() throws {
        let text = "# Setup\n\nRun npm run dev to start.\nThen open the page.\n\nLater: run npm run dev again.\n"
        // Across two lines: the longer line is the quote, all of it the context.
        let across = (text as NSString).range(of: "npm run dev to start.\nThen open")
        let made = try XCTUnwrap(AnnotationQuote.make(in: text, selected: across))
        XCTAssertEqual(made.quote, "npm run dev to start.")
        XCTAssertEqual(made.selected, "npm run dev to start. Then open")
        // The second "npm run dev" grows until it is the first place its words are.
        let second = (text as NSString).range(of: "npm run dev", options: .backwards)
        let grown = try XCTUnwrap(AnnotationQuote.make(in: text, selected: second))
        XCTAssertEqual(grown.quote, "run npm run dev")
        XCTAssertEqual(AnnotationQuote.find(grown.quote, in: text)?.location, second.location - 4)
        // What was selected goes along: the quote grew past it.
        XCTAssertEqual(grown.selected, "npm run dev")
        XCTAssertNil(AnnotationQuote.make(in: text, selected: NSRange(location: 7, length: 2)))
    }
}
