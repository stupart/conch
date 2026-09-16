import SwiftUI
import XCTest
@testable import ConchDesign

/// The row-state and attention colours, measured rather than judged by eye.
///
/// These exist because the Mac app carried its own palette, and its own note records what
/// went wrong when these values were picked by eye: hover once read as MORE selected than
/// the selected row, and a "selected" step of 1.07:1 sat below the ~1.2:1 where a surface
/// step is perceptible at all. A design doc is not evidence either — workspace-v1 §7
/// proposed 3.5% / 6.5% fills and an unmeasured #E5533D, and both fail here.
final class RowStateTokenTests: XCTestCase {
    private let schemes: [ColorScheme] = [.light, .dark]

    /// Every surface a row or a mark can sit on.
    private var grounds: [ConchColorToken] { ConchColor.grounds }

    /// A translucent fill is not a colour until it sits on something: composite it first, the
    /// way the screen does, then measure.
    private func composited(_ token: ConchColorToken, over ground: ConchRGBA, _ scheme: ColorScheme) -> ConchRGBA {
        let fill = token.rgba(scheme)
        func mix(_ fore: Double, _ back: Double) -> UInt32 {
            UInt32(((fore * fill.alpha + back * (1 - fill.alpha)) * 255).rounded())
        }
        return ConchRGBA(
            mix(fill.red, ground.red) << 16 | mix(fill.green, ground.green) << 8 | mix(fill.blue, ground.blue)
        )
    }

    /// `attention` carries text — a question's header — so it is held to AA, not to the 3:1
    /// that would be enough for a mark alone.
    func testAttentionClearsAAOnEveryGround() {
        for scheme in schemes {
            for ground in grounds {
                let ratio = ConchColor.attention.rgba(scheme).contrast(on: ground.rgba(scheme))
                XCTAssertGreaterThanOrEqual(
                    ratio, 4.5,
                    "attention on \(ground.name) in \(scheme) is \(String(format: "%.2f", ratio)):1"
                )
            }
        }
    }

    /// The bug this guards: a hovered row reading as more selected than the selected one.
    func testASelectedRowOutranksAHoveredOne() {
        for scheme in schemes {
            for ground in grounds {
                let base = ground.rgba(scheme)
                let hover = composited(ConchColor.rowHover, over: base, scheme).contrast(on: base)
                let selected = composited(ConchColor.rowSelected, over: base, scheme).contrast(on: base)

                XCTAssertGreaterThan(
                    selected, hover + 0.1,
                    "\(ground.name) in \(scheme): selected \(String(format: "%.3f", selected)) "
                        + "vs hover \(String(format: "%.3f", hover))"
                )
                // Perceptible at all, per the palette note this replaces.
                XCTAssertGreaterThanOrEqual(selected, 1.25, "selected on \(ground.name) in \(scheme)")
                XCTAssertGreaterThanOrEqual(hover, 1.1, "hover on \(ground.name) in \(scheme)")
            }
        }
    }

    /// Both fills must step the SAME way off the ground — darker in light, lighter in dark.
    ///
    /// If they stepped opposite ways, selection and hover would be further from each other than
    /// selection is from the ground, and the list would read as three unrelated surfaces.
    func testHoverAndSelectionStepTheSameWayOffTheGround() {
        for scheme in schemes {
            for ground in grounds {
                let base = ground.rgba(scheme)
                let hover = composited(ConchColor.rowHover, over: base, scheme)
                let selected = composited(ConchColor.rowSelected, over: base, scheme)

                XCTAssertLessThan(
                    selected.contrast(on: hover), selected.contrast(on: base),
                    "\(ground.name) in \(scheme): the two fills step opposite ways off the ground"
                )
            }
        }
    }

    /// The gallery renders `all`; a token missing from it is a token no one ever looks at.
    func testTheNewTokensAreInTheGallery() {
        let names = Set(ConchColor.all.map(\.name))
        for token in [ConchColor.rowHover, ConchColor.rowSelected, ConchColor.attention] {
            XCTAssertTrue(names.contains(token.name), "\(token.name) is missing from ConchColor.all")
        }
    }
}
