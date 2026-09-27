import SwiftUI

// The pieces setup is drawn from, on the Mac and the iPhone alike: what each row describes (an agent, a permission, a
// download), and the small parts every screen shares (buttons, the check, the spinner, a card of rows, a keycap).

extension EnvironmentValues {
    /// The app's icon, for the screens that introduce conch. The apps pass their own asset; the gallery reads the repo's.
    @Entry public var conchAppIcon: Image? = nil
    /// Each agent's mark by its backend ("claude", "codex"): the apps' template images.
    @Entry public var conchAgentMarks: [String: Image] = [:]
}

// MARK: - What the rows describe

/// One agent conch can listen to, as setup finds it on this Mac.
public struct OnboardingAgent: Identifiable, Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable {
        case claude
        case codex

        public var name: String { self == .claude ? "Claude Code" : "Codex" }
    }

    public enum State: Equatable, Sendable {
        /// Found, with conch's hooks and plugin in its own settings. `from` is where it lives ("Homebrew").
        case connected(version: String, from: String)
        /// Found, not yet told about conch.
        case found(version: String, from: String)
        /// Writing the hooks and the plugin.
        case connecting(version: String, from: String)
        /// Installed but not signed in, so it can't start a session.
        case signIn(version: String)
        /// Not on this Mac.
        case missing
        /// Its own installer running, with the line it printed last.
        case installing(line: String)
        /// The installer, or connecting, failed: what it said, and the command to try by hand.
        case failed(reason: String, command: String)
        /// Two copies: the one conch would run and the one the person's shell runs are different versions.
        case twoCopies(conch: String, shell: String)
    }

    /// Two installs that disagree, as `conch doctor` finds them: the one conch resolves and the one the person's shell
    /// runs, each "version  path". Shown under the row whatever its state.
    public struct Copies: Equatable, Sendable {
        public let conch: String
        public let shell: String

        public init(conch: String, shell: String) {
            self.conch = conch
            self.shell = shell
        }
    }

    public let kind: Kind
    public var state: State
    /// Sessions already open that read their hooks only at start: each needs `/hooks` once.
    public var openSessions: Int
    /// One more line under the row, in the row's words: what conch is waiting for, or why it can't yet.
    public var note: String?
    public var copies: Copies?

    public var id: Kind { kind }

    public init(_ kind: Kind, _ state: State, openSessions: Int = 0, note: String? = nil, copies: Copies? = nil) {
        self.kind = kind
        self.state = state
        self.openSessions = openSessions
        self.note = note
        self.copies = copies
    }
}

/// The one thing an agent's row can do.
public enum OnboardingAgentAction: Equatable, Sendable {
    /// Write conch's hooks and plugin into the agent's own settings.
    case connect
    /// Run the agent's own installer.
    case install
    /// The last install or connect failed: the same again.
    case retry
    /// Open Terminal on the agent's sign-in.
    case signIn
    /// Put this command on the clipboard.
    case copy(String)
}

/// A permission asked the first time its feature is used rather than in setup: setup says when, and offers it early.
/// Screen Recording is the ask people most often turn down when it comes before they've seen why.
public struct OnboardingDeferredAsk: Identifiable, Equatable, Sendable {
    public let id: String
    public let symbol: String
    public let title: String
    /// When it will be asked: "The first time you draw on your screen or record a Show."
    public let when: String

    public init(id: String, symbol: String, title: String, when: String) {
        self.id = id
        self.symbol = symbol
        self.title = title
        self.when = when
    }

    public static let screenRecording = OnboardingDeferredAsk(
        id: ConchPermission.screenRecording.rawValue, symbol: ConchPermission.screenRecording.symbol, title: ConchPermission.screenRecording.title,
        when: "The first time you draw on your screen or record a Show."
    )
    public static let notifications = OnboardingDeferredAsk(
        id: "notifications", symbol: "bell.badge", title: "Notifications",
        when: "The first time something is ready while conch is quiet."
    )
}

/// One of the things conch downloads on a first run. They start when setup begins and finish on their own; nothing
/// waits on them.
public struct OnboardingDownload: Identifiable, Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case queued
        case downloading(done: Double, total: Double, secondsLeft: Int?)
        /// Unpacking or checking, with the step it's on.
        case installing(String)
        case ready
        case failed(String)
        /// Paused until the Mac is back online; it carries on from where it stopped.
        case offline(done: Double, total: Double)
        case noSpace(needs: Double, free: Double)
    }

    public let id: String
    public let title: String
    /// What it's for, in a few words.
    public let purpose: String
    public var state: State
    /// A failure a Retry can help: not one that retries by itself, or one no retry fixes (an Intel Mac).
    public var canRetry: Bool

    public init(id: String, title: String, purpose: String, state: State, canRetry: Bool = true) {
        self.id = id
        self.title = title
        self.purpose = purpose
        self.state = state
        self.canRetry = canRetry
    }

    public var fraction: Double? {
        switch state {
        case let .downloading(done, total, _), let .offline(done, total): total > 0 ? done / total : 0
        case .ready: 1
        default: nil
        }
    }

    public var isReady: Bool { state == .ready }

    /// Gigabytes and megabytes the way Finder writes them.
    public static func size(_ bytes: Double) -> String {
        bytes >= 1_000_000_000 ? String(format: "%.1f GB", bytes / 1_000_000_000) : "\(Int((bytes / 1_000_000).rounded())) MB"
    }
}

// MARK: - Type

/// Setup's own sizes, beside ConchType: a display size for the one line each screen leads with, and on the iPhone the
/// system's text styles. On the Mac (where the gallery draws the iPhone screens too) the iPhone sizes are the styles'
/// default sizes, so a render is what a phone at the default text size shows.
public enum OnboardingType {
    #if os(macOS)
    public static let welcome = Font.system(size: 40, weight: .semibold)
    public static let display = Font.system(size: 26, weight: .semibold)
    public static let lede = Font.system(size: 14)
    public static let rowTitle = Font.system(size: 13, weight: .semibold)
    public static let rowDetail = Font.system(size: 12)
    #else
    public static let welcome = Font.largeTitle.weight(.bold)
    public static let display = Font.title.weight(.bold)
    public static let lede = Font.body
    public static let rowTitle = Font.headline
    public static let rowDetail = Font.subheadline
    #endif

    /// The iPhone's text styles at their default size.
    public enum Phone {
        #if os(iOS)
        public static let largeTitle = Font.largeTitle.weight(.bold)
        public static let title = Font.title.weight(.bold)
        public static let title3 = Font.title3.weight(.semibold)
        public static let headline = Font.headline
        public static let body = Font.body
        public static let callout = Font.callout
        public static let subheadline = Font.subheadline
        public static let footnote = Font.footnote
        public static let caption = Font.caption
        public static let button = Font.headline
        public static let buttonMedium = Font.body.weight(.medium)
        #else
        public static let largeTitle = Font.system(size: 34, weight: .bold)
        public static let title = Font.system(size: 28, weight: .bold)
        public static let title3 = Font.system(size: 20, weight: .semibold)
        public static let headline = Font.system(size: 17, weight: .semibold)
        public static let body = Font.system(size: 17)
        public static let callout = Font.system(size: 16)
        public static let subheadline = Font.system(size: 15)
        public static let footnote = Font.system(size: 13)
        public static let caption = Font.system(size: 12)
        public static let button = Font.system(size: 17, weight: .semibold)
        public static let buttonMedium = Font.system(size: 17, weight: .medium)
        #endif
    }
}

// MARK: - Buttons

/// Setup's buttons. Primary is the one thing that moves the step on (ink, like every primary action in conch); action
/// is a row's one thing to do, drawn as Settings' permission rows draw theirs (a small ink capsule); row is a quieter
/// control on a card (Change, Hear one); quiet is words alone.
public struct OnboardingButton: View {
    public enum Style: Sendable {
        case primary
        case action
        case row
        case quiet
    }

    public enum Size: Sendable {
        case regular
        case large
        /// Full width, for the iPhone.
        case phone
    }

    let title: String
    let systemImage: String?
    let style: Style
    let size: Size
    let action: () -> Void

    public init(_ title: String, systemImage: String? = nil, style: Style = .primary, size: Size = .regular, action: @escaping () -> Void = {}) {
        self.title = title
        self.systemImage = systemImage
        self.style = style
        self.size = size
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            OnboardingButtonLabel(title, systemImage: systemImage, style: style, size: size)
        }
        .buttonStyle(OnboardingPress())
        .accessibilityLabel(title)
    }
}

/// How a setup button looks, apart from what it does: for a menu that has to look like one of them (Change).
public struct OnboardingButtonLabel: View {
    let title: String
    let systemImage: String?
    let style: OnboardingButton.Style
    let size: OnboardingButton.Size

    public init(_ title: String, systemImage: String? = nil, style: OnboardingButton.Style = .primary, size: OnboardingButton.Size = .regular) {
        self.title = title
        self.systemImage = systemImage
        self.style = style
        self.size = size
    }

    private var font: Font {
        switch (size, style) {
        case (.phone, .quiet): OnboardingType.Phone.body
        case (.phone, _): OnboardingType.Phone.button
        case (.large, _): .system(size: 15, weight: .semibold)
        case (.regular, .row), (.regular, .action): .system(size: 12, weight: .semibold)
        case (.regular, .quiet): .system(size: 13, weight: .medium)
        case (.regular, .primary): .system(size: 13, weight: .semibold)
        }
    }

    private var height: CGFloat {
        switch size {
        case .phone: style == .quiet ? 44 : 52
        case .large: 40
        case .regular: style == .row || style == .action ? 26 : 30
        }
    }

    public var body: some View {
        HStack(spacing: 5) {
            Text(title)
            if let systemImage {
                Image(systemName: systemImage).font(.system(size: size == .phone ? 13 : 10, weight: .bold))
            }
        }
        .font(font)
        // On the iPhone a label wraps at large text sizes rather than truncating; on the Mac it stays one line.
        .lineLimit(size == .phone ? 3 : 1)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: size != .phone, vertical: true)
        .foregroundStyle(style == .primary || style == .action ? AnyShapeStyle(ConchColor.onAccent) : style == .row ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textSecondary))
        .padding(.horizontal, style == .quiet ? 4 : size == .large ? 26 : size == .phone ? 20 : style == .action ? 11 : style == .row ? 12 : 16)
        .frame(maxWidth: size == .phone && style != .quiet ? .infinity : nil)
        .padding(.vertical, size == .phone ? 8 : 0)
        .frame(minHeight: height, maxHeight: size == .phone ? nil : height)
        .background {
            switch style {
            case .primary, .action:
                if size == .phone {
                    RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ConchColor.accent)
                } else {
                    Capsule().fill(ConchColor.accent)
                }
            case .row:
                Capsule().fill(ConchColor.fill)
                    .overlay(Capsule().strokeBorder(ConchColor.hairline, lineWidth: 0.5))
            case .quiet:
                EmptyView()
            }
        }
        .contentShape(Rectangle())
    }
}

/// Pressed, a button settles in a touch on the pop spring and springs back; under Reduce Motion it only dims.
struct OnboardingPress: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

// MARK: - Marks

/// Done: ready's green disc with a white check, the "come and look" green's calmer use.
public struct OnboardingCheck: View {
    let size: CGFloat

    public init(size: CGFloat = 18) { self.size = size }

    public var body: some View {
        Circle()
            .fill(VoiceOrb.readyFill.color)
            .overlay(
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.5, weight: .bold))
                    .foregroundStyle(ConchColor.onVoice)
            )
            .frame(width: size, height: size)
            .accessibilityLabel("Done")
    }
}

/// Working on it: an arc that turns, still in a render and under Reduce Motion (where it pulses instead of turning).
public struct OnboardingSpinner: View {
    let size: CGFloat
    let phase: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.conchRendersStatically) private var statically

    public init(size: CGFloat = 14, phase: Double? = nil) {
        self.size = size
        self.phase = phase
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: statically || reduceMotion)) { timeline in
            let turn = phase ?? (statically ? 0.12 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9)
            ZStack {
                Circle().stroke(ConchColor.fill, lineWidth: size * 0.14)
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(ConchColor.textSecondary, style: StrokeStyle(lineWidth: size * 0.14, lineCap: .round))
                    .rotationEffect(.degrees(reduceMotion ? 0 : turn * 360))
            }
            .frame(width: size, height: size)
        }
        .accessibilityLabel("Working")
    }
}

/// A thin bar for a download: ink on the fill track, calm rather than the blue that means an agent at work.
public struct OnboardingProgressBar: View {
    let fraction: Double
    var height: CGFloat = 4
    var tint: ConchColorToken = ConchColor.textSecondary

    public init(_ fraction: Double, height: CGFloat = 4, tint: ConchColorToken = ConchColor.textSecondary) {
        self.fraction = fraction
        self.height = height
        self.tint = tint
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(ConchColor.fill)
                Capsule().fill(tint)
                    .frame(width: max(height, proxy.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: height)
        .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
    }
}

/// A key as it's printed on the keyboard: ⌃, ⌥, ⌘, P.
public struct Keycap: View {
    let key: String
    var size: CGFloat = 12
    /// Held down right now: the key in the card lights as the real one is pressed, so trying it is its own proof.
    var lit = false

    public init(_ key: String, size: CGFloat = 12, lit: Bool = false) {
        self.key = key
        self.size = size
        self.lit = lit
    }

    public var body: some View {
        Text(key)
            .font(.system(size: size, weight: .semibold, design: .rounded))
            .foregroundStyle(lit ? AnyShapeStyle(ConchColor.onAccent) : AnyShapeStyle(ConchColor.textPrimary))
            .frame(minWidth: size * 1.9)
            .padding(.horizontal, 4)
            .frame(height: size * 1.9)
            .background(
                RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous)
                    .fill(lit ? AnyShapeStyle(ConchColor.accent) : AnyShapeStyle(ConchColor.surfaceRaised))
                    .shadow(color: .black.opacity(lit ? 0 : 0.12), radius: 0, y: 1)
            )
            .offset(y: lit ? 1 : 0)
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
    }
}

/// A shortcut as keycaps: "⌃⌥⌘P" drawn as four keys.
public struct KeyChord: View {
    let chord: String
    var size: CGFloat = 12
    var lit = false

    public init(_ chord: String, size: CGFloat = 12, lit: Bool = false) {
        self.chord = chord
        self.size = size
        self.lit = lit
    }

    public var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(chord.enumerated()), id: \.offset) { _, key in Keycap(String(key), size: size, lit: lit) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chord)
    }
}

// MARK: - Cards and rows

/// Rows grouped on one surface, as System Settings groups them: white on the ground in light, a step up in dark, a
/// hairline round it, and a hairline between rows that starts where the words do.
public struct OnboardingCard<Content: View>: View {
    let content: Content

    public init(@ViewBuilder content: () -> Content) { self.content = content() }

    public var body: some View {
        VStack(spacing: 0) { content }
            .background(
                RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous)
                    .fill(ConchColor.surface)
                    .conchElevation(.panel)
            )
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }
}

/// The line between two rows in a card, from where the words start.
public struct OnboardingDivider: View {
    var leading: CGFloat = 60

    public init(leading: CGFloat = 60) { self.leading = leading }

    public var body: some View {
        Rectangle().fill(ConchColor.hairline).frame(height: 1).padding(.leading, leading)
    }
}

/// A row's icon: a symbol, or an agent's mark, on a soft tile.
public struct OnboardingTile: View {
    let symbol: String?
    let image: Image?
    var size: CGFloat = 32
    var dimmed = false

    public init(symbol: String, size: CGFloat = 32, dimmed: Bool = false) {
        self.symbol = symbol
        self.image = nil
        self.size = size
        self.dimmed = dimmed
    }

    public init(image: Image?, fallback: String, size: CGFloat = 32, dimmed: Bool = false) {
        self.symbol = image == nil ? fallback : nil
        self.image = image
        self.size = size
        self.dimmed = dimmed
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(ConchColor.fill)
            if let image {
                image.renderingMode(.template).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                    .frame(width: size * 0.56, height: size * 0.56)
            } else if let symbol {
                Image(systemName: symbol).font(.system(size: size * 0.44, weight: .medium))
            }
        }
        .foregroundStyle(dimmed ? ConchColor.textTertiary : ConchColor.textPrimary)
        .frame(width: size, height: size)
    }
}

/// A row: tile, what it is and a line under it, and whatever it acts with on the right.
public struct OnboardingRow<Trailing: View, Below: View>: View {
    let tile: OnboardingTile
    let title: String
    let detail: String
    var detailTone: ConchColorToken = ConchColor.textSecondary
    var tag: String?
    let trailing: Trailing
    let below: Below

    public init(tile: OnboardingTile, title: String, detail: String, detailTone: ConchColorToken = ConchColor.textSecondary, tag: String? = nil,
                @ViewBuilder trailing: () -> Trailing, @ViewBuilder below: () -> Below) {
        self.tile = tile
        self.title = title
        self.detail = detail
        self.detailTone = detailTone
        self.tag = tag
        self.trailing = trailing()
        self.below = below()
    }

    public var body: some View {
        HStack(alignment: .top, spacing: ConchSpace.x3) {
            tile
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(title).font(OnboardingType.rowTitle).foregroundStyle(ConchColor.textPrimary)
                    if let tag {
                        Text(tag)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(ConchColor.textSecondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(ConchColor.fill))
                    }
                }
                Text(detail)
                    .font(OnboardingType.rowDetail)
                    .foregroundStyle(detailTone)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(1.5)
                below
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 1)
            trailing.frame(minHeight: 32)
        }
        .padding(.horizontal, ConchSpace.x4)
        .padding(.vertical, 14)
    }
}

extension OnboardingRow where Below == EmptyView {
    public init(tile: OnboardingTile, title: String, detail: String, detailTone: ConchColorToken = ConchColor.textSecondary, tag: String? = nil,
                @ViewBuilder trailing: () -> Trailing) {
        self.init(tile: tile, title: title, detail: detail, detailTone: detailTone, tag: tag, trailing: trailing, below: { EmptyView() })
    }
}

/// A status on the right of a row: a mark and a word.
public struct OnboardingStatus: View {
    public enum Kind: Sendable {
        case done
        case working
        case off
        case note
    }

    let kind: Kind
    let text: String

    public init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }

    public var body: some View {
        HStack(spacing: 6) {
            switch kind {
            case .done: OnboardingCheck(size: 16)
            case .working: OnboardingSpinner(size: 13)
            case .off:
                Image(systemName: "exclamationmark.circle.fill").font(.system(size: 14)).foregroundStyle(ConchColor.attention)
            case .note: EmptyView()
            }
            Text(text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(kind == .off ? ConchColor.attention : ConchColor.textSecondary)
                .lineLimit(1)
                .fixedSize()
        }
    }
}

// MARK: - Layout

/// Chips in rows, wrapping when a row is full.
public struct OnboardingFlowLayout: Layout {
    var spacing: CGFloat

    public init(spacing: CGFloat = 6) { self.spacing = spacing }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func rows(width: CGFloat, subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.items.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.items + [index], needed, max(current.height, size.height))
            }
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}
