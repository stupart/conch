import SwiftUI

/// The breath behind an agent at work: a halo of `active` blue that comes and goes, slowly, behind the working dot in
/// the Mac's sidebar and the phone's list.
///
/// It is the one mark in the list that moves, and only by enough to say "alive": the marks that want something
/// (waiting, needs, review) stay still, so this never competes with them. The dot in front never fades, so it holds
/// its 3:1 at every instant; only the halo comes and goes. Under Reduce Motion there is no halo at all, just the dot.
///
/// Every halo breathes on the same clock, so a list of working sessions rises and falls together rather than
/// flickering out of step.
public struct ActiveHalo: View {
    let diameter: CGFloat
    let phase: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var rendersStatically

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

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || phase != nil || rendersStatically)) { timeline in
            let time = phase.map { $0 * ConchMotion.activeBreathPeriod }
                ?? (rendersStatically ? 0 : timeline.date.timeIntervalSinceReferenceDate)
            Circle()
                .fill(ConchColor.active)
                .frame(width: diameter, height: diameter)
                .opacity(Self.opacity(at: time, reduceMotion: reduceMotion))
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
