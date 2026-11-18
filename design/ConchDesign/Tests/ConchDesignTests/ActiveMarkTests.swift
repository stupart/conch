import SwiftUI
import XCTest
@testable import ConchDesign

/// Working's blue and its breath, measured rather than judged by eye: a status mark needs 3:1 on every ground it sits on.
final class ActiveMarkTests: XCTestCase {
    private let schemes: [ColorScheme] = [.light, .dark]

    /// A mark, so 3:1, on every ground the sidebar, the stage and the fog give it: light 3.23 at
    /// worst (the ground), dark 5.08 at worst (raised).
    func testWorkingClearsThreeToOneOnEveryGround() {
        for scheme in schemes {
            for ground in ConchColor.grounds {
                let ratio = ConchColor.active.rgba(scheme).contrast(on: ground.rgba(scheme))
                XCTAssertGreaterThanOrEqual(
                    ratio, 3,
                    "active on \(ground.name) in \(scheme) is \(String(format: "%.2f", ratio)):1"
                )
            }
        }
    }

    /// Reduce Motion gets the still dot: no halo at any moment of any breath.
    func testTheBreathIsStillUnderReduceMotion() {
        for step in 0...400 {
            let time = Double(step) * 0.037
            XCTAssertEqual(ActiveHalo.opacity(at: time, reduceMotion: true), 0, "halo at \(time) s under Reduce Motion")
        }
    }

    /// Otherwise it rises from nothing to its peak and back, once per period, and never past the
    /// peak: a breath, not a flash.
    func testTheBreathRisesToItsPeakAndBack() {
        let period = ConchMotion.activeBreathPeriod
        let samples = (0...400).map { ActiveHalo.opacity(at: Double($0) * period / 400, reduceMotion: false) }
        XCTAssertEqual(samples.first ?? -1, 0, accuracy: 1e-9)
        XCTAssertEqual(samples.last ?? -1, 0, accuracy: 1e-9)
        XCTAssertEqual(samples.max() ?? 0, ActiveHalo.peak, accuracy: 1e-6)
        XCTAssertEqual(ActiveHalo.opacity(at: period / 2, reduceMotion: false), ActiveHalo.peak, accuracy: 1e-9)
        XCTAssertTrue(samples.allSatisfy { $0 >= 0 && $0 <= ActiveHalo.peak + 1e-9 })
    }
}
