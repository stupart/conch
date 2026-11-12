import SwiftUI

extension EnvironmentValues {
    /// Set by the gallery. ImageRenderer cannot draw a platform text field, so a component that hosts one
    /// draws a SwiftUI stand-in in the same type and colours instead.
    @Entry public var conchRendersStatically = false
    /// How far a palette has crossfaded from light (0) to dark (1). Colour tokens follow it rather than the colour scheme,
    /// so the words turn with the look.
    @Entry public var conchDarkness: Double? = nil
}

// MARK: - VoiceGlyph

/// The voice everywhere except the menu bar: a waveform while speaking, a mic while listening, a muted
/// speaker when quiet. The waveform swells and the mic breathes, gently; both hold still under Reduce Motion.
public struct VoiceGlyph: View {
    public enum Kind: Sendable {
        case speaking
        case listening
        case quiet

        var label: String {
            switch self {
            case .speaking: "Speaking"
            case .listening: "Listening"
            case .quiet: "Quiet"
            }
        }
    }

    let kind: Kind
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Its window can't be seen: the clock stops (`conchHidden`).
    @Environment(\.conchHidden) private var hidden

    public init(_ kind: Kind, size: CGFloat = 18) {
        self.kind = kind
        self.size = size
    }

    /// Bar heights from the approved control bar, out of 18.
    static let bars: [CGFloat] = [7, 14, 10, 16, 6]

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || kind == .quiet || hidden)) { timeline in
            glyph(at: reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate)
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(kind.label)
    }

    @ViewBuilder
    private func glyph(at time: Double) -> some View {
        let unit = size / 18
        switch kind {
        case .speaking:
            HStack(spacing: 2 * unit) {
                ForEach(Self.bars.indices, id: \.self) { index in
                    // Each bar swells on its own phase, so they never move as one block.
                    let swell = reduceMotion ? 1 : 0.72 + 0.28 * sin(2 * .pi * (time / ConchMotion.wavePeriod + Double(index) * 0.23))
                    Capsule().frame(width: 2.5 * unit, height: Self.bars[index] * unit * swell)
                }
            }
        case .listening:
            Image(systemName: "mic")
                .font(.system(size: 15 * unit, weight: .semibold))
                .opacity(reduceMotion ? 1 : 0.82 + 0.18 * sin(2 * .pi * time / ConchMotion.breathPeriod))
        case .quiet:
            Image(systemName: "speaker.slash")
                .font(.system(size: 14 * unit, weight: .semibold))
        }
    }
}

// MARK: - VoiceOrb

/// The round voice control at the start of the control bar and the menu header.
public struct VoiceOrb: View {
    let state: VoiceState
    let size: CGFloat

    /// How far the listening ring reaches past the orb, as a fraction of its size.
    public static let ringSpread: CGFloat = 5 / 36
    /// The mic on listening's orange, the same in light and dark as the orange is.
    public static let onListening = ConchColor.textPrimary.light
    /// Ready's disc, under a white check: the light green in both schemes, as the menu bar mark drew it when it was
    /// coloured. Dark's brighter green is for a mark on a dark ground, and the check on it measured 2.72; on this it is 3.57.
    public static let readyFill = ConchColor.ready.light

    public init(state: VoiceState, size: CGFloat = 36) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        ZStack {
            switch state {
            case .speaking:
                Circle().fill(ConchColor.accent)
                VoiceGlyph(.speaking, size: size / 2).foregroundStyle(ConchColor.onAccent)
            case .listening:
                Circle().fill(ConchColor.listeningRing).padding(-size * Self.ringSpread)
                Circle().fill(ConchColor.listening)
                // Dark on the orange: white on #FF9F0A measured 2.06, this 8.19.
                VoiceGlyph(.listening, size: size / 2).foregroundStyle(Self.onListening.color)
            case .quiet:
                Circle().fill(ConchColor.fill)
                VoiceGlyph(.quiet, size: size / 2).foregroundStyle(ConchColor.textSecondary)
            case .talk:
                Circle().fill(ConchColor.fill)
                Image(systemName: "mic")
                    .font(.system(size: size * 15 / 36, weight: .semibold))
                    .foregroundStyle(ConchColor.textSecondary)
            case .ready:
                Circle().fill(Self.readyFill.color)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 15 / 36, weight: .bold))
                    .foregroundStyle(ConchColor.onVoice)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.title)
    }
}

/// The orb with the state and what it is about: "Speaking / Blueprint monorepo", or with `leadsWithDetail`,
/// "Blueprint monorepo / Speaking".
public struct VoiceStateLabel: View {
    let state: VoiceState
    let detail: String
    let orbSize: CGFloat
    let leadsWithDetail: Bool

    public init(state: VoiceState, detail: String, orbSize: CGFloat = 36, leadsWithDetail: Bool = false) {
        self.state = state
        self.detail = detail
        self.orbSize = orbSize
        self.leadsWithDetail = leadsWithDetail
    }

    public var body: some View {
        let detailFirst = leadsWithDetail && !detail.isEmpty
        HStack(spacing: ConchSpace.x3) {
            VoiceOrb(state: state, size: orbSize)
            VStack(alignment: .leading, spacing: 1) {
                Text(detailFirst ? detail : state.title)
                    .font(ConchType.uiEmphasis)
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                if detailFirst || !detail.isEmpty {
                    Text(detailFirst ? state.title : detail)
                        .font(ConchType.secondary)
                        .foregroundStyle(ConchColor.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(detail.isEmpty ? state.title : "\(state.title), \(detail)")
    }
}

// MARK: - ReviewScene

/// What opening a review brings forward (the menu's Ready for you, the floating pill, the phone's Next): the agents
/// showing you their work, rather than you going to find it (Tyler: "it's like the agents are messaging me 'look at this' and showing me stuff").
public enum ReviewScene: Equatable {
    /// The deliverable itself, in whatever app macOS opens it with.
    case open(URL)
    /// conch's window, on the session.
    case app
    /// The session's terminal.
    case terminal

    /// The scene a review asked for (`scene.target.kind`, v1). None, or one this build doesn't know, is `auto`.
    public enum Kind: String, Sendable {
        case auto, link, conversation, terminal
    }

    /// `auto` and `link`: the link first, a web page or a file that is there; else conch's window if it is open; else the
    /// session's terminal; else conch's window anyway, for a session there is nothing else to show of. `link` is the
    /// same order said explicitly: a link that fails to open (passed back as nil) falls through to the rest.
    /// `conversation`: conch's window on the session, even with a link, opened if it is closed. `terminal`: the
    /// session's terminal, else conch's window.
    public static func choose(kind: Kind = .auto, link: URL?, fileExists: (String) -> Bool, appWindowOpen: Bool, revealable: Bool) -> ReviewScene {
        switch kind {
        case .conversation: return .app
        case .terminal: return revealable ? .terminal : .app
        case .auto, .link: break
        }
        if let link, ["http", "https"].contains(link.scheme?.lowercased() ?? "") { return .open(link) }
        if let link, link.isFileURL, fileExists(link.path) { return .open(link) }
        if appWindowOpen { return .app }
        if revealable { return .terminal }
        return .app
    }

    /// The review a click brings forward, from the ready ones by version (a session and when its review was filed) and
    /// filing time. Oldest filed first, ties by version so the order never shuffles; the unopened before any already
    /// opened; the next after `last`, round to the first again. A `last` no longer ready starts the queue over.
    public static func next<Key: Comparable & Hashable>(after last: Key?, in ready: [(key: Key, at: Double)], opened: Set<Key>) -> Key? {
        let queue = order(ready)
        let unopened = queue.filter { !opened.contains($0) }
        let pool = unopened.isEmpty ? queue : unopened
        guard let lastIndex = last.flatMap(queue.firstIndex(of:)) else { return pool.first }
        return pool.first { queue.firstIndex(of: $0)! > lastIndex } ?? pool.first
    }

    /// Oldest filed first, ties by version so the order never shuffles.
    public static func order<Key: Comparable>(_ ready: [(key: Key, at: Double)]) -> [Key] {
        ready.sorted { ($0.at, $0.key) < ($1.at, $1.key) }.map { $0.key }
    }

    /// The deliverable kinds (src/deliverables.ts) conch's window shows inside itself, in the deliverable pane's own
    /// renderers (ReviewView.swift): a page, a document, a picture, a video, a sound, a live url, a folder's tree.
    static let panelKinds: Set<String> = ["page", "markdown", "text", "image", "pdf", "video", "audio", "url", "folder"]

    /// A deliverable only conch can show as it was published, so it opens in conch from anywhere rather than in its own
    /// app: one with marks (drawn only where conch shows the work), and a folder, whose tree with what the agent pointed at
    /// (`focus`) is conch's; Finder would show the folder and none of it.
    ///
    /// And a Figma file (`FigmaLink`, 2026-11-11). Tyler: "Make figma show in the deliverables area instead of
    /// automatically sending me to figma." It shows as Figma's embed in conch's deliverable pane; "Open in Figma" (⌘3) is
    /// the way to the app.
    public static func opensOnlyInConch(deliverable: String?, marked: Bool, link: URL? = nil) -> Bool {
        marked || deliverable == "folder" || link.map(FigmaLink.isFile) == true
    }
    /// The same kinds by a file's extension, src/deliverables.ts's table, for a deliverable filed without one.
    static let panelExtensions: Set<String> = [
        "html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff", "mp4", "mov", "m4v", "webm",
        "mp3", "m4a", "wav", "aac", "aiff", "flac", "ogg", "pdf", "md", "markdown",
        "txt", "log", "json", "yaml", "yml", "toml", "csv", "diff", "patch",
    ]

    /// A deliverable conch's window shows itself, in its deliverable pane, rather than bringing it forward in its own app.
    /// It was the conversation panel's rule (09-21, "BOTH") and stays the window's now the panel is gone (2026-11-11).
    /// Only where the scene would open the link, so a scene asked for by name, or a link with nothing behind it, is as
    /// before; and only a kind the pane can draw, so an app window, the Simulator, a terminal or an office document still
    /// comes forward in its own app. A Figma file is drawn too, as Figma's embed (2026-11-11). `deliverable` is the kind
    /// it was filed as; with none, from a daemon older than kinds, the link says: a web page but Figma's other pages, or a
    /// file by its extension.
    public static func panelShowsContent(kind: Kind, deliverable: String?, link: URL?, fileExists: (String) -> Bool) -> Bool {
        guard case let .open(url) = choose(kind: kind, link: link, fileExists: fileExists, appWindowOpen: false, revealable: false) else { return false }
        // A Figma file, whatever it was filed as: Figma's embed, drawn here (`FigmaLink.embedPage`, 2026-11-11).
        if FigmaLink.isFile(url) { return true }
        if let deliverable { return panelKinds.contains(deliverable) }
        if url.isFileURL { return panelExtensions.contains(url.pathExtension.lowercased()) }
        let host = url.host?.lowercased() ?? ""
        return host != "figma.com" && !host.hasSuffix(".figma.com")
    }
}

// MARK: - Previews

#Preview("Voice") {
    VStack(alignment: .leading, spacing: 20) {
        HStack(spacing: 20) {
            VoiceGlyph(.speaking)
            VoiceGlyph(.listening)
            VoiceGlyph(.quiet)
        }
        .foregroundStyle(ConchColor.textPrimary)
        HStack(spacing: 20) {
            ForEach(VoiceState.allCases, id: \.self) { VoiceOrb(state: $0) }
        }
        VoiceStateLabel(state: .speaking, detail: "Blueprint monorepo")
    }
    .padding(32)
    .background(ConchColor.ground)
}
