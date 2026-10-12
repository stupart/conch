import XCTest
@testable import ConchDesign

/// The lagoon switch's motion (LagoonSwitchMotion.swift) is turned.js's, number for number: its frames, its springs, where
/// a click mid-animation picks up, and the reduced-motion crossfade.
final class LagoonSwitchMotionTests: XCTestCase {
    typealias Motion = LagoonSwitchMotion

    /// turned.js's `frame(dir, t)` itself, sampled (the brand repo's generated/oct/lagoon-toggle/v2, 2026-10-10) in its own
    /// field order: x lin cx rx ry water collar collarX rim crab lid wet dry face turn shade roll lean sq.
    static let golden: [(Motion.Direction, Double, [Double])] = [
        (.on, 0, [0, -1, 11.1, 9.5, 8.5, 1, 0, -1.98, 0, 32, 0, 0, 44, 0, 1, 1, 0, 0, 0]),
        (.on, 17.5, [0.050932, 0.925, 11.150932, 9.5, 8.5, 1, 0, -1.929068, 0, 32, 0, 0, 44, 0, 1, 1, 0, -0.161187, 0]),
        (.on, 72, [1.031651, 6.92, 12.131651, 9.5, 8.5, 1, 0.450074, -0.948349, 0.002646, 32, 0, 0, 44, 0, 1, 1, 0, -1.677899, 0]),
        (.on, 140, [4.792443, 14.4, 15.892443, 7.951336, 8.5, 1, 1, 2.812443, 0.104, 32, 0, 0, 44, 0, 0.836983, 0.970657, -4.925063, -3.452364, 0]),
        (.on, 181, [8.278999, 18.91, 19.378999, 2.658533, 8.5, 1, 1, 6.298999, 0.219157, 32, 0, 0, 44, 0, 0.279846, 0.870372, -8.640405, -2.807736, 0.000286]),
        (.on, 222, [11.563331, 22.663331, 22.663331, 4.444106, 8.5, 1, 1, 9.583331, 0.359215, 32, 0, 0, 44, 1, 0.467801, 0.904204, -7.954506, -0.109892, 0.022037]),
        (.on, 275, [14.635226, 25.735226, 25.735226, 9.148768, 8.5, 1, 1, 12.655226, 0.556145, 32, 0, 0, 44, 1, 0.963028, 0.993345, -2.424606, 2.751643, 0.044641]),
        (.on, 333, [16.655979, 27.755979, 27.755979, 9.5, 8.5, 1, 1, 14.675979, 0.761593, 32, 0, 0, 44, 1, 1, 1, -0, 2.502547, 0.024418]),
        (.on, 400, [17.82, 28.92, 28.92, 9.5, 8.5, 1, 0.917566, 15.84, 0.93925, 32, 0, 0, 44, 1, 1, 1, -0, 1.030629, 0.014336]),
        (.on, 450, [17.82, 34.853611, 28.92, 7.25242, 6.489007, 1, 0.544067, 15.84, 0.998156, 32, 0, 0, 44, 1, 1, 1, -0, 0.897638, 0.014288]),
        (.on, 500, [17.82, 48.371078, 28.92, 2.132168, 1.907729, 1, 0.140037, 15.84, 1, 18.540282, 0, 0, 44, 1, 1, 1, -0, 0.077169, -0.006321]),
        (.on, 560, [17.82, 53.379712, 28.92, 0.234957, 0.210225, 1, 0, 15.84, 1, 3.025489, 0, 0, 44, 1, 1, 1, -0, -0.190457, 0.000428]),
        (.on, 650, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, -1.689577, 0, 0, 44, 1, 1, 1, -0, 0.014515, -0.000231]),
        (.on, 800, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 0, 0, 44, 1, 1, 1, -0, -0.004526, 0.000002]),
        (.on, 830, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 0.567994, 0, 44, 1, 1, 1, -0, -0.004683, -0.000018]),
        (.on, 855, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 1, 0, 44, 1, 1, 1, -0, -0.003081, -0.000012]),
        (.on, 900, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 1, 0, 44, 1, 1, 1, -0, -0.000156, 0.000003]),
        (.on, 1100, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 0, 0, 44, 1, 1, 1, -0, -0.000113, 0]),
        (.on, 1500, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 0, 0, 44, 1, 1, 1, -0, 0, -0]),
        (.off, 0, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0, 0, 1, 44, 1, 1, 1, 0, 0, 0]),
        (.off, 17.5, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 0.669351, 0, 1, 44, 1, 1, 1, 0, 0, 0]),
        (.off, 72, [17.82, 54, 28.92, 0, 0, 1, 0, 15.84, 1, 8.538552, 0, 1, 44, 1, 1, 1, 0, 0, 0]),
        (.off, 140, [17.664286, 47.457408, 28.764286, 2.462963, 2.203704, 1, 0, 15.684286, 0.983969, 28.262864, 0, 1, 44, 1, 1, 1, 0, 0.40947, 0]),
        (.off, 181, [16.820223, 30.916428, 27.920223, 8.384277, 7.523468, 1, 0.293166, 14.840223, 0.916666, 32, 0, 1, 44, 1, 0.99711, 0.99948, 0.683801, 1.64523, 0]),
        (.off, 222, [14.970045, 26.070045, 26.070045, 8.245795, 8.5, 0.997883, 0.731571, 12.990045, 0.808704, 32, 0, 1, 44, 1, 0.867978, 0.976236, 4.469417, 2.903182, 0]),
        (.off, 275, [10.937977, 22.037977, 22.037977, 1.258551, 8.5, 0.943491, 0.8, 8.957977, 0.62991, 32, 0, 1, 44, 1, 0.132479, 0.843846, 8.920672, 3.340122, 0]),
        (.off, 333, [6.185802, 17.285802, 17.285802, 7.526081, 8.5, 0.819587, 0.8, 4.205802, 0.41413, 32, 0, 1, 44, 0, 0.792219, 0.962599, 5.492131, 0.035263, 0.022854]),
        (.off, 400, [2.54671, 13.64671, 13.64671, 9.49986, 8.5, 0.629975, 0.8, 0.56671, 0.185281, 32, 0, 1, 44, 0, 0.999985, 0.999997, 0.048848, -2.976987, 0.041132]),
        (.off, 450, [0.992518, 12.092518, 12.092518, 9.5, 8.5, 0.4816, 0.769387, -0.987482, 0.06075, 32, 0, 1, 43.837037, 0, 1, 1, 0, -2.338477, 0.022264]),
        (.off, 500, [0.113125, 10.93077, 11.213125, 9.5, 8.5, 0.348225, 0.504783, -1.866875, 0.001844, 32, 0, 1, 42.885048, 0, 1, 1, 0, -1.196904, 0.014863]),
        (.off, 560, [0, 7.447892, 11.1, 9.5, 8.5, 0.234375, 0.112029, -1.98, 0, 32, 0, 1, 40.746776, 0, 1, 1, 0, -0.897638, 0.014288]),
        (.off, 650, [0, 0.209353, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 1, 35.872702, 0, 1, 1, 0, 0.186117, -0.002043]),
        (.off, 800, [0, -2, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 0.98805, 24.786283, 0, 1, 1, 0, -0.0309, -0.000225]),
        (.off, 830, [0, -2, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 0.964637, 22.324554, 0, 1, 1, 0, -0.020527, 0.000002]),
        (.off, 855, [0, -2, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 0.93676, 20.249537, 0, 1, 1, 0, -0.009084, 0.000076]),
        (.off, 900, [0, -2, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 0.870061, 16.503704, 0, 1, 1, 0, 0.003534, 0.000018]),
        (.off, 1100, [0, -2, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 0.427646, 1.502332, 0, 1, 1, 0, -0.00046, -0.000001]),
        (.off, 1500, [0, -2, 11.1, 9.5, 8.5, 0.2, 0, -1.98, 0, 32, 0, 0, -6, 0, 1, 1, 0, 0.000002, 0]),
    ]

    func testEveryFieldMatchesTurnedJS() {
        for (direction, t, want) in Self.golden {
            let f = Motion.frame(direction, at: t)
            let got = [f.x, f.lin, f.cx, f.rx, f.ry, f.water, f.collar, f.collarX, f.rim, f.crab, f.lid, f.wet, f.dry,
                       f.face ? 1 : 0, f.turn, f.shade, f.roll, f.lean, f.squash]
            let names = ["x", "lin", "cx", "rx", "ry", "water", "collar", "collarX", "rim", "crab", "lid", "wet", "dry",
                         "face", "turn", "shade", "roll", "lean", "sq"]
            for (index, name) in names.enumerated() {
                XCTAssertEqual(got[index], want[index], accuracy: 1e-4, "\(direction) t=\(t) \(name)")
            }
        }
    }

    func testTheTwoFinishedStates() {
        let on = Motion.frame(.on, at: Motion.end)
        XCTAssertEqual(on.x, Motion.travel)
        XCTAssertTrue(on.face)
        XCTAssertEqual(on.turn, 1)
        XCTAssertEqual(on.crab, 0, accuracy: 1e-9, "the OG is up")
        XCTAssertEqual(on.lid, 0, "eyes open")
        XCTAssertEqual(on.rim, 1)
        XCTAssertEqual(on.lin, 54, accuracy: 1e-9, "the water fills the track")
        XCTAssertEqual(on.rx, 0)
        let off = Motion.frame(.off, at: Motion.end)
        XCTAssertEqual(off.x, 0)
        XCTAssertFalse(off.face)
        XCTAssertEqual(off.crab, Motion.crabHidden)
        XCTAssertEqual(off.rim, 0)
        XCTAssertEqual(off.wet, 0, "dry")
        XCTAssertEqual(off.collar, 0)
        XCTAssertLessThan(off.lin, 0, "no water")
    }

    func testTheSlideTheTurnAndTheOG() {
        // 17.82 pt over 400 ms, and still there after.
        XCTAssertEqual(Motion.frame(.on, at: 400).x, 17.82, accuracy: 1e-9)
        XCTAssertLessThan(Motion.frame(.on, at: 399).x, 17.82)
        // Edge-on at the swap: never thinner than 0.06, and the spiral turns to the opening there.
        let swap = stride(from: 0.0, through: 400, by: 1).first { Motion.frame(.on, at: $0).face }!
        XCTAssertEqual(swap, 196, accuracy: 2)
        XCTAssertEqual(Motion.frame(.on, at: swap).turn, 0.06, accuracy: 0.03)
        XCTAssertGreaterThanOrEqual(stride(from: 0.0, through: 1500, by: 1).map { Motion.frame(.on, at: $0).turn }.min()!, 0.06)
        // The OG waits 70 ms after landing, then rises.
        XCTAssertEqual(Motion.frame(.on, at: 469).crab, Motion.crabHidden)
        XCTAssertLessThan(Motion.frame(.on, at: 520).crab, Motion.crabHidden)
        // One blink at 0.8 s: shut by 855 ms, open again by 975.
        XCTAssertEqual(Motion.frame(.on, at: 855).lid, 1)
        XCTAssertEqual(Motion.frame(.on, at: 975).lid, 0)
        // Off: the OG ducks before the shell moves.
        XCTAssertEqual(Motion.frame(.off, at: 110).x, Motion.travel)
        XCTAssertGreaterThan(Motion.frame(.off, at: 100).crab, 15)
    }

    func testTheSpringsAreNormalised() {
        for springs in [Motion.springs.on, Motion.springs.off] {
            XCTAssertEqual(Double(springs.lean.map { abs($0) }.max()!), 3.5, accuracy: 1e-5)
            XCTAssertEqual(Double(springs.squash.max()!), 0.045, accuracy: 1e-6)
            XCTAssertGreaterThanOrEqual(Double(springs.squash.min()!), -0.02)
            XCTAssertEqual(springs.lean.count, 1501)
        }
    }

    /// turned.js's flip, sampled: (was, t, now) → where the new timeline picks up.
    func testAClickMidwayPicksUpWhereTheShellIs() {
        let cases: [(Motion.Direction, Double, Motion.Direction, Double)] = [
            (.on, 100, .off, 410), (.on, 200, .off, 288), (.on, 300, .off, 210), (.on, 450, .off, 110), (.on, 1500, .off, 0),
            (.off, 50, .on, 400), (.off, 200, .on, 314), (.off, 300, .on, 186), (.off, 400, .on, 106), (.off, 1000, .on, 0),
            (.on, 250.5, .off, 246),
        ]
        for (was, t, now, want) in cases {
            XCTAssertEqual(Motion.resume(from: was, at: t, to: now), want, "\(was) at \(t) → \(now)")
        }
    }

    func testThePlayhead() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var head = LagoonSwitchPlayhead(isOn: false)
        XCTAssertFalse(head.isMoving(at: t0), "at rest where it was left")
        XCTAssertEqual(head.pose(at: t0, reduceMotion: false), .motion(.off, Motion.end))
        head.flip(toOn: true, at: t0, reduceMotion: false)
        guard case let .motion(started, at200) = head.pose(at: t0.addingTimeInterval(0.2), reduceMotion: false) else { return XCTFail() }
        XCTAssertEqual(started, .on)
        XCTAssertEqual(at200, 200, accuracy: 1e-3)
        // Clicked again 200 ms in: back from where the shell is, not from the start.
        head.flip(toOn: false, at: t0.addingTimeInterval(0.2), reduceMotion: false)
        let x = Motion.frame(.on, at: 200).x
        guard case let .motion(direction, t) = head.pose(at: t0.addingTimeInterval(0.2), reduceMotion: false) else { return XCTFail() }
        XCTAssertEqual(direction, .off)
        XCTAssertEqual(t, 288, accuracy: 1e-3)
        XCTAssertEqual(Motion.frame(.off, at: t).x, x, accuracy: 0.1, "within turned.js's 2 ms search step")
        XCTAssertTrue(head.isMoving(at: t0.addingTimeInterval(1)))
        XCTAssertFalse(head.isMoving(at: t0.addingTimeInterval(2)))
    }

    func testReducedMotionCrossfades() {
        let t0 = Date(timeIntervalSince1970: 1_000)
        var head = LagoonSwitchPlayhead(isOn: false)
        XCTAssertEqual(head.pose(at: t0, reduceMotion: true), .crossfade(on: 0))
        head.flip(toOn: true, at: t0, reduceMotion: true)
        XCTAssertEqual(head.length, 200)
        XCTAssertEqual(head.pose(at: t0, reduceMotion: true), .crossfade(on: 0))
        XCTAssertEqual(head.pose(at: t0.addingTimeInterval(0.2), reduceMotion: true), .crossfade(on: 1))
        XCTAssertFalse(head.isMoving(at: t0.addingTimeInterval(0.2)))
        // Back mid-fade: from what showed.
        head.flip(toOn: false, at: t0.addingTimeInterval(0.1), reduceMotion: true)
        guard case let .crossfade(on) = head.pose(at: t0.addingTimeInterval(0.1), reduceMotion: true) else { return XCTFail() }
        XCTAssertEqual(on, Motion.crossfadeOn(.on, at: 100), accuracy: 0.02)
        // A change made as a crossfade, drawn with motion: its finished state.
        XCTAssertEqual(head.pose(at: t0.addingTimeInterval(0.1), reduceMotion: false), .motion(.off, Motion.end))
    }
}
