import CoreGraphics
import ImageIO
import XCTest
@testable import ConchDesign

/// The canvas's document and its one path builder: what is on screen and what an agent is sent are drawn from these.
final class CanvasTests: XCTestCase {
    /// A 1000 × 500 point display, so a unit point reads straight off as points.
    private let size = CGSize(width: 1000, height: 500)
    private lazy var anchor = CanvasAnchor(id: 7, frame: CGRect(origin: .zero, size: size))

    private func at(_ x: CGFloat, _ y: CGFloat, p: Double? = nil, t: Double = 0) -> CanvasPoint {
        CanvasPoint(x: x / size.width, y: y / size.height, p: p, t: t)
    }

    private func mark(_ kind: CanvasMark.Kind, _ points: CanvasPoint..., text: String? = nil, author: CanvasMark.Author = .you) -> CanvasMark {
        CanvasMark(kind: kind, author: author, points: points, text: text)
    }

    // MARK: The document

    func testItRoundTripsThroughJSONAndLeavesOutAMousesPressure() throws {
        var document = CanvasDocument(anchor: anchor, id: "c1", at: 1_000)
        document.add(mark(.pen, at(10, 10, t: 0), at(20, 12, p: 0.4, t: 0.01)))
        document.add(mark(.note, at(300, 200), text: "make this bigger"))
        let data = try JSONEncoder().encode(document)
        XCTAssertEqual(try JSONDecoder().decode(CanvasDocument.self, from: data), document)
        let json = String(decoding: data, as: UTF8.self)
        // A mouse sample has no pressure, and says so by leaving it out; a tablet's is kept.
        XCTAssertEqual(json.components(separatedBy: "\"p\":").count - 1, 1)
        XCTAssertTrue(json.contains("\"kind\":\"display\""))
        XCTAssertTrue(json.contains("\"author\":\"you\""))
    }

    func testUndoTakesTheNewestMark() {
        var document = CanvasDocument(anchor: anchor)
        document.add(mark(.box, at(0, 0), at(10, 10)))
        document.add(mark(.arrow, at(0, 0), at(10, 10)))
        XCTAssertEqual(document.undo()?.kind, .arrow)
        XCTAssertEqual(document.marks.map(\.kind), [.box])
        document.undo()
        XCTAssertNil(document.undo())
        XCTAssertTrue(document.isEmpty)
    }

    func testNotesAreNumberedPerAuthorInTheOrderTheyWerePinned() {
        var document = CanvasDocument(anchor: anchor)
        let first = mark(.note, at(1, 1)), agent = mark(.note, at(2, 2), author: .agent), second = mark(.note, at(3, 3))
        for each in [first, mark(.pen, at(0, 0)), agent, second] { document.add(each) }
        XCTAssertEqual(document.number(of: first), 1)
        XCTAssertEqual(document.number(of: second), 2)
        XCTAssertEqual(document.number(of: agent), 1)
        document.setText("bigger", of: second.id)
        XCTAssertEqual(document.marks.last?.text, "bigger")
    }

    /// A note says what it is about by where it is pinned: `1. box (62%,18%): "make this bigger"`.
    func testANoteIsAboutTheNewestMarkItIsPinnedOn() {
        var document = CanvasDocument(anchor: anchor)
        let box = mark(.box, at(100, 100), at(300, 200))
        let arrow = mark(.arrow, at(500, 400), at(700, 300))
        let inner = mark(.box, at(150, 120), at(250, 180))
        for each in [box, arrow, inner] { document.add(each) }
        XCTAssertEqual(document.target(of: mark(.note, at(200, 150)))?.id, inner.id, "the newest box on top wins")
        XCTAssertEqual(document.target(of: mark(.note, at(120, 190)))?.id, box.id)
        // Just outside a box still counts, as a pin dropped on its edge would.
        XCTAssertEqual(document.target(of: mark(.note, at(310, 150)))?.id, box.id)
        XCTAssertEqual(document.target(of: mark(.note, at(600, 360)))?.id, arrow.id, "on the arrow's shaft")
        XCTAssertNil(document.target(of: mark(.note, at(900, 60))), "open space is about itself")
    }

    // MARK: The path builder

    /// Width across the stroke at `x`, found by probing the filled outline straight down.
    private func thickness(of path: CGPath, atX x: CGFloat, around y: CGFloat) -> CGFloat {
        let inside = stride(from: y - 20, through: y + 20, by: 0.05).filter { path.contains(CGPoint(x: x, y: $0)) }
        guard let top = inside.first, let bottom = inside.last else { return 0 }
        return bottom - top
    }

    func testAStrokeIsOneFilledOutlineThroughItsSamplesWithRoundEnds() {
        let samples = (0...50).map { at(100 + CGFloat($0) * 8, 250, t: Double($0) / 60) }
        let path = CanvasInk.stroke(samples, in: size, width: 6, thinning: 0)
        XCTAssertTrue(path.contains(CGPoint(x: 300, y: 250)))
        XCTAssertFalse(path.contains(CGPoint(x: 300, y: 256)))
        // Round, not flat: just past each end is still ink, and not a whole radius past.
        XCTAssertTrue(path.contains(CGPoint(x: 502, y: 250)))
        XCTAssertFalse(path.contains(CGPoint(x: 504, y: 250)))
        XCTAssertTrue(path.contains(CGPoint(x: 98, y: 250)))
        XCTAssertEqual(thickness(of: path, atX: 300, around: 250), 6, accuracy: 0.2)
        XCTAssertEqual(path.boundingBoxOfPath.minX, 97, accuracy: 0.5)
        XCTAssertEqual(path.boundingBoxOfPath.maxX, 503, accuracy: 0.5)
    }

    func testATabletsPressureSetsTheWidth() {
        let light = CanvasInk.stroke((0...40).map { at(100 + CGFloat($0) * 5, 100, p: 0, t: Double($0) / 60) }, in: size, width: 8, thinning: 0.5)
        let firm = CanvasInk.stroke((0...40).map { at(100 + CGFloat($0) * 5, 100, p: 1, t: Double($0) / 60) }, in: size, width: 8, thinning: 0.5)
        XCTAssertEqual(thickness(of: light, atX: 200, around: 100), 4, accuracy: 0.2)
        XCTAssertEqual(thickness(of: firm, atX: 200, around: 100), 8, accuracy: 0.2)
    }

    /// A mouse or trackpad has no pressure: a fast stroke draws thinner than a slow one, as a pen would.
    func testWithoutPressureSpeedThinsIt() {
        let slow = CanvasInk.stroke((0...40).map { at(100 + CGFloat($0) * 2, 100, t: Double($0) / 60) }, in: size, width: 8, thinning: 0.5)
        let fast = CanvasInk.stroke((0...40).map { at(100 + CGFloat($0) * 20, 100, t: Double($0) / 60) }, in: size, width: 8, thinning: 0.5)
        XCTAssertGreaterThan(thickness(of: slow, atX: 150, around: 100), thickness(of: fast, atX: 500, around: 100) + 1.5)
    }

    func testAClickIsADot() {
        let dot = CanvasInk.stroke([at(40, 40)], in: size, width: 6, thinning: 0.5)
        XCTAssertTrue(dot.contains(CGPoint(x: 42.5, y: 40)))
        XCTAssertFalse(dot.contains(CGPoint(x: 43.5, y: 40)))
    }

    func testAHighlightIsAnEvenMarkerLine() {
        let ink = CanvasInk.shape(of: mark(.highlight, at(100, 100, t: 0), at(160, 100, t: 0.01), at(400, 100, t: 0.02)), in: size).ink
        XCTAssertEqual(thickness(of: ink, atX: 130, around: 100), CanvasInk.highlightWidth, accuracy: 0.3)
        XCTAssertEqual(thickness(of: ink, atX: 350, around: 100), CanvasInk.highlightWidth, accuracy: 0.3)
    }

    func testAnArrowHasAShaftAndAHeadAtItsSecondPoint() {
        let ink = CanvasInk.shape(of: mark(.arrow, at(100, 300), at(400, 300)), in: size).ink
        XCTAssertTrue(ink.contains(CGPoint(x: 200, y: 300)), "the shaft")
        XCTAssertTrue(ink.contains(CGPoint(x: 398, y: 300)), "the head's tip")
        XCTAssertTrue(ink.contains(CGPoint(x: 390, y: 305)), "the head is wider than the shaft")
        XCTAssertFalse(ink.contains(CGPoint(x: 200, y: 305)))
        XCTAssertFalse(ink.contains(CGPoint(x: 405, y: 300)))
    }

    func testABoxIsARoundedOutlineWithAWashInside() {
        let shape = CanvasInk.shape(of: mark(.box, at(300, 200), at(100, 100)), in: size)
        XCTAssertTrue(shape.ink.contains(CGPoint(x: 200, y: 100)), "its top edge, drawn from either corner")
        XCTAssertFalse(shape.ink.contains(CGPoint(x: 200, y: 150)))
        XCTAssertTrue(shape.wash?.contains(CGPoint(x: 200, y: 150)) == true)
        XCTAssertFalse(shape.ink.contains(CGPoint(x: 100.5, y: 100.5)), "its corners are rounded")
    }

    func testANotesBadgeSitsAboveAndRightOfItsSpot() {
        let ink = CanvasInk.shape(of: mark(.note, at(500, 300)), in: size).ink
        XCTAssertEqual(ink.boundingBoxOfPath.minX, 500, accuracy: 0.01)
        XCTAssertEqual(ink.boundingBoxOfPath.maxY, 300, accuracy: 0.01)
        XCTAssertEqual(ink.boundingBoxOfPath.width, CanvasInk.pinSide, accuracy: 0.01)
        XCTAssertTrue(ink.contains(CGPoint(x: 501.5, y: 298.5)), "its sharper corner is on the spot")
        XCTAssertFalse(ink.contains(CGPoint(x: 523.5, y: 276.5)), "the others are round")
    }

    /// The picture an agent is sent is the same path at the picture's size: every mark, drawn twice as big at scale 2,
    /// lands on exactly twice the points.
    func testThePictureIsTheScreensPathAtItsOwnScale() {
        let marks = [
            mark(.pen, at(100, 100, t: 0), at(140, 120, t: 0.02), at(200, 180, t: 0.04), at(260, 170, t: 0.07)),
            mark(.highlight, at(300, 300, t: 0), at(420, 305, t: 0.05)),
            mark(.arrow, at(600, 100), at(700, 200)),
            mark(.box, at(50, 350), at(250, 450)),
            mark(.note, at(800, 400)),
        ]
        for each in marks {
            let screen = CanvasInk.shape(of: each, in: size).ink.boundingBoxOfPath
            let picture = CanvasInk.shape(of: each, in: CGSize(width: size.width * 2, height: size.height * 2), scale: 2).ink.boundingBoxOfPath
            XCTAssertEqual(picture.minX, screen.minX * 2, accuracy: 0.5, "\(each.kind)")
            XCTAssertEqual(picture.minY, screen.minY * 2, accuracy: 0.5, "\(each.kind)")
            XCTAssertEqual(picture.width, screen.width * 2, accuracy: 0.5, "\(each.kind)")
            XCTAssertEqual(picture.height, screen.height * 2, accuracy: 0.5, "\(each.kind)")
        }
    }

    // MARK: The picture

    /// A screen of one flat colour, `width` × `height` pixels.
    private func screen(_ width: Int, _ height: Int, grey: CGFloat = 1) -> CGImage {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(srgbRed: grey, green: grey, blue: grey, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }

    /// The pixel at `x`, `y` from the top left, as 0–255 red, green, blue.
    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
        let at = (y * image.width + x) * 4
        return (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2]))
    }

    /// The display's pixels, the marks drawn over them where they were drawn, and no more than 1568 px on the long edge.
    func testThePictureIsTheScreenWithTheMarksOverItAtMost1568Across() throws {
        var document = CanvasDocument(anchor: anchor)
        document.add(mark(.box, at(100, 100), at(300, 200)))
        // A 2x display: 2000 × 1000 pixels, fitted into 1568 × 784.
        let picture = try XCTUnwrap(CanvasInk.render(document, over: screen(2000, 1000)))
        XCTAssertEqual(picture.width, 1568)
        XCTAssertEqual(picture.height, 784)
        let k = 1568.0 / 1000
        // The box's top edge, in Tyler's orange, not flipped to the bottom.
        let edge = pixel(picture, Int(200 * k), Int(100 * k))
        XCTAssertEqual(edge.r, 0xFF, accuracy: 3)
        XCTAssertEqual(edge.g, 0x6A, accuracy: 3)
        XCTAssertEqual(edge.b, 0x3D, accuracy: 3)
        // Inside, the screen shows through the faintest wash; outside, the screen as it was.
        let inside = pixel(picture, Int(200 * k), Int(150 * k))
        XCTAssertGreaterThan(inside.b, 235)
        XCTAssertLessThan(inside.b, 255)
        XCTAssertEqual(pixel(picture, Int(200 * k), Int(400 * k)).b, 255)
        // A smaller screen is never scaled up.
        XCTAssertEqual(CanvasInk.render(document, over: screen(1000, 500))?.width, 1000)
    }

    /// Without the Screen Recording grant there is no screen: the marks alone, on the ground, so they read anywhere.
    func testWithNoScreenItIsTheMarksAloneOnTheGround() throws {
        var document = CanvasDocument(anchor: anchor)
        document.add(mark(.arrow, at(100, 250), at(900, 250)))
        let picture = try XCTUnwrap(CanvasInk.render(document, over: nil))
        XCTAssertEqual(picture.width, 1568)
        let ground = pixel(picture, 10, 10)
        XCTAssertEqual(ground.r, 0xF2, accuracy: 2)
        XCTAssertEqual(pixel(picture, 784, 392).r, 0xFF, accuracy: 3)
    }

    /// A highlight is multiplied into what is under it, as a marker is: yellow over white, darker over grey.
    func testAHighlightMultipliesOverTheScreen() throws {
        var document = CanvasDocument(anchor: anchor)
        document.add(mark(.highlight, at(100, 250), at(900, 250)))
        let white = try XCTUnwrap(CanvasInk.render(document, over: screen(1000, 500)))
        let grey = try XCTUnwrap(CanvasInk.render(document, over: screen(1000, 500, grey: 0.5)))
        XCTAssertEqual(pixel(white, 500, 250).r, 255, accuracy: 3)
        XCTAssertLessThan(pixel(white, 500, 250).b, 180, "yellow")
        XCTAssertLessThan(pixel(grey, 500, 250).r, 140, "multiplied, not laid over")
    }

    func testAPictureRoundTripsAsAPNG() throws {
        let data = try XCTUnwrap(CanvasInk.png(screen(40, 20)))
        XCTAssertEqual(Array(data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        XCTAssertEqual(CGImageSourceCreateImageAtIndex(source, 0, nil)?.width, 40)
    }

    // MARK: The prompt

    func testThePromptLeadsWithThePictureThenTheNotesByNumberThenTheRest() {
        var document = CanvasDocument(anchor: anchor)
        document.add(mark(.box, at(520, 40), at(720, 140)))
        document.add(mark(.note, at(600, 90), text: "make this\nbigger"))
        document.add(mark(.arrow, at(100, 400), at(300, 300)))
        document.add(mark(.note, at(200, 350), text: "move here"))
        document.add(mark(.note, at(950, 480), text: "  "))
        document.add(mark(.note, at(900, 20), text: "and this"))
        XCTAssertEqual(
            CanvasPrompt.text(for: document, about: "Arch brand page (http://localhost:3000/invite)", picture: "/c/flat.png", clean: "/c/raw.png", marks: "/c/canvas.json"),
            """
            /c/flat.png
            [canvas] Tyler marked up Arch brand page (http://localhost:3000/invite).
            1. box (62%,18%): "make this bigger"
            2. arrow (10%,80%)→(30%,60%): "move here"
            4. note (90%,4%): "and this"
            Clean screen + marks: /c/raw.png, /c/canvas.json
            """
        )
    }

    func testWithoutAScreenThePromptSaysWhy() {
        var document = CanvasDocument(anchor: anchor)
        document.add(mark(.pen, at(10, 10), at(20, 20)))
        let text = CanvasPrompt.text(for: document, about: "Safari", picture: "/c/flat.png", clean: nil, marks: "/c/canvas.json")
        XCTAssertEqual(text.components(separatedBy: "\n").first, "/c/flat.png")
        XCTAssertTrue(text.contains("[canvas] Tyler marked up Safari.\n"))
        XCTAssertTrue(text.hasSuffix("the picture is his marks alone. Marks: /c/canvas.json"))
        XCTAssertFalse(text.contains("raw.png"))
    }

    /// Live ink is rebuilt on every pointer event, so a long stroke must stay far inside a frame.
    func testALongStrokeBuildsWellInsideAFrame() {
        let samples = (0..<600).map { i -> CanvasPoint in
            let t = CGFloat(i) / 20
            return at(100 + t * 30, 250 + sin(t) * 80, t: Double(i) / 120)
        }
        let start = Date()
        for _ in 0..<20 { _ = CanvasInk.stroke(samples, in: size, width: 3.2, thinning: 0.5) }
        // Measured at about 0.1 ms; a frame at 120 Hz is 8 ms, and a loaded test run gets the rest.
        XCTAssertLessThan(Date().timeIntervalSince(start) / 20, 0.004)
    }
}
