import Foundation

/// The lagoon switch's motion, "turned" (2026-10-10): the brand repo's
/// `generated/oct/lagoon-toggle/v2/turned.js` (on `v2.js`), ported number for number. Off shows the shell's spiral side.
/// On, the shell slides right, turns to face you mid-slide (squeezed edge-on, the spiral swapped for the opening at the
/// thinnest moment) while Tide's water follows it in, lands, and the OG comes up out of the opening and blinks. Off, the OG
/// ducks first, the shell slides back and turns back, the water drains, and the darker wet grey dries.
///
/// One timeline per direction drives every layer, so the water, the foam, the shell and the eyes stay in step: the whole
/// switch is a pure function of (direction, elapsed ms), `frame(_:at:)`, which `LagoonSwitchArtwork` draws. Lengths are
/// in points at real size (40 × 22), which is turned.js's `--u` of 1px.
public enum LagoonSwitchMotion {
    public enum Direction: String, Sendable, Equatable, CaseIterable {
        case on
        case off
    }

    // MARK: Geometry (v2.css, pt)

    public static let width = 40.0
    public static let height = 22.0
    /// How far the shell slides (`TRAVEL`).
    public static let travel = 17.82
    /// The shell's box at rest, off: `.knob{left:.4; top:1.5; width:21.41; height:19}`.
    public static let knobLeft = 0.4
    public static let knobTop = 1.5
    public static let knobWidth = 21.41
    public static let knobHeight = 19.0
    /// The OG's hidden offset, in % of the knob's height (`D`): he lives below the lower rim.
    public static let crabHidden = 32.0
    /// The lids' sweep, % of the knob's height (`EYE_TOP`, `EYE_BOT`).
    public static let eyeTop = 20.5
    public static let eyeBottom = 44.0
    /// The shell's centre in the knob (`KC`), and the water's ellipse round it (`RX`, `RY`).
    static let knobCentre = 10.7
    static let waterRadiusX = 9.5
    static let waterRadiusY = 8.5
    /// The foam collar's width (`.foam{width:13.08}`), which also sets it just behind the shell's centre.
    public static let collarWidth = 13.08
    /// The inside of the track that the water, the wet sand and the foam are clipped to:
    /// `.in{clip-path:inset(1.95 1.85 round 9.05)}`.
    public static let insetY = 1.95
    public static let insetX = 1.85
    public static let insetRadius = 9.05
    /// `.hole`'s clip: the opening's lower rim, as % of the knob's box. The OG is drawn only above it.
    public static let rimPolygon: [(x: Double, y: Double)] = [
        (0, 0), (100, 0), (100, 40.6), (93.8, 44.4), (87.5, 47.3), (81.2, 49.4), (75, 50.6), (68.8, 51.1), (62.5, 50.7),
        (56.2, 49.5), (50, 47.4), (43.8, 44.6), (37.5, 40.9), (31.2, 36.4), (25, 31), (18.8, 24.9), (12.5, 17.9),
        (6.2, 10.1), (0, 1.5),
    ]
    /// Transform origins, as fractions of the knob's box: the slide's lean (`.knob`), the squash (`.bob`), the turn (`.turn`).
    public static let leanOrigin = (x: 0.5, y: 0.94)
    public static let squashOrigin = (x: 0.5, y: 0.96)
    public static let turnOrigin = (x: 0.5, y: 0.60)

    // MARK: Timeline (ms)

    /// The slide (`SL`): 400 ms, cubic-bezier(.45, 0, .4, .86).
    public static let slide = 400.0
    /// The OG comes up 70 ms after the shell lands (`ON_EYES`), and blinks 330 ms after that (`ON_BLINK`).
    public static let eyesUp = slide + 70
    public static let blink = eyesUp + 330
    /// Off: the eyes duck first, then the shell starts back (`OFF_K0`).
    public static let offStart = 110.0
    /// Both timelines end here (`END`): the wet grey has dried.
    public static let end = 1500.0
    /// Reduced motion: the two finished states crossfade (`.rm>div{transition:opacity 200ms ease}`).
    public static let crossfade = 200.0

    /// What the switch shows: a moment of the motion, or, with Reduce motion, the two finished states crossfading (how
    /// much of "on" shows).
    public enum Pose: Equatable, Sendable {
        case motion(Direction, Double)
        case crossfade(on: Double)
    }

    /// Everything the switch draws at one moment (turned.js `frame()`, field for field).
    public struct Frame: Equatable, Sendable {
        /// The shell's travel, pt.
        public var x = 0.0
        /// The water: kept left of `lin` and outside the ellipse (`cx`, the track's middle; `rx` × `ry`) round the shell.
        public var lin = 0.0
        public var cx = 0.0
        public var rx = 0.0
        public var ry = 0.0
        public var water = 0.0
        /// The foam collar riding the water's edge: its opacity and its left edge, pt.
        public var collar = 0.0
        public var collarX = 0.0
        /// The cream rim over the grey one.
        public var rim = 0.0
        /// The OG's offset below the rim, % of the knob's height (0 = up, `crabHidden` = down).
        public var crab = 0.0
        /// The blink: 0 open, 1 shut.
        public var lid = 0.0
        /// The wet grey's opacity, and where it has dried to from the right, pt.
        public var wet = 0.0
        public var dry = 0.0
        /// The shell faces you (the opening, `knob-closed-a`) rather than its spiral side (`knob-closed-c`).
        public var face = false
        /// The turn's horizontal squeeze (edge-on at the swap), its darkening, and the roll that goes with it (deg).
        public var turn = 1.0
        public var shade = 1.0
        public var roll = 0.0
        /// The lean against the slide's acceleration (deg), and the squash on landing.
        public var lean = 0.0
        public var squash = 0.0
    }

    /// The moment `t` (ms, clamped to the timeline) of one direction.
    public static func frame(_ direction: Direction, at t: Double) -> Frame {
        let i = Int(clamp(t, 0, end).rounded())
        var f = Frame()
        switch direction {
        case .on:
            f.x = xOn(t)
            let kc = knobLeft + f.x + knobCentre, s = fill((t - slide) / 200)   // after it lands, the water floods round the shell
            f.lin = min(-1 + 0.11 * t, kc) + (54 - kc) * s
            f.cx = kc
            f.rx = waterRadiusX * (1 - s)
            f.ry = waterRadiusY * (1 - s)
            f.water = 1
            f.collar = smooth((t - 30) / 90) * (1 - smooth((t - slide + 30) / 170))
            f.collarX = kc - collarWidth
            f.rim = smooth((t - 60) / slide)
            f.crab = t < eyesUp ? crabHidden : crabHidden * (1 - outBack((t - eyesUp) / 260))
            let b = t - blink                                                   // one blink: close 55 ms, hold 45, open 75
            f.lid = b < 0 ? 0 : b < 55 ? smooth(b / 55) : b < 100 ? 1 : 1 - smooth((b - 100) / 75)
            f.wet = 0
            f.dry = 44
        case .off:
            f.x = xOff(t)
            let kc = knobLeft + f.x + knobCentre, g = smooth((t - offStart) / 90), e = smooth((t - offStart - slide + 30) / 230)
            // the shell backs into the water with a bow wave at its back, then what is left drains out to the left
            f.lin = (54 + (kc - 54) * g) * (1 - e) + (-2) * e
            f.cx = kc
            f.rx = waterRadiusX * g
            f.ry = waterRadiusY * g
            f.water = 1 - 0.8 * smooth((t - offStart - 100) / slide)              // and thins as it goes
            f.collar = 0.8 * smooth((t - offStart - 30) / 100) * (1 - smooth((t - offStart - slide + 80) / 170))
            f.collarX = kc - collarWidth
            f.rim = 1 - smooth((t - offStart) / slide)
            f.crab = crabHidden * pow(inCubic(t / 150), 0.6)                      // the eyes duck first
            f.lid = 0
            f.wet = 1 - smooth((t - 760) / 620)                                   // wet grey, drying
            f.dry = 44 - 50 * smooth((t - 420) / 900)                             // ... from the right, where the water left first
        }
        let q = direction == .on
            ? clamp((t - 0.18 * slide) / (0.62 * slide))
            : 1 - clamp((t - offStart - 0.12 * slide) / (0.62 * slide))
        let e = smooth(q)                                                         // 0 = spiral side, 1 = facing you
        f.face = e >= 0.5
        f.turn = max(0.06, abs(cos(Double.pi * e)))                               // edge-on at the swap
        f.shade = 0.82 + 0.18 * f.turn                                            // a touch darker as it turns edge-on
        f.roll = sin(Double.pi * e) * (direction == .on ? -9 : 9)                 // and rolls a little with the turn
        f.rx *= f.turn                                                            // the water hugs the shell's back as it narrows
        let spring = direction == .on ? springs.on : springs.off
        f.lean = Double(spring.lean[i])
        f.squash = Double(spring.squash[i])
        return f
    }

    /// Clicked mid-animation: where on the new direction's timeline to pick up, so the shell goes back from wherever it
    /// is (turned.js `flip`). The nearest moment of the new slide whose shell sits where this one is, searched every 2 ms;
    /// from the start when the last one had finished, or goes the same way.
    public static func resume(from was: Direction, at t: Double, to now: Direction) -> Double {
        guard t < end, was != now else { return 0 }
        let x = frame(was, at: t).x
        let lo = now == .off ? offStart : 0, hi = now == .off ? offStart + slide : slide
        var best = 0.0, distance = Double.greatestFiniteMagnitude
        var u = lo
        while u <= hi {
            let d = abs(frame(now, at: u).x - x)
            if d < distance { distance = d; best = u }
            u += 2
        }
        return best
    }

    // MARK: Reduced motion

    /// How much of the finished "on" state shows, `crossfade` ms into a reduced-motion change: CSS `ease`.
    public static func crossfadeOn(_ direction: Direction, at t: Double) -> Double {
        let p = ease(t / crossfade)
        return direction == .on ? p : 1 - p
    }

    /// Changed back mid-crossfade: carry on from the opacity it had reached.
    public static func resumeCrossfade(from was: Direction, at t: Double, to now: Direction) -> Double {
        guard t < crossfade, was != now else { return 0 }
        let shown = crossfadeOn(was, at: t)
        var best = 0.0, distance = Double.greatestFiniteMagnitude
        var u = 0.0
        while u <= crossfade {
            let d = abs(crossfadeOn(now, at: u) - shown)
            if d < distance { distance = d; best = u }
            u += 2
        }
        return best
    }

    // MARK: The curves

    /// CSS `cubic-bezier()` as a function of progress (turned.js `bez`): Newton's method on x, 8 steps.
    struct CubicBezier {
        let ax, bx, cx, ay, by, cy: Double

        init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
            cx = 3 * x1
            bx = 3 * (x2 - x1) - cx
            ax = 1 - cx - bx
            cy = 3 * y1
            by = 3 * (y2 - y1) - cy
            ay = 1 - cy - by
        }

        func callAsFunction(_ p: Double) -> Double {
            if p <= 0 { return 0 }
            if p >= 1 { return 1 }
            var t = p
            for _ in 0..<8 {
                let e = ((ax * t + bx) * t + cx) * t - p, d = (3 * ax * t + 2 * bx) * t + cx
                if abs(e) < 1e-6 || d == 0 { break }
                t -= e / d
            }
            let s = min(1, max(0, t))
            return ((ay * s + by) * s + cy) * s
        }
    }

    static func clamp(_ v: Double, _ a: Double = 0, _ b: Double = 1) -> Double { min(b, max(a, v)) }
    static func smooth(_ p: Double) -> Double { let p = clamp(p); return p * p * (3 - 2 * p) }
    static func outBack(_ p: Double) -> Double { let p = clamp(p), c = 1.25; return 1 + (c + 1) * pow(p - 1, 3) + c * pow(p - 1, 2) }
    static func inCubic(_ p: Double) -> Double { let p = clamp(p); return p * p * p }
    /// Calm start, lands with a little speed left.
    static let slideCurve = CubicBezier(0.45, 0, 0.4, 0.86)
    static let fill = CubicBezier(0.4, 0, 0.2, 1)
    /// CSS `ease`.
    static let ease = CubicBezier(0.25, 0.1, 0.25, 1)

    static func xOn(_ t: Double) -> Double { travel * slideCurve(t / slide) }
    static func xOff(_ t: Double) -> Double { travel * (1 - slideCurve((t - offStart) / slide)) }

    // MARK: The springs

    /// Per-ms lean (deg) and squash, one pair per direction, driven by the shell's own acceleration and normalised to
    /// about 3.5° of lean and a 4.5% squash at most. Kept as `Float`, as turned.js keeps them in a `Float32Array`.
    struct Springs: Sendable {
        let lean: [Float]
        let squash: [Float]
    }

    static let springs: (on: Springs, off: Springs) = (simulate(xOn), simulate(xOff))

    static func simulate(_ xf: (Double) -> Double) -> Springs {
        let n = Int(end) + 1
        var lean = [Float](repeating: 0, count: n), squash = [Float](repeating: 0, count: n)
        var th = 0.0, dth = 0.0, s = 0.0, ds = 0.0, v0 = 0.0, x0 = xf(0)
        let wl = 2 * Double.pi / 230, zl = 0.5, ws = 2 * Double.pi / 150, zs = 0.42
        let travelled = xf(end) - xf(0)
        let sign: Double = travelled == 0 ? 1 : (travelled > 0 ? 1 : -1)
        for t in 1..<n {
            let x = xf(Double(t)), v = x - x0, a = v - v0                        // pt/ms, pt/ms²
            x0 = x
            v0 = v
            dth += -wl * wl * th - 2 * zl * wl * dth - 2.6 * a                   // lean against the acceleration (inertia)
            th += dth
            ds += -ws * ws * s - 2 * zs * ws * ds + 1.15 * max(0, -a * sign)
            s += ds
            lean[t] = Float(th)
            squash[t] = Float(s)
        }
        let maxLean = lean.map { abs($0) }.max() ?? 1, maxSquash = squash.max() ?? 1
        return Springs(
            lean: lean.map { Float(Double($0) * 3.5 / Double(maxLean)) },
            squash: squash.map { Float(max(-0.02, Double($0) * 0.045 / Double(maxSquash))) }
        )
    }
}

/// Where a switch is in its timeline: which way it last went, and when that started. A clock-free value, so a click
/// mid-animation (`flip`) and every frame (`elapsed`) can be checked without one.
public struct LagoonSwitchPlayhead: Equatable, Sendable {
    public private(set) var direction: LagoonSwitchMotion.Direction
    /// The moment the direction's timeline was at 0. Far in the past: at rest, at the end of it.
    public private(set) var start: Date
    /// Whether it last changed as a crossfade (reduced motion) rather than the motion.
    public private(set) var crossfade: Bool

    public init(isOn: Bool) {
        direction = isOn ? .on : .off
        start = .distantPast
        crossfade = false
    }

    /// How long this change runs, ms.
    public var length: Double { crossfade ? LagoonSwitchMotion.crossfade : LagoonSwitchMotion.end }

    /// Where on its timeline the switch is at `now`, ms.
    public func elapsed(at now: Date) -> Double {
        LagoonSwitchMotion.clamp(now.timeIntervalSince(start) * 1000, 0, length)
    }

    public func isMoving(at now: Date) -> Bool { elapsed(at: now) < length }

    /// What to draw at `now`. A change made one way and drawn the other (Reduce motion switched mid-change) shows its
    /// finished state, as turned.js's two layers do.
    public func pose(at now: Date, reduceMotion: Bool) -> LagoonSwitchMotion.Pose {
        if reduceMotion {
            return .crossfade(on: crossfade ? LagoonSwitchMotion.crossfadeOn(direction, at: elapsed(at: now)) : (direction == .on ? 1 : 0))
        }
        return .motion(direction, crossfade ? LagoonSwitchMotion.end : elapsed(at: now))
    }

    /// Turned on or off at `now`: from the start, or, mid-change, back from wherever the shell is (or the crossfade had got
    /// to).
    public mutating func flip(toOn on: Bool, at now: Date, reduceMotion: Bool) {
        let next: LagoonSwitchMotion.Direction = on ? .on : .off
        let t = elapsed(at: now)
        let from: Double
        if reduceMotion {
            from = crossfade ? LagoonSwitchMotion.resumeCrossfade(from: direction, at: t, to: next) : 0
        } else {
            from = crossfade ? 0 : LagoonSwitchMotion.resume(from: direction, at: t, to: next)
        }
        direction = next
        crossfade = reduceMotion
        start = now.addingTimeInterval(-from / 1000)
    }
}
