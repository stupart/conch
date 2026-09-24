import CoreGraphics
import XCTest
@testable import ConchDesign

/// An agent's marks as canvas marks: mapped onto what their numbers are fractions of, or placed on what conch found.
final class AgentInkTests: XCTestCase {
    /// A 1000 × 500 point display.
    private let size = CGSize(width: 1000, height: 500)

    private func points(_ mark: CanvasMark?) -> [CGPoint] {
        (mark?.points ?? []).map { $0.point(in: size) }
    }

    // MARK: Frames

    /// On a canvas the frame is the whole display: an agent's numbers are the display's.
    func testOnACanvasItsNumbersAreTheDisplays() throws {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        let arrow = try XCTUnwrap(AgentInk.mark(id: "a", kind: .arrow, label: "here", at: CGPoint(x: 0.1, y: 0.2), to: CGPoint(x: 0.5, y: 0.4), rect: nil, pts: [], in: whole))
        XCTAssertEqual(arrow.kind, .arrow)
        XCTAssertEqual(arrow.author, .agent)
        XCTAssertEqual(arrow.text, "here")
        XCTAssertEqual(points(arrow), [CGPoint(x: 100, y: 100), CGPoint(x: 500, y: 200)])
        XCTAssertEqual(arrow.points.first?.p, 1, "an even line, not one read from a mouse's speed")
    }

    /// On an image the frame is where the image is shown: its numbers land inside that rect.
    func testOnAnImageItsNumbersAreFractionsOfWhereTheImageIs() throws {
        let image = CGRect(x: 0.5, y: 0.25, width: 0.4, height: 0.5)
        let box = try XCTUnwrap(AgentInk.mark(id: "b", kind: .box, label: nil, at: nil, to: nil, rect: CGRect(x: 0.5, y: 0.5, width: 0.5, height: 0.5), pts: [], in: image))
        XCTAssertEqual(box.kind, .box)
        XCTAssertEqual(box.rect(in: CGSize(width: 1, height: 1)).minX, 0.7, accuracy: 1e-9)
        XCTAssertEqual(box.rect(in: CGSize(width: 1, height: 1)).minY, 0.5, accuracy: 1e-9)
        XCTAssertEqual(box.rect(in: CGSize(width: 1, height: 1)).width, 0.2, accuracy: 1e-9)
        XCTAssertEqual(box.rect(in: CGSize(width: 1, height: 1)).height, 0.25, accuracy: 1e-9)
    }

    func testEachKindBecomesItsCanvasMark() {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1), r = CGRect(x: 0.1, y: 0.1, width: 0.2, height: 0.2), p = CGPoint(x: 0.3, y: 0.3)
        let kinds = AgentInk.Kind.allCases.map { kind in
            AgentInk.mark(id: kind.rawValue, kind: kind, label: "words", at: p, to: p, rect: r, pts: [p, CGPoint(x: 0.4, y: 0.4)], in: whole)?.kind
        }
        XCTAssertEqual(kinds, [.arrow, .box, .ellipse, .area, .text, .note, .pen])
    }

    /// Nothing is drawn at a guessed position: a mark missing what its kind needs is no mark.
    func testAMarkWithoutItsGeometryIsNotDrawn() {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        XCTAssertNil(AgentInk.mark(id: "a", kind: .arrow, label: nil, at: CGPoint(x: 0, y: 0), to: nil, rect: nil, pts: [], in: whole))
        XCTAssertNil(AgentInk.mark(id: "b", kind: .box, label: nil, at: nil, to: nil, rect: nil, pts: [], in: whole))
        XCTAssertNil(AgentInk.mark(id: "c", kind: .stroke, label: nil, at: nil, to: nil, rect: nil, pts: [CGPoint(x: 0, y: 0)], in: whole))
        XCTAssertNil(AgentInk.mark(id: "d", kind: .text, label: nil, at: CGPoint(x: 0, y: 0), to: nil, rect: nil, pts: [], in: whole), "text is its words")
    }

    // MARK: Placing on what conch found

    /// An element 200 × 100 points at (400, 200).
    private let element = CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.2)

    func testABoxIsPaddedRoundWhatItMarks() {
        let box = AgentInk.mark(id: "b", kind: .box, label: nil, on: element, size: size)
        XCTAssertEqual(box?.kind, .box)
        XCTAssertEqual(points(box), [CGPoint(x: 390, y: 192), CGPoint(x: 610, y: 308)])
        let ellipse = AgentInk.mark(id: "e", kind: .ellipse, label: nil, on: element, size: size)
        XCTAssertEqual(points(ellipse), points(box))
        XCTAssertEqual(AgentInk.mark(id: "h", kind: .highlight, label: nil, on: element, size: size)?.kind, .area)
    }

    /// An arrow comes from clear space beside the element and points at its side, never starting on it.
    func testAnArrowPointsInFromClearSpace() throws {
        let arrow = points(AgentInk.mark(id: "a", kind: .arrow, label: nil, on: element, size: size))
        let (tail, head) = (try XCTUnwrap(arrow.first), try XCTUnwrap(arrow.last))
        XCTAssertEqual(head, CGPoint(x: 608, y: 250), "at its right side, halfway down")
        XCTAssertEqual(tail, CGPoint(x: 750, y: 370), "150 out and 70 below it")
        // Hard against the right edge, it comes from the left instead, and stays on screen.
        let edge = points(AgentInk.mark(id: "a", kind: .arrow, label: nil, on: CGRect(x: 0.85, y: 0.4, width: 0.14, height: 0.1), size: size))
        XCTAssertEqual(edge.last, CGPoint(x: 842, y: 225))
        XCTAssertEqual(edge.first, CGPoint(x: 700, y: 320))
        // At the bottom, it comes from above rather than off the screen or out of the element.
        let low = points(AgentInk.mark(id: "a", kind: .arrow, label: nil, on: CGRect(x: 0.1, y: 0.85, width: 0.2, height: 0.12), size: size))
        let lowRect = CGRect(x: 100, y: 425, width: 200, height: 60)
        XCTAssertFalse(lowRect.insetBy(dx: -8, dy: -8).contains(try XCTUnwrap(low.first)))
        XCTAssertLessThanOrEqual(try XCTUnwrap(low.first).y, 460)
    }

    func testAPinSitsOnItsTopRightAndTextUnderIt() {
        let pin = AgentInk.mark(id: "p", kind: .pin, label: "this one", on: element, size: size)
        XCTAssertEqual(pin?.kind, .note)
        XCTAssertEqual(pin?.text, "this one")
        XCTAssertEqual(points(pin), [CGPoint(x: 600, y: 200)])
        XCTAssertEqual(points(AgentInk.mark(id: "t", kind: .text, label: "words", on: element, size: size)), [CGPoint(x: 400, y: 308)])
        // A stroke is its own points: never placed on an element.
        XCTAssertNil(AgentInk.mark(id: "s", kind: .stroke, label: nil, on: element, size: size))
        XCTAssertNil(AgentInk.mark(id: "b", kind: .box, label: nil, on: .zero, size: size), "an element with no size was not found")
    }

    // MARK: From the page to the screen

    func testAClientRectBecomesTheWebViewsPoints() {
        let client = CGRect(x: 100, y: 50, width: 40, height: 20)
        // A page at its own size: CSS pixels are points.
        XCTAssertEqual(AgentInk.viewRect(client: client, viewport: .init(width: 800), viewWidth: 800), client)
        // Zoomed to 150%: 800 points show 533⅓ CSS pixels.
        XCTAssertEqual(AgentInk.viewRect(client: client, viewport: .init(width: 800 / 1.5), viewWidth: 800), CGRect(x: 150, y: 75, width: 60, height: 30))
        // Pinched to 2x, the visual viewport 10 and 20 pixels into the layout one.
        XCTAssertEqual(AgentInk.viewRect(client: client, viewport: .init(left: 10, top: 20, scale: 2, width: 800), viewWidth: 800), CGRect(x: 180, y: 60, width: 80, height: 40))
    }

    /// AppKit's screen is y up from the main display's bottom; a canvas is y down from its display's top left.
    func testAScreenRectBecomesFractionsOfItsDisplay() {
        let display = CGRect(x: 1000, y: -200, width: 1000, height: 500)
        let onScreen = CGRect(x: 1400, y: 50, width: 200, height: 100)
        let unit = AgentInk.unit(onScreen, on: display)
        XCTAssertEqual(unit.minX, 0.4, accuracy: 1e-9)
        XCTAssertEqual(unit.minY, 0.3, accuracy: 1e-9)
        XCTAssertEqual(unit.width, 0.2, accuracy: 1e-9)
        XCTAssertEqual(unit.height, 0.2, accuracy: 1e-9)
    }

    // MARK: Drawing it on

    /// Agent ink draws on along its own line: an arrow from tail to head, an area across its middle, as wide as it is tall.
    func testItDrawsOnAlongItsOwnLine() throws {
        let arrow = CanvasMark(kind: .arrow, author: .agent, points: [CanvasPoint(x: 0.1, y: 0.2), CanvasPoint(x: 0.5, y: 0.2)])
        let spine = try XCTUnwrap(CanvasInk.spine(of: arrow, in: size))
        XCTAssertEqual(spine.path.boundingBox, CGRect(x: 100, y: 100, width: 400, height: 0))
        XCTAssertEqual(spine.path.currentPoint, CGPoint(x: 500, y: 100), "ends at the head")
        let area = CanvasMark(kind: .area, author: .agent, points: [CanvasPoint(x: 0.1, y: 0.1), CanvasPoint(x: 0.3, y: 0.2)])
        let across = try XCTUnwrap(CanvasInk.spine(of: area, in: size))
        XCTAssertEqual(across.path.boundingBox, CGRect(x: 100, y: 75, width: 200, height: 0))
        XCTAssertEqual(across.width, 54)
        XCTAssertNil(CanvasInk.spine(of: CanvasMark(kind: .note, author: .agent, points: [CanvasPoint(x: 0.5, y: 0.5)]), in: size), "a pin pops")
    }

    func testALabelSitsBesideItsMark() {
        let box = CanvasMark(kind: .box, author: .agent, points: [CanvasPoint(x: 0.1, y: 0.2), CanvasPoint(x: 0.3, y: 0.4)])
        XCTAssertEqual(CanvasInk.labelSpot(of: box, in: size), CGPoint(x: 312, y: 94))
        let arrow = CanvasMark(kind: .arrow, author: .agent, points: [CanvasPoint(x: 0.1, y: 0.2), CanvasPoint(x: 0.5, y: 0.4)])
        XCTAssertEqual(CanvasInk.labelSpot(of: arrow, in: size), CGPoint(x: 110, y: 110), "by its tail")
        XCTAssertNil(CanvasInk.labelSpot(of: CanvasMark(kind: .note, author: .agent, points: [CanvasPoint(x: 0.5, y: 0.5)]), in: size))
    }

    /// Its ellipse and area are drawn as the box is: the ellipse an outline with a wash, the area a filled wash.
    func testAnEllipseAndAnAreaHaveTheirShapes() {
        let ellipse = CanvasInk.shape(of: CanvasMark(kind: .ellipse, author: .agent, points: [CanvasPoint(x: 0.1, y: 0.2), CanvasPoint(x: 0.3, y: 0.4)]), in: size)
        XCTAssertTrue(ellipse.ink.contains(CGPoint(x: 200, y: 100)), "its top")
        XCTAssertFalse(ellipse.ink.contains(CGPoint(x: 200, y: 150)))
        XCTAssertFalse(ellipse.ink.contains(CGPoint(x: 101, y: 101)), "round, so not its bounding corner")
        XCTAssertTrue(ellipse.wash?.contains(CGPoint(x: 200, y: 150)) == true)
        let area = CanvasMark(kind: .area, author: .agent, points: [CanvasPoint(x: 0.1, y: 0.2), CanvasPoint(x: 0.3, y: 0.4)])
        XCTAssertTrue(CanvasInk.shape(of: area, in: size).ink.contains(CGPoint(x: 200, y: 150)))
        XCTAssertEqual(CanvasInk.fill(of: area).hex, CanvasInk.agent.hex)
        XCTAssertLessThan(CanvasInk.fill(of: area).alpha, 0.5)
        XCTAssertTrue(CanvasInk.multiplies(area))
    }
}
