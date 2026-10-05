import CoreGraphics
import Foundation

// MARK: - Where the input is

/// Where conch's one input is. Tyler: "Have to make sure only one is in use or active at a time — think of it like: the
/// input box is leaving the Mac app and coming with you — we literally remove it from the Mac app UI until they go back to
/// the app and it swoops back into the UI."
///
/// One value, so there is never a second input to type into: the window holds the composer only while this is `.window`,
/// and the panel only while it is `.panel` or `.replyLine`.
public enum ComposerPlace: String, Equatable, Sendable, CaseIterable {
    /// Under the conversation, in conch's window.
    case window
    /// The conversation panel's reply line.
    case panel
    /// The panel at its least: the reply line alone, brought up because the panel was off or folded to its handle.
    case replyLine
    /// Nowhere: no window to hold it, and nowhere it may follow to.
    case none

    /// Out of the window, floating over whatever Tyler went to.
    public var floats: Bool { self == .panel || self == .replyLine }
}

/// What decides where the input is.
public struct ComposerSituation: Equatable, Sendable {
    /// The conversation panel as the menu has it: off, folded to its handle, or open (docked or full screen).
    public enum Panel: Equatable, Sendable { case off, collapsed, open }

    /// conch is the app in front.
    public var appActive: Bool
    /// conch's window is on screen: there, not minimised, the app not hidden, and on the space in front.
    public var windowShown: Bool
    public var panel: Panel
    /// The menu's Reply Line: the input may go to the panel at all. Off, the panel shows only the words.
    public var replyLine: Bool
    /// The menu's With Panel Off: leaving conch with the panel off or folded brings the reply line up alone. On by default.
    public var withPanelOff: Bool
    /// Something the input opened is up, its file picker, which brings conch forward while it is: the input stays put.
    public var held: Bool
    /// The overlays are on (`ConchOverlays`). Off, the input never leaves conch's window.
    public var overlays: Bool

    public init(appActive: Bool, windowShown: Bool, panel: Panel, replyLine: Bool = true, withPanelOff: Bool = true, held: Bool = false,
                overlays: Bool = true) {
        self.appActive = appActive
        self.windowShown = windowShown
        self.panel = panel
        self.replyLine = replyLine
        self.withPanelOff = withPanelOff
        self.held = held
        self.overlays = overlays
    }
}

public enum ComposerPlacement {
    /// The one rule. In conch's window while conch is in front and its window is there to type into; otherwise with Tyler:
    /// the panel's reply line when the panel is open, else the reply line alone. With the reply line off, or With Panel Off
    /// off and nothing open, it stays in the window, and with no window it is nowhere. The window closing never strands
    /// what was typed: the draft is the session's (`ComposerDraftStore`), wherever the input is. With the overlays off
    /// (`ConchOverlays`) there is no panel and no reply line: it is always in the window, held or not.
    public static func place(_ situation: ComposerSituation, current: ComposerPlace) -> ComposerPlace {
        if !situation.overlays { return .window }
        if situation.held { return current }
        if situation.appActive, situation.windowShown { return .window }
        if situation.replyLine {
            if situation.panel == .open { return .panel }
            if situation.withPanelOff { return .replyLine }
        }
        return situation.windowShown ? .window : .none
    }
}

// MARK: - conch steering the screen

/// conch steering the screen for a send: the daemon brings Terminal forward to type into a session's window, and conch
/// takes the front back once the keys are in (`StateStore.send`, and the session commands that type). Tyler: "We don't
/// need the input box to leave the ui and come back when its the app temporarily steering the ui to do a paste into a
/// terminal." So while one is under way the input holds where it is (`ComposerSituation.held`): from the press, until
/// conch has the front back or the send did not go, and never past `failsafe`. Anything Tyler does himself lets go at
/// once (another app coming forward, conch's window closed, minimised or hidden), and the next look at where the input
/// should be moves it.
public struct ComposerSteering: Equatable, Sendable {
    public typealias ID = Int

    /// The app conch steers to type: the daemon activates it for a session's tab (`focusSessionWindow`), and conch takes
    /// the front back from it and from nothing else.
    public static let terminal = "com.apple.Terminal"
    /// The longest a send holds the input with the daemon silent. A delivery answers within a second or two; one still
    /// going after this lets the input follow wherever the screen is by then.
    public static let failsafe: TimeInterval = 10
    /// Asked for the front back: the longest to wait for conch to have it.
    public static let landing: TimeInterval = 1.5

    private struct Hold: Equatable, Sendable {
        var until: TimeInterval
        var refocusing = false
    }

    private var holds: [ID: Hold] = [:]
    private var last: ID = 0

    public init() {}

    /// A send conch steers for, pressed now: the input holds until it is done.
    public mutating func begin(at now: TimeInterval) -> ID {
        holds = holds.filter { $0.value.until > now }
        last &+= 1
        holds[last] = Hold(until: now + Self.failsafe)
        return last
    }

    /// Its keys are in. `refocusing`: conch asked for the front back, and holds until it is in front (`landed`), a moment
    /// at most; else it lets go now, and the input goes wherever the screen says.
    public mutating func delivered(_ id: ID, refocusing: Bool, at now: TimeInterval) {
        guard holds[id] != nil else { return }
        holds[id] = refocusing ? Hold(until: now + Self.landing, refocusing: true) : nil
    }

    /// It did not go (no daemon, the write failed): nothing will steer, so it lets go.
    public mutating func end(_ id: ID) {
        holds[id] = nil
    }

    /// conch is in front again: every send that was waiting for that is done. One still typing holds on.
    public mutating func landed() {
        holds = holds.filter { !$0.value.refocusing }
    }

    /// Tyler went somewhere himself: nothing conch steers holds the input any longer.
    public mutating func endAll() {
        holds.removeAll()
    }

    public func held(at now: TimeInterval) -> Bool {
        holds.values.contains { now < $0.until }
    }

    /// When the next hold runs out, for another look then.
    public func expiry(after now: TimeInterval) -> TimeInterval? {
        holds.values.map(\.until).filter { $0 > now }.min()
    }
}

// MARK: - The swoop

/// The input's glass on its way from one place to another. Its frame, its corner and its chrome (the window's card to the
/// panel's glass) spring together on `ConchMotion.morph`, from its middle, so it never leans toward one edge as it grows;
/// what is on it crossfades from the look it left to the look it lands as, each drawn at its own proportions and never
/// stretched. A new destination mid-flight retargets every spring from where the glass is and how fast it is moving:
/// nothing is queued, so switching apps back and forth quickly bends one flight rather than stacking several.
///
/// Once it has arrived the live input shows under it, and the glass hands off to it (`handoff`), so the last frame of the
/// flight and the first of the input are the same picture. Under Reduce Motion nothing travels: the input fades out where
/// it was and in where it goes.
public struct ComposerFlight: Equatable {
    /// The input's glass: where it is (any one space, y either way), its corner, and its chrome, 0 the window's card to 1
    /// the panel's glass.
    public struct Shape: Equatable, Sendable {
        public var rect: CGRect
        public var radius: CGFloat
        public var chrome: CGFloat

        public init(rect: CGRect, radius: CGFloat, chrome: CGFloat) {
            self.rect = rect
            self.radius = radius
            self.chrome = chrome
        }

        /// The composer's card in conch's window: `ConchRadius.large`, the surface.
        public static func window(_ rect: CGRect) -> Shape { Shape(rect: rect, radius: ConchRadius.large, chrome: 0) }
        /// The composer as the panel's reply line, alone or in the panel: the panel's own corner, glass.
        public static func floating(_ rect: CGRect) -> Shape { Shape(rect: rect, radius: ConchRadius.panel, chrome: 1) }

        /// For a place.
        public static func of(_ place: ComposerPlace, _ rect: CGRect) -> Shape {
            place.floats ? floating(rect) : window(rect)
        }

        /// This shape at `scale` about its middle: where an input with nowhere to come from appears from, and where one with
        /// nowhere to go leaves to. Never from nothing (`ConchMotion.appearScale`).
        public func scaled(_ scale: CGFloat) -> Shape {
            let width = rect.width * scale, height = rect.height * scale
            return Shape(rect: CGRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height), radius: radius * scale, chrome: chrome)
        }
    }

    /// One card to draw this frame.
    public struct Card: Equatable, Sendable {
        public var shape: Shape
        /// How much of it shows, the glass and what is on it.
        public var opacity: CGFloat
        /// The look it left and the look it lands as, each at its own proportions, crossfaded on the glass.
        public var leaving: CGFloat
        public var arriving: CGFloat
        /// Lifted, mid-flight: its shadow deepens and spreads.
        public var lift: CGFloat
    }

    /// Where it left, and where it is going.
    public private(set) var from: ComposerPlace
    public private(set) var to: ComposerPlace
    /// Where it left from and where it lands: Reduce Motion fades it out at one and in at the other.
    public private(set) var source: Shape
    public private(set) var target: Shape
    public let reduceMotion: Bool
    /// It began unseen, its source covered by the app that came forward or already gone: it fades in as it leaves.
    public private(set) var emerges: Bool
    /// It has nowhere to land (`.none`): it fades out as it goes.
    public private(set) var vanishes: Bool
    /// Its frame has come to rest where it was going: the live input shows under it from now.
    public private(set) var arrived = false
    /// The hand-off is done: nothing is left to draw.
    public private(set) var landed = false

    private var midX: Sprung, midY: Sprung, width: Sprung, height: Sprung, radius: Sprung, chrome: Sprung
    /// 0 at the look it left to 1 at the look it lands as.
    private var progress = Sprung(0)
    /// The glass's own opacity: from 0 when it began unseen, toward 0 when it has nowhere to land, else 1. Its own spring,
    /// so a retarget never makes it jump.
    private var appear: Sprung
    /// 1 while it flies, to 0 as the live input takes over.
    private var handoff = Sprung(1)

    /// A value on a spring, with how fast it is moving.
    private struct Sprung: Equatable {
        var value: CGFloat
        var velocity: CGFloat = 0
        init(_ value: CGFloat) { self.value = value }
    }

    public init(from: ComposerPlace, at source: Shape, to: ComposerPlace, at target: Shape, emerges: Bool = false, reduceMotion: Bool = false) {
        self.from = from
        self.to = to
        self.source = source
        self.target = target
        self.emerges = emerges
        self.reduceMotion = reduceMotion
        vanishes = to == .none
        appear = Sprung(emerges ? 0 : 1)
        midX = Sprung(source.rect.midX)
        midY = Sprung(source.rect.midY)
        width = Sprung(source.rect.width)
        height = Sprung(source.rect.height)
        radius = Sprung(source.radius)
        chrome = Sprung(source.chrome)
    }

    /// The glass where it is now.
    public var current: Shape {
        Shape(
            rect: CGRect(x: midX.value - width.value / 2, y: midY.value - height.value / 2, width: max(0, width.value), height: max(0, height.value)),
            radius: max(0, radius.value),
            chrome: min(1, max(0, chrome.value))
        )
    }

    /// 0 where it left to 1 where it lands, past 1 as the spring overshoots.
    public var fraction: CGFloat { progress.value }

    /// Somewhere new to go, from wherever it is. Back where it came from, the two looks trade places and the crossfade runs
    /// back from where it had got to; anywhere else, it carries on from the look it mostly shows. Either way the glass keeps
    /// its position and its speed.
    public mutating func retarget(to place: ComposerPlace, at shape: Shape) {
        guard place != to else { return follow(shape) }
        // Only the first leg can begin unseen; from here on it is on screen, fading in or not.
        emerges = false
        if place == from {
            (from, to) = (to, from)
            source = current
            progress.value = 1 - progress.value
            progress.velocity = -progress.velocity
        } else {
            if progress.value >= 0.5 { from = to }
            to = place
            source = current
            progress = Sprung(0)
        }
        target = shape
        vanishes = place == .none
        arrived = false
        landed = false
        handoff = Sprung(1)
    }

    /// The place it is going to moved under it (a window resized, the panel dragged or grown a line): the same flight, a
    /// new end. After it has arrived there is nothing to follow; the live input is there.
    public mutating func follow(_ shape: Shape) {
        guard !arrived else { return }
        target = shape
    }

    /// One display frame. True once there is nothing left to draw.
    @discardableResult
    public mutating func step(dt: Double) -> Bool {
        guard !landed else { return true }
        let spring = ConchMotion.morph.resolved(reduceMotion: reduceMotion)
        var still = spring.step(&progress.value, velocity: &progress.velocity, to: 1, dt: dt, epsilon: 0.01)
        // In as it leaves when it began unseen, quick and with no overshoot; out over the whole flight to nowhere.
        let fade = vanishes ? ConchMotion.morph.resolved(reduceMotion: true) : ConchMotion.liftOff
        still = fade.step(&appear.value, velocity: &appear.velocity, to: vanishes ? 0 : 1, dt: dt, epsilon: 0.005) && still
        if reduceMotion {
            // Nothing travels: the frame is wherever it lands.
            midX = Sprung(target.rect.midX)
            midY = Sprung(target.rect.midY)
            width = Sprung(target.rect.width)
            height = Sprung(target.rect.height)
            radius = Sprung(target.radius)
            chrome = Sprung(target.chrome)
        } else {
            // At rest within a point, and moving under ten a second: the live input is there then, and the hand-off's fade
            // covers the rest. A quarter of a point kept the input untouchable for most of half a second after it had,
            // to the eye, landed.
            let near = Self.restsWithin
            still = spring.step(&midX.value, velocity: &midX.velocity, to: target.rect.midX, dt: dt, epsilon: near) && still
            still = spring.step(&midY.value, velocity: &midY.velocity, to: target.rect.midY, dt: dt, epsilon: near) && still
            still = spring.step(&width.value, velocity: &width.velocity, to: target.rect.width, dt: dt, epsilon: near) && still
            still = spring.step(&height.value, velocity: &height.velocity, to: target.rect.height, dt: dt, epsilon: near) && still
            still = spring.step(&radius.value, velocity: &radius.velocity, to: target.radius, dt: dt, epsilon: 0.25) && still
            still = spring.step(&chrome.value, velocity: &chrome.velocity, to: target.chrome, dt: dt, epsilon: 0.01) && still
        }
        if still, !arrived {
            arrived = true
            progress = Sprung(1)
            midX = Sprung(target.rect.midX)
            midY = Sprung(target.rect.midY)
            width = Sprung(target.rect.width)
            height = Sprung(target.rect.height)
            radius = Sprung(target.radius)
            chrome = Sprung(target.chrome)
        }
        if arrived {
            // With nowhere to land there is nothing to hand to.
            if vanishes || ConchMotion.liftOff.step(&handoff.value, velocity: &handoff.velocity, to: 0, dt: dt, epsilon: 0.01) {
                handoff = Sprung(0)
                landed = true
            }
        }
        return landed
    }

    /// What to draw now: the one glass in flight, or under Reduce Motion the input fading out where it was and in where it
    /// goes. Empty once it has landed.
    public var cards: [Card] {
        guard !landed else { return [] }
        let p = min(1, max(0, progress.value))
        let hand = min(1, max(0, handoff.value))
        if reduceMotion {
            let leaving = 1 - Self.smooth(p, 0, 1), arriving = Self.smooth(p, 0, 1)
            var cards: [Card] = []
            if !emerges, leaving > 0.001 { cards.append(Card(shape: source, opacity: leaving * hand, leaving: 1, arriving: 0, lift: 0)) }
            if !vanishes, arriving > 0.001 { cards.append(Card(shape: target, opacity: arriving * hand, leaving: 0, arriving: 1, lift: 0)) }
            return cards
        }
        let opacity = min(1, max(0, appear.value)) * hand
        return [Card(shape: current, opacity: opacity, leaving: Self.leaving(p), arriving: Self.arriving(p), lift: sin(.pi * p))]
    }

    /// How close, in points, the glass has come to rest where it lands before the live input takes over under it.
    public static let restsWithin: CGFloat = 1

    /// The look it lands as comes in over the look it left, whole by the middle of the flight, and only then does the look
    /// it left go, drawn under it (`Card.leaving` first). One of them is always whole: two pictures of the same draft
    /// coincide on the glass (`slices`), so every word stays at full strength the whole way, where a straight crossfade
    /// (the two adding to one) dimmed them to three quarters mid-flight. The two are mirror images, so a flight turned
    /// back mid-air runs back from exactly where it was.
    public static func leaving(_ p: CGFloat) -> CGFloat { 1 - smooth(p, 0.5, crossfade.upperBound) }
    public static func arriving(_ p: CGFloat) -> CGFloat { smooth(p, crossfade.lowerBound, 0.5) }
    /// Where in the flight the looks trade places: through the middle, clear of the lift at the start and the settle at
    /// the end, and even about it.
    public static let crossfade: ClosedRange<CGFloat> = 0.15...0.85

    /// Smoothstep from `a` to `b`.
    static func smooth(_ x: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
        let t = min(1, max(0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)
    }
}

// MARK: - The picture on the glass

extension ComposerFlight {
    /// A piece of a picture of the composer, and where it goes on the glass: top left, in points, the same size at both
    /// ends. Nothing is ever scaled.
    public struct Slice: Equatable, Sendable {
        public var from: CGRect
        public var to: CGRect
    }

    /// The composer's bar under its field: 34 of controls and 6 of the glass's padding under them.
    public static let bar: CGFloat = 40
    /// The bar's trailing cluster (Read it again and Send, or Stop), with the glass's padding after it.
    public static let trailing: CGFloat = 72

    /// A picture of the composer, `picture` in size, laid on glass `card` in size the way the composer lays itself out:
    /// its field from the top leading corner, its bar's leading cluster (attach, the mic, where it is going) from the
    /// bottom leading corner, and its trailing cluster from the bottom trailing corner, each at its own size. Scaling
    /// the whole picture to the glass's width drew the words of two layouts at two sizes on top of each other mid-flight;
    /// placed like this, two pictures of the same draft coincide wherever they overlap, and the crossfade between them
    /// shows only what really changed, a line wrapping differently.
    public static func slices(picture: CGSize, in card: CGSize) -> [Slice] {
        let bar = min(Self.bar, picture.height), trailing = min(Self.trailing, picture.width)
        let top = max(0, picture.height - bar), leading = max(0, picture.width - trailing)
        return [
            Slice(from: CGRect(x: 0, y: 0, width: picture.width, height: top), to: CGRect(x: 0, y: 0, width: picture.width, height: top)),
            Slice(from: CGRect(x: 0, y: top, width: leading, height: bar), to: CGRect(x: 0, y: card.height - bar, width: leading, height: bar)),
            Slice(from: CGRect(x: leading, y: top, width: trailing, height: bar), to: CGRect(x: card.width - trailing, y: card.height - bar, width: trailing, height: bar)),
        ].filter { $0.from.width > 0 && $0.from.height > 0 }
    }
}

// MARK: - Where the reply line alone sits

public enum ComposerDockGeometry {
    /// The reply line alone: the width of the window's composer, so the flight between them is a move rather than a
    /// resize, never wider than the screen allows.
    public static func replyLineWidth(measure: CGFloat, in visible: CGRect) -> CGFloat {
        min(measure, max(0, visible.width - 2 * ConchSpace.x6))
    }
}

/// The one spot conch remembers for the reply line alone: the last place Tyler left it. It is kept relative to the
/// visible frame of the screen he left it on, so a new resolution or a Dock moved keeps it where it was in the same
/// sense. `across` and `up` are how far along the glass's free travel it sits, 0 against the visible frame's leading or
/// bottom edge and 1 against its trailing or top edge: flush against an edge stays flush, centred stays centred, and
/// every value is wholly on screen.
public struct ReplyLineSpot: Codable, Equatable, Sendable {
    /// The display it was left on, by its UUID, which outlives unplugging it and plugging it back in.
    public var screen: String
    public var across: Double
    public var up: Double

    public init(screen: String, across: Double, up: Double) {
        self.screen = screen
        self.across = across
        self.up = up
    }
}

/// Where the reply line alone sits: the input out with Tyler while the panel is off or folded (`ComposerPlace.replyLine`,
/// "detached"). Tyler: "Can we make it so that the input bar defaults to bottom center of the screen when it's in
/// detached mode (or wherever u left it for that one last time) but u can drag it around where u want to and stuff?"
///
/// Bottom centre of its screen's visible frame, clear of the Dock by `margin`, until he drags it somewhere; then there,
/// on that screen, until he drags it again, lets go of it near bottom centre, or double-clicks it home. Screen
/// coordinates, y up, as AppKit has them.
public enum ReplyLinePlacement {
    /// A display as the rule sees it.
    public struct Screen: Equatable, Sendable {
        public var id: String
        public var frame: CGRect
        /// Clear of the menu bar and the Dock.
        public var visible: CGRect

        public init(id: String, frame: CGRect, visible: CGRect) {
            self.id = id
            self.frame = frame
            self.visible = visible
        }
    }

    /// Where it sits: its glass, the screen it is on, and the edge a longer draft grows it from.
    public struct Placed: Equatable, Sendable {
        public var frame: CGRect
        public var screen: String
        /// In the top half of its screen it hangs from its top edge and grows down; in the bottom half it stands on its
        /// bottom edge and grows up.
        public var growsDown: Bool
    }

    /// Between the glass and the Dock (or the screen's foot with the Dock hidden or at a side): the panel's own margin
    /// in from its corner (`PanelGlass.Geometry.docked`), which the reply line alone kept there too, so it sits on the
    /// same line the panel would and the floating shadow under it has room.
    public static let margin: CGFloat = ConchSpace.x6
    /// Let go within this many points of bottom centre, it goes home and nothing is remembered. Three times a click's
    /// wobble (`wobble`), so an aim back at the middle by eye lands there; about 2% of the 580 pt bar, so a spot chosen
    /// on purpose just beside the middle is kept.
    public static let snap: CGFloat = ConchSpace.x3
    /// Moved less than this between press and let-go, the press was a click and nothing moves: the panel's own drag
    /// threshold (`FloatingPanels.released`).
    public static let wobble: CGFloat = 4

    /// Bottom centre of `visible`, `margin` above its foot.
    public static func home(size: CGSize, in visible: CGRect) -> CGRect {
        clamped(CGRect(x: visible.midX - size.width / 2, y: visible.minY + margin, width: size.width, height: size.height), in: visible)
    }

    /// `rect` moved the least it takes to be wholly inside `visible`; centred on an axis it is too big for.
    public static func clamped(_ rect: CGRect, in visible: CGRect) -> CGRect {
        func axis(_ origin: CGFloat, _ length: CGFloat, _ low: CGFloat, _ span: CGFloat) -> CGFloat {
            guard length <= span else { return low + (span - length) / 2 }
            return min(max(origin, low), low + span - length)
        }
        return CGRect(
            x: axis(rect.minX, rect.width, visible.minX, visible.width),
            y: axis(rect.minY, rect.height, visible.minY, visible.height),
            width: rect.width,
            height: rect.height
        )
    }

    /// The spot `rect` is at on `screen`, clamped onto it first.
    public static func spot(of rect: CGRect, on screen: Screen) -> ReplyLineSpot {
        let visible = screen.visible, inside = clamped(rect, in: visible)
        func fraction(_ origin: CGFloat, _ length: CGFloat, _ low: CGFloat, _ span: CGFloat) -> Double {
            let free = span - length
            return free > 0 ? unit(Double((origin - low) / free)) : 0.5
        }
        return ReplyLineSpot(
            screen: screen.id,
            across: fraction(inside.minX, inside.width, visible.minX, visible.width),
            up: fraction(inside.minY, inside.height, visible.minY, visible.height)
        )
    }

    /// The glass, `size`, at `spot` in `visible`: wholly inside it, whatever the spot says.
    public static func frame(of spot: ReplyLineSpot, size: CGSize, in visible: CGRect) -> CGRect {
        func origin(_ fraction: Double, _ length: CGFloat, _ low: CGFloat, _ span: CGFloat) -> CGFloat {
            let free = span - length
            return free > 0 ? low + free * CGFloat(unit(fraction)) : low + free / 2
        }
        return CGRect(
            x: origin(spot.across, size.width, visible.minX, visible.width),
            y: origin(spot.up, size.height, visible.minY, visible.height),
            width: size.width,
            height: size.height
        )
    }

    /// The screen it goes on. The spot's own, while that display is there. Else the one it is on now (`current`): it
    /// stays put while it shows, so conch steering Terminal forward on another display, which moves the main screen,
    /// or the pointer wandering, never moves it. Else, with no spot, the panel's (`home`); then the pointer's; then the
    /// main one; then any.
    public static func screen(for spot: ReplyLineSpot?, in screens: [Screen], current: String?, home: String?, pointer: CGPoint?, main: String?) -> Screen? {
        func named(_ id: String?) -> Screen? { id.flatMap { id in screens.first { $0.id == id } } }
        if let own = named(spot?.screen) { return own }
        if let here = named(current) { return here }
        if spot == nil, let panel = named(home) { return panel }
        if let pointer, let under = screens.first(where: { $0.frame.contains(pointer) }) { return under }
        return named(main) ?? screens.first
    }

    /// The one rule: at the spot on its screen, else bottom centre of the screen `screen(for:…)` picks. The width of the
    /// window's composer (`ComposerDockGeometry.replyLineWidth`), `height` tall.
    public static func place(measure: CGFloat, height: CGFloat, spot: ReplyLineSpot?, screens: [Screen], current: String?, home: String?, pointer: CGPoint?, main: String?) -> Placed? {
        guard let screen = screen(for: spot, in: screens, current: current, home: home, pointer: pointer, main: main) else { return nil }
        let visible = screen.visible
        let size = CGSize(width: ComposerDockGeometry.replyLineWidth(measure: measure, in: visible), height: height)
        let frame = spot.flatMap { $0.screen == screen.id ? self.frame(of: $0, size: size, in: visible) : nil } ?? self.home(size: size, in: visible)
        return Placed(frame: frame, screen: screen.id, growsDown: frame.midY > visible.midY)
    }

    /// Let go at `rect`: on the screen under its middle (else under the pointer, else the one it covers most), wholly on
    /// it, at that screen's width. Within `snap` of bottom centre it goes home and `spot` is nil: nothing to remember.
    /// Otherwise `spot` is where it came to rest.
    public static func released(_ rect: CGRect, screens: [Screen], pointer: CGPoint?, measure: CGFloat) -> (placed: Placed, spot: ReplyLineSpot?)? {
        let middle = CGPoint(x: rect.midX, y: rect.midY)
        func covered(_ screen: Screen) -> CGFloat {
            let overlap = screen.frame.intersection(rect)
            return overlap.isNull ? 0 : overlap.width * overlap.height
        }
        guard let screen = screens.first(where: { $0.frame.contains(middle) })
            ?? pointer.flatMap({ pointer in screens.first { $0.frame.contains(pointer) } })
            ?? screens.max(by: { covered($0) < covered($1) }) else { return nil }
        let visible = screen.visible
        let width = ComposerDockGeometry.replyLineWidth(measure: measure, in: visible)
        let rest = clamped(CGRect(x: rect.midX - width / 2, y: rect.minY, width: width, height: rect.height), in: visible)
        let home = home(size: rest.size, in: visible)
        if hypot(rest.minX - home.minX, rest.minY - home.minY) <= snap {
            return (Placed(frame: home, screen: screen.id, growsDown: home.midY > visible.midY), nil)
        }
        return (Placed(frame: rest, screen: screen.id, growsDown: rest.midY > visible.midY), spot(of: rest, on: screen))
    }

    /// The pointer went further than a click's wobble between press and let-go: the press was a move.
    public static func isMove(from press: CGPoint, to release: CGPoint) -> Bool {
        hypot(release.x - press.x, release.y - press.y) > wobble
    }

    /// 0 to 1; the middle for anything that is not a number.
    private static func unit(_ value: Double) -> Double {
        value.isFinite ? min(1, max(0, value)) : 0.5
    }
}

// MARK: - The glass in flight

/// The input's glass as the swoop draws it, at `chrome` from the window's card (0: the surface and its hairline) to the
/// panel's glass (1: the overlay's strong glass and its line), in one appearance: sRGB components with alpha, for a host
/// that draws it itself (the Mac's swoop, in Core Animation) and for the gallery. Its shadow is the floating elevation
/// both ends wear (`ConchElevation.floating`), lifted mid-flight.
public struct ComposerGlass: Equatable, Sendable {
    public var fill: SIMD4<Double>
    public var line: SIMD4<Double>
    public var shadowOpacity: Double
    public var shadowRadius: CGFloat
    public var shadowY: CGFloat

    public init(chrome: CGFloat, lift: CGFloat = 0, dark: Bool) {
        let scheme: ColorSchemeName = dark ? .dark : .light
        func components(_ token: ConchColorToken) -> SIMD4<Double> {
            let rgba = scheme == .dark ? token.dark : token.light
            return SIMD4(rgba.red, rgba.green, rgba.blue, rgba.alpha)
        }
        let t = Double(min(1, max(0, chrome)))
        fill = components(ConchColor.surface) + (components(ConchColor.overlayGlassStrong) - components(ConchColor.surface)) * t
        line = components(ConchColor.hairline) + (components(ConchColor.overlayLine) - components(ConchColor.hairline)) * t
        let elevation = ConchElevation.floating
        let raised = 1 + 0.5 * Double(min(1, max(0, lift)))
        shadowOpacity = min(1, (dark ? elevation.darkOpacity : elevation.opacity) * (1 + 0.3 * Double(min(1, max(0, lift)))))
        shadowRadius = elevation.radius * CGFloat(raised)
        shadowY = elevation.y * CGFloat(raised)
    }

    private enum ColorSchemeName { case light, dark }
}
