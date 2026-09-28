import QuartzCore
import SwiftUI
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif

/// The breath behind an agent at work: a halo of `active` blue that comes and goes, slowly, behind the working dot in
/// the Mac's sidebar and the phone's list.
///
/// It is the one mark in the list that moves, and only by enough to say "alive": the marks that want something
/// (waiting, needs, review) stay still, so this never competes with them. The dot in front never fades, so it holds
/// its 3:1 at every instant; only the halo comes and goes. Under Reduce Motion there is no halo at all, just the dot.
///
/// Every halo breathes on the same clock, so a list of working sessions rises and falls together rather than
/// flickering out of step.
///
/// Core Animation plays the breath (`BreathingDisc`), not a SwiftUI clock. It was a `TimelineView` at 30 frames a
/// second, one per working row, and each frame re-ran the whole window's view graph: measured on the Mac app's own
/// views over Tyler's published state (eleven working rows, 28 Sep), 11.9% of a core with the window doing nothing
/// else, against 1.1% with the same rows waiting — and it went on ticking in a window that was hidden or never shown.
/// A layer animation is drawn by the window server from keyframes it is handed once, so a breathing list costs the app
/// nothing per frame, and nothing at all where it can't be seen.
public struct ActiveHalo: View {
    let diameter: CGFloat
    let phase: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var rendersStatically
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.conchDarkness) private var darkness

    /// `phase`, 0 to 1 through one breath, draws a single still frame of it, for the gallery.
    public init(diameter: CGFloat, phase: Double? = nil) {
        self.diameter = diameter
        self.phase = phase
    }

    /// The halo at its fullest: enough to see that the list is alive, too little to be taken for a mark of its own.
    /// Tuned by picture (the gallery's ledger-marks): at 0.26 a working row, at its peak, weighed as much as a
    /// waiting one.
    public static let peak = 0.2
    /// How far the halo reaches past the dot, the same at every size: proportional, the phone's 15 pt dot grew a
    /// 27 pt disc that crowded its label.
    public static let ring: CGFloat = 3

    /// How much of the halo shows `time` seconds in: a slow sine from nothing to `peak` and back, once per
    /// `ConchMotion.activeBreathPeriod`. Always nothing under Reduce Motion, which leaves the still dot.
    public static func opacity(at time: Double, reduceMotion: Bool) -> Double {
        guard !reduceMotion else { return 0 }
        return peak * (0.5 - 0.5 * cos(2 * .pi * time / ConchMotion.activeBreathPeriod))
    }

    /// One breath as Core Animation plays it: `opacity(at:)` at `samples` even steps through a period, both ends
    /// included, joined by straight lines. At 48 a step is a twelfth of a second, and the line between two samples is
    /// never more than 0.0005 from the sine — far below a visible step in a halo that peaks at 0.2.
    public static func keyframes(samples: Int = 48) -> [Double] {
        let period = ConchMotion.activeBreathPeriod
        return (0...samples).map { opacity(at: Double($0) * period / Double(samples), reduceMotion: false) }
    }

    /// Where in its breath a halo starts, `time` being now on the shared clock (seconds since the reference date): so
    /// a halo added later picks the breath up where every other halo is, rather than starting its own from nothing.
    public static func clockOffset(at time: Double) -> Double {
        let period = ConchMotion.activeBreathPeriod
        let into = time.truncatingRemainder(dividingBy: period)
        return into < 0 ? into + period : into
    }

    public var body: some View {
        Group {
            if reduceMotion {
                // No halo at all, just the dot: nothing drawn, and no clock left running for it.
                Color.clear
            } else if phase != nil || rendersStatically {
                // A still frame (the gallery, whose ImageRenderer cannot draw a platform view): the same function the
                // breath is sampled from, drawn once.
                let time = phase.map { $0 * ConchMotion.activeBreathPeriod } ?? 0
                Circle()
                    .fill(ConchColor.active)
                    .opacity(Self.opacity(at: time, reduceMotion: reduceMotion))
            } else {
                BreathingDisc(colour: darkness.map { ConchColor.active.rgba(darkness: $0) } ?? ConchColor.active.rgba(colorScheme))
            }
        }
        .frame(width: diameter, height: diameter)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension View {
    /// Breathes `ActiveHalo` behind this mark, sized from the mark's `pointSize`. A background, so the mark keeps its
    /// own size and baseline in whatever row it sits in; nothing at all when `breathes` is false, so a list's other
    /// marks carry no halo to pause.
    public func activeBreath(pointSize: CGFloat, breathes: Bool = true, phase: Double? = nil) -> some View {
        background {
            if breathes {
                ActiveHalo(diameter: pointSize + 2 * ActiveHalo.ring, phase: phase)
            }
        }
    }
}

/// The working mark whole: `active`'s dot with its breath. For the places that draw it on its own (the legend, the
/// gallery); the lists draw their own dot and add `activeBreath`.
public struct ActiveMark: View {
    let pointSize: CGFloat
    let phase: Double?

    public init(pointSize: CGFloat = 8, phase: Double? = nil) {
        self.pointSize = pointSize
        self.phase = phase
    }

    public var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: pointSize, weight: .medium))
            .foregroundStyle(ConchColor.active)
            .activeBreath(pointSize: pointSize, phase: phase)
    }
}

// MARK: - The breath, played by Core Animation

/// The halo's disc as a layer whose opacity Core Animation keyframes through `ActiveHalo.keyframes()`, forever, on the
/// shared clock (`ActiveHalo.clockOffset`). Handed over once when the view reaches a window; the app does no work per
/// frame after that.
final class BreathingLayer {
    static let key = "conch.breath"
    /// The breath never needs more than this: a 0.2 swing over four seconds moves less than a hundredth a frame here,
    /// and the window server is left free to draw it at less.
    static let frameRate = CAFrameRateRange(minimum: 10, maximum: 30, preferred: 30)

    let disc = CALayer()

    init() {
        // The model value: seen only if the animation is ever gone, and then the dot stands alone, as under Reduce Motion.
        disc.opacity = 0
    }

    func layout(in bounds: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        disc.frame = bounds
        disc.cornerRadius = min(bounds.width, bounds.height) / 2
        CATransaction.commit()
    }

    func paint(_ colour: ConchRGBA) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        disc.backgroundColor = CGColor(srgbRed: colour.red, green: colour.green, blue: colour.blue, alpha: colour.alpha)
        CATransaction.commit()
    }

    /// Starts the breath where the shared clock is, unless it is already breathing. `now` is seconds since the reference
    /// date, for tests to pin.
    func breathe(now: Double = Date().timeIntervalSinceReferenceDate) {
        guard disc.animation(forKey: Self.key) == nil else { return }
        disc.add(Self.animation(now: now), forKey: Self.key)
    }

    static func animation(now: Double) -> CAKeyframeAnimation {
        let breath = CAKeyframeAnimation(keyPath: "opacity")
        breath.values = ActiveHalo.keyframes().map { NSNumber(value: $0) }
        breath.calculationMode = .linear
        breath.duration = ConchMotion.activeBreathPeriod
        breath.repeatCount = .infinity
        breath.timeOffset = ActiveHalo.clockOffset(at: now)
        breath.isRemovedOnCompletion = false
        breath.preferredFrameRateRange = frameRate
        return breath
    }
}

#if canImport(AppKit)
struct BreathingDisc: NSViewRepresentable {
    let colour: ConchRGBA

    func makeNSView(context: Context) -> BreathingDiscView { BreathingDiscView() }

    func updateNSView(_ view: BreathingDiscView, context: Context) { view.colour = colour }
}

final class BreathingDiscView: NSView {
    let breath = BreathingLayer()
    var colour = ConchRGBA(0x0A84FF) { didSet { if colour != oldValue { breath.paint(colour) } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(breath.disc)
        breath.paint(colour)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        breath.layout(in: bounds)
    }

    /// A window is where it can be seen: the breath is handed over there, and again if a move lost it.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { breath.breathe() }
    }
}
#else
struct BreathingDisc: UIViewRepresentable {
    let colour: ConchRGBA

    func makeUIView(context: Context) -> BreathingDiscView { BreathingDiscView() }

    func updateUIView(_ view: BreathingDiscView, context: Context) { view.colour = colour }
}

final class BreathingDiscView: UIView {
    let breath = BreathingLayer()
    var colour = ConchRGBA(0x0A84FF) { didSet { if colour != oldValue { breath.paint(colour) } } }

    private var foreground: NSObjectProtocol?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(breath.disc)
        breath.paint(colour)
        foreground = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.window != nil { self?.breath.breathe() } }
        }
    }

    required init?(coder: NSCoder) { nil }

    deinit { foreground.map(NotificationCenter.default.removeObserver) }

    override func layoutSubviews() {
        super.layoutSubviews()
        breath.layout(in: bounds)
    }

    /// A window is where it can be seen: the breath is handed over there, and again if a move lost it (UIKit drops a
    /// layer's animations when its view leaves the window, and when the app goes to the background).
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { breath.breathe() }
    }
}
#endif
