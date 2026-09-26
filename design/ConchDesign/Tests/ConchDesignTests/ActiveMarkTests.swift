import SwiftUI
import XCTest
@testable import ConchDesign

/// Working's blue and its breath, measured rather than judged by eye.
///
/// Tyler asked for working to stop being grey: "some other color that feels more like 'active' and
/// 'positive'". The palette already carries two rules a blue could break: a status mark needs 3:1
/// on every ground it sits on, and full-strength cyan means only that your microphone is open.
final class ActiveMarkTests: XCTestCase {
    private let schemes: [ColorScheme] = [.light, .dark]

    /// The Mac palette's literals for the two colours the blue must never be taken for
    /// (mac-app/conch-mac/Palette.swift: `brandCyan`, `statusWaiting`).
    private let micOpen = ConchRGBA(0x58C9D4)
    private let waiting = ConchRGBA(0x279B4C)

    private func composited(_ token: ConchColorToken, over ground: ConchRGBA, _ scheme: ColorScheme) -> ConchRGBA {
        let fill = token.rgba(scheme)
        func mix(_ fore: Double, _ back: Double) -> UInt32 {
            UInt32(((fore * fill.alpha + back * (1 - fill.alpha)) * 255).rounded())
        }
        return ConchRGBA(mix(fill.red, ground.red) << 16 | mix(fill.green, ground.green) << 8 | mix(fill.blue, ground.blue))
    }

    private func hue(_ colour: ConchRGBA) -> Double {
        let r = colour.red, g = colour.green, b = colour.blue
        let top = max(r, g, b), spread = top - min(r, g, b)
        guard spread > 0 else { return 0 }
        let sector: Double
        switch top {
        case r: sector = ((g - b) / spread).truncatingRemainder(dividingBy: 6)
        case g: sector = (b - r) / spread + 2
        default: sector = (r - g) / spread + 4
        }
        return (sector * 60 + 360).truncatingRemainder(dividingBy: 360)
    }

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

    /// The conversation panel's switcher draws working's ring on its own glass, laid over the fog.
    /// That grey is where the darker #0A84FF failed in dark, at 2.32.
    func testWorkingClearsThreeToOneOnTheSwitchersGlass() {
        for scheme in schemes {
            let glass = composited(ConchColor.overlayGlassStrong, over: ConchColor.fog.rgba(scheme), scheme)
            let ratio = ConchColor.active.rgba(scheme).contrast(on: glass)
            XCTAssertGreaterThanOrEqual(ratio, 3, "active on the switcher in \(scheme) is \(String(format: "%.2f", ratio)):1")
        }
        XCTAssertEqual(FogSession.markColor(.working).name, ConchColor.active.name)
        XCTAssertEqual(FogSession.markColor(.ready).name, ConchColor.ready.name)
    }

    /// Blue, apart from the mic's cyan and waiting's green: 25 degrees of hue from the cyan at the
    /// nearest, and far more from the green, in both schemes.
    func testWorkingIsItsOwnHue() {
        for scheme in schemes {
            let blue = hue(ConchColor.active.rgba(scheme))
            XCTAssertGreaterThanOrEqual(blue - hue(micOpen), 20, "active vs the mic's cyan in \(scheme)")
            XCTAssertGreaterThanOrEqual(blue - hue(waiting), 60, "active vs waiting's green in \(scheme)")
            // Blue, not violet: short of the overlay's iris glow.
            XCTAssertLessThan(blue, hue(ConchColor.idleGlow.rgba(scheme)) - 10, "active in \(scheme)")
        }
    }

    /// The gallery renders `all`; a token missing from it is a token no one ever looks at.
    func testWorkingIsInTheGallery() {
        XCTAssertTrue(ConchColor.all.contains { $0.name == ConchColor.active.name })
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
        // Slower than the listening mic's breath, and quiet at its fullest.
        XCTAssertGreaterThan(period, ConchMotion.breathPeriod)
        XCTAssertLessThanOrEqual(ActiveHalo.peak, 0.25)
    }
}
