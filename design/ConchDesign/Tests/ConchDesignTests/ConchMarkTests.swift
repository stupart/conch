#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The menu bar mark, measured in the pixels AppKit draws rather than judged by eye: a template at both scales, Talk centred
/// to the pixel, the shell in the same place in every state, and each state its own picture.
final class ConchMarkTests: XCTestCase {
    private let grids = [ConchMark.Grid.oneX, ConchMark.Grid.twoX]

    /// Each pixel's coverage, 0 to 255, top row first.
    private func coverage(_ state: VoiceState, _ grid: ConchMark.Grid) -> [[Int]] {
        let rep = ConchMark.bitmap(for: state, on: grid)
        let data = rep.bitmapData!
        return (0..<rep.pixelsHigh).map { y in
            (0..<rep.pixelsWide).map { x in Int(data[y * rep.bytesPerRow + x * rep.samplesPerPixel + 3]) }
        }
    }

    /// Clear pixels from the left, right, top and bottom edges to the ink.
    private func margins(_ pixels: [[Int]]) -> (left: Int, right: Int, top: Int, bottom: Int) {
        let rows = pixels.indices.filter { pixels[$0].contains { $0 > 0 } }
        let columns = pixels[0].indices.filter { x in pixels.contains { $0[x] > 0 } }
        return (columns.first!, pixels[0].count - 1 - columns.last!, rows.first!, pixels.count - 1 - rows.last!)
    }

    func testEveryStateIsAnEighteenPointTemplateWithItsOwnOneXAndTwoX() {
        for state in VoiceState.allCases {
            let image = ConchMark.statusImage(for: state)
            XCTAssertTrue(image.isTemplate, "\(state) must be a template, so macOS inks it for the bar and the open menu")
            XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
            let widths = image.representations.compactMap { $0 as? NSBitmapImageRep }.map(\.pixelsWide).sorted()
            XCTAssertEqual(widths, [18, 36], "\(state)")
        }
    }

    /// Measured, not eyeballed: Talk's ink has the same clear space left and right, and top and bottom, at both scales,
    /// so the status button's own centring puts it on the bar's centre line.
    func testTalkIsCentredToThePixelAtBothScales() {
        let one = margins(coverage(.talk, .oneX)), two = margins(coverage(.talk, .twoX))
        for margin in [one, two] {
            XCTAssertEqual(margin.left, margin.right)
            XCTAssertEqual(margin.top, margin.bottom)
        }
    }

    /// Every state is the circle, looking, plus what it adds: wherever Talk has ink the state has it too, so the shell and
    /// the eyes never move and a change of state is never a jump. (Within 2 of 255: the boolean union of one more part
    /// tessellates an edge a hair differently.)
    func testTheShellAndTheEyesStayPutInEveryState() {
        for grid in grids {
            let talk = coverage(.talk, grid)
            for state in [VoiceState.ready, .speaking, .listening] {
                let pixels = coverage(state, grid)
                for (y, row) in talk.enumerated() {
                    for (x, ink) in row.enumerated() {
                        XCTAssertGreaterThanOrEqual(pixels[y][x], ink - 2, "\(state) \(Int(grid.side)) px at \(x),\(y)")
                    }
                }
            }
        }
    }

    /// Quiet is Talk dimmed, the way macOS dims a status item that is off: the same pixels at `quietOpacity`.
    func testQuietIsTalkDimmed() {
        for grid in grids {
            let talk = coverage(.talk, grid), quiet = coverage(.quiet, grid)
            for (y, row) in talk.enumerated() {
                for (x, ink) in row.enumerated() {
                    XCTAssertEqual(Double(quiet[y][x]), Double(ink) * ConchMark.quietOpacity, accuracy: 1.5, "\(Int(grid.side)) px at \(x),\(y)")
                }
            }
        }
    }

    /// Talk is its own mirror image, pixel for pixel, at both scales: an eye a pixel lower or a stalk a shade greyer on one
    /// side is the first thing a mark this small shows.
    func testTalkIsMirrorSymmetric() {
        for grid in grids {
            let pixels = coverage(.talk, grid)
            for row in pixels {
                for x in row.indices {
                    XCTAssertLessThanOrEqual(abs(row[x] - row[row.count - 1 - x]), 2, "\(Int(grid.side)) px, column \(x)")
                }
            }
        }
    }

    /// Whatever a state adds beside the shell keeps a clear pixel between itself and the shell and the crab, at both
    /// scales: at 1x a 1 px arc's ends used to smear into the ring (117, 88, 77 across three columns). Counted from a
    /// quarter coverage, where a pixel starts to show; the faint edge pixels of two curves may meet below that.
    func testWhatAStateAddsStaysClearOfTheMark() {
        for grid in grids {
            let talk = coverage(.talk, grid)
            for state in [VoiceState.ready, .speaking] {
                let pixels = coverage(state, grid)
                for (y, row) in pixels.enumerated() {
                    for (x, ink) in row.enumerated() where ink >= 64 && talk[y][x] == 0 {
                        for dy in -1...1 {
                            for dx in -1...1 {
                                let (nx, ny) = (x + dx, y + dy)
                                guard talk.indices.contains(ny), talk[ny].indices.contains(nx) else { continue }
                                XCTAssertLessThan(talk[ny][nx], 64, "\(state) \(Int(grid.side)) px: \(x),\(y) touches the mark at \(nx),\(ny)")
                            }
                        }
                    }
                }
            }
        }
    }

    /// No two states draw the same picture: at least a few pixels apart at 1x and more at 2x, by a quarter of full
    /// coverage or more, so a state can't be told from another only by a faint edge. (Quiet is Talk's pixels at
    /// `quietOpacity`, 89 apart where Talk is solid.)
    func testEachStateIsItsOwnPicture() {
        for grid in grids {
            let pictures = VoiceState.allCases.map { ($0, coverage($0, grid)) }
            for (index, (state, pixels)) in pictures.enumerated() {
                for (other, otherPixels) in pictures[(index + 1)...] {
                    let apart = zip(pixels.joined(), otherPixels.joined()).filter { abs($0 - $1) >= 64 }.count
                    XCTAssertGreaterThanOrEqual(apart, grid.side == 18 ? 4 : 16, "\(state) and \(other) at \(Int(grid.side)) px")
                }
            }
        }
    }
}
#endif
