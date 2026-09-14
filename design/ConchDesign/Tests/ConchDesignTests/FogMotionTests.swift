import XCTest
@testable import ConchDesign

/// The overlay lab's pointer invariants (conch-design/lab-tests/fuzz.mjs and throw-path.mjs) held by the motion the Mac
/// overlay runs, stepped at 120 fps. Screen coordinates, y up.
final class FogMotionTests: XCTestCase {
    static let laptop = CGRect(x: 0, y: 0, width: 1728, height: 1117)
    static let corners: [FogCorner] = [.bottomLeading, .bottomTrailing, .topLeading, .topTrailing]

    /// Tyler: "it kinda breaks when i pull resize up from the bottom - the bottom looses its corner".
    func testResizingUpFromTheBottomMakesItTallerInItsCorner() {
        var sim = Sim(size: CGSize(width: 760, height: 560), corner: .bottomLeading, in: Self.laptop)
        // Grabbed by the bottom edge and pulled up and a little right: taller and wider at once, its corner flush throughout.
        sim.gesture(from: CGPoint(x: 380, y: 30), by: CGVector(dx: 50, dy: 200))
        sim.settle()
        XCTAssertEqual(sim.motion.frame, CGRect(x: 0, y: 0, width: 810, height: 760))
        // Pulled far past its tallest it gives a little, then springs back to 900, still in its corner.
        sim.gesture(from: CGPoint(x: 700, y: 700), by: CGVector(dx: 0, dy: 600))
        XCTAssertGreaterThan(sim.frames.map(\.height).max() ?? 0, 910)
        sim.settle()
        XCTAssertEqual(sim.motion.frame, CGRect(x: 0, y: 0, width: 810, height: 900))
        // And pushed far below its shortest, the same.
        sim.gesture(from: CGPoint(x: 700, y: 850), by: CGVector(dx: 0, dy: -900))
        XCTAssertLessThan(sim.frames.map(\.height).min() ?? 0, 350)
        sim.settle()
        XCTAssertEqual(sim.motion.frame, CGRect(x: 0, y: 0, width: 810, height: 360))
        XCTAssertEqual(sim.motion.corner, .bottomLeading)
        XCTAssertEqual(sim.problems, [])
    }

    /// The lab's throw-path cases (throw-path.mjs), including the hard flick near a side and the steep throw from top right
    /// to bottom left that once sat on a side before sliding into its corner.
    func testTheLabsThrowPathsNeverSitOnASideBeforeTheirCorner() {
        let mx: CGFloat = 1728 - 900, my: CGFloat = 1117 - 640
        // Name, docked start, a slow drag to this origin (the lab's y-down), the flick (y-down), and how fast it goes.
        let cases: [(String, FogCorner, CGPoint?, CGVector, Flick)] = [
            ("bl → br, sideways", .bottomLeading, nil, CGVector(dx: 300, dy: 0), .normal),
            ("tl → tr, sideways", .topLeading, nil, CGVector(dx: 300, dy: 0), .normal),
            ("bl → tr, diagonal", .bottomLeading, nil, CGVector(dx: 260, dy: -200), .normal),
            ("br → tl, diagonal", .bottomTrailing, nil, CGVector(dx: -260, dy: -200), .normal),
            ("bl → tr, shallow", .bottomLeading, nil, CGVector(dx: 320, dy: -70), .normal),
            ("tr → bl, steep", .topTrailing, nil, CGVector(dx: -180, dy: 300), .normal),
            ("mid-left, flick right", .bottomLeading, CGPoint(x: 0, y: 262), CGVector(dx: 300, dy: 6), .normal),
            ("mid-right, flick left", .bottomTrailing, CGPoint(x: mx, y: 200), CGVector(dx: -300, dy: -6), .normal),
            ("near right, flick right", .bottomTrailing, CGPoint(x: mx - 120, y: 200), CGVector(dx: 320, dy: -20), .normal),
            ("near left, flick left", .bottomLeading, CGPoint(x: 120, y: 262), CGVector(dx: -320, dy: 20), .normal),
            ("near right, hard flick", .bottomTrailing, CGPoint(x: mx - 60, y: 190), CGVector(dx: 360, dy: -10), .fast),
            ("near left, hard flick", .bottomLeading, CGPoint(x: 60, y: 270), CGVector(dx: -360, dy: 10), .fast),
            ("above top, hard flick left", .topTrailing, CGPoint(x: 460, y: -40), CGVector(dx: -340, dy: -35), .max),
            ("below bottom, hard flick right", .bottomTrailing, CGPoint(x: mx - 460, y: my + 40), CGVector(dx: 340, dy: 35), .max),
            ("above top, short hop left", .topTrailing, CGPoint(x: 300, y: -40), CGVector(dx: -190, dy: -35), .max),
        ]
        for (name, from, to, flick, speed) in cases {
            var sim = Sim(size: CGSize(width: 900, height: 640), corner: from, in: Self.laptop)
            sim.throwFromMiddle(to: to.map { CGPoint(x: $0.x, y: my - $0.y) }, flick: CGVector(dx: flick.dx, dy: -flick.dy), speed)
            sim.settle()
            XCTAssertEqual(sim.problems, [], name)
            XCTAssertLessThan(sim.longestStick, 2, "\(name): sat on a side for \(sim.longestStick) frames before its corner")
            XCTAssertLessThan(sim.furthestOff, 200, name)
            if name == "tr → bl, steep" { XCTAssertEqual(sim.motion.corner, .bottomLeading, name) }
        }
    }

    /// Tossed hard into its own corner it overshoots the screen's edges a little and comes back: it never hard-stops.
    func testAThrowPastTheScreenEdgeRubberBands() {
        var sim = Sim(size: CGSize(width: 900, height: 640), corner: .bottomLeading, in: Self.laptop)
        sim.throwFromMiddle(to: CGPoint(x: 300, y: 225), flick: CGVector(dx: -150, dy: -112), .normal)
        sim.settle()
        XCTAssertEqual(sim.motion.corner, .bottomLeading)
        XCTAssertGreaterThan(sim.furthestOff, 1)
        XCTAssertLessThan(sim.furthestOff, 200)
        XCTAssertLessThan(sim.longestStick, 2)
        XCTAssertEqual(sim.problems, [])
    }

    /// Resting before letting go throws nothing: it docks in the corner nearest where it is.
    func testAPauseBeforeLettingGoThrowsNothing() {
        for (pause, corner) in [(0.06, FogCorner.bottomLeading), (0.004, .bottomTrailing)] {
            var sim = Sim(size: CGSize(width: 760, height: 560), corner: .bottomLeading, in: Self.laptop)
            sim.press(CGPoint(x: 380, y: 280))
            for i in 1...9 { sim.drag(CGPoint(x: 380 + 300 * CGFloat(i) / 9, y: 280), at: sim.time + 0.01) }
            sim.release(at: sim.time + pause)
            sim.settle()
            XCTAssertEqual(sim.motion.corner, corner, "paused \(pause) s")
            XCTAssertEqual(sim.problems, [])
        }
    }

    /// fuzz.mjs's episodes: throws, flicks and resizes from anywhere, grabbed mid-flight and mid-spring, cut short, and
    /// screens changing under them, with every frame checked.
    func testThrowsAndResizesKeepTheLabsInvariants() {
        var random = Seeded(state: 7)
        let screens = [Self.laptop, CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: -1920, y: 140, width: 1920, height: 1080), CGRect(x: 0, y: 0, width: 1024, height: 768)]
        var throwCount = 0, resizeCount = 0
        for episode in 0..<400 {
            var sim = Sim(size: CGSize(width: 300 + 1200 * random.next(), height: 250 + 900 * random.next()), corner: random.pick(Self.corners), in: random.pick(screens))
            var log: [String] = []
            for _ in 0...Int(random.next() * 4) {
                let f = sim.motion.frame
                let band = max(120, min(f.width, f.height) / 5)
                let op = random.pick(["throw", "throw", "flick", "resize", "resize", "anchored", "screen"])
                var point: CGPoint
                switch op {
                case "throw", "flick":
                    point = CGPoint(x: f.minX + band + max(0, f.width - 2 * band) * random.next(), y: f.minY + band + max(0, f.height - 2 * band) * random.next())
                case "resize":
                    let depth = 2 + (band - 4) * random.next()
                    point = CGPoint(x: f.minX + f.width * random.next(), y: f.minY + f.height * random.next())
                    switch Int(random.next() * 4) {
                    case 0: point.x = f.minX + depth
                    case 1: point.x = f.maxX - depth
                    case 2: point.y = f.minY + depth
                    default: point.y = f.maxY - depth
                    }
                case "anchored":
                    let depth = 3 + 37 * random.next()
                    point = CGPoint(x: f.minX + f.width * random.next(), y: f.minY + f.height * random.next())
                    if random.next() < 0.5 {
                        point.y = sim.motion.corner.bottom ? f.minY + depth : f.maxY - depth
                    } else {
                        point.x = sim.motion.corner.leading ? f.minX + depth : f.maxX - depth
                    }
                default:
                    let screen = random.pick(screens)
                    log.append("screen \(screen)")
                    sim.dock(in: screen)
                    continue
                }
                let flying = sim.motion.isMoving
                sim.press(point)
                if op == "anchored", !flying, !sim.motion.isResizing { sim.problem("a press on an anchored edge moved instead of resizing") }
                if sim.motion.isResizing { resizeCount += 1 } else { throwCount += 1 }
                let steps = 1 + Int(random.next() * 24), far = random.next() < 0.3
                let target = far
                    ? CGPoint(x: sim.screen.minX - 300 + (sim.screen.width + 600) * random.next(), y: sim.screen.minY - 300 + (sim.screen.height + 600) * random.next())
                    : CGPoint(x: point.x - 600 + 1200 * random.next(), y: point.y - 600 + 1200 * random.next())
                let middle = random.next() < 0.35 ? random.pick(["cancel", "screen", "pause", "lostup"]) : nil
                let middleAt = 1 + Int(random.next() * Double(steps))
                log.append("\(op) at \(point) \(sim.motion.isResizing ? "resizes" : "moves") to \(target) in \(steps)\(middle.map { ", \($0) at \(middleAt)" } ?? "")")
                var cancelled = false
                for i in 1...steps {
                    let u = CGFloat(i) / CGFloat(steps)
                    sim.drag(CGPoint(x: point.x + (target.x - point.x) * u, y: point.y + (target.y - point.y) * u), at: sim.time + (op == "flick" ? 0.002 + 0.004 * random.next() : 0.004 + 0.018 * random.next()))
                    guard i == middleAt, let middle else { continue }
                    switch middle {
                    case "cancel": cancelled = true
                    case "screen": sim.dock(in: random.pick(screens))
                    case "pause": sim.wait(0.06 + 0.24 * random.next())
                    default: sim.wait(0.1 + 0.2 * random.next())   // the button came up where we never heard: noticed a few frames on
                    }
                    if middle != "pause" { break }
                }
                if random.next() < 0.2 { sim.wait(0.06 + 0.19 * random.next()) }
                sim.release(at: sim.time + 0.001, cancelled: cancelled)
                if random.next() < 0.5 { sim.wait(0.6 * random.next()) } else { sim.settle() }
            }
            sim.settle()
            XCTAssertEqual(sim.problems, [], "episode \(episode): \(log.joined(separator: "; "))")
            if !sim.problems.isEmpty { break }
        }
        XCTAssertGreaterThan(throwCount, 300)
        XCTAssertGreaterThan(resizeCount, 300)
    }
}

/// A generator that repeats: the lab's own LCG.
struct Seeded {
    var state: UInt32
    mutating func next() -> CGFloat {
        state = state &* 1664525 &+ 1013904223
        return CGFloat(state) / 4_294_967_296
    }
    mutating func pick<T>(_ items: [T]) -> T { items[min(items.count - 1, Int(next() * CGFloat(items.count)))] }
}

enum Flick { case normal, fast, max }

/// `FogMotion` driven the way the Mac overlay drives it: pointer events between 120 fps frames, with the lab's per-frame
/// audits (overlay-lab.html's auditFlight and tick) and its settle checks (fuzz.mjs).
struct Sim {
    var motion: FogMotion
    private(set) var screen: CGRect
    private(set) var time: TimeInterval = 100
    /// Every frame since the last press.
    private(set) var frames: [CGRect] = []
    /// The longest run of frames a flight sat on a side before its corner.
    private(set) var longestStick = 0
    /// How much further past a screen edge a flight went than where it was let go.
    private(set) var furthestOff: CGFloat = 0
    private(set) var problems: [String] = []
    private var samples: [(time: TimeInterval, point: CGPoint)] = []
    /// The corner a resize under way, or springing back, keeps.
    private var resizing: FogCorner?
    private var flight: Audit?

    private struct Audit {
        let pastAtRelease: CGFloat
        /// Let go at or past that side (left, right, bottom, top), or so nearly along it that its straight path runs
        /// within 2 pt of it for the last 24 pt: sliding along it is the only way in. (The lab takes only within 12 pt.)
        let at: [Bool]
        /// Still leaving a side it was released on.
        var leaving: [Bool]
        var stuck = 0
    }

    init(size: CGSize, corner: FogCorner, in screen: CGRect) {
        motion = FogMotion(size: size, corner: corner, in: screen)
        self.screen = screen
    }

    mutating func problem(_ text: String) {
        if problems.count < 5 { problems.append("\(text) (t \(time), frame \(motion.frame), corner \(motion.corner), screen \(screen))") }
    }

    mutating func frame() {
        time += 1.0 / 120
        motion.step(dt: 1.0 / 120)
        check()
    }

    mutating func wait(_ seconds: TimeInterval) { advance(to: time + seconds) }

    private mutating func advance(to t: TimeInterval) {
        while time + 1.0 / 120 <= t + 1e-9 { frame() }
    }

    mutating func press(_ point: CGPoint) {
        let local = CGPoint(x: point.x - motion.origin.x, y: point.y - motion.origin.y)
        let flying = motion.isMoving
        motion.press(at: point, time: time)
        if motion.isResizing != (!flying && FogDock.resizes(at: local, in: motion.size)) { problem("a press at \(local) chose wrongly") }
        resizing = motion.isResizing ? motion.corner : nil
        flight = nil
        samples = [(time, point)]
        frames = []
    }

    mutating func drag(_ point: CGPoint, at t: TimeInterval) {
        advance(to: t)
        motion.drag(to: point, time: t)
        samples.append((t, point))
        check()
    }

    mutating func release(at t: TimeInterval, cancelled: Bool = false) {
        advance(to: t)
        let moving = motion.isGesturing && !motion.isResizing
        motion.release(at: t, in: screen, cancelled: cancelled)
        guard moving else { return }
        // The corner its momentum picks, as FogDock.corner(releasedAt:velocity:) chooses: velocity over the last 80 ms,
        // none after a 50 ms rest, at most 6000 pt/s.
        var velocity = CGVector.zero
        if !cancelled, let last = samples.last, t - last.time <= 0.05,
           let first = samples.first(where: { last.time - $0.time <= 0.08 }), last.time - first.time > 0.004 {
            velocity = CGVector(dx: (last.point.x - first.point.x) / (last.time - first.time), dy: (last.point.y - first.point.y) / (last.time - first.time))
        }
        let speed = hypot(velocity.dx, velocity.dy)
        if speed > 6000 { velocity = CGVector(dx: velocity.dx * 6000 / speed, dy: velocity.dy * 6000 / speed) }
        let center = CGPoint(x: motion.frame.midX, y: motion.frame.midY)
        if motion.corner != FogDock.corner(releasedAt: center, velocity: velocity, in: screen) { problem("flew to \(motion.corner), not the corner its momentum picks") }
        let past = pastSides(), o = motion.origin, docked = motion.docked
        let travel = [abs(o.y - docked.y), abs(o.y - docked.y), abs(o.x - docked.x), abs(o.x - docked.x)]
        let at = (0..<4).map { past[$0] >= -12 || -past[$0] <= travel[$0] / 12 }
        flight = Audit(pastAtRelease: max(0, past.max()!), at: at, leaving: past.map { $0 >= -2 })
    }

    /// Press, pull by `delta` over 100 ms, let go.
    mutating func gesture(from point: CGPoint, by delta: CGVector) {
        press(point)
        for i in 1...10 { drag(CGPoint(x: point.x + delta.dx * CGFloat(i) / 10, y: point.y + delta.dy * CGFloat(i) / 10), at: time + 0.01) }
        release(at: time + 0.005)
    }

    /// throw-path.mjs's perform: grab the middle, optionally drag slowly to the origin `to` and hold still, then flick and
    /// let go.
    mutating func throwFromMiddle(to: CGPoint?, flick: CGVector, _ speed: Flick) {
        var grab = CGPoint(x: motion.frame.midX, y: motion.frame.midY)
        press(grab)
        if let to {
            let end = CGPoint(x: grab.x + to.x - motion.origin.x, y: grab.y + to.y - motion.origin.y)
            for i in 1...20 { drag(CGPoint(x: grab.x + (end.x - grab.x) * CGFloat(i) / 20, y: grab.y + (end.y - grab.y) * CGFloat(i) / 20), at: time + 0.012) }
            grab = end
            wait(0.16)
        }
        let (n, gap) = speed == .max ? (10, 0.001) : speed == .fast ? (4, 0.005) : (9, 0.01)
        for i in 1...n { drag(CGPoint(x: grab.x + flick.dx * CGFloat(i) / CGFloat(n), y: grab.y + flick.dy * CGFloat(i) / CGFloat(n)), at: time + gap) }
        release(at: time + 0.001)
    }

    /// The screens changed: docked again at once, ending any gesture.
    mutating func dock(in screen: CGRect) {
        self.screen = screen
        motion.dock(motion.corner, in: screen)
        resizing = nil
        flight = nil
    }

    mutating func settle() {
        for _ in 0..<1200 where !motion.isSettled { frame() }
        guard motion.isSettled else { return problem("did not settle") }
        let f = motion.frame, least = FogDock.minSize(in: screen), most = FogDock.maxSize(in: screen)
        let docked = FogDock.frame(size: motion.size, corner: motion.corner, in: screen)
        if abs(f.minX - docked.minX) > 0.01 || abs(f.minY - docked.minY) > 0.01 || f.size != docked.size { problem("not docked to its corner") }
        if !screen.insetBy(dx: -0.5, dy: -0.5).contains(f) { problem("outside the screen") }
        if f.width < least.width - 0.5 || f.height < least.height - 0.5 || f.width > most.width + 0.5 || f.height > most.height + 0.5 { problem("outside its size limits") }
        flight = nil
    }

    /// How far past each side of the screen it is, left, right, bottom, top: above 0 is past it.
    private func pastSides() -> [CGFloat] {
        let f = motion.frame
        return [screen.minX - f.minX, f.maxX - screen.maxX, screen.minY - f.minY, f.maxY - screen.maxY]
    }

    private mutating func check() {
        let f = motion.frame
        guard f.minX.isFinite, f.minY.isFinite, f.width.isFinite, f.height.isFinite else { return problem("geometry is not a number") }
        frames.append(f)
        let least = FogDock.minSize(in: screen), most = FogDock.maxSize(in: screen)
        if f.width <= least.width - 200 || f.height <= least.height - 200 || f.width >= most.width + 200 || f.height >= most.height + 200 {
            problem("size past its rubber band")
        }
        if let corner = resizing {
            if motion.corner != corner { problem("corner changed during a resize") }
            let offX = corner.leading ? f.minX - screen.minX : f.maxX - screen.maxX
            let offY = corner.bottom ? f.minY - screen.minY : f.maxY - screen.maxY
            if abs(offX) > 0.01 || abs(offY) > 0.01 { problem("anchored edges not flush during a resize") }
        }
        guard var audit = flight, motion.isMoving, !motion.isGesturing else { return }
        // In flight it never sits on a side before its corner. Its own corner's sides count while flush and still more
        // than 24 pt out, unless it was let go at or past that side; other sides count on or past them, unless it is still leaving
        // one it was let go on. An axis with under 24 pt of travel is skipped: it spans it.
        let past = pastSides()
        furthestOff = max(furthestOff, max(0, past.max()!) - audit.pastAtRelease)
        let corner = motion.corner
        let own = [corner.leading, !corner.leading, corner.bottom, !corner.bottom]
        let far = hypot(f.minX - motion.docked.x, f.minY - motion.docked.y) > 24
        var stuck = false
        for side in 0..<4 {
            if (side < 2 ? screen.width - f.width : screen.height - f.height) < 24 { continue }
            if own[side] {
                if abs(past[side]) <= 2, !audit.at[side], far { stuck = true }
            } else if past[side] < -2 {
                audit.leaving[side] = false
            } else if !audit.leaving[side] {
                stuck = true
            }
        }
        audit.stuck = stuck ? audit.stuck + 1 : 0
        longestStick = max(longestStick, audit.stuck)
        if audit.stuck == 2 { problem("in flight it sat on a side before reaching its corner") }
        if max(0, past.max()!) - audit.pastAtRelease >= 200 { problem("flew further off the screen than its rubber band") }
        flight = audit
    }
}
