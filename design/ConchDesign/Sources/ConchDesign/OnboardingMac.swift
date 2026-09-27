import SwiftUI

// The Mac's setup window: a rail of the steps on the left, with the downloads under them, and one step at a time on the
// right. Every view here is drawn from data (Onboarding.swift, OnboardingParts.swift) and acts through closures, so the
// app hosts it with live state and the gallery with fixtures.

/// The window's measures.
public enum OnboardingWindowMetrics {
    public static let size = CGSize(width: 880, height: 620)
    /// The rail, and how far it floats in from the window's edges.
    public static let railWidth: CGFloat = 220
    public static let railInset: CGFloat = 10
    /// Room at the top of the rail for the window's own buttons.
    public static let titlebar: CGFloat = 40
    public static let pagePadding = EdgeInsets(top: 48, leading: 44, bottom: 22, trailing: 40)
}

// MARK: - The window

/// Setup's window: the rail and the step. The window's own buttons sit over the rail's top, as a sidebar's do.
public struct OnboardingWindow<Content: View>: View {
    let progress: OnboardingProgress
    let steps: [OnboardingStep]
    let downloads: [OnboardingDownload]
    let details: [OnboardingStep: String]
    let onOpen: (OnboardingStep) -> Void
    let onRetry: ((OnboardingDownload) -> Void)?
    let content: Content

    /// `steps` is the rail this Mac shows (`OnboardingReadiness.rail`): no Try it until the practice turn is built.
    public init(progress: OnboardingProgress, steps: [OnboardingStep] = OnboardingStep.rail, downloads: [OnboardingDownload],
                details: [OnboardingStep: String] = [:], onOpen: @escaping (OnboardingStep) -> Void = { _ in },
                onRetry: ((OnboardingDownload) -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.progress = progress
        self.steps = steps
        self.downloads = downloads
        self.details = details
        self.onOpen = onOpen
        self.onRetry = onRetry
        self.content = content()
    }

    public var body: some View {
        HStack(spacing: 0) {
            OnboardingRail(progress: progress, steps: steps, downloads: downloads, details: details, onOpen: onOpen, onRetry: onRetry)
                .padding(OnboardingWindowMetrics.railInset)
                .padding(.trailing, -OnboardingWindowMetrics.railInset / 2)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(width: OnboardingWindowMetrics.size.width, height: OnboardingWindowMetrics.size.height)
        .background(ConchColor.ground)
    }
}

/// The rail caught part way between two steps, for a picture of the move: the highlight between the two rows, and the
/// step being left popping its check in. The app never sets it (its highlight moves on its own spring); the gallery does,
/// to draw the move frame by frame.
public struct OnboardingRailMove: Equatable, Sendable {
    public let from: OnboardingStep
    /// The highlight's travel, 0 at `from` to 1 at the progress's step (the pop spring's value, so it can overshoot).
    public let travel: CGFloat
    /// The left step's check, 0.5 to 1 as it pops in.
    public let check: CGFloat

    public init(from: OnboardingStep, travel: CGFloat, check: CGFloat) {
        self.from = from
        self.travel = travel
        self.check = check
    }
}

extension EnvironmentValues {
    @Entry public var onboardingRailMove: OnboardingRailMove? = nil
}

/// The steps, where each stands, and the downloads under them.
public struct OnboardingRail: View {
    let progress: OnboardingProgress
    let steps: [OnboardingStep]
    let downloads: [OnboardingDownload]
    let details: [OnboardingStep: String]
    let onOpen: (OnboardingStep) -> Void
    let onRetry: ((OnboardingDownload) -> Void)?
    @Environment(\.conchAppIcon) private var icon
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onboardingRailMove) private var move
    @Namespace private var current

    /// A row's height and the gap between rows.
    static let rowPitch: CGFloat = 36

    public init(progress: OnboardingProgress, steps: [OnboardingStep] = OnboardingStep.rail, downloads: [OnboardingDownload],
                details: [OnboardingStep: String] = [:], onOpen: @escaping (OnboardingStep) -> Void = { _ in },
                onRetry: ((OnboardingDownload) -> Void)? = nil) {
        self.progress = progress
        self.steps = steps
        self.downloads = downloads
        self.details = details
        self.onOpen = onOpen
        self.onRetry = onRetry
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: OnboardingWindowMetrics.titlebar)
            HStack(spacing: 10) {
                AppIconView(size: 30)
                VStack(alignment: .leading, spacing: 0) {
                    Text("conch").font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                    Text("Setup").font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 18)

            VStack(spacing: 2) {
                ForEach(Array(steps.enumerated()), id: \.element) { index, step in
                    stepRow(step, number: index + 1)
                }
            }
            .background(alignment: .top) {
                if let move, let from = steps.firstIndex(of: move.from), let to = steps.firstIndex(of: progress.step) {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(ConchColor.fillSelected)
                        .conchElevation(.raised)
                        .frame(height: 34)
                        .offset(y: (CGFloat(from) + (CGFloat(to) - CGFloat(from)) * move.travel) * Self.rowPitch)
                }
            }

            Spacer(minLength: 12)
            if !downloads.isEmpty {
                DownloadsTray(downloads: downloads, onRetry: onRetry)
            }
        }
        .padding(10)
        .frame(width: OnboardingWindowMetrics.railWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(ConchColor.fill)
        )
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: progress.step)
    }

    private func stepRow(_ step: OnboardingStep, number: Int) -> some View {
        let isCurrent = progress.step == step
        let mark = progress.mark(step)
        return Button { onOpen(step) } label: {
            HStack(spacing: 10) {
                StepMark(mark: mark, number: number, current: isCurrent)
                    .scaleEffect(move?.from == step ? move!.check : 1)
                Text(step.title)
                    .font(.system(size: 13, weight: isCurrent ? .semibold : .medium))
                    .foregroundStyle(isCurrent || mark == .done ? ConchColor.textPrimary : ConchColor.textSecondary)
                Spacer(minLength: 4)
                if let detail = details[step] ?? (mark == .later ? "Later" : nil) {
                    Text(detail)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(ConchColor.textTertiary)
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 34)
            .background {
                if isCurrent, move == nil {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(ConchColor.fillSelected)
                        .conchElevation(.raised)
                        .matchedGeometryEffect(id: "current", in: current)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(step.title), \(mark == .done ? "done" : mark == .later ? "left for later" : isCurrent ? "current step" : "to do")")
    }
}

/// A step's mark in the rail: its number, ink while it's the one open, a check when done, a dashed ring when left for later.
struct StepMark: View {
    let mark: OnboardingMark
    let number: Int
    let current: Bool
    var size: CGFloat = 18

    var body: some View {
        ZStack {
            switch (mark, current) {
            case (.done, _):
                OnboardingCheck(size: size).transition(.scale(scale: 0.6).combined(with: .opacity))
            case (_, true):
                Circle().fill(ConchColor.accent)
                Text("\(number)").font(.system(size: size * 0.55, weight: .bold)).foregroundStyle(ConchColor.onAccent)
            case (.later, false):
                Circle().strokeBorder(ConchColor.textTertiary, style: StrokeStyle(lineWidth: 1.2, dash: [2.2, 2.2]))
            case (.todo, false):
                Circle().strokeBorder(ConchColor.textTertiary.opacity(0.7), lineWidth: 1.2)
                Text("\(number)").font(.system(size: size * 0.55, weight: .semibold)).foregroundStyle(ConchColor.textTertiary)
            }
        }
        .frame(width: size, height: size)
    }
}

/// The app's icon at a size, with the corners and the lift an icon has in the Dock. The mark stands in when there is none.
public struct AppIconView: View {
    let size: CGFloat
    var lifted = false
    @Environment(\.conchAppIcon) private var icon

    public init(size: CGFloat, lifted: Bool = false) {
        self.size = size
        self.lifted = lifted
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
        Group {
            if let icon {
                icon.resizable().interpolation(.high).aspectRatio(contentMode: .fill)
            } else {
                ZStack {
                    Rectangle().fill(ConchColor.surface)
                    ConchMarkView().frame(width: size * 0.6, height: size * 0.6)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5))
        .shadow(color: .black.opacity(lifted ? 0.22 : 0.1), radius: lifted ? size * 0.12 : 1.5, y: lifted ? size * 0.07 : 1)
        .accessibilityHidden(true)
    }
}

/// What's downloading, under the steps. It says how much is left and never asks for anything unless something fails.
public struct DownloadsTray: View {
    let downloads: [OnboardingDownload]
    let onRetry: ((OnboardingDownload) -> Void)?

    /// `onRetry`, when given, makes a failed download's Retry a button; without it a failure only says when it tries again.
    public init(downloads: [OnboardingDownload], onRetry: ((OnboardingDownload) -> Void)? = nil) {
        self.downloads = downloads
        self.onRetry = onRetry
    }

    /// How many are ready: only speech recognition knows its bytes (the voices are built in steps), so a byte total
    /// across both would be a guess.
    private var summary: String {
        let ready = downloads.filter(\.isReady).count
        return ready == downloads.count ? "Ready" : "\(ready) of \(downloads.count) ready"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(ConchColor.hairlineStrong).frame(height: 1).padding(.bottom, 2)
            HStack {
                Text("Downloads").font(.system(size: 11, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
                Spacer()
                Text(summary).font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary).monospacedDigit()
            }
            ForEach(downloads) { item in DownloadLine(item: item, onRetry: onRetry) }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }
}

struct DownloadLine: View {
    let item: OnboardingDownload
    /// Off where the row beside it already names the download (Settings › Setup).
    var showsTitle = true
    var onRetry: ((OnboardingDownload) -> Void)?

    var body: some View {
        VStack(alignment: showsTitle ? .leading : .trailing, spacing: 5) {
            HStack(spacing: 6) {
                if showsTitle {
                    Text(item.title).font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textPrimary).lineLimit(1)
                }
                Spacer(minLength: 4)
                trailing
            }
            switch item.state {
            case let .downloading(done, total, _):
                OnboardingProgressBar(total > 0 ? done / total : 0, height: 3)
            case let .offline(done, total):
                OnboardingProgressBar(total > 0 ? done / total : 0, height: 3, tint: ConchColor.textTertiary)
            default:
                EmptyView()
            }
            if let note {
                Text(note.text)
                    .font(.system(size: 11))
                    .foregroundStyle(note.alert ? ConchColor.attention : ConchColor.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        switch item.state {
        case .queued:
            Text("Next").font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
        case let .downloading(done, total, _):
            Text("\(Int((total > 0 ? done / total * 100 : 0).rounded()))%").font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary).monospacedDigit()
        case .installing:
            OnboardingSpinner(size: 11)
        case .ready:
            OnboardingCheck(size: 14)
        case .failed, .noSpace:
            if let onRetry, item.canRetry {
                Button { onRetry(item) } label: {
                    Text("Retry").font(.system(size: 11, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                        .padding(.horizontal, 8).frame(height: 20).background(Capsule().fill(ConchColor.surface))
                        .contentShape(Capsule())
                }
                .buttonStyle(OnboardingPress())
                .accessibilityLabel("Retry \(item.title)")
            } else {
                Image(systemName: "exclamationmark.circle").font(.system(size: 11, weight: .semibold)).foregroundStyle(ConchColor.attention)
            }
        case .offline:
            Image(systemName: "wifi.slash").font(.system(size: 10, weight: .semibold)).foregroundStyle(ConchColor.textTertiary)
        }
    }

    private var note: (text: String, alert: Bool)? {
        switch item.state {
        case let .downloading(_, _, secondsLeft?): (Self.left(secondsLeft), false)
        case let .installing(step): (step, false)
        case let .failed(reason): (reason, true)
        case .offline: ("Waiting for the internet. It carries on from here.", false)
        case let .noSpace(needs, free): ("Needs \(OnboardingDownload.size(needs)) free; this Mac has \(OnboardingDownload.size(free)).", true)
        default: nil
        }
    }

    static func left(_ seconds: Int) -> String {
        seconds < 60 ? "Less than a minute left" : seconds < 120 ? "About a minute left" : "About \(seconds / 60) minutes left"
    }
}

// MARK: - A step's page

/// One step: what it's called, a line on why, the step itself, and the buttons that move on.
public struct OnboardingPage<Content: View>: View {
    let title: String
    let lede: String
    let note: String?
    let primary: String?
    let secondary: String?
    /// False while the step waits on something only the person can do (speaking, for the microphone check).
    let primaryEnabled: Bool
    let onPrimary: () -> Void
    let onSecondary: () -> Void
    let content: Content

    public init(title: String, lede: String, note: String? = nil, primary: String? = "Continue", secondary: String? = "Skip for now",
                primaryEnabled: Bool = true, onPrimary: @escaping () -> Void = {}, onSecondary: @escaping () -> Void = {},
                @ViewBuilder content: () -> Content) {
        self.title = title
        self.lede = lede
        self.note = note
        self.primary = primary
        self.secondary = secondary
        self.primaryEnabled = primaryEnabled
        self.onPrimary = onPrimary
        self.onSecondary = onSecondary
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(OnboardingType.display)
                .tracking(-0.5)
                .foregroundStyle(ConchColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
            Text(lede)
                .font(OnboardingType.lede)
                .foregroundStyle(ConchColor.textSecondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 500, alignment: .leading)
                .padding(.top, 8)
            content
                .padding(.top, 24)
            Spacer(minLength: 16)
            HStack(alignment: .center, spacing: 14) {
                if let note {
                    Text(note)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textTertiary)
                        .lineSpacing(1.5)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 300, alignment: .leading)
                }
                Spacer(minLength: 0)
                if let secondary { OnboardingButton(secondary, style: .quiet, action: onSecondary) }
                if let primary {
                    // Return is the step's one way on.
                    OnboardingButton(primary, action: onPrimary)
                        .keyboardShortcut(.defaultAction)
                        .opacity(primaryEnabled ? 1 : 0.32)
                        .disabled(!primaryEnabled)
                }
            }
        }
        .padding(OnboardingWindowMetrics.pagePadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// A page giving way to the next on `swap`: the old one leaves soft and a touch large, the new one arrives from a touch
/// small. Reduce Motion keeps the timing and only fades.
public struct OnboardingSwap: ViewModifier {
    let scale: CGFloat
    let blur: CGFloat
    let opacity: Double

    public func body(content: Content) -> some View {
        content.scaleEffect(scale).blur(radius: blur).opacity(opacity)
    }
}

extension AnyTransition {
    /// One setup page giving way to the next (`ConchMotion.swap`); pair it with `ConchMotion.swap.animation(reduceMotion:)`.
    public static func onboardingSwap(reduceMotion: Bool) -> AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .modifier(active: OnboardingSwap(scale: ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0),
                                 identity: OnboardingSwap(scale: 1, blur: 0, opacity: 1)),
            removal: .modifier(active: OnboardingSwap(scale: 1 / ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0),
                               identity: OnboardingSwap(scale: 1, blur: 0, opacity: 1))
        )
    }
}

// MARK: - Welcome

/// The first screen, before the rail: who conch is, in one line, and one button.
public struct OnboardingWelcome: View {
    public enum Backdrop: Sendable {
        /// The app's own ground: calm, and the icon the only colour.
        case calm
        /// The shore: water above, sand below, the icon at the waterline.
        case shore
    }

    let backdrop: Backdrop
    let onBegin: () -> Void
    let onLater: () -> Void
    @Environment(\.colorScheme) private var scheme

    public init(backdrop: Backdrop = .calm, onBegin: @escaping () -> Void = {}, onLater: @escaping () -> Void = {}) {
        self.backdrop = backdrop
        self.onBegin = onBegin
        self.onLater = onLater
    }

    public var body: some View {
        ZStack {
            switch backdrop {
            case .calm: Rectangle().fill(ConchColor.ground)
            case .shore: ShoreBackdrop()
            }
            VStack(spacing: 0) {
                AppIconView(size: 116, lifted: true)
                    .padding(.top, backdrop == .shore ? 62 : 104)
                    .padding(.bottom, backdrop == .shore ? 78 : 34)
                Text("rally your agents.")
                    .font(OnboardingType.welcome)
                    .tracking(-1.4)
                    .foregroundStyle(ConchColor.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text("conch reads your agents' finished work aloud, brings you what they made, and takes your answer by voice, here or on your iPhone.")
                    .font(.system(size: 15))
                    .foregroundStyle(ConchColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3.5)
                    .frame(maxWidth: 480)
                    .padding(.top, 14)
                OnboardingButton("Set up conch", size: .large, action: onBegin)
                    .keyboardShortcut(.defaultAction)
                    .padding(.top, 30)
                Text("About three minutes. Voices and speech recognition (2.2 GB) download as you go, and run on this Mac.")
                    .font(.system(size: 12))
                    .foregroundStyle(ConchColor.textTertiary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(1.5)
                    .frame(maxWidth: 360)
                    .padding(.top, 16)
                Spacer(minLength: 0)
                OnboardingButton("Set up later", style: .quiet, action: onLater)
                    .padding(.bottom, 20)
            }
            .padding(.horizontal, 40)
        }
        .frame(width: OnboardingWindowMetrics.size.width, height: OnboardingWindowMetrics.size.height)
    }
}

/// Water over sand, very soft: the lagoon the brand lives in, held back to a wash so the words stay the loudest thing.
struct ShoreBackdrop: View {
    /// Where the water meets the sand, from the top: between the icon (it ends at 178) and the line (it starts at 256).
    static let waterline: CGFloat = 214
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        let line = Self.waterline
        GeometryReader { proxy in
            let size = proxy.size
            ZStack(alignment: .top) {
                LinearGradient(
                    colors: dark
                        ? [Color(red: 0.04, green: 0.11, blue: 0.18), Color(red: 0.06, green: 0.24, blue: 0.33)]
                        : [Color(red: 0.84, green: 0.94, blue: 0.97), Color(red: 0.56, green: 0.80, blue: 0.90)],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: line + 30)
                // Light from above, as it falls through shallow water.
                ZStack {
                    ForEach(0..<6, id: \.self) { index in
                        Capsule()
                            .fill(Color.white.opacity(dark ? 0.05 : 0.32))
                            .frame(width: CGFloat(22 + (index % 3) * 14), height: line * 1.6)
                            .rotationEffect(.degrees(Double(-24 + index * 10)))
                            .offset(x: CGFloat(-190 + index * 76), y: -line * 0.35)
                    }
                }
                .blur(radius: 16)
                .frame(width: size.width, height: line + 30)
                .clipped()
                // Wet sand first, then dry: the tide's last reach.
                ShoreLine(amplitude: 6, waves: 2.2, phase: 0.6)
                    .fill(dark ? Color(red: 0.17, green: 0.15, blue: 0.12) : Color(red: 0.90, green: 0.84, blue: 0.74))
                    .frame(height: size.height - line)
                    .offset(y: line)
                ShoreLine(amplitude: 5, waves: 2.2, phase: 1.3)
                    .fill(dark ? Color(red: 0.12, green: 0.11, blue: 0.10) : Color(red: 0.96, green: 0.93, blue: 0.87))
                    .frame(height: size.height - line - 16)
                    .offset(y: line + 16)
                ShoreLine(amplitude: 6, waves: 2.2, phase: 0.6, open: true)
                    .stroke(Color.white.opacity(dark ? 0.16 : 0.85), lineWidth: 2)
                    .frame(height: size.height - line)
                    .offset(y: line)
            }
        }
    }
}

/// The top edge of the sand: a long, low swell. Open, it is the edge alone, for the foam along it.
struct ShoreLine: Shape {
    var amplitude: CGFloat
    var waves: CGFloat
    var phase: CGFloat = 0.6
    var open = false

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let steps = 96
        for index in 0...steps {
            let x = rect.width * CGFloat(index) / CGFloat(steps)
            let y = amplitude * sin(CGFloat(index) / CGFloat(steps) * waves * 2 * .pi + phase) + amplitude
            if index == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        if !open {
            path.addLine(to: CGPoint(x: rect.width, y: rect.maxY))
            path.addLine(to: CGPoint(x: 0, y: rect.maxY))
            path.closeSubpath()
        }
        return path
    }
}

// MARK: - Agents

public struct OnboardingAgentsStep: View {
    let agents: [OnboardingAgent]
    /// Said in place of the rows when there are none to show: the daemon hasn't answered.
    let problem: String?
    let onAction: (OnboardingAgent.Kind, OnboardingAgentAction) -> Void
    let onContinue: () -> Void
    let onSkip: () -> Void

    public init(agents: [OnboardingAgent], problem: String? = nil,
                onAction: @escaping (OnboardingAgent.Kind, OnboardingAgentAction) -> Void = { _, _ in },
                onContinue: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {}) {
        self.agents = agents
        self.problem = problem
        self.onAction = onAction
        self.onContinue = onContinue
        self.onSkip = onSkip
    }

    /// None on this Mac yet (or only on its way): the page offers to install rather than reporting what it found.
    private var noneYet: Bool {
        !agents.isEmpty && agents.allSatisfy { agent in
            switch agent.state {
            case .missing, .installing, .failed: true
            default: false
            }
        }
    }

    public var body: some View {
        OnboardingPage(
            title: noneYet ? "Get an agent" : "Your agents",
            lede: noneYet
                ? "conch works with Claude Code and Codex, and neither is on this Mac yet. Install one here; conch connects it when it's done."
                : "conch listens to the coding agents you already use. Here's what it found on this Mac.",
            note: noneYet
                ? "Each installs with its own official installer, and you sign in with your own account."
                : "Connecting adds conch's hooks and plugin to the agent's own settings, and backs them up first.",
            secondary: noneYet ? "Later" : "Skip for now",
            onPrimary: onContinue,
            onSecondary: onSkip
        ) {
            if agents.isEmpty {
                HStack(spacing: 10) {
                    if let problem {
                        Image(systemName: "exclamationmark.circle").font(.system(size: 13)).foregroundStyle(ConchColor.attention)
                        Text(problem).font(OnboardingType.rowDetail).foregroundStyle(ConchColor.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        OnboardingSpinner(size: 13)
                        Text("Looking for your agents…").font(OnboardingType.rowDetail).foregroundStyle(ConchColor.textSecondary)
                    }
                }
                .padding(.top, 4)
            } else {
                OnboardingCard {
                    ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                        if index > 0 { OnboardingDivider() }
                        OnboardingAgentRow(agent: agent) { onAction(agent.kind, $0) }
                    }
                }
            }
        }
    }
}

/// One agent: where it stands, and the one thing to press. The same row sits in Settings › Setup.
public struct OnboardingAgentRow: View {
    let agent: OnboardingAgent
    let onAction: (OnboardingAgentAction) -> Void
    @Environment(\.conchAgentMarks) private var marks

    public init(agent: OnboardingAgent, onAction: @escaping (OnboardingAgentAction) -> Void = { _ in }) {
        self.agent = agent
        self.onAction = onAction
    }

    public var body: some View {
        OnboardingRow(
            tile: OnboardingTile(image: marks[agent.kind.rawValue], fallback: agent.kind == .claude ? "asterisk" : "chevron.left.forwardslash.chevron.right",
                                 dimmed: agent.state == .missing),
            title: agent.kind.name,
            detail: detail,
            detailTone: isFailure ? ConchColor.attention : ConchColor.textSecondary
        ) {
            trailing
        } below: {
            below
        }
    }

    private var isFailure: Bool {
        if case .failed = agent.state { return true }
        return false
    }

    private var detail: String {
        switch agent.state {
        case let .connected(version, from), let .found(version, from), let .connecting(version, from): from.isEmpty ? "Version \(version)" : "Version \(version) · \(from)"
        case let .signIn(version): "Version \(version) · not signed in yet, so it can't start a session"
        case .missing: agent.kind == .claude ? "Anthropic's coding agent, in your terminal." : "OpenAI's coding agent, in your terminal."
        case .installing: "Installing with its own installer…"
        case let .failed(reason, _): reason
        case .twoCopies: "Two copies on this Mac, and they're different versions."
        }
    }

    @ViewBuilder private var trailing: some View {
        switch agent.state {
        case .connected: OnboardingStatus(.done, "Connected")
        case .found: OnboardingButton("Connect", style: .action) { onAction(.connect) }
        case .connecting: OnboardingStatus(.working, "Connecting")
        case .signIn: OnboardingButton("Sign in", systemImage: "arrow.up.forward", style: .action) { onAction(.signIn) }
        case .missing: OnboardingButton("Install", style: .action) { onAction(.install) }
        case .installing: OnboardingSpinner(size: 14)
        case .failed: OnboardingButton("Try again", style: .action) { onAction(.retry) }
        case .twoCopies: OnboardingButton("Use the newer one", style: .action)
        }
    }

    @ViewBuilder private var below: some View {
        switch agent.state {
        case let .installing(line):
            Text(line)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ConchColor.textTertiary)
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.top, 4)
        case let .failed(_, command) where !command.isEmpty:
            CopyableCommand(command) { onAction(.copy(command)) }.padding(.top, 6)
        case let .twoCopies(conch, shell):
            Self.copiesLines(conch: conch, shell: shell)
        case .connected where agent.openSessions > 0, .connecting where agent.openSessions > 0:
            HooksNote(count: agent.openSessions).padding(.top, 6)
        default:
            EmptyView()
        }
        if let note = agent.note {
            Text(note)
                .font(.system(size: 12))
                .foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
        }
        if let copies = agent.copies {
            Self.copiesLines(conch: copies.conch, shell: copies.shell)
        }
    }

    private static func copiesLines(conch: String, shell: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("conch runs \(conch)")
            Text("your shell runs \(shell)")
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ConchColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
        .padding(.top, 4)
    }
}

/// Sessions already open read their hooks only when they start.
struct HooksNote: View {
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "info.circle").font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
            (Text("\(count == 1 ? "One session is" : "\(count) sessions are") already open. Type ")
                + Text("/hooks").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(ConchColor.textPrimary)
                + Text(" in \(count == 1 ? "it" : "each") once, or restart \(count == 1 ? "it" : "them")."))
                .font(.system(size: 12))
                .foregroundStyle(ConchColor.textSecondary)
        }
    }
}

/// A command to run by hand, with a Copy.
struct CopyableCommand: View {
    let command: String
    let onCopy: () -> Void
    @State private var copied = false

    init(_ command: String, onCopy: @escaping () -> Void = {}) {
        self.command = command
        self.onCopy = onCopy
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(command)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ConchColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 4)
            Button {
                onCopy()
                copied = true
            } label: {
                Text(copied ? "Copied" : "Copy").font(.system(size: 11, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(OnboardingPress())
            .accessibilityLabel("Copy the command")
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).fill(ConchColor.fill))
    }
}

// MARK: - Permissions

public struct OnboardingPermissionsStep: View {
    let statuses: [ConchPermission: ConchPermissionStatus]
    let now: [ConchPermission]
    let whenNeeded: [OnboardingDeferredAsk]
    /// The permission whose System Settings list is open right now, which conch is watching.
    let waitingOn: ConchPermission?
    /// What went wrong doing a row's one thing (`PermissionCenter.notes`), said under it.
    let notes: [ConchPermission: String]
    /// Where each deferred ask stands, by its id: allowed already, or a reopen away.
    let deferred: [String: ConchPermissionStatus]
    let onAction: (ConchPermission, ConchPermissionAction) -> Void
    let onAllowNow: (OnboardingDeferredAsk) -> Void
    let onContinue: () -> Void
    let onSkip: () -> Void

    /// The three the voice loop needs, in the order it needs them: hearing you, then typing your reply into Terminal.
    public static let loop: [ConchPermission] = OnboardingReadiness.setupAsks

    /// `now` are Settings' own rows (`ConchPermissionRow`), asked here; `whenNeeded` are asked by the feature that uses
    /// them, the first time it does, and can be allowed early from here.
    public init(statuses: [ConchPermission: ConchPermissionStatus], now: [ConchPermission] = Self.loop,
                whenNeeded: [OnboardingDeferredAsk] = [.screenRecording, .notifications], waitingOn: ConchPermission? = nil,
                notes: [ConchPermission: String] = [:], deferred: [String: ConchPermissionStatus] = [:],
                onAction: @escaping (ConchPermission, ConchPermissionAction) -> Void = { _, _ in },
                onAllowNow: @escaping (OnboardingDeferredAsk) -> Void = { _ in },
                onContinue: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {}) {
        self.statuses = statuses
        self.now = now
        self.whenNeeded = whenNeeded
        self.waitingOn = waitingOn
        self.notes = notes
        self.deferred = deferred
        self.onAction = onAction
        self.onAllowNow = onAllowNow
        self.onContinue = onContinue
        self.onSkip = onSkip
    }

    /// While System Settings is open at a list, its row says conch is watching instead of offering the same button again.
    public static let waitingLine = "Waiting for you in System Settings…"

    public var body: some View {
        OnboardingPage(
            title: "A few permissions",
            lede: "Only the microphone is needed to talk. The other two let conch type your answer into the right Terminal.",
            note: "Each is one grant, to conch. Change them later in Settings › Permissions.",
            onPrimary: onContinue,
            onSecondary: onSkip
        ) {
            VStack(alignment: .leading, spacing: 8) {
                OnboardingCard {
                    ForEach(Array(now.enumerated()), id: \.element) { index, permission in
                        if index > 0 { OnboardingDivider(leading: 54) }
                        ConchPermissionRow(
                            permission: permission,
                            status: permission == waitingOn && statuses[permission] != .granted
                                ? .unknown(Self.waitingLine) : statuses[permission] ?? .unknown("Checking…"),
                            note: notes[permission],
                            onAction: { onAction(permission, $0) }
                        )
                        .padding(.horizontal, ConchSpace.x4)
                        .padding(.vertical, 12)
                    }
                }
                if !whenNeeded.isEmpty {
                    Text("Asked the first time you need them")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ConchColor.textTertiary)
                        .padding(.top, 8)
                        .padding(.leading, 2)
                    OnboardingCard {
                        ForEach(Array(whenNeeded.enumerated()), id: \.element.id) { index, ask in
                            if index > 0 { OnboardingDivider(leading: 54) }
                            DeferredAskRow(ask: ask, status: deferred[ask.id]) { onAllowNow(ask) }
                        }
                    }
                }
            }
        }
    }
}

/// One line for a permission asked later: what, when, and a quiet way to allow it now.
public struct DeferredAskRow: View {
    let ask: OnboardingDeferredAsk
    /// Allowed already says so instead of offering it; a reopen away offers the reopen.
    let status: ConchPermissionStatus?
    let onAllowNow: () -> Void

    public init(ask: OnboardingDeferredAsk, status: ConchPermissionStatus? = nil, onAllowNow: @escaping () -> Void = {}) {
        self.ask = ask
        self.status = status
        self.onAllowNow = onAllowNow
    }

    public var body: some View {
        HStack(spacing: ConchSpace.x4) {
            Image(systemName: ask.symbol)
                .font(.system(size: 15))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(ask.title).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary)
                Text(ask.when).font(ConchType.secondary).foregroundStyle(ConchColor.textSecondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            switch status {
            case .granted?: OnboardingStatus(.done, "Allowed")
            case .needsRelaunch?: OnboardingButton(ConchPermissionAction.reopen.title, style: .quiet, action: onAllowNow)
            case .restricted?: OnboardingStatus(.note, ConchPermissionStatus.restricted.label)
            default: OnboardingButton("Allow now", style: .quiet, action: onAllowNow)
            }
        }
        .padding(.horizontal, ConchSpace.x4)
        .frame(height: 52)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(ask.title): \(status == .granted ? "allowed" : ask.when)")
    }
}

/// Under System Settings' list while conch waits on it: conch's own tile to drag into the list, which is the whole
/// job. It never takes focus from System Settings, and closes itself a moment after the switch goes on.
public struct PermissionGuide: View {
    let permission: ConchPermission
    let granted: Bool
    /// The running app as a file, for the tile's drag: exactly this conch goes into the list.
    let dragItem: (() -> NSItemProvider)?
    let onClose: () -> Void

    public init(permission: ConchPermission, granted: Bool = false, dragItem: (() -> NSItemProvider)? = nil, onClose: @escaping () -> Void = {}) {
        self.permission = permission
        self.granted = granted
        self.dragItem = dragItem
        self.onClose = onClose
    }

    public var body: some View {
        HStack(spacing: 14) {
            if granted {
                OnboardingCheck(size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("conch is on").font(.system(size: 14, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                    Text("You can close System Settings.").font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                }
            } else {
                // The tile is a real file drag of the running app, so the one dropped is exactly this conch.
                HStack(spacing: 8) {
                    AppIconView(size: 30)
                    Text("conch").font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                }
                .padding(.leading, 6)
                .padding(.trailing, 12)
                .frame(height: 42)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ConchColor.surface).conchElevation(.floating))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .onDrag { dragItem?() ?? NSItemProvider() }
                .accessibilityLabel("conch, drag into the list")
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold))
                        Text("Drag conch into the list above").font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(ConchColor.textPrimary)
                    Text("Already there? Switch it on.").font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                }
            }
            Spacer(minLength: 8)
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(ConchColor.textTertiary)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(OnboardingPress())
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, 14)
        .frame(width: 420, height: 64)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ConchColor.surfaceRaised))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
        .conchElevation(.overlay)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(granted ? "conch is on in \(permission.title)" : "Drag conch into the \(permission.title) list above")
    }
}

/// A switch as System Settings draws one. Drawn rather than AppKit's, so a render shows it as the window does.
struct MiniSwitch: View {
    let on: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Capsule()
            .fill(on ? AnyShapeStyle(Color(red: 0.2, green: 0.78, blue: 0.35)) : AnyShapeStyle(ConchColor.hairlineStrong))
            .frame(width: 32, height: 19)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(Color.white).shadow(color: .black.opacity(0.2), radius: 1, y: 0.5).padding(2)
            }
            .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: on)
    }
}

// MARK: - Voice

/// Where the natural voices stand, for the voice step.
public enum VoiceRing: Equatable, Sendable {
    /// Ready; `playing` is the voice speaking its sample.
    case ready(playing: Int?)
    /// Being built, and where it is: "Step 3 of 4". The voices are built in steps, not bytes, so there is no percent.
    case settingUp(String)
    /// Needs Apple silicon, or turned off: the Mac's own voice.
    case unavailable(String)
}

/// The microphone check: the level as it moves, and what speech recognition made of it.
public struct MicCheck: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case needsPermission
        case listening
        case heard(String)
        /// Nothing above the noise floor for a few seconds.
        case silent
        /// The level works; the words wait for speech recognition to finish downloading.
        case waitingForRecognition(Double)
        /// The check couldn't run, in words a person can act on.
        case problem(String)
    }

    public var device: String
    public var state: State
    /// Recent levels, 0 to 1, oldest first.
    public var levels: [Double]

    public init(device: String, state: State, levels: [Double]) {
        self.device = device
        self.state = state
        self.levels = levels
    }
}

public struct OnboardingVoiceStep: View {
    let ring: VoiceRing
    let mic: MicCheck
    @Environment(\.conchRendersStatically) private var statically
    /// The Mac's inputs, for Change; picking one makes it the Mac's input.
    let devices: [String]
    let onHear: (Int) -> Void
    let onPickDevice: (String) -> Void
    let onAllowMicrophone: () -> Void
    let onContinue: () -> Void
    let onSkip: () -> Void

    /// conch's ring of voices (CONCH_TTS_VOICES), by the names Kokoro gives them.
    public static let voices = ["Heart", "Michael", "Emma", "Adam", "Nova", "George", "Bella", "Sky"]

    public init(ring: VoiceRing, mic: MicCheck, devices: [String] = [], onHear: @escaping (Int) -> Void = { _ in },
                onPickDevice: @escaping (String) -> Void = { _ in }, onAllowMicrophone: @escaping () -> Void = {},
                onContinue: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {}) {
        self.ring = ring
        self.mic = mic
        self.devices = devices
        self.onHear = onHear
        self.onPickDevice = onPickDevice
        self.onAllowMicrophone = onAllowMicrophone
        self.onContinue = onContinue
        self.onSkip = onSkip
    }

    public var body: some View {
        OnboardingPage(
            title: "Hear conch, and let it hear you",
            lede: "Each session speaks in its own voice, so you know who's talking without looking. Then say something to check the microphone.",
            note: "Voices and speech recognition run on this Mac. Nothing you say is uploaded.",
            primaryEnabled: heardYou,
            onPrimary: onContinue,
            onSecondary: onSkip
        ) {
            VStack(spacing: 14) {
                OnboardingCard { voices }
                OnboardingCard { microphone }
            }
        }
    }

    private var ready: Bool {
        if case .ready = ring { return true }
        return false
    }

    /// Continue waits for the one proof that matters: conch heard you. The level moving is enough while speech
    /// recognition is still downloading.
    private var heardYou: Bool {
        switch mic.state {
        case .heard, .waitingForRecognition: true
        default: false
        }
    }

    private var voices: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: ConchSpace.x3) {
                OnboardingTile(symbol: "speaker.wave.2")
                VStack(alignment: .leading, spacing: 3) {
                    Text("Voices").font(OnboardingType.rowTitle).foregroundStyle(ConchColor.textPrimary)
                    Text(ringDetail).font(OnboardingType.rowDetail).foregroundStyle(ConchColor.textSecondary)
                }
                Spacer()
                if ready {
                    // The next voice round the ring each press, so Hear one walks all eight.
                    OnboardingButton("Hear one", systemImage: "play.fill", style: .row) { onHear(nextToHear) }
                }
            }
            // The ring, one chip a voice, across the card's full width so all eight sit on one line. A chip plays its own.
            OnboardingFlowLayout(spacing: 6) {
                ForEach(Array(Self.voices.enumerated()), id: \.offset) { index, name in
                    Button { onHear(index) } label: {
                        VoiceChip(name: name, playing: ring == .ready(playing: index), enabled: ready)
                    }
                    .buttonStyle(OnboardingPress())
                    .disabled(!ready)
                    .accessibilityLabel("Hear \(name)")
                }
            }
            if case let .settingUp(step) = ring {
                HStack(spacing: 8) {
                    OnboardingSpinner(size: 11)
                    Text("\(step) · until then, conch speaks with the Mac's own voice.")
                        .font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
                }
            }
        }
        .padding(ConchSpace.x4)
    }

    /// The voice after the one playing, or the first.
    private var nextToHear: Int {
        if case let .ready(playing?) = ring { return (playing + 1) % Self.voices.count }
        return 0
    }

    private var ringDetail: String {
        switch ring {
        case .ready: "Eight natural voices. Each session keeps the one it's given."
        case .settingUp: "Eight natural voices, arriving now."
        case let .unavailable(reason): reason
        }
    }

    private var microphone: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: ConchSpace.x3) {
                OnboardingTile(symbol: "mic")
                VStack(alignment: .leading, spacing: 3) {
                    Text("Microphone").font(OnboardingType.rowTitle).foregroundStyle(ConchColor.textPrimary)
                    Text(mic.device).font(OnboardingType.rowDetail).foregroundStyle(ConchColor.textSecondary)
                }
                Spacer()
                if mic.state == .needsPermission {
                    OnboardingButton(ConchPermissionAction.ask.title, style: .action, action: onAllowMicrophone)
                } else if devices.count > 1, statically {
                    // A menu is an AppKit control, which a render can't draw: its label stands in.
                    OnboardingButtonLabel("Change", systemImage: "chevron.up.chevron.down", style: .row)
                } else if devices.count > 1 {
                    Menu {
                        ForEach(devices, id: \.self) { device in
                            Button(device) { onPickDevice(device) }
                        }
                    } label: {
                        OnboardingButtonLabel("Change", systemImage: "chevron.up.chevron.down", style: .row)
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .accessibilityLabel("Change the microphone")
                }
            }
            if mic.state != .needsPermission {
                LevelMeter(levels: mic.levels, live: mic.state != .silent)
                    .padding(.leading, 44)
                heard.padding(.leading, 44)
            }
        }
        .padding(ConchSpace.x4)
    }

    @ViewBuilder private var heard: some View {
        switch mic.state {
        case .needsPermission:
            EmptyView()
        case .listening:
            Text("Say anything. What conch hears shows here.")
                .font(.system(size: 13)).foregroundStyle(ConchColor.textTertiary)
        case let .heard(words):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("“\(words)”").font(.system(size: 15, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                Spacer(minLength: 4)
                OnboardingStatus(.done, "Heard you")
            }
        case .silent:
            Text("Nothing from \(mic.device) yet. Is it muted, or is another input in use? Change picks a different one.")
                .font(.system(size: 12)).foregroundStyle(ConchColor.attention)
                .fixedSize(horizontal: false, vertical: true)
        case let .waitingForRecognition(fraction):
            Text("conch can hear you. Your words show here once speech recognition is ready (\(Int((fraction * 100).rounded()))%).")
                .font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        case let .problem(words):
            Text(words)
                .font(.system(size: 12)).foregroundStyle(ConchColor.attention)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct VoiceChip: View {
    let name: String
    let playing: Bool
    let enabled: Bool

    var body: some View {
        HStack(spacing: 5) {
            if playing { VoiceGlyph(.speaking, size: 11) }
            Text(name).font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(playing ? AnyShapeStyle(ConchColor.onAccent) : enabled ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textTertiary))
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Capsule().fill(playing ? AnyShapeStyle(ConchColor.accent) : AnyShapeStyle(ConchColor.fill)))
    }
}

/// The microphone's level as a row of bars, newest on the right: listening's orange while it hears, faint while silent.
public struct LevelMeter: View {
    let levels: [Double]
    let live: Bool

    public init(levels: [Double], live: Bool = true) {
        self.levels = levels
        self.live = live
    }

    public var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                Capsule()
                    .fill(live && level > 0.08 ? AnyShapeStyle(ConchColor.listening) : AnyShapeStyle(ConchColor.fill))
                    .frame(width: 3, height: max(4, 26 * level))
            }
        }
        .frame(height: 28, alignment: .center)
        .accessibilityLabel(live ? "Microphone level" : "No sound")
    }
}

// MARK: - iPhone

/// The iPhone step, from the code on screen to the phone handing back.
public enum PhoneStepState: Equatable, Sendable {
    /// The code on screen. Without a relay the phone must share this Wi-Fi, and the short code is the way in.
    case waiting(relay: Bool)
    case connecting
    case settingUp(PhoneHandoff)
    case finished(PhoneHandoff)
    /// The code ran out, or the relay didn't answer.
    case failed(String)
}

/// What the code on screen is, which decides what the steps beside it say.
public enum PairingCodeKind: Sendable {
    /// A link the system Camera opens (conch, or the App Store without it).
    case link
    /// conch's own code, `conch-relay-v1:`, which only conch's scanner on the iPhone reads.
    case inApp
}

public struct OnboardingPhoneStep: View {
    let state: PhoneStepState
    let qr: Image?
    let kind: PairingCodeKind
    let lanCode: String
    /// Where the iPhone types to reach this Mac without a relay ("192.168.1.20:8674").
    let lanHost: String?
    let onNewCode: () -> Void
    let onContinue: () -> Void
    let onSkip: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(state: PhoneStepState, qr: Image?, kind: PairingCodeKind = .link, lanCode: String = "482 193", lanHost: String? = nil,
                onNewCode: @escaping () -> Void = {}, onContinue: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {}) {
        self.state = state
        self.qr = qr
        self.kind = kind
        self.lanCode = lanCode
        self.lanHost = lanHost
        self.onNewCode = onNewCode
        self.onContinue = onContinue
        self.onSkip = onSkip
    }

    /// The three steps beside the code, for the code it is. Without a relay there is no code to scan in the app: the
    /// iPhone types this Mac's address and the short code instead.
    public static func steps(for kind: PairingCodeKind, relay: Bool = true) -> [String] {
        switch (kind, relay) {
        case (.link, _): ["Open the Camera on your iPhone.", "Point it at the code.", "Tap the conch banner that appears."]
        case (.inApp, true): ["Open conch on your iPhone.", "Tap Scan the code on my Mac.", "Point it at this code."]
        case (.inApp, false): ["Open conch on your iPhone.", "Tap Scan the code on my Mac, then Enter a code instead.", "Type the address and code below."]
        }
    }

    private var finished: Bool {
        if case .finished = state { return true }
        return false
    }

    public var body: some View {
        OnboardingPage(
            title: "conch on your iPhone",
            lede: "Hear your agents and answer them from anywhere, on any connection. What passes between your iPhone and this Mac is encrypted end to end.",
            note: finished ? nil : "This step carries on by itself when your iPhone is done.",
            primary: finished ? "Continue" : nil,
            secondary: finished ? nil : "Skip for now",
            onPrimary: onContinue,
            onSecondary: onSkip
        ) {
            switch state {
            case let .waiting(relay): scan(relay: relay, dimmed: false)
            case .connecting: scan(relay: true, dimmed: true)
            case let .settingUp(handoff), let .finished(handoff): mirror(handoff)
            case let .failed(reason): failed(reason)
            }
        }
    }

    private func scan(relay: Bool, dimmed: Bool) -> some View {
        HStack(alignment: .top, spacing: 28) {
            // The in-app code carries the relay: without one there is nothing to scan, so no empty card.
            if relay || kind == .link { PairingCode(qr: qr, dimmed: dimmed) }
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(Self.steps(for: kind, relay: relay).enumerated()), id: \.offset) { index, line in
                    NumberedLine(index + 1, line)
                }
                Text(relay
                     ? (kind == .link
                        ? "No conch on your iPhone yet? The same code opens it in the App Store."
                        : "No conch on your iPhone yet? Install it, then scan this code.")
                     : kind == .link
                        ? "Your iPhone needs to be on this Wi-Fi. Or type this code in conch on your iPhone:"
                        : "Your iPhone needs to be on this Wi-Fi.")
                    .font(.system(size: 12))
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineSpacing(1.5)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
                if !relay {
                    VStack(alignment: .leading, spacing: 2) {
                        if let lanHost {
                            Text(lanHost).font(.system(size: 13, design: .monospaced)).foregroundStyle(ConchColor.textSecondary)
                                .textSelection(.enabled)
                        }
                        Text(lanCode).font(.system(size: 22, weight: .semibold, design: .monospaced)).foregroundStyle(ConchColor.textPrimary)
                            .textSelection(.enabled)
                            .accessibilityLabel("Code \(lanCode.map(String.init).joined(separator: " "))")
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    if dimmed { OnboardingSpinner(size: 12) } else { PulseDot() }
                    Text(dimmed ? "Connecting to your iPhone…" : "Waiting for your iPhone…")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textSecondary)
                }
            }
            .frame(height: 216, alignment: .topLeading)
        }
    }

    private func mirror(_ handoff: PhoneHandoff) -> some View {
        HStack(alignment: .top, spacing: 28) {
            PhoneOutline(done: handoff.stage == .finished)
                .frame(width: 216, height: 216)
            VStack(alignment: .leading, spacing: 0) {
                Text(handoff.device ?? "Your iPhone")
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                Text(handoff.stage == .finished
                     ? "All set on your iPhone. Carrying on here."
                     : "Setting itself up. Follow along on your iPhone; this Mac carries on by itself.")
                    .font(.system(size: 13)).foregroundStyle(ConchColor.textSecondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 11) {
                    ForEach(PhoneSetupStage.mirrored, id: \.self) { stage in
                        MirrorLine(stage: stage, handoff: handoff)
                    }
                }
                .padding(.top, 18)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func failed(_ reason: String) -> some View {
        HStack(alignment: .top, spacing: 28) {
            PairingCode(qr: qr, dimmed: true)
            VStack(alignment: .leading, spacing: 10) {
                Text("Couldn't pair").font(.system(size: 15, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                Text(reason).font(.system(size: 13)).foregroundStyle(ConchColor.textSecondary)
                    .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                OnboardingButton("New code", systemImage: "arrow.clockwise", style: .action, action: onNewCode).padding(.top, 4)
            }
        }
    }
}

/// The pairing code on white, as a scanner needs it, with the icon in the middle so it reads as conch's.
public struct PairingCode: View {
    let qr: Image?
    var dimmed = false
    var side: CGFloat = 216

    public init(qr: Image?, dimmed: Bool = false, side: CGFloat = 216) {
        self.qr = qr
        self.dimmed = dimmed
        self.side = side
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white)
            if let qr {
                qr.interpolation(.none).resizable().aspectRatio(contentMode: .fit)
                    .frame(width: side - 36, height: side - 36)
                    .opacity(dimmed ? 0.18 : 1)
            }
            AppIconView(size: side * 0.2)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: side * 0.06, style: .continuous).fill(Color.white))
                .opacity(dimmed ? 0.4 : 1)
            if dimmed { OnboardingSpinner(size: 22).environment(\.colorScheme, .light) }
        }
        .frame(width: side, height: side)
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
        .conchElevation(.panel)
        .accessibilityLabel("Pairing code for conch on iPhone")
    }
}

struct NumberedLine: View {
    let number: Int
    let text: String

    init(_ number: Int, _ text: String) {
        self.number = number
        self.text = text
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: 20, height: 20)
                .background(Circle().fill(ConchColor.fill))
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(text).font(.system(size: 14)).foregroundStyle(ConchColor.textPrimary)
        }
    }
}

struct MirrorLine: View {
    let stage: PhoneSetupStage
    let handoff: PhoneHandoff

    var body: some View {
        let reached = handoff.stage > stage
        let here = handoff.stage == stage || (stage == .paired && handoff.stage == .connecting)
        let declined = handoff.declined.contains(stage)
        HStack(spacing: 10) {
            Group {
                if declined {
                    Circle().strokeBorder(ConchColor.textTertiary, style: StrokeStyle(lineWidth: 1.2, dash: [2.2, 2.2]))
                } else if reached {
                    OnboardingCheck(size: 18)
                } else if here {
                    OnboardingSpinner(size: 16)
                } else {
                    Circle().strokeBorder(ConchColor.textTertiary.opacity(0.6), lineWidth: 1.2)
                }
            }
            .frame(width: 18, height: 18)
            Text(stage.title)
                .font(.system(size: 13, weight: here ? .semibold : .regular))
                .foregroundStyle(reached || here ? ConchColor.textPrimary : ConchColor.textTertiary)
            if declined {
                Text("Not now").font(.system(size: 12)).foregroundStyle(ConchColor.textTertiary)
            }
        }
    }
}

/// A calm dot that breathes while conch waits for something outside itself. Still in a render.
struct PulseDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var statically

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || statically)) { timeline in
            let breath = reduceMotion || statically ? 0.6 : 0.5 + 0.5 * sin(timeline.date.timeIntervalSinceReferenceDate * 2 * .pi / ConchMotion.breathPeriod)
            ZStack {
                Circle().fill(ConchColor.textTertiary.opacity(0.3 * breath)).frame(width: 14, height: 14)
                Circle().fill(ConchColor.textSecondary).frame(width: 7, height: 7)
            }
        }
        .frame(width: 14, height: 14)
    }
}

/// An iPhone, drawn in line: the Mac's picture of the phone it's waiting on.
public struct PhoneOutline: View {
    let done: Bool

    public init(done: Bool) { self.done = done }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(ConchColor.surface)
                .frame(width: 104, height: 212)
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(ConchColor.textTertiary.opacity(0.55), lineWidth: 2.5))
                .conchElevation(.panel)
            Capsule().fill(ConchColor.textPrimary.opacity(0.85)).frame(width: 30, height: 9).offset(y: -92)
            VStack(spacing: 10) {
                AppIconView(size: 38)
                if done {
                    OnboardingCheck(size: 20)
                } else {
                    OnboardingSpinner(size: 16)
                }
            }
        }
    }
}

// MARK: - Try it

/// Where Try it stands before the tour: ready to start, or why not yet, in words a person can act on.
public enum PracticeStartState: Equatable, Sendable {
    case ready
    /// Asked the daemon; the window steps aside once it answers.
    case starting
    /// The microphone is off for conch: asked for here, as the voice step asks. `action` is the row's own button.
    case needsMicrophone(action: String)
    /// Speech recognition is still downloading: Start waits for it.
    case waitingForRecognition(Double)
    /// The phone, or another Mac, has conch's audio: the daemon's words, and Hand it back.
    case audioElsewhere(String)
    /// It couldn't start, or stopped: why.
    case problem(String)
}

public struct OnboardingPracticeStep<Preview: View>: View {
    let preview: Preview
    let state: PracticeStartState
    let onStart: () -> Void
    let onSkip: () -> Void
    /// The status line's button: Allow… for the microphone, Hand it back for the audio.
    let onAction: () -> Void

    public init(state: PracticeStartState = .ready, onStart: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {},
                onAction: @escaping () -> Void = {}, @ViewBuilder preview: () -> Preview) {
        self.preview = preview()
        self.state = state
        self.onStart = onStart
        self.onSkip = onSkip
        self.onAction = onAction
    }

    public var body: some View {
        OnboardingPage(
            title: "Try it",
            lede: "A practice turn: conch reads it aloud and you answer out loud. It goes to no agent and costs nothing. Then a quick look at the pill, the panel and drawing on your screen.",
            note: "This window steps aside while you try it.",
            primary: "Start",
            secondary: "Skip",
            primaryEnabled: startable,
            onPrimary: onStart,
            onSecondary: onSkip
        ) {
            VStack(alignment: .leading, spacing: 14) {
                preview
                    .frame(maxWidth: .infinity)
                    .frame(height: 236)
                    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 0.5))
                    .accessibilityHidden(true)
                status
            }
        }
    }

    /// Start waits on what only the person, or the download, can change.
    private var startable: Bool {
        switch state {
        case .ready, .audioElsewhere, .problem: true
        case .starting, .needsMicrophone, .waitingForRecognition: false
        }
    }

    @ViewBuilder private var status: some View {
        switch state {
        case .ready:
            EmptyView()
        case .starting:
            HStack(spacing: 8) {
                OnboardingSpinner(size: 12)
                Text("Starting the practice turn…").font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
            }
        case let .needsMicrophone(action):
            statusLine("conch can't hear you yet: the microphone is off for conch.", tone: ConchColor.attention, button: action)
        case let .waitingForRecognition(fraction):
            HStack(spacing: 10) {
                OnboardingSpinner(size: 12)
                Text("Speech recognition is still downloading (\(Int((fraction * 100).rounded()))%). Start works once it's here.")
                    .font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case let .audioElsewhere(words):
            statusLine(words, tone: ConchColor.textSecondary, button: "Hand it back")
        case let .problem(words):
            statusLine(words, tone: ConchColor.attention, button: nil)
        }
    }

    private func statusLine(_ words: String, tone: ConchColorToken, button: String?) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text(words)
                .font(.system(size: 12))
                .foregroundStyle(tone)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let button { OnboardingButton(button, style: .action, action: onAction) }
        }
    }
}

/// Try it's picture of what's coming: the pill reading the practice turn, and its line, over a soft ground. Light, as
/// the design draws it, in either appearance.
public struct PracticePreview: View {
    public init() {}

    public var body: some View {
        ZStack(alignment: .top) {
            LinearGradient(colors: [Color(red: 0.80, green: 0.86, blue: 0.94), Color(red: 0.93, green: 0.86, blue: 0.84), Color(red: 0.86, green: 0.82, blue: 0.93)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.7))
                .padding(.horizontal, 44)
                .padding(.top, 46)
                .padding(.bottom, -20)
                .blur(radius: 1.5)
            VStack(spacing: 18) {
                ControlBar(state: .speaking, detail: "Practice turn", mode: .constant(.talk))
                (Text("Hi, I'm conch. When an agent finishes, ")
                    + Text("I read you what it did. Try answering me.").foregroundColor(Color.black.opacity(0.32)))
                    .font(.system(size: 17, weight: .medium))
                    .tracking(-0.2)
                    .foregroundStyle(Color.black.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.82)))
                    .conchElevation(.floating)
            }
            .padding(.top, 20)
        }
        .environment(\.colorScheme, .light)
    }
}

/// The tour's card, beside whatever it points at: which beat, what it is, and what to try. Its button moves the tour on
/// when the thing itself didn't happen; Skip tour is there at every beat.
public struct CoachCard: View {
    public enum Pointer: Sendable {
        case up
        case down
        case left
        /// Pointing right: the card to the left of what it's about, when there's no room on its right.
        case right
        case none
    }

    let beat: Int
    let of: Int
    let title: String
    let text: String
    let chord: String?
    /// The chord held down right now: its keys light, and the beat moves on by itself.
    let chordLit: Bool
    let heard: String?
    /// A plain word when something didn't happen, and a quieter button to try again.
    let note: String?
    let retry: String?
    let pointer: Pointer
    let primary: String
    let onPrimary: () -> Void
    let onSkip: () -> Void
    let onRetry: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(beat: Int, of: Int, title: String, text: String, chord: String? = nil, chordLit: Bool = false, heard: String? = nil,
                note: String? = nil, retry: String? = nil, pointer: Pointer = .none, primary: String = "Next",
                onPrimary: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {}, onRetry: @escaping () -> Void = {}) {
        self.chordLit = chordLit
        self.beat = beat
        self.of = of
        self.title = title
        self.text = text
        self.chord = chord
        self.heard = heard
        self.note = note
        self.retry = retry
        self.pointer = pointer
        self.primary = primary
        self.onPrimary = onPrimary
        self.onSkip = onSkip
        self.onRetry = onRetry
    }

    /// A beat's card, as the tour's rule says it (`TourCard`), pointing where it hangs.
    public init(_ card: TourCard, pointer: Pointer? = nil, onPrimary: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {},
                onRetry: @escaping () -> Void = {}) {
        self.init(beat: card.beat.rawValue, of: TourCard.count, title: card.title, text: card.text, chord: card.chord, chordLit: card.chordLit,
                  heard: card.heard, note: card.note, retry: card.retry, pointer: pointer ?? card.pointer, primary: card.primary,
                  onPrimary: onPrimary, onSkip: onSkip, onRetry: onRetry)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 5) {
                ForEach(1...of, id: \.self) { index in
                    Capsule()
                        .fill(index == beat ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textTertiary.opacity(0.35)))
                        .frame(width: index == beat ? 14 : 5, height: 5)
                }
                .accessibilityHidden(true)
                Spacer()
                Button(action: onSkip) {
                    Text("Skip tour").font(.system(size: 11, weight: .medium)).foregroundStyle(ConchColor.textTertiary)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Skip tour")
            }
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.top, 12)
                .accessibilityAddTraits(.isHeader)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(ConchColor.textSecondary)
                .lineSpacing(2.5)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
            if let heard {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("“\(heard)”").font(.system(size: 13, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                        .lineLimit(3)
                    Spacer(minLength: 4)
                    OnboardingStatus(.done, "Sent")
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ConchColor.fill))
                .padding(.top, 10)
                .transition(.opacity.combined(with: .scale(scale: reduceMotion ? 1 : ConchMotion.popScale)))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Sent: \(heard)")
            } else if let note {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(ConchColor.attention)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
            }
            HStack(spacing: 8) {
                if let chord {
                    KeyChord(chord, size: 11, lit: chordLit)
                    Text(chordLit ? "Got it" : "to try it").font(.system(size: 11, weight: chordLit ? .semibold : .regular))
                        .foregroundStyle(chordLit ? ConchColor.textPrimary : ConchColor.textTertiary)
                }
                Spacer()
                if let retry { OnboardingButton(retry, style: .quiet, action: onRetry) }
                OnboardingButton(primary, action: onPrimary)
            }
            .padding(.top, 14)
        }
        .padding(16)
        .frame(width: 300)
        .background(CoachShape(pointer: pointer).fill(ConchColor.surfaceRaised))
        .overlay(CoachShape(pointer: pointer).stroke(ConchColor.hairlineStrong, lineWidth: 0.5))
        .compositingGroup()
        .conchElevation(.overlay)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: heard)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: chordLit)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Tour, \(beat) of \(of): \(title)")
    }
}

/// The one tip the tour leaves behind (`PillTip`), hanging from the pill: its words, in the pill's ready green, and a way
/// to close it. It goes the first time the pill is used.
public struct PillTipView: View {
    let onClose: () -> Void

    public init(onClose: @escaping () -> Void = {}) {
        self.onClose = onClose
    }

    public var body: some View {
        HStack(alignment: .center, spacing: 9) {
            Circle().fill(VoiceOrb.readyFill.color).frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(PillTip.text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ConchColor.textPrimary)
                .fixedSize()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(ConchColor.textTertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close tip")
        }
        .padding(.leading, 12)
        .padding(.trailing, 7)
        .padding(.vertical, 8)
        .background(CoachShape(pointer: .up, radius: 12, size: 7).fill(ConchColor.surfaceRaised))
        .overlay(CoachShape(pointer: .up, radius: 12, size: 7).stroke(ConchColor.hairlineStrong, lineWidth: 0.5))
        .compositingGroup()
        .conchElevation(.overlay)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Tip: \(PillTip.text)")
    }
}

/// The card's outline with its pointer grown out of one edge, so the two read as one shape.
struct CoachShape: Shape {
    let pointer: CoachCard.Pointer
    var radius: CGFloat = 16
    var size: CGFloat = 9

    func path(in rect: CGRect) -> Path {
        var path = Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        let tip: (CGPoint, CGPoint, CGPoint)?
        switch pointer {
        case .up:
            let x = rect.midX
            tip = (CGPoint(x: x - size, y: rect.minY + 0.5), CGPoint(x: x, y: rect.minY - size), CGPoint(x: x + size, y: rect.minY + 0.5))
        case .down:
            let x = rect.minX + 44
            tip = (CGPoint(x: x - size, y: rect.maxY - 0.5), CGPoint(x: x, y: rect.maxY + size), CGPoint(x: x + size, y: rect.maxY - 0.5))
        case .left:
            let y = rect.minY + 40
            tip = (CGPoint(x: rect.minX + 0.5, y: y - size), CGPoint(x: rect.minX - size, y: y), CGPoint(x: rect.minX + 0.5, y: y + size))
        case .right:
            let y = rect.minY + 40
            tip = (CGPoint(x: rect.maxX - 0.5, y: y - size), CGPoint(x: rect.maxX + size, y: y), CGPoint(x: rect.maxX - 0.5, y: y + size))
        case .none:
            tip = nil
        }
        if let tip {
            var triangle = Path()
            triangle.move(to: tip.0)
            triangle.addQuadCurve(to: tip.2, control: tip.1)
            triangle.closeSubpath()
            path = path.union(triangle)
        }
        return path
    }
}

// MARK: - The end, and coming back

public struct OnboardingSummaryLine: Identifiable, Sendable {
    public let step: OnboardingStep
    public let detail: String
    public let status: String
    public let done: Bool
    public var id: OnboardingStep { step }

    public init(step: OnboardingStep, detail: String, status: String, done: Bool) {
        self.step = step
        self.detail = detail
        self.status = status
        self.done = done
    }

    var symbol: String {
        switch step {
        case .agents: "person.2"
        case .permissions: "lock.shield"
        case .voice: "waveform"
        case .phone: "iphone"
        default: "checkmark"
        }
    }
}

/// Something to do first, offered at the end: setup ends on an action, not on a summary.
public struct OnboardingFirstAction: Identifiable, Sendable {
    public let id: String
    public let symbol: String
    public let title: String
    public let detail: String

    public init(id: String, symbol: String, title: String, detail: String) {
        self.id = id
        self.symbol = symbol
        self.title = title
        self.detail = detail
    }
}

public struct OnboardingDoneStep: View {
    let summary: [OnboardingSummaryLine]
    let actions: [OnboardingFirstAction]
    let openAtLogin: Bool
    /// Why the switch didn't take, or what macOS still wants, in place of the notice beside it.
    let loginNote: String?
    let onToggleLogin: (Bool) -> Void
    let onAction: (String) -> Void
    let onClose: () -> Void

    public init(summary: [OnboardingSummaryLine], actions: [OnboardingFirstAction], openAtLogin: Bool = true, loginNote: String? = nil,
                onToggleLogin: @escaping (Bool) -> Void = { _ in },
                onAction: @escaping (String) -> Void = { _ in }, onClose: @escaping () -> Void = {}) {
        self.summary = summary
        self.actions = actions
        self.openAtLogin = openAtLogin
        self.loginNote = loginNote
        self.onToggleLogin = onToggleLogin
        self.onAction = onAction
        self.onClose = onClose
    }

    public var body: some View {
        OnboardingPage(
            title: "You're set.",
            lede: "conch lives in your menu bar now. What would you like to do first?",
            note: nil,
            primary: nil,
            secondary: "Close",
            onSecondary: onClose
        ) {
            VStack(alignment: .leading, spacing: 16) {
                OnboardingCard {
                    ForEach(Array(actions.enumerated()), id: \.element.id) { index, action in
                        if index > 0 { OnboardingDivider(leading: 60) }
                        Button { onAction(action.id) } label: {
                            HStack(spacing: ConchSpace.x3) {
                                OnboardingTile(symbol: action.symbol)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(action.title).font(OnboardingType.rowTitle).foregroundStyle(ConchColor.textPrimary)
                                    Text(action.detail).font(OnboardingType.rowDetail).foregroundStyle(ConchColor.textSecondary)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(ConchColor.textTertiary)
                            }
                            .padding(.horizontal, ConchSpace.x4)
                            .frame(height: 58)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(OnboardingPress())
                        .accessibilityLabel(action.title)
                        .accessibilityHint(action.detail)
                    }
                }
                // What's set, in one line each: the detail lives in Settings › Setup.
                OnboardingFlowLayout(spacing: 14) {
                    ForEach(summary) { line in
                        HStack(spacing: 5) {
                            if line.done {
                                OnboardingCheck(size: 13)
                            } else {
                                Circle().strokeBorder(ConchColor.textTertiary, style: StrokeStyle(lineWidth: 1.1, dash: [2, 2])).frame(width: 13, height: 13)
                            }
                            Text(line.detail).font(.system(size: 12)).foregroundStyle(line.done ? ConchColor.textSecondary : ConchColor.textTertiary)
                        }
                    }
                }
                Button { onToggleLogin(!openAtLogin) } label: {
                    HStack(spacing: 10) {
                        MiniSwitch(on: openAtLogin)
                        Text("Open conch when you log in").font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                        Text(loginNote ?? "macOS will say it added a background item. That's this.")
                            .font(.system(size: 11))
                            .foregroundStyle(loginNote == nil ? ConchColor.textTertiary : ConchColor.attention)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Open conch when you log in")
                .accessibilityValue(openAtLogin ? "On" : "Off")
                .accessibilityAddTraits(.isToggle)
            }
        }
    }
}

/// Where conch lives: a strip of menu bar with its mark picked out.
public struct MenuBarHint: View {
    public init() {}

    public var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 13) {
                Image(systemName: "wifi")
                Image(systemName: "battery.75percent")
                ConchMarkView()
                    .frame(width: 18, height: 18)
                    .padding(5)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(ConchColor.fillSelected).conchElevation(.raised))
                Image(systemName: "switch.2")
                Text("Mon 9:41").font(.system(size: 12, weight: .medium))
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(ConchColor.textPrimary)
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(ConchColor.fill))
            Text("Click the shell for Talk and Quiet, the panel, and everything that's ready.")
                .font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Launched on a Mac that already had conch: what's set, and only what's missing.
public struct OnboardingWelcomeBack<Rows: View>: View {
    let count: Int
    let rows: Rows
    let onDone: () -> Void
    let onNotNow: () -> Void

    /// `count` is how many rows follow, for the line that introduces them.
    public init(count: Int = 2, onDone: @escaping () -> Void = {}, onNotNow: @escaping () -> Void = {}, @ViewBuilder rows: () -> Rows) {
        self.count = count
        self.rows = rows()
        self.onDone = onDone
        self.onNotNow = onNotNow
    }

    /// "Two things are new since you set it up, or still off."
    public static func lede(count: Int) -> String {
        let words = ["No", "One", "Two", "Three", "Four", "Five"]
        let number = count < words.count ? words[count] : "\(count)"
        return "conch already knows your agents and can hear you. \(number) \(count == 1 ? "thing is" : "things are") new since you set it up, or still off."
    }

    public var body: some View {
        OnboardingPage(
            title: "Welcome back",
            lede: Self.lede(count: count),
            note: "Nothing else changed. Settings › Setup has the rest.",
            primary: "Done",
            secondary: "Not now",
            onPrimary: onDone,
            onSecondary: onNotNow
        ) {
            OnboardingCard { rows }
        }
    }
}

/// A row Welcome back and Settings share for something that isn't a permission: drawn as the permission rows are, the
/// icon bare, the words, and the one button.
public struct OnboardingActionRow: View {
    let symbol: String
    let title: String
    let detail: String
    let button: String
    let action: () -> Void

    public init(symbol: String, title: String, detail: String, button: String, action: @escaping () -> Void = {}) {
        self.symbol = symbol
        self.title = title
        self.detail = detail
        self.button = button
        self.action = action
    }

    /// Welcome back's iPhone row, for a Mac that has never paired one.
    public static func phone(action: @escaping () -> Void = {}) -> OnboardingActionRow {
        OnboardingActionRow(symbol: "iphone", title: "Your iPhone", detail: "New: hear your agents and answer them from anywhere.", button: "Pair", action: action)
    }

    public var body: some View {
        HStack(alignment: .center, spacing: ConchSpace.x4) {
            Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(ConchColor.textSecondary).frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary)
                Text(detail).font(ConchType.secondary).foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            OnboardingButton(button, style: .action, action: action)
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Settings › Setup

/// Setup, kept: Settings' tab with where each step stands, the downloads, and the way to run it again.
public struct OnboardingSettingsPane: View {
    let lines: [OnboardingSummaryLine]
    let downloads: [OnboardingDownload]
    let onAction: (OnboardingStep) -> Void
    let onRetry: ((OnboardingDownload) -> Void)?
    let onRunAgain: () -> Void

    public init(lines: [OnboardingSummaryLine], downloads: [OnboardingDownload], onAction: @escaping (OnboardingStep) -> Void = { _ in },
                onRetry: ((OnboardingDownload) -> Void)? = nil, onRunAgain: @escaping () -> Void = {}) {
        self.lines = lines
        self.downloads = downloads
        self.onAction = onAction
        self.onRetry = onRetry
        self.onRunAgain = onRunAgain
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Setup").font(.system(size: 18, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                    Text("What conch has on this Mac, and what's still off.").font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                }
                Spacer()
                OnboardingButton("Run setup again", style: .row, action: onRunAgain)
            }
            OnboardingCard {
                ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                    if index > 0 { OnboardingDivider(leading: 52) }
                    HStack(spacing: 12) {
                        OnboardingTile(symbol: line.symbol, size: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(line.step.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                            Text(line.detail).font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if line.done {
                            OnboardingStatus(.done, line.status)
                        } else {
                            OnboardingButton(line.status, style: .action) { onAction(line.step) }
                        }
                    }
                    .padding(.horizontal, ConchSpace.x4)
                    .frame(height: 54)
                }
            }
            Text("Downloads").font(.system(size: 11, weight: .semibold)).foregroundStyle(ConchColor.textSecondary).padding(.top, 4)
            OnboardingCard {
                ForEach(Array(downloads.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { OnboardingDivider(leading: ConchSpace.x4) }
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                            Text(item.purpose).font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                        }
                        Spacer()
                        DownloadLine(item: item, showsTitle: false, onRetry: onRetry).frame(width: 190)
                    }
                    .padding(.horizontal, ConchSpace.x4)
                    .padding(.vertical, 12)
                }
            }
        }
        .padding(24)
        .frame(width: 620, alignment: .topLeading)
        .background(ConchColor.ground)
    }
}
