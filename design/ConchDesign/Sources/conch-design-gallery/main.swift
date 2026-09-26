// Renders every token and component, light and dark, to PNGs, so the design is checked by picture
// without opening an app window:  swift run conch-design-gallery <outdir>
import AppKit
import ConchDesign
import CoreImage
import ImageIO
import SwiftUI

let outDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "gallery", isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// Top-level code here is not main-actor isolated, but it does run on the main thread, which ImageRenderer needs.
func render<Content: View>(_ name: String, width: CGFloat = 960, @ViewBuilder _ content: () -> Content) throws {
    try MainActor.assumeIsolated { try renderOnMain(name, width: width, content) }
}

@MainActor
func renderOnMain<Content: View>(_ name: String, width: CGFloat, _ content: () -> Content) throws {
    for scheme in [ColorScheme.light, .dark] {
        let sheet = VStack(alignment: .leading, spacing: 28) { content() }
            .padding(40)
            .frame(width: width, alignment: .leading)
            .background(ConchColor.ground)
            .environment(\.colorScheme, scheme)
            .environment(\.conchRendersStatically, true)
        let renderer = ImageRenderer(content: sheet)
        renderer.scale = 2
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            fatalError("could not render \(name)")
        }
        let file = outDir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
        try png.write(to: file)
        print(file.path)
    }
}

struct Heading: View {
    let title: String
    var note = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(ConchType.title).foregroundStyle(ConchColor.textPrimary)
            if !note.isEmpty { Text(note).font(ConchType.secondary).foregroundStyle(ConchColor.textSecondary) }
        }
    }
}

struct Caption: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(ConchType.meta).foregroundStyle(ConchColor.textTertiary) }
}

struct Swatch: View {
    let token: ConchColorToken
    @Environment(\.colorScheme) private var scheme

    private var note: String {
        let value = token.rgba(scheme)
        if ConchColor.text.contains(where: { $0.name == token.name }) {
            return ConchColor.grounds.map { "\($0.name) \(String(format: "%.1f", value.contrast(on: $0.rgba(scheme))))" }.joined(separator: " · ")
        }
        if token.name == "onAccent" {
            return "on accent \(String(format: "%.1f", value.contrast(on: ConchColor.accent.rgba(scheme))))"
        }
        if [ConchColor.speaking, ConchColor.listening, ConchColor.quiet, ConchColor.ready].contains(where: { $0.name == token.name }) {
            return "graphic on ground \(String(format: "%.1f", value.contrast(on: ConchColor.ground.rgba(scheme))))"
        }
        return ""
    }

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 8)
                .fill(ConchColor.surface)
                .overlay(RoundedRectangle(cornerRadius: 8).fill(token))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
                .frame(width: 52, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(token.name).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary)
                Text(token.rgba(scheme).hexString).font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
                if !note.isEmpty { Caption(note) }
            }
        }
        .frame(width: 420, alignment: .leading)
    }
}

func pairs<T>(_ items: [T]) -> [[T]] {
    stride(from: 0, to: items.count, by: 2).map { Array(items[$0..<min($0 + 2, items.count)]) }
}

let sample = "Changed. The button reads Join, and it still waits for the email check."

// Colours
try render("tokens-color") {
    Heading(title: "Colour", note: "Text contrast is listed against each ground (WCAG, 4.5 minimum).")
    VStack(alignment: .leading, spacing: 14) {
        ForEach(Array(pairs(ConchColor.all).enumerated()), id: \.offset) { _, row in
            HStack(spacing: 20) { ForEach(row, id: \.name) { Swatch(token: $0) } }
        }
    }
    HStack(spacing: 16) {
        ForEach(ConchColor.grounds, id: \.name) { ground in
            VStack(alignment: .leading, spacing: 6) {
                Caption(ground.name)
                Text("Primary text").font(ConchType.uiBody).foregroundStyle(ConchColor.textPrimary)
                Text("Secondary text").font(ConchType.uiBody).foregroundStyle(ConchColor.textSecondary)
                Text("Tertiary text").font(ConchType.uiBody).foregroundStyle(ConchColor.textTertiary)
            }
            .padding(14)
            .frame(width: 200, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ground))
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairline, lineWidth: 1))
        }
    }
}

// Type
try render("tokens-type") {
    Heading(title: "Type", note: "SF Pro through the system font. Shown at the macOS sizes; iOS uses the text style beside each.")
    ForEach(ConchType.roles, id: \.name) { role in
        VStack(alignment: .leading, spacing: 4) {
            Caption("\(role.name) · macOS \(role.mac) · iOS \(role.iOS)")
            Text(role.name == "code" ? "conch shot /tmp/conch.png" : sample)
                .font(role.font)
                .foregroundStyle(role.name == "secondary" ? ConchColor.textSecondary : role.name == "meta" ? ConchColor.textTertiary : ConchColor.textPrimary)
                .lineSpacing(role.name == "readingBody" ? ConchType.readingLineSpacing : 0)
        }
    }
}

// Space, radius, elevation, motion
try render("tokens-scale") {
    Heading(title: "Space, radius, elevation, motion")
    VStack(alignment: .leading, spacing: 6) {
        Caption("space, a 4-point scale")
        ForEach(ConchSpace.scale, id: \.self) { value in
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 2).fill(ConchColor.accent).frame(width: value * 4, height: 10)
                Text("\(Int(value))").font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
            }
        }
    }
    VStack(alignment: .leading, spacing: 6) {
        Caption("radius: small, medium, large, panel")
        HStack(spacing: 16) {
            ForEach(ConchRadius.scale, id: \.self) { radius in
                RoundedRectangle(cornerRadius: radius)
                    .fill(ConchColor.surface)
                    .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
                    .frame(width: 96, height: 72)
                    .overlay(Text("\(Int(radius))").font(ConchType.code).foregroundStyle(ConchColor.textSecondary))
            }
        }
    }
    VStack(alignment: .leading, spacing: 10) {
        Caption("elevation")
        HStack(spacing: 28) {
            ForEach(ConchElevation.allCases, id: \.self) { level in
                RoundedRectangle(cornerRadius: ConchRadius.large)
                    .fill(ConchColor.surface)
                    .frame(width: 150, height: 90)
                    .conchElevation(level)
                    .overlay(Text(level.rawValue).font(ConchType.uiBody).foregroundStyle(ConchColor.textPrimary))
            }
        }
        .padding(.vertical, 24)
    }
    VStack(alignment: .leading, spacing: 4) {
        Caption("motion (seconds; none under Reduce Motion)")
        Text(verbatim: "quick \(ConchMotion.quick) · standard \(ConchMotion.standard) · gentle \(ConchMotion.gentle) · wave \(ConchMotion.wavePeriod) · breath \(ConchMotion.breathPeriod)")
            .font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
        Caption("springs, bounce / response (s), from the overlay lab; Reduce Motion drops the bounce")
        Text(verbatim: ConchMotion.springs.map { "\($0.name) \($0.spring.bounce) / \($0.spring.response)" }.joined(separator: " · "))
            .font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
        Text(verbatim: "flight: scale \(ConchMotion.flightScale) · blur \(ConchMotion.flightBlur) · opacity \(ConchMotion.flightOpacity) · words: reveal \(ConchMotion.wordReveal) s · blur \(ConchMotion.wordRevealBlur) · \(ConchMotion.wordsPerSecond)/s")
            .font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
    }
}

// Motion: each spring seen rather than read
try render("tokens-motion") {
    Heading(title: "Motion", note: "Each spring from 0 to 1 over 1.2 s, stepped the way the apps step it. Tuned in the overlay lab; Reduce Motion drops the bounce.")
    ForEach(ConchMotion.springs, id: \.name) { item in
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.name).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary)
                Text(verbatim: "bounce \(item.spring.bounce) · \(item.spring.response) s").font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
            }
            .frame(width: 200, alignment: .leading)
            SpringCurve(spring: item.spring).frame(width: 640, height: 64)
        }
    }
}

/// A spring's step response over `seconds`, against a hairline at its target.
struct SpringCurve: View {
    let spring: ConchSpring
    var seconds = 1.2

    var body: some View {
        Canvas { context, size in
            let scheme = context.environment.colorScheme
            // 0 at the bottom, 1 at 70% up, leaving room above for the overshoot.
            func y(_ value: CGFloat) -> CGFloat { size.height * (0.95 - 0.7 * value) }
            var target = Path()
            target.move(to: CGPoint(x: 0, y: y(1)))
            target.addLine(to: CGPoint(x: size.width, y: y(1)))
            context.stroke(target, with: .color(ConchColor.hairlineStrong.color(scheme)), lineWidth: 1)
            var value: CGFloat = 0, velocity: CGFloat = 0
            var curve = Path()
            curve.move(to: CGPoint(x: 0, y: y(0)))
            for frame in 1...240 {
                spring.step(&value, velocity: &velocity, to: 1, dt: seconds / 240)
                curve.addLine(to: CGPoint(x: size.width * CGFloat(frame) / 240, y: y(value)))
            }
            context.stroke(curve, with: .color(ConchColor.accent.color(scheme)), lineWidth: 2)
        }
    }
}

// The mark
try render("mark") {
    Heading(title: "The conch mark", note: "Menu bar only. 16 pt, cropped tight, 1.15 pt stroke; Talk is a template image.")
    HStack(alignment: .top, spacing: 18) {
        ForEach(VoiceState.allCases, id: \.self) { state in
            VStack(alignment: .leading, spacing: 12) {
                ConchMarkView(state: state)
                    .frame(width: 96, height: 96)
                    .frame(width: 150, height: 130)
                    .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.surface))
                Text(state.title).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary)
                // The real status item image, at menu bar size, in a strip like the bar.
                HStack(spacing: 10) {
                    Image(nsImage: ConchMark.statusImage(for: state))
                        .renderingMode(state == .talk ? .template : .original)
                        .foregroundStyle(ConchColor.textPrimary)
                        .frame(width: 16, height: 16)
                        .padding(.horizontal, 5)
                        .background(RoundedRectangle(cornerRadius: 4).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
                    Image(systemName: "wifi").font(.system(size: 13, weight: .medium))
                    Text("10:31").font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(ConchColor.fill))
            }
        }
    }
}

// Voice components
try render("components-voice") {
    Heading(title: "Voice", note: "VoiceGlyph, VoiceOrb and VoiceStateLabel.")
    Caption("VoiceGlyph: speaking, listening, quiet (18 and 32)")
    HStack(spacing: 28) {
        VoiceGlyph(.speaking)
        VoiceGlyph(.listening)
        VoiceGlyph(.quiet)
        VoiceGlyph(.speaking, size: 32)
        VoiceGlyph(.listening, size: 32)
        VoiceGlyph(.quiet, size: 32)
    }
    .foregroundStyle(ConchColor.textPrimary)
    Caption("VoiceOrb: talk, speaking, listening, quiet, ready")
    HStack(spacing: 28) {
        ForEach(VoiceState.allCases, id: \.self) { VoiceOrb(state: $0) }
    }
    .padding(6)
    Caption("VoiceStateLabel, and the menu header at 30 pt")
    HStack(spacing: 36) {
        VoiceStateLabel(state: .speaking, detail: "Blueprint monorepo")
        VoiceStateLabel(state: .listening, detail: "You turned on the mic")
        VoiceStateLabel(state: .quiet, detail: "2 ready for you")
    }
    VoiceStateLabel(state: .ready, detail: "Arch brand page", orbSize: 30)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(width: 290, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.surface))
}

// Controls
try render("components-controls") {
    Heading(title: "Controls", note: "TalkQuietSwitch, IconButton, GlassPill and InlineReplyLine.")
    Caption("TalkQuietSwitch")
    HStack(spacing: 20) {
        TalkQuietSwitch(mode: .constant(.talk))
        TalkQuietSwitch(mode: .constant(.quiet))
    }
    Caption("IconButton: plain and primary")
    HStack(spacing: 16) {
        IconButton("bubble.left", label: "Show conversation") {}
        IconButton("arrow.up.left.and.arrow.down.right", label: "Full screen") {}
        IconButton("xmark", label: "Close") {}
        IconButton("arrow.up", label: "Send", style: .primary) {}
    }
    Caption("GlassPill: the control bar (M3), over a busy backdrop")
    ZStack {
        LinearGradient(colors: [Color(red: 0.96, green: 0.79, blue: 0.66), Color(red: 0.73, green: 0.80, blue: 0.95), Color(red: 0.85, green: 0.77, blue: 0.93)], startPoint: .topLeading, endPoint: .bottomTrailing)
            .overlay(Text("Join the Arch team").font(.system(size: 44, weight: .bold)).foregroundStyle(.black.opacity(0.75)).offset(y: -46))
        // The first pill sits over the words, to show the glass.
        VStack(spacing: 56) {
            GlassPill("Voice controls") {
                VoiceStateLabel(state: .speaking, detail: "Blueprint monorepo")
                TalkQuietSwitch(mode: .constant(.talk))
                IconButton("bubble.left", label: "Show conversation") {}
            }
            GlassPill("Voice controls") {
                VoiceStateLabel(state: .listening, detail: "You turned on the mic")
                TalkQuietSwitch(mode: .constant(.quiet))
                IconButton("bubble.left", label: "Show conversation") {}
            }
        }
    }
    .frame(width: 880, height: 220)
    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
    Caption("InlineReplyLine: empty, typed, listening")
    VStack(alignment: .leading, spacing: 18) {
        InlineReplyLine(text: .constant(""), isListening: false, onMic: {}, onSend: {})
        InlineReplyLine(text: .constant("Looks good. Ship it."), isListening: false, onMic: {}, onSend: {})
        InlineReplyLine(text: .constant("Then do the same for the Dayloop invite"), isListening: true, onMic: {}, onSend: {})
    }
    .padding(24)
    .frame(width: 880, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: ConchRadius.large).fill(ConchColor.fog))
}

// M3: the floating control bar and the conversation fog, over a page standing in for another app.
struct OtherApp: View {
    var compact = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        let ink = dark ? Color.white.opacity(0.85) : Color.black.opacity(0.78)
        ZStack(alignment: compact ? .center : .topLeading) {
            LinearGradient(
                colors: dark
                    ? [Color(red: 0.20, green: 0.14, blue: 0.24), Color(red: 0.10, green: 0.15, blue: 0.25), Color(red: 0.24, green: 0.15, blue: 0.12)]
                    : [Color(red: 0.96, green: 0.79, blue: 0.66), Color(red: 0.73, green: 0.80, blue: 0.95), Color(red: 0.85, green: 0.77, blue: 0.93)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            if compact {
                Text("Join the Arch team").font(.system(size: 44, weight: .bold)).foregroundStyle(ink)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Blueprint Studio").font(.system(size: 16, weight: .semibold))
                    Spacer().frame(height: 60)
                    Text("Join the Arch team").font(.system(size: 44, weight: .bold))
                    Text("You'll see Arch's boards and drafts as soon as you're in.").font(.system(size: 18))
                    RoundedRectangle(cornerRadius: 12).frame(width: 360, height: 52).opacity(0.85)
                    RoundedRectangle(cornerRadius: 12).frame(width: 360, height: 52).opacity(0.3)
                }
                .foregroundStyle(ink)
                .padding(.leading, 420)
                .padding(.top, 56)
            }
        }
    }
}

/// `page` blurred by Core Image, standing in for the app's behind-window blur, which ImageRenderer cannot draw (and SwiftUI's
/// own blur tiles in it).
func softened(_ page: CGImage, sigma: Double, saturation: Double = 1) -> CGImage? {
    let input = CIImage(cgImage: page)
    let output = input.clampedToExtent().applyingGaussianBlur(sigma: sigma)
        .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: saturation])
        .cropped(to: input.extent)
    return CIContext().createCGImage(output, from: input.extent)
}

struct BlurredOtherApp: View {
    let size: CGSize
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let blurred { Image(decorative: blurred, scale: 2) }
    }

    private var blurred: CGImage? {
        let renderer = ImageRenderer(content: OtherApp().frame(width: size.width, height: size.height).environment(\.colorScheme, scheme))
        renderer.scale = 2
        return renderer.cgImage.flatMap { softened($0, sigma: 60) }
    }
}

let sampleTurns = [
    ConversationTurn(id: "1", fromYou: true, text: "The invite page still says Accept invitation. Make the button just say Join."),
    ConversationTurn(id: "2", fromYou: false, text: "The label is in `InviteCard.tsx`, and the email invite reads it too, so I'll give the page its own."),
    ConversationTurn(id: "3", fromYou: true, text: "Fine. Keep the email check."),
    ConversationTurn(id: "4", fromYou: false, text: "Changed. The button reads **Join**, and it still waits for the email check before it can be pressed. Tests pass."),
]

/// The overlay over a screen, layered as the Mac overlay layers it (FloatingPanels): the page, the stand-in blur under the
/// look's own mask, the look, and the words. Mid-air it all fades a little.
struct FogScreen<Page: View, Blur: View>: View {
    let page: Page
    let blur: Blur
    let screen: CGSize
    let motion: FogMotion
    var insets = EdgeInsets()
    var voice = VoiceState.talk
    var fullScreen = false
    var draft = ""
    var turns = sampleTurns
    var hovering = true
    /// The words as they move; a fresh, settled one unless a shot sets one up.
    var text: FogTextState?
    /// The session named beside the buttons, the switcher's list and whether it is open, Previous and Next, and the reply line.
    var session: FogSession?
    var sessions: [FogSession] = []
    var switching = false
    var pager = false
    var showsReply = true
    /// Full screen, a deliverable shown in the panel in place of the words.
    var content: FogContent?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let state = text ?? FogTextState()
        var look = FogLook(motion, insets: insets)
        look.darkness = scheme == .dark ? 1 : 0
        // The scrim follows the reply line as it grows.
        let words = ConversationFog.textFrame(in: motion.size, corner: motion.corner, insets: insets, fullScreen: fullScreen, magnet: motion.magnet)
        look.replyHeight = showsReply ? state.replyTarget(for: draft, width: words.width - ConversationFog.micSpace, fontSize: ConversationFog.replyFontSize(fullScreen: fullScreen), in: words.height) : 0
        // Top left, as SwiftUI lays out.
        let fog = CGRect(x: motion.frame.minX, y: screen.height - motion.frame.maxY, width: motion.size.width, height: motion.size.height)
        let panel = fullScreen ? CGRect(origin: .zero, size: screen) : fog
        let window = look.window.offsetBy(dx: fog.minX, dy: fog.minY)
        return ZStack(alignment: .topLeading) {
            page
            ZStack(alignment: .topLeading) {
                blur.mask(alignment: .topLeading) {
                    if fullScreen {
                        Color.black
                    } else if let mask = look.mask() {
                        Image(decorative: mask, scale: 1).resizable().interpolation(.high)
                            .frame(width: window.width, height: window.height)
                            .offset(x: window.minX, y: window.minY)
                    }
                }
                if !fullScreen {
                    FogLookView(look: look, voice: voice).offset(x: window.minX, y: window.minY)
                }
                // The words' flight blur is left out: SwiftUI's blur tiles in ImageRenderer.
                ConversationFog(
                    turns: turns,
                    draft: .constant(draft),
                    text: state,
                    isListening: voice == .listening,
                    isFullScreen: fullScreen,
                    corner: motion.corner,
                    insets: insets,
                    look: fullScreen ? nil : look,
                    floating: motion.isMoving,
                    hovering: hovering,
                    session: session,
                    sessions: sessions,
                    isSwitching: .constant(switching),
                    showsReply: showsReply,
                    content: content,
                    onPrevious: pager ? {} : nil,
                    onNext: pager ? {} : nil,
                    onMic: {},
                    onSend: {},
                    onCollapse: {},
                    onFullScreen: {}
                )
                .frame(width: panel.width, height: panel.height)
                .scaleEffect(1 - (1 - ConchMotion.flightScale) * motion.flying)
                .offset(x: panel.minX, y: panel.minY)
            }
            .compositingGroup()
            .opacity(1 - (1 - ConchMotion.flightOpacity) * motion.flying)
        }
        .frame(width: screen.width, height: screen.height, alignment: .topLeading)
        .clipped()
        .environment(\.conchDarkness, look.darkness)
    }
}

let m3Screen = CGSize(width: 1200, height: 750)

func docked(_ corner: FogCorner, size: CGSize = CGSize(width: 760, height: 560), in screen: CGSize = m3Screen) -> FogMotion {
    FogMotion(size: size, corner: corner, in: CGRect(origin: .zero, size: screen))
}

func m3Fog(_ corner: FogCorner, fullScreen: Bool = false, draft: String = "", voice: VoiceState = .talk, session: FogSession? = nil, switching: Bool = false, pager: Bool = false, showsReply: Bool = true, hovering: Bool = true, content: FogContent? = nil) -> some View {
    FogScreen(page: OtherApp(), blur: BlurredOtherApp(size: m3Screen), screen: m3Screen, motion: docked(corner), voice: voice, fullScreen: fullScreen, draft: draft, hovering: hovering, session: session, sessions: panelSessions, switching: switching, pager: pager, showsReply: showsReply, content: content)
        .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
}

/// The sessions the panel names and switches between. The gallery has no agent marks (they are the Mac app's assets),
/// so the agent's name stands in for them here.
let panelSessions = FogSession.ordered([
    FogSession(id: "docs", label: "conch docs", agent: "Claude", standing: .other),
    FogSession(id: "arch", label: "Arch brand page", agent: "Claude", item: "The invite card: the button reads Join, and it still waits for the email check", standing: .ready),
    FogSession(id: "tests", label: "invite tests", agent: "Codex", standing: .working),
    FogSession(id: "dayloop", label: "Dayloop invite", agent: "Codex", item: "Screenshots at desktop and 390 px", standing: .ready),
])
let panelSession = panelSessions[0]

let barDetails: [VoiceState: String] = [
    .talk: "Blueprint monorepo", .speaking: "Blueprint monorepo", .listening: "You turned on the mic",
    .quiet: "Blueprint monorepo", .ready: "3 sessions",
]
let barReady = ControlBar.Ready(label: "Prime page wireframe", position: 1, count: 3, inspect: "Save stays reachable at phone width")

/// One bar over the page standing in for another app, with a caption saying which state it is.
func barRow(_ caption: String, _ bar: ControlBar) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Caption(caption)
        ZStack {
            OtherApp(compact: true)
            bar
        }
        .frame(width: 880, height: 104)
        .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
    }
}

try render("m3-control-bar") {
    Heading(title: "Control bar", note: "M3. A non-activating panel under the menu bar. While anything is ready its label is the Ready pill, with its ›, whatever the voice is doing; Talk and Quiet give their second line to news.")
    barRow("Talk, with news", ControlBar(state: .talk, detail: barDetails[.talk]!, mode: .constant(.talk), news: "2 working"))
    barRow("Talk, nothing to report", ControlBar(state: .talk, detail: barDetails[.talk]!, mode: .constant(.talk)))
    barRow("Ready: the next session, and where it is — tooltip \"\(barReady.help.replacingOccurrences(of: "\n", with: " / "))\"", ControlBar(state: .ready, detail: barDetails[.ready]!, mode: .constant(.talk), ready: barReady, onTap: {}))
    barRow("Ready, one alone", ControlBar(state: .ready, detail: barDetails[.ready]!, mode: .constant(.talk), ready: .init(label: "Arch brand page", position: 1, count: 1), onTap: {}))
    barRow("Speaking, with something still ready: the pill stays a button", ControlBar(state: .speaking, detail: barDetails[.speaking]!, mode: .constant(.talk), ready: barReady, onTap: {}))
    barRow("Listening: the ring clears the capsule, the mic dark on the orange", ControlBar(state: .listening, detail: barDetails[.listening]!, mode: .constant(.talk)))
    barRow("Quiet", ControlBar(state: .quiet, detail: barDetails[.quiet]!, mode: .constant(.quiet), news: "1 working"))
}

// M2: the menu bar menu, drawn from `StatusMenu`'s rows, the words the app builds its NSMenu from. The drawing stands in
// for AppKit's (an NSMenu can't be rendered offscreen); the rows, ticks, dots and keys are the real ones.
struct MenuPicture: View {
    let rows: [StatusMenu.Row]
    let voice: VoiceState
    let detail: String
    /// ⌥ held: each alternate in place of the item before it.
    var option = false
    @Environment(\.colorScheme) private var scheme

    private var shown: [StatusMenu.Row] {
        var out: [StatusMenu.Row] = []
        for row in rows {
            guard case let .item(item) = row else { out.append(row); continue }
            if item.alternate {
                if option { out[out.count - 1] = row }
            } else {
                out.append(row)
            }
        }
        return out
    }

    private func keys(_ item: StatusMenu.Item) -> String {
        guard !item.key.isEmpty else { return "" }
        return item.modifiers.map(\.rawValue).joined() + (item.key == " " ? "Space" : item.key.uppercased())
    }

    var body: some View {
        let dark = scheme == .dark
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
                switch row {
                case .header:
                    VoiceStateLabel(state: voice, detail: detail, orbSize: 30)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                case .separator:
                    Rectangle().fill(dark ? Color.white.opacity(0.1) : Color.black.opacity(0.1)).frame(height: 1).padding(.horizontal, 10).padding(.vertical, 5)
                case let .section(title):
                    Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(dark ? Color.white.opacity(0.5) : Color.black.opacity(0.5))
                        .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 2)
                case let .item(item):
                    HStack(spacing: 6) {
                        Group {
                            switch item.mark {
                            case .on: Image(systemName: "checkmark")
                            case .mixed: Image(systemName: "minus")
                            case .off: Color.clear
                            }
                        }
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 12)
                        if let dot = item.dot {
                            Image(systemName: dot.symbol).font(.system(size: 7)).foregroundStyle(dot.colour)
                        }
                        Text(item.title).font(.system(size: 13))
                        Spacer(minLength: 16)
                        Text(keys(item)).font(.system(size: 13)).opacity(0.5)
                    }
                    .foregroundStyle(dark ? Color.white.opacity(item.enabled ? 0.88 : 0.3) : Color.black.opacity(item.enabled ? 0.85 : 0.3))
                    .padding(.horizontal, 10)
                    .frame(height: 22)
                }
            }
        }
        .padding(.vertical, 5)
        .frame(width: 330, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(dark ? Color(white: 0.17) : Color(white: 0.95)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(dark ? Color.white.opacity(0.12) : Color.black.opacity(0.12), lineWidth: 0.5))
    }
}

let menuInput = StatusMenu.Input(
    voice: .ready, quiet: false, exchangeActive: false, controlBar: true, conversation: true, collapsed: true,
    replyLine: true, drawing: false,
    ready: [.init(id: "r1", label: "Prime page wireframe"), .init(id: "r2", label: "Arch brand page")],
    working: [.init(id: "w1", label: "Parser refactor"), .init(id: "w2", label: "Invite tests")]
)

try render("m2-status-menu", width: 1180) {
    Heading(title: "Menu bar menu", note: "M2. StatusMenu's rows. The conversation panel folded to its handle is a dash, not a tick; Ready for you rows open the item, ⌥ opens conch; working is a filled blue dot.")
    HStack(alignment: .top, spacing: 36) {
        VStack(alignment: .leading, spacing: 10) {
            Caption("As it opens")
            MenuPicture(rows: StatusMenu.rows(menuInput), voice: .ready, detail: "2 sessions")
        }
        VStack(alignment: .leading, spacing: 10) {
            Caption("With ⌥ held")
            MenuPicture(rows: StatusMenu.rows(menuInput), voice: .ready, detail: "2 sessions", option: true)
        }
        VStack(alignment: .leading, spacing: 10) {
            Caption("Listening, the panel open, drawing")
            MenuPicture(rows: StatusMenu.rows(StatusMenu.Input(
                voice: .listening, quiet: true, exchangeActive: true, controlBar: false, conversation: true, collapsed: false,
                replyLine: false, drawing: true, ready: [], working: [.init(id: "w1", label: "Parser refactor")]
            )), voice: .listening, detail: "You turned on the mic")
        }
    }
}

try render("m3-fog-corner", width: 1280) {
    Heading(title: "Conversation fog, corner", note: "M3. The blur is simulated here; the app draws a behind-window visual effect view under the same mask.")
    m3Fog(.bottomLeading)
}

try render("m3-fog-fullscreen", width: 1280) {
    Heading(title: "Conversation fog, full screen", note: "Command-Return or the button; leaving restores the corner's frame. Listening, with a reply typed.")
    m3Fog(.bottomLeading, fullScreen: true, draft: "Looks good. Ship it, then the Dayloop invite", voice: .listening)
}

try render("m3-fog-collapsed", width: 1280) {
    Heading(title: "Conversation fog, collapsed", note: "The fog's collapse button folds it to this handle in its corner; a click opens it again at the size it had.")
    ZStack(alignment: .bottomLeading) {
        OtherApp()
        FogHandle {}
            .padding(ConchSpace.x4)
    }
    .frame(width: m3Screen.width, height: m3Screen.height)
    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
}

try render("m3-panel-header", width: 1280) {
    Heading(title: "Conversation panel, named", note: "The session, its agent and the item it is on, one line beside the buttons; Previous and Next walk what is ready. Pointer away: faint.")
    m3Fog(.bottomLeading, session: panelSession, pager: true)
    m3Fog(.bottomLeading, session: panelSession, pager: true, hovering: false)
    // A short name with no item, and nothing ready: the name hugs the buttons in their corner.
    m3Fog(.bottomTrailing, session: panelSessions[3])
}

try render("m3-panel-switcher", width: 1280) {
    Heading(title: "Conversation panel, switching", note: "A click on the name lists every session: ready for you, working, the rest. It opens away from the docked edge.")
    m3Fog(.bottomLeading, session: panelSession, switching: true, pager: true)
    m3Fog(.topTrailing, session: panelSession, switching: true, pager: true)
}

try render("m3-panel-fullscreen", width: 1280) {
    Heading(title: "Conversation panel, full screen on a pick", note: "A session with nothing to open: its words fill the screen, named at the top left. Reply line off.")
    m3Fog(.bottomLeading, fullScreen: true, session: panelSession, pager: true, showsReply: false)
}

/// A page an agent staged, as the side panel's web renderer draws it: its origin above it, then the page.
struct StagedPage: View {
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "globe").font(.system(size: 9.5))
                Text(verbatim: "http://localhost:3111").font(.system(size: 11))
            }
            .foregroundStyle(ConchColor.textSecondary)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ConchColor.surface)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            // panel-lab's staged site: a light page whatever the panel's appearance, as a web page is.
            ZStack(alignment: .leading) {
                Color(red: 0.98, green: 0.97, blue: 0.96)
                RadialGradient(colors: [Color(red: 0.96, green: 0.79, blue: 0.66), .clear], center: UnitPoint(x: 0.2, y: 0.4), startRadius: 0, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.73, green: 0.80, blue: 0.96), .clear], center: UnitPoint(x: 0.82, y: 0.3), startRadius: 0, endRadius: 420)
                VStack(alignment: .leading, spacing: 18) {
                    Text(verbatim: "Earn on your Bitcoin.").font(.system(size: 60, weight: .bold)).tracking(-2)
                    Text(verbatim: "One account for your Bitcoin: hold it, put it to work, and sign every move yourself.")
                        .font(.system(size: 18)).foregroundStyle(Color.black.opacity(0.6)).frame(width: 380, alignment: .leading)
                    Text(verbatim: "Get early access").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 22).padding(.vertical, 13)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Color(red: 1, green: 0.42, blue: 0.24)))
                }
                .foregroundStyle(Color(red: 0.08, green: 0.08, blue: 0.08))
                .padding(.leading, 400)
            }
        }
    }
}

let stagedPage = FogContent(id: "arch-invite-v3") { StagedPage() }

try render("m3-panel-content", width: 1280) {
    Heading(title: "Conversation panel, full screen on a deliverable", note: "A page, document, picture, video, sound or live url shows inside the panel under its header; the reply line floats at its foot, and the words step aside. Next crossfades it in place.")
    m3Fog(.bottomLeading, fullScreen: true, draft: "Make the heading one line on phones", session: panelSessions[0], pager: true, content: stagedPage)
    Caption("Reply line off: the deliverable takes the whole panel.")
    m3Fog(.bottomLeading, fullScreen: true, session: panelSessions[0], pager: true, showsReply: false, content: stagedPage)
}

try render("m3-fog-top-right", width: 1280) {
    Heading(title: "Conversation fog, dragged to the top right", note: "It faces the screen corner nearest it: the fog gathers in the top-right corner and the words move up there.")
    m3Fog(.topTrailing)
}

try render("m3-fog-bottom-right", width: 1280) {
    Heading(title: "Conversation fog, dragged to the bottom right", note: "The same corner fog, turned to face the bottom-right corner.")
    m3Fog(.bottomTrailing)
}

// The overlay lab's own shots (lab-shots/v2-*.png) beside the same scenes drawn by these components over the lab's
// backdrops. Those are private screenshots, so they are read from CONCH_LAB (default ~/Projects/conch-design) at render
// time and never kept in this repo; without them this part is skipped. The Core Image blur only stands in for the live
// behind-window blur and has none of the system material's own tint, so these use the lab's tint, not the app's.
let labDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CONCH_LAB"] ?? NSHomeDirectory() + "/Projects/conch-design")
let labScreen = CGSize(width: 1728, height: 1117)
/// The lab's transcript, as much of it as the fog shows.
let labTurns = [
    (true, "The card feels heavy on the gradient. Can we lighten it?"),
    (false, "I swapped the two stacked shadows for one soft one at 20% and eased the corner radius from 16 to 22. It sits lighter now, and the edge still reads against the peach."),
    (true, "Better. The avatar row feels cramped though."),
    (false, "There are 10 px between the avatar and the name now, and the name dropped to 14 px grey so the heading leads."),
    (true, "What about on a phone?"),
    (false, "At 390 px the card runs edge to edge with 20 px of padding and the Join button stays full width. The heading takes two lines."),
    (true, "Keep the heading on one line on mobile if it fits."),
    (false, "It fits at 26 px with slightly tighter tracking, so phones get that and desktop keeps 30."),
    (true, "Make the button just say Join."),
    (false, "Changed. The button reads Join, and it still waits for the email check before it can be pressed."),
].enumerated().map { ConversationTurn(id: "\($0.offset)", fromYou: $0.element.0, text: $0.element.1) }

func labImage(_ path: String) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(labDir.appendingPathComponent(path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func bitmap(_ size: CGSize, _ draw: (CGContext) -> Void) -> CGImage? {
    guard let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.interpolationQuality = .high
    draw(context)
    return context.makeImage()
}

func writePNG(_ image: CGImage, _ name: String) throws {
    let file = outDir.appendingPathComponent(name)
    try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: file)
    print(file.path)
}

/// The lab's text states (`applyState` in overlay-lab.html): a reply typed to three and to five-plus lines, a long reply part
/// way in, and scrolled up while it comes in.
let threeLines = "Looks good. Ship it, then do the same for the Dayloop invite, and keep its heading on one line on phones."
let manyLines = threeLines + " Use their teal and sand for the gradient, keep one soft shadow, and send me screenshots at desktop and 390 px before you open the pull request. If the email check needs changes, ask me first."
let longReply = "Here's the plan for the Dayloop invite. I'll start from the Arch card, swap the hero gradient for Dayloop's teal and sand, and keep the single soft shadow so it stays light. The avatar row keeps its 10 px gap, the heading drops to 26 px on phones, and the button just says Join. Then I'll wire up the same email check, run the invite tests, and send you screenshots at desktop and 390 px before I open the pull request."
let replyTurns = labTurns + [ConversationTurn(id: "reply", fromYou: false, text: longReply)]

/// The long reply with its first `shown` words in, the last few still fading up.
@MainActor
func streaming(shown: Int) -> FogTextState {
    let state = FogTextState()
    state.update(turns: labTurns, now: 0)
    state.update(turns: replyTurns, now: 10)
    state.step(dt: 0, now: state.reveal.starts[shown - 1] + 0.12, reduceMotion: false)
    return state
}

/// Scrolled up by the reader, then the long reply started coming in below: the pill says so.
@MainActor
func scrolledUp(by offset: CGFloat) -> FogTextState {
    let state = FogTextState()
    state.update(turns: labTurns, now: 0)
    state.measured(content: 5000, box: 400)
    state.scroll(by: offset, momentum: false)
    state.update(turns: replyTurns, now: 10)
    state.step(dt: 0, now: 12.6, reduceMotion: false)
    return state
}

/// Dragged by its middle to the middle of the screen and held there.
func floating(_ size: CGSize, in screen: CGSize) -> FogMotion {
    var motion = docked(.bottomLeading, size: size, in: screen)
    motion.press(at: CGPoint(x: size.width / 2, y: size.height / 2), time: 0)
    motion.drag(to: CGPoint(x: screen.width / 2, y: screen.height / 2), time: 0.05)
    for _ in 0..<240 { motion.step(dt: 1.0 / 120) }
    return motion
}

if let busy = labImage("lab-backdrops/real-screen-busy.png"), let darkApp = labImage("lab-backdrops/real-screen-dark-app.png") {
    let size = CGSize(width: 900, height: 640)
    let bottom = EdgeInsets(top: 0, leading: 0, bottom: 65, trailing: 0), top = EdgeInsets(top: 33, leading: 0, bottom: 0, trailing: 0)
    let left = CGRect(x: 0, y: 380, width: 1000, height: 737), right = CGRect(x: 728, y: 0, width: 1000, height: 737)
    let middle = CGRect(x: 314, y: 190, width: 1100, height: 737)
    let bl = docked(.bottomLeading, size: size, in: labScreen)
    typealias Shot = (lab: String, backdrop: CGImage, motion: FogMotion, insets: EdgeInsets, voice: VoiceState, dark: Bool, crop: CGRect, draft: String, turns: [ConversationTurn], text: FogTextState?)
    let shots: [Shot] = MainActor.assumeIsolated { [
        ("v2-docked-bl", busy, bl, bottom, .talk, false, left, "", labTurns, nil),
        // The lab's auto appearance turned this one dark: its words sit over the dark app window. Top-down: newest at the top.
        ("v2-docked-tr", busy, docked(.topTrailing, size: size, in: labScreen), top, .talk, true, right, "", labTurns, nil),
        ("v2-floating-mid", busy, floating(size, in: labScreen), bottom, .talk, false, middle, "", labTurns, nil),
        ("v2-docked-bl-voice-listening", busy, bl, bottom, .listening, false, left, "", labTurns, nil),
        ("v2-docked-bl-voice-speaking", busy, bl, bottom, .speaking, false, left, "", labTurns, nil),
        ("v2-docked-bl-bg-dark", darkApp, bl, bottom, .talk, true, left, "", labTurns, nil),
        ("v2-typing-3", busy, bl, bottom, .talk, false, left, threeLines, labTurns, nil),
        ("v2-typing-5", busy, bl, bottom, .talk, false, left, manyLines, labTurns, nil),
        ("v2-streaming", busy, bl, bottom, .speaking, false, left, "", replyTurns, streaming(shown: 32)),
        ("v2-scrolled-up", busy, bl, bottom, .speaking, false, left, "", replyTurns, scrolledUp(by: 330)),
    ] }
    for shot in shots {
        // The backdrop as the lab lays it out, covering the screen, and its backdrop filter: blur(22px) saturate(1.25), 1.4 on dark.
        let page = bitmap(labScreen) { context in
            let scale = max(labScreen.width / CGFloat(shot.backdrop.width), labScreen.height / CGFloat(shot.backdrop.height))
            let w = CGFloat(shot.backdrop.width) * scale, h = CGFloat(shot.backdrop.height) * scale
            context.draw(shot.backdrop, in: CGRect(x: (labScreen.width - w) / 2, y: (labScreen.height - h) / 2, width: w, height: h))
        }!
        let soft = softened(page, sigma: 22, saturation: shot.dark ? 1.4 : 1.25)!
        let scene = FogScreen(page: Image(decorative: page, scale: 1), blur: Image(decorative: soft, scale: 1), screen: labScreen, motion: shot.motion, insets: shot.insets, voice: shot.voice, draft: shot.draft, turns: shot.turns, hovering: false, text: shot.text)
            .environment(\.colorScheme, shot.dark ? .dark : .light)
            .environment(\.conchRendersStatically, true)
        let native = MainActor.assumeIsolated { () -> CGImage in
            let renderer = ImageRenderer(content: scene)
            renderer.scale = 1
            guard let image = renderer.cgImage else { fatalError("could not render \(shot.lab)") }
            return image
        }
        try writePNG(native, "native-1d-\(shot.lab).png")
        if let lab = labImage("lab-shots/\(shot.lab).png"), let a = lab.cropping(to: shot.crop), let b = native.cropping(to: shot.crop),
           let pair = bitmap(CGSize(width: 2 * a.width + 12, height: a.height), { context in
               context.draw(a, in: CGRect(x: 0, y: 0, width: a.width, height: a.height))
               context.draw(b, in: CGRect(x: a.width + 12, y: 0, width: b.width, height: b.height))
           }) {
            try writePNG(pair, "native-1d-\(shot.lab)-compare.png")
        }
    }
}

// MARK: - Wave 2: the canvas

/// A markup over the m3 screen, 0 to 1 across it: a box round the invite card, a note in it, an arrow, a stroke and a
/// highlight. Drawn by `CanvasInk`, the builder the glass and the picture an agent is sent both use.
let canvasMarks: [CanvasMark] = {
    func at(_ x: CGFloat, _ y: CGFloat, _ t: Double = 0) -> CanvasPoint { CanvasPoint(x: x / m3Screen.width, y: y / m3Screen.height, t: t) }
    let wave = (0...60).map { i -> CanvasPoint in
        let x = 820 + CGFloat(i) * 4.5
        return at(x, 150 + sin(CGFloat(i) / 7) * 18, Double(i) / (i < 30 ? 90 : 30))
    }
    return [
        CanvasMark(kind: .box, points: [at(700, 60), at(1150, 260)]),
        CanvasMark(kind: .note, points: [at(1080, 120)], text: "make this bigger"),
        CanvasMark(kind: .arrow, points: [at(560, 360), at(760, 250)]),
        CanvasMark(kind: .pen, points: wave),
        CanvasMark(kind: .highlight, points: [at(820, 300, 0), at(1000, 302, 0.1), at(1100, 300, 0.2)]),
    ]
}()

struct CanvasInkPreview: View {
    let marks: [CanvasMark]
    let size: CGSize

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(marks) { mark in
                let shape = CanvasInk.shape(of: mark, in: size)
                if let wash = shape.wash { Path(wash).fill(CanvasInk.colour(mark.author).color.opacity(CanvasInk.washOpacity)) }
                Path(shape.ink)
                    .fill(CanvasInk.fill(of: mark).color)
                    .blendMode(CanvasInk.multiplies(mark) ? .multiply : .normal)
                if mark.kind == .note, let spot = mark.points.first?.point(in: size) {
                    Text("1").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                        .frame(width: CanvasInk.pinSide, height: CanvasInk.pinSide)
                        .position(x: spot.x + CanvasInk.pinSide / 2, y: spot.y - CanvasInk.pinSide / 2)
                }
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
}

/// The sessions Send's menu lists in these renders, most likely first.
let canvasDestinations = [
    CanvasToolPill.Destination(id: "dev", label: "Dayloop invite", why: "on screen"),
    CanvasToolPill.Destination(id: "arch", label: "Arch brand page", why: "in the panel"),
    CanvasToolPill.Destination(id: "api", label: "API refactor"),
    CanvasToolPill.Destination(id: "docs", label: "Docs site"),
]

func canvasPill(
    mode: CanvasToolPill.Mode = .tools, hangs: Bool = false, tool: CanvasMark.Kind = .box, armed: Bool = true, drawn: Bool = true,
    sending: Bool = false, route: String? = "Arch brand page", sure: Bool = true, routeMenu: CanvasToolPill.RouteMenu? = nil,
    notice: CanvasToolPill.Notice? = nil, recording: CanvasToolPill.Recording? = nil, narrate: Bool = false, missed: AgentInk.Missed? = nil
) -> some View {
    CanvasToolPill(
        mode: mode, hangs: hangs, tool: tool, armed: armed, canUndo: drawn, canSend: (drawn || recording != nil) && route != nil, sending: sending,
        route: route.map { CanvasToolPill.Route(id: $0 == "Dayloop invite" ? "dev" : "arch", label: $0, sure: sure) },
        destinations: canvasDestinations, routeMenu: routeMenu, notice: notice,
        onTool: { _ in }, onUndo: {}, onSend: {}, recording: recording, onShow: {}, narrate: narrate, onNarrate: {},
        onDiscard: drawn || recording != nil ? {} : nil, onDone: armed ? {} : nil, missed: missed
    )
}

try render("w2-canvas", width: 1280) {
    Heading(title: "Canvas", note: "Wave 2. The pen down over the screen: its marks, and the tools risen out of the conversation panel's top edge.")
    ZStack(alignment: .topLeading) {
        m3Fog(.bottomLeading, session: panelSession, pager: true)
        CanvasInkPreview(marks: canvasMarks, size: m3Screen)
        // Centred on the docked glass (760 wide, inset 24), 8 pt above its top edge.
        canvasPill().position(x: 380, y: m3Screen.height - 560 + ConchSpace.x6 - ConchSpace.x2 - 21)
    }
    .frame(width: m3Screen.width, height: m3Screen.height)
    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
}

try render("w2-canvas-tools") {
    Heading(title: "Canvas tools", note: "The pen down, nothing drawn; a box in hand; the pen up with ink left; sending; a Send with nowhere to go; and Show recording, near its cap, and stopped.")
    canvasPill(tool: .pen, drawn: false)
    canvasPill()
    canvasPill(armed: false, route: "Dayloop invite")
    canvasPill(tool: .note, sending: true)
    canvasPill(armed: false, route: nil, notice: .nowhere)
    // Show: recording, 23 seconds in; in its last fifteen; stopped at the cap, waiting for Send or the ×.
    canvasPill(tool: .pen, recording: .since(Date().addingTimeInterval(-23)))
    canvasPill(armed: false, drawn: false, recording: .since(Date().addingTimeInterval(-108)))
    canvasPill(armed: false, notice: .stopped(at: 120), recording: .stopped(120))
}

// The quality pass's pill states: what it says when Screen Recording is missing, after a Send, when conch is only guessing
// where Send goes, while a Show records, and with an agent's marks alone.
try render("qp-canvas-pill-states", width: 1000) {
    Heading(title: "Canvas pill states", note: "Never sent, or recorded, without saying so; where it went; where it would go when conch is guessing; and an agent's marks alone.")
    Caption("Send without Screen Recording: nothing goes until Tyler picks")
    canvasPill(armed: false, notice: .noScreen(marks: true))
    Caption("After Open Settings: a grant reaches conch only once it reopens")
    canvasPill(armed: false, notice: .reopen(marks: true))
    Caption("Show without Screen Recording, no ink: the notice alone, hanging under the control bar")
    canvasPill(mode: .notice, hangs: true, armed: false, drawn: false, notice: .noScreen(marks: false))
    Caption("Sent: the ink cleared, this for 1.5 s, then it sinks")
    canvasPill(mode: .notice, armed: false, drawn: false, notice: .sent(to: "Arch brand page"))
    Caption("Not sent: the daemon's reason (#426's resume it), the marks back")
    canvasPill(armed: false, notice: .notSent(to: "Arch brand page", sentence: ConchSendFailure.sentence(reason: "session-stopped")))
    Caption("A guess (a localhost page at 0.7): Send reads Send to… and asks")
    canvasPill(armed: false, route: "Arch brand page", sure: false)
    canvasPill(armed: false, route: "Arch brand page", sure: false, routeMenu: .sendTo)
    Caption("Sure: the route's name is a menu that only changes where; hanging, the menu opens under it")
    canvasPill(hangs: true, tool: .pen, route: "Dayloop invite", routeMenu: .change)
    Caption("Show recording, the pen up (clicks reach the app), voice off; then stopped by macOS")
    canvasPill(armed: false, drawn: false, recording: .since(Date().addingTimeInterval(-31)))
    canvasPill(armed: false, drawn: false, notice: .stoppedByMacOS(at: 31), recording: .stopped(31))
    canvasPill(armed: false, drawn: false, notice: .noFrames, recording: .stopped(31))
    Caption("An agent's marks alone: a chip, never the tools; and what couldn't be shown here")
    canvasPill(mode: .agentChip, armed: false, drawn: false)
    canvasPill(mode: .agentChip, armed: false, drawn: false, missed: AgentInk.Missed([(kind: "box", label: "Join, as you asked"), (kind: "arrow", label: nil)]))
}

// The picture Send makes, `flat.png`: the screen at 2x with the same marks drawn over it by the same builder, fitted to
// 1568 px; and without the Screen Recording grant, the marks alone.
do {
    var document = CanvasDocument(anchor: CanvasAnchor(id: 1, frame: CGRect(origin: .zero, size: m3Screen)), id: "gallery", at: 0)
    canvasMarks.forEach { document.add($0) }
    // The agent's answer, placed on what it named (`AgentInk`): a box round the Join button, an arrow at the email line,
    // a highlight on the heading, and a pin.
    func element(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX / m3Screen.width, y: rect.minY / m3Screen.height, width: rect.width / m3Screen.width, height: rect.height / m3Screen.height)
    }
    document.merge(agent: [
        AgentInk.mark(id: "join", kind: .box, label: "Join, as you asked", on: element(CGRect(x: 432, y: 270, width: 364, height: 52)), size: m3Screen),
        AgentInk.mark(id: "email", kind: .arrow, label: "Still waits for the email check", on: element(CGRect(x: 432, y: 336, width: 364, height: 52)), size: m3Screen),
        AgentInk.mark(id: "title", kind: .highlight, label: nil, on: element(CGRect(x: 432, y: 176, width: 390, height: 44)), size: m3Screen),
        AgentInk.mark(id: "pin", kind: .pin, label: "One line on phones", on: element(CGRect(x: 432, y: 176, width: 390, height: 44)), size: m3Screen),
    ].compactMap { $0 })
    let screen = MainActor.assumeIsolated { () -> CGImage? in
        let renderer = ImageRenderer(content: m3Fog(.bottomLeading, session: panelSession, pager: true).environment(\.conchRendersStatically, true))
        renderer.scale = 2
        return renderer.cgImage
    }
    if let flat = CanvasInk.render(document, over: screen) { try writePNG(flat, "w2-canvas-flat.png") }
    if let alone = CanvasInk.render(document, over: nil) { try writePNG(alone, "w2-canvas-flat-no-screen.png") }
}

// Something Tyler sent through conch, as his own row in the conversation (`SentReceiptRow`): a canvas, a Show, a video
// from the phone, and a canvas whose picture hasn't been read yet, between his words and a reply so the row can be
// judged against the bubble beside it. The thumbnails are the pictures each one sends: the canvas's flat.png, a frame,
// and a contact sheet.
do {
    var document = CanvasDocument(anchor: CanvasAnchor(id: 1, frame: CGRect(origin: .zero, size: m3Screen)), id: "receipts", at: 0)
    canvasMarks.forEach { document.add($0) }
    let screen = MainActor.assumeIsolated { () -> CGImage? in
        let renderer = ImageRenderer(content: m3Fog(.bottomLeading, session: panelSession, pager: true).environment(\.conchRendersStatically, true))
        renderer.scale = 1
        return renderer.cgImage
    }
    let flat = CanvasInk.render(document, over: screen)
    let sheet = screen.flatMap { frame in VideoStoryboard.contactSheet((0..<6).map { (at: Double($0) * 3, image: frame) }) }
    let picture = { (image: CGImage?) in image.map { Image(decorative: $0, scale: 2) } }
    let canvas = ConchSentReceipt(kind: .canvas, title: "Marked up Invite page", detail: "2 marks · 1 note\n“make the button just say Join”")
    let show = ConchSentReceipt(kind: .show, title: "Showed Invite page · 0:23", detail: "“okay so this page, this one bigger, and this footer, that's it”")
    let video = ConchSentReceipt(kind: .video, title: "Sent a video · 0:42", detail: "“this button should be blue, and the header jumps when I scroll”")
    let yours = { (words: String) in
        HStack {
            Spacer(minLength: 48)
            Text(words)
                .font(ConchType.readingBody)
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
        }
    }
    let sent = { (receipt: ConchSentReceipt, thumbnail: Image?) in
        HStack {
            Spacer(minLength: 48)
            SentReceiptRow(receipt: receipt, thumbnail: thumbnail) {}
        }
    }
    try render("w3-sent-receipts", width: 720) {
        Heading(title: "Sent receipts", note: "What Tyler sent through conch, as one quiet row in his bubble: a thumbnail, what it was, his words from it. A click opens it whole.")
        VStack(alignment: .leading, spacing: 22) {
            yours("The invite page still says Accept invitation.")
            sent(canvas, picture(flat))
            Text("Changed. The button reads **Join**, and it still waits for the email check.")
                .font(ConchType.readingBody)
                .foregroundStyle(ConchColor.textPrimary)
            sent(show, picture(screen))
            sent(video, picture(sheet))
            sent(ConchSentReceipt(kind: .canvas, title: "Marked up Safari", detail: "3 marks"), nil)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: 600)
        .background(ConchColor.surface, in: RoundedRectangle(cornerRadius: ConchRadius.large))
    }
}

// The sidebar's marks, as the Mac draws them (DashboardView's `LedgerVisual`): every state a session can be in, and the
// sub-agents under one, working and paused. Working is `active`'s blue, with its breath caught at its fullest; the
// breath's other moments, and the blue beside the colours it must never be taken for, follow.

/// The sidebar's state colours as Palette.swift holds them, so the page draws the sidebar the way the app does: waiting
/// is ready's token, and the mic's cyan has none yet.
enum SidebarInk {
    static let waiting = ConchColor.ready
    static let micOpen = Color(red: 88 / 255, green: 201 / 255, blue: 212 / 255)
}

struct SidebarMark {
    let symbol: String
    let size: CGFloat
    let colour: AnyShapeStyle
    let meaning: String
    var breathes = false
    var wantsYou = false
    var live = false

    static let working = SidebarMark(symbol: "circle.fill", size: 8, colour: AnyShapeStyle(ConchColor.active), meaning: "Working — an agent is running, nothing needed from you", breathes: true)
    static let waitingOnAgents = SidebarMark(symbol: "person.2.fill", size: 9, colour: AnyShapeStyle(SidebarInk.waiting), meaning: "Its agents are working — you can talk to it")
    static let listening = SidebarMark(symbol: "mic.fill", size: 10, colour: AnyShapeStyle(SidebarInk.micOpen), meaning: "Mic open — it is hearing you", live: true)
    static let waiting = SidebarMark(symbol: "circle.inset.filled", size: 8, colour: AnyShapeStyle(SidebarInk.waiting), meaning: "Ready for you — its turn is over", wantsYou: true)
    static let needs = SidebarMark(symbol: "exclamationmark.circle.fill", size: 10.5, colour: AnyShapeStyle(ConchColor.attention), meaning: "Blocked — needs an answer", wantsYou: true)
    static let review = SidebarMark(symbol: "checkmark.circle.fill", size: 10.5, colour: AnyShapeStyle(ConchColor.ready), meaning: "Ready for you — work to look at")
    static let manual = SidebarMark(symbol: "pause.fill", size: 9, colour: AnyShapeStyle(ConchColor.textSecondary), meaning: "Manual — turns held for later")
    static let recording = SidebarMark(symbol: "record.circle.fill", size: 10.5, colour: AnyShapeStyle(SidebarInk.micOpen), meaning: "Recording your reply", live: true)
    static let speaking = SidebarMark(symbol: "play.fill", size: 9, colour: AnyShapeStyle(ConchColor.textTertiary), meaning: "Reading a reply aloud", live: true)
    static let transcribing = SidebarMark(symbol: "ellipsis", size: 11, colour: AnyShapeStyle(ConchColor.active), meaning: "Transcribing what you said — it goes in next", live: true)
    static let paused = SidebarMark(symbol: "circle", size: 8, colour: AnyShapeStyle(ConchColor.textTertiary), meaning: "Paused — a sub-agent that isn't running")
    static let idle = SidebarMark(symbol: "circle.dotted", size: 8, colour: AnyShapeStyle(ConchColor.textTertiary), meaning: "Idle — nothing happening")
}

struct SidebarGlyph: View {
    let mark: SidebarMark
    var phase = 0.5

    var body: some View {
        Image(systemName: mark.symbol)
            .font(.system(size: mark.size, weight: .medium))
            .foregroundStyle(mark.colour)
            .activeBreath(pointSize: mark.size, breathes: mark.breathes, phase: phase)
    }
}

/// `DashboardRow`'s anatomy: the live rail, the 16 pt mark, the label, the summary, the age.
struct SidebarSessionRow: View {
    let mark: SidebarMark
    let label: String
    var summary = ""
    var age = "4m"
    var phase = 0.5

    var body: some View {
        HStack(spacing: 8) {
            Capsule(style: .continuous)
                .fill(mark.colour)
                .frame(width: 3, height: 22)
                .opacity(mark.live ? 1 : 0)
                .frame(width: 10)
            SidebarGlyph(mark: mark, phase: phase).frame(width: 16)
            Text(label)
                .font(.system(size: 13, weight: mark.wantsYou ? .semibold : .medium))
                .foregroundStyle(ConchColor.textPrimary)
                .lineLimit(1)
            Text(summary)
                .font(.system(size: 12))
                .foregroundStyle(ConchColor.textTertiary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(age).font(.system(size: 11).monospacedDigit()).foregroundStyle(ConchColor.textTertiary)
        }
        .padding(.trailing, 10)
        .frame(height: 30)
    }
}

/// `AgentGroup`'s line: the mark at three quarters, the name in 11.5 pt.
struct SidebarAgentRow: View {
    let mark: SidebarMark
    let label: String
    var phase = 0.5

    var body: some View {
        HStack(spacing: 7) {
            SidebarGlyph(mark: mark, phase: phase)
                .scaleEffect(0.75)
                .frame(width: 12, height: 12)
            Text(label).font(.system(size: 11.5)).foregroundStyle(ConchColor.textSecondary).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .padding(.leading, 30)
    }
}

struct SidebarColumn<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Caption(title)
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.ground))
                .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
        }
    }
}

try render("ledger-marks", width: 1240) {
    Heading(title: "Sidebar marks", note: "Working is `active`'s blue, its halo breathing (caught here at its fullest). A sub-agent is working or paused: never waiting's green, since nobody replies to one.")
    HStack(alignment: .top, spacing: 28) {
        SidebarColumn(title: "Sessions, and the sub-agents under one") {
            SidebarSessionRow(mark: .working, label: "Parser refactor", summary: "Running the suite")
            SidebarSessionRow(mark: .waitingOnAgents, label: "Release notes", summary: "Handed out three drafts", age: "2m")
            SidebarAgentRow(mark: .working, label: "Socrates")
            SidebarAgentRow(mark: .working, label: "Gibbs", phase: 0)
            SidebarAgentRow(mark: .paused, label: "Pasteur")
            SidebarSessionRow(mark: .working, label: "Invite tests", age: "1m")
            SidebarAgentRow(mark: .working, label: "fix flaky retry test")
            SidebarAgentRow(mark: .paused, label: "Hume")
            SidebarAgentRow(mark: .needs, label: "Euler")
            SidebarSessionRow(mark: .listening, label: "Docs pass", age: "now")
            SidebarSessionRow(mark: .waiting, label: "Settings copy", summary: "Done — three options", age: "6m")
            SidebarSessionRow(mark: .needs, label: "Deploy script", summary: "Allow rm -rf build?", age: "1m")
            SidebarSessionRow(mark: .review, label: "Invite page", summary: "The button reads Join", age: "12m")
            SidebarSessionRow(mark: .manual, label: "Nightly cleanup", age: "1h")
            SidebarSessionRow(mark: .recording, label: "Docs pass", age: "now")
            SidebarSessionRow(mark: .transcribing, label: "Docs pass", age: "now")
            SidebarSessionRow(mark: .speaking, label: "Settings copy", age: "now")
            SidebarSessionRow(mark: .idle, label: "Scratch", age: "2d")
        }
        .frame(width: 400)

        VStack(alignment: .leading, spacing: 10) {
            Caption("The legend (Keyboard Shortcuts)")
            ForEach([SidebarMark.working, .waitingOnAgents, .listening, .waiting, .needs, .review, .manual, .recording, .speaking, .transcribing, .paused, .idle], id: \.meaning) { mark in
                HStack(spacing: 10) {
                    Image(systemName: mark.symbol)
                        .font(.system(size: 10.5))
                        .foregroundStyle(mark.colour)
                        .frame(width: 16)
                    Text(mark.meaning).font(.system(size: 12.5)).foregroundStyle(ConchColor.textPrimary)
                }
            }
        }
        .frame(width: 360, alignment: .leading)

        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 10) {
                Caption("One breath, \(Int(ConchMotion.activeBreathPeriod)) s; Reduce Motion is the first, still")
                HStack(spacing: 18) {
                    ForEach([0, 0.125, 0.25, 0.375, 0.5], id: \.self) { phase in
                        VStack(spacing: 6) {
                            ActiveMark(pointSize: 8, phase: phase)
                                .scaleEffect(3)
                                .frame(width: 48, height: 48)
                            Text(String(format: "%.0f%%", ActiveHalo.opacity(at: phase * ConchMotion.activeBreathPeriod, reduceMotion: false) * 100))
                                .font(ConchType.code)
                                .foregroundStyle(ConchColor.textSecondary)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Caption("Working beside the colours it must never be taken for")
                ForEach(ConchColor.grounds, id: \.name) { ground in
                    GroundStrip(ground: ground)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Caption("The phone (SessionRowView, AgentRowView)")
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(ConchColor.active)
                            .activeBreath(pointSize: 15, phase: 0.5)
                            .frame(width: 22)
                        Text("Parser refactor").font(.body.weight(.semibold)).foregroundStyle(ConchColor.textPrimary)
                    }
                    ForEach([("circle.fill", "Socrates", true), ("circle", "Pasteur", false)], id: \.1) { symbol, name, working in
                        HStack(spacing: 8) {
                            Image(systemName: symbol)
                                .font(.system(size: 11))
                                .foregroundStyle(working ? AnyShapeStyle(ConchColor.active) : AnyShapeStyle(ConchColor.textTertiary))
                                .activeBreath(pointSize: 11, breathes: working, phase: 0.5)
                                .frame(width: 16)
                            Text(name).font(.footnote).foregroundStyle(ConchColor.textSecondary)
                        }
                        .padding(.leading, 34)
                    }
                }
                .padding(14)
                .frame(width: 330, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.ground))
                .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
            }
        }
    }
}

/// Mic open, working, waiting and review on one ground, with working's contrast there.
struct GroundStrip: View {
    let ground: ConchColorToken
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 14) {
            ForEach([("mic", AnyShapeStyle(SidebarInk.micOpen)), ("working", AnyShapeStyle(ConchColor.active)), ("waiting", AnyShapeStyle(SidebarInk.waiting)), ("review", AnyShapeStyle(ConchColor.ready))], id: \.0) { name, colour in
                VStack(spacing: 4) {
                    Circle().fill(colour).frame(width: 14, height: 14)
                    Text(name).font(.system(size: 9.5)).foregroundStyle(ConchColor.textTertiary)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 2) {
                Text(ground.name).font(ConchType.meta).foregroundStyle(ConchColor.textSecondary)
                Text(String(format: "working %.2f:1", ConchColor.active.rgba(scheme).contrast(on: ground.rgba(scheme))))
                    .font(ConchType.code)
                    .foregroundStyle(ConchColor.textSecondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(width: 330)
        .background(RoundedRectangle(cornerRadius: ConchRadius.small).fill(ground))
        .overlay(RoundedRectangle(cornerRadius: ConchRadius.small).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }
}

// MARK: - The conversation panel as it ships: glass

// The m3 pages above draw the retired fog (FogLookView). These draw the panel the Mac shows: the page, then the glass,
// then the words and buttons padded in by the glass's inset (FloatingPanels). ImageRenderer can't draw Liquid Glass, so
// the glass is panel-lab's stand-in (`PanelGlass.standIn`: white at 52% or #1E1E22 at 50% over the page blurred), with
// `ConchGlassPanel`'s own colour, wash, hairline and grab bar over it. The lab's screenshots are read from CONCH_LAB as
// above; without them the stand-in page is the gallery's own gradient.
let panelScreenSize = CGSize(width: 1440, height: 900)
/// The lab's menu bar, which full screen keeps clear of.
let panelMenuBar: CGFloat = 28
let dockedWindow = CGRect(x: 0, y: panelScreenSize.height - 640, width: 900, height: 640)

/// A backdrop covering the panel's screen, and the same blurred as the glass blurs it (panel-lab: blur 28, saturate 1.7).
struct PanelBackdrop {
    let name: String
    let page: CGImage
    let soft: CGImage

    init(_ name: String, _ image: CGImage) {
        self.name = name
        page = bitmap(panelScreenSize) { context in
            let scale = max(panelScreenSize.width / CGFloat(image.width), panelScreenSize.height / CGFloat(image.height))
            let w = CGFloat(image.width) * scale, h = CGFloat(image.height) * scale
            context.draw(image, in: CGRect(x: (panelScreenSize.width - w) / 2, y: (panelScreenSize.height - h) / 2, width: w, height: h))
        }!
        soft = softened(page, sigma: 28, saturation: 1.7)!
    }
}

@MainActor
func drawnPage(_ dark: Bool) -> CGImage? {
    let renderer = ImageRenderer(content: OtherApp().frame(width: panelScreenSize.width, height: panelScreenSize.height).environment(\.colorScheme, dark ? .dark : .light))
    renderer.scale = 1
    return renderer.cgImage
}

let panelBackdrops: [PanelBackdrop] = MainActor.assumeIsolated {
    let drawn = drawnPage
    var all: [PanelBackdrop] = []
    if let busy = labImage("lab-backdrops/real-screen-busy.png") { all.append(PanelBackdrop("busy", busy)) }
    if let dark = labImage("lab-backdrops/real-screen-dark-app.png") { all.append(PanelBackdrop("dark app", dark)) }
    if let light = drawn(false) { all.append(PanelBackdrop("gradient, light", light)) }
    if let dark = drawn(true) { all.append(PanelBackdrop("gradient, dark", dark)) }
    return all
}

/// The busy screen, else the gallery's own page.
let panelBackdrop = panelBackdrops[0]
let darkBackdrop = panelBackdrops.first { $0.name == "dark app" } ?? panelBackdrops[panelBackdrops.count - 1]

/// The panel over a screen, as FloatingPanels layers it, in its window (top left, in the screen) with its glass
/// `geometry`. `darkness` overrides the sheet's appearance, for a panel that doesn't match the app under it.
struct PanelScene: View {
    var backdrop = panelBackdrop
    var window = dockedWindow
    var geometry = PanelGlass.Geometry.docked
    var fullScreen = false
    var corner = FogCorner.bottomLeading
    var turns = sampleTurns
    var draft = ""
    var hovering = true
    var session: FogSession? = panelSession
    var switching = false
    var selection: String?
    var content: FogContent?
    var notice: String?
    var empty: String?
    var speaking: FogSession?
    var voice = VoiceState.talk
    var working = false
    var showsWords = true
    var darkness: Double?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = darkness ?? (scheme == .dark ? 1 : 0)
        let inset = geometry.insets
        let glass = CGRect(x: window.minX + inset.leading, y: window.minY + inset.top, width: window.width - inset.leading - inset.trailing, height: window.height - inset.top - inset.bottom)
        let shape = RoundedRectangle(cornerRadius: geometry.radius, style: .continuous)
        let screenInsets = fullScreen ? EdgeInsets(top: panelMenuBar, leading: 0, bottom: 0, trailing: 0) : EdgeInsets()
        ZStack(alignment: .topLeading) {
            Image(decorative: backdrop.page, scale: 1)
            // The stand-in for Liquid Glass: the page blurred under the lab's glass colour, with the lab's drop shadow.
            ZStack(alignment: .topLeading) {
                Image(decorative: backdrop.soft, scale: 1).offset(x: -glass.minX, y: -glass.minY)
                PanelGlass.standIn(darkness: dark).color
            }
            .frame(width: glass.width, height: glass.height, alignment: .topLeading)
            .clipShape(shape)
            .shadow(color: .black.opacity(0.42), radius: 35, y: 30)
            .offset(x: glass.minX, y: glass.minY)
            ConchGlassPanel(darkness: dark, voice: voice, radius: geometry.radius)
                .frame(width: glass.width, height: glass.height)
                .offset(x: glass.minX, y: glass.minY)
            if showsWords {
                ConversationFog(
                    turns: turns,
                    draft: .constant(draft),
                    text: FogTextState(),
                    isListening: voice == .listening,
                    isWorking: working,
                    isFullScreen: fullScreen,
                    corner: corner,
                    insets: screenInsets.less(inset),
                    hovering: hovering,
                    session: session,
                    sessions: switching ? panelSessions : [],
                    isSwitching: .constant(switching),
                    switcherSelection: selection,
                    showsReply: session != nil,
                    content: content,
                    notice: notice,
                    empty: empty,
                    speaking: speaking,
                    onPrevious: {},
                    onNext: {},
                    onMic: {},
                    onSend: {},
                    onCollapse: {},
                    onFullScreen: {},
                    onCanvas: {}
                )
                .padding(inset)
                .frame(width: window.width, height: window.height)
                .offset(x: window.minX, y: window.minY)
            }
        }
        .frame(width: panelScreenSize.width, height: panelScreenSize.height, alignment: .topLeading)
        .clipped()
        .environment(\.conchDarkness, dark)
        .environment(\.colorScheme, dark > 0.5 ? .dark : .light)
        .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
    }
}

let standInNote = "The glass is a stand-in: ImageRenderer can't draw Liquid Glass, so it is panel-lab's own (white 52% in light, #1E1E22 50% in dark, over the screen blurred 28 pt), under the panel's colour, wash (PanelGlass.wash), hairline and grab bar."
let fullWindow = CGRect(origin: .zero, size: panelScreenSize)
let fullGlass = PanelGlass.Geometry.fullScreen(menuBar: panelMenuBar)

try render("qp-panel-docked", width: 1520) {
    Heading(title: "Conversation panel, docked, as it ships", note: standInNote)
    Caption("Pointer over the panel: the buttons' fills in. One left edge for the buttons, the mic and the words; the item isn't repeated beside the name (the newest reply says it); the placeholder names who the reply goes to.")
    PanelScene()
    Caption("Pointer away: only the fills go. The name and the icons keep their contrast (the lab's 0.4 over everything left them at 2.1:1 and 1.6:1).")
    PanelScene(hovering: false)
}

try render("qp-panel-mismatch", width: 1520) {
    Heading(title: "The panel over an app that doesn't match it", note: "Auto follows the system's appearance, so a light panel can sit over a dark app and a dark one over a light page. The wash keeps every level of the words at 4.5:1 either way. " + standInNote)
    Caption("Light panel over a dark app.")
    PanelScene(backdrop: darkBackdrop, darkness: 0)
    Caption("Dark panel over the busy screen.")
    PanelScene(darkness: 1)
}

try render("qp-panel-fullscreen", width: 1520) {
    Heading(title: "Full screen, on a deliverable", note: "Still the glass: 12 pt from the screen's edges and the menu bar, a 26 pt corner. The header names the item only here, where the words are hidden; the newest reply keeps one quiet line above the reply, and a click opens it whole. Collapse steps out beside Exit full screen. " + standInNote)
    PanelScene(window: fullWindow, geometry: fullGlass, fullScreen: true, session: panelSession, content: stagedPage)
    Caption("Full screen on a session with nothing to open: its words, in the same glass.")
    PanelScene(window: fullWindow, geometry: fullGlass, fullScreen: true, session: panelSessions[1])
}

try render("qp-panel-switcher", width: 1520) {
    Heading(title: "The switcher", note: "Glass that blurs the words under it, with a 20 pt corner. Ready and working are filled dots in their colours (the hollow ring is the sidebar's Paused). ↑ and ↓ pick a row out (here the working one), Return opens it, Esc or a click anywhere else closes it. " + standInNote)
    PanelScene(switching: true, selection: "tests")
}

try render("qp-panel-states", width: 1520) {
    Heading(title: "Empty, not running, a failed reply, and the voice elsewhere", note: standInNote)
    Caption("No sessions yet: said where the words would be, with no reply line to type into.")
    PanelScene(turns: [], session: nil, empty: "No sessions yet")
    Caption("The daemon down.")
    PanelScene(turns: [], session: nil, empty: "conch isn't running")
    Caption("A reply that didn't go: the words are back in the line, and the reason under it, in the sentence the dashboard and the phone show.")
    PanelScene(draft: "Make the button just say Join", notice: ConchSendFailure.sentence(reason: "system-dialog-blocking"))
    Caption("The voice reading another session: named beside the header, a click away.")
    PanelScene(speaking: panelSessions[1], voice: .speaking)
}

/// The glass part way through a morph: the window and its glass in a straight line from one to the other.
func morphFrame(_ from: CGRect, _ to: CGRect, _ glassFrom: PanelGlass.Geometry, _ glassTo: PanelGlass.Geometry, at t: CGFloat) -> some View {
    let window = CGRect(x: from.minX + (to.minX - from.minX) * t, y: from.minY + (to.minY - from.minY) * t, width: from.width + (to.width - from.width) * t, height: from.height + (to.height - from.height) * t)
    return PanelScene(window: window, geometry: PanelGlass.Geometry.lerp(glassFrom, glassTo, t), showsWords: false)
        .scaleEffect(0.24, anchor: .topLeading)
        .frame(width: panelScreenSize.width * 0.24, height: panelScreenSize.height * 0.24, alignment: .topLeading)
}

try render("qp-panel-morph", width: 1520) {
    Heading(title: "The morphs, frame by frame", note: "On ConchMotion.morph, the window and its glass together; the words step aside and come back 120 ms after it lands, laid out for where it landed. Under Reduce Motion each is a cut. " + standInNote)
    Caption("Docked to full screen: the corner eases from 30 to 26, the margin from 24 to 12.")
    HStack(spacing: 12) {
        ForEach([0, 0.35, 0.7, 1] as [CGFloat], id: \.self) { t in morphFrame(dockedWindow, fullWindow, .docked, fullGlass, at: t) }
    }
    Caption("Docked to collapsed: the glass shrinks into the handle's circle, which takes over as it lands.")
    let handle = CGRect(x: 0, y: panelScreenSize.height - FogHandle.side, width: FogHandle.side, height: FogHandle.side)
    HStack(spacing: 12) {
        ForEach([0, 0.35, 0.7, 1] as [CGFloat], id: \.self) { t in morphFrame(dockedWindow, handle, .docked, .collapsed(corner: .bottomLeading), at: t) }
    }
    Caption("The handle, collapsed: the panel's own glyph and glass.")
    ZStack(alignment: .bottomLeading) {
        Image(decorative: panelBackdrop.page, scale: 1)
        FogHandle {}
    }
    .frame(width: 480, height: 200, alignment: .bottomLeading)
    .clipped()
    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
}

// The contrast, before and after, over each backdrop: the ground under the words' column read off the blurred page
// pixel by pixel, the stand-in glass and (after) the wash laid over it, and each ink measured against it. Before is the
// lab's inks with no wash: #6E6E73, past turns at half, the placeholder at 28% and 32%.
struct ContrastRow: Identifiable {
    let id: String
    let values: [(String, Double, Double)]
}

@MainActor
func contrastRows() -> [ContrastRow] {
    let column = ConversationFog.textFrame(in: CGSize(width: dockedWindow.width - 48, height: dockedWindow.height - 48), corner: .bottomLeading, insets: EdgeInsets(), fullScreen: false)
        .offsetBy(dx: dockedWindow.minX + 24, dy: dockedWindow.minY + 24)
    var rows: [ContrastRow] = []
    for backdrop in panelBackdrops {
        let width = backdrop.soft.width, height = backdrop.soft.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(backdrop.soft, in: CGRect(x: 0, y: 0, width: width, height: height))
        var samples: [ConchRGBA] = []
        for y in stride(from: Int(column.minY), to: Int(column.maxY), by: 6) {
            for x in stride(from: Int(column.minX), to: Int(column.maxX), by: 6) {
                let i = (y * width + x) * 4
                samples.append(ConchRGBA(UInt32(pixels[i]) << 16 | UInt32(pixels[i + 1]) << 8 | UInt32(pixels[i + 2])))
            }
        }
        for darkness in [0.0, 1.0] {
            let lightest = PanelGlass.mesh.max { $0.contrast(on: ConchRGBA(0)) < $1.contrast(on: ConchRGBA(0)) }
            func worst(_ ink: ConchRGBA, wash: Double?) -> Double {
                samples.flatMap { backdrop in [nil, lightest].map { PanelGlass.ground(over: backdrop, darkness: darkness, mesh: $0, wash: wash) } }
                    .map { ink.contrast(on: $0) }.min() ?? 0
            }
            let text = ConchColor.overlayText.rgba(darkness: darkness)
            let secondary = ConchColor.overlayTextSecondary.rgba(darkness: darkness), placeholder = ConchColor.overlayPlaceholder.rgba(darkness: darkness)
            let oldSecondary = darkness > 0.5 ? ConchRGBA(0xB8B8BE) : ConchRGBA(0x6E6E73)
            let oldPlaceholder = darkness > 0.5 ? ConchRGBA(0xF5F5F7, alpha: 0.32) : ConchRGBA(0x1D1D1F, alpha: 0.28)
            rows.append(ContrastRow(id: "\(backdrop.name), \(darkness > 0.5 ? "dark" : "light") panel", values: [
                ("past turn", worst(ConchRGBA(text.hex, alpha: 0.5), wash: 0), worst(ConchRGBA(text.hex, alpha: ConversationFog.pastOpacity), wash: nil)),
                ("You / item", worst(oldSecondary, wash: 0), worst(secondary, wash: nil)),
                ("placeholder", worst(oldPlaceholder, wash: 0), worst(placeholder, wash: nil)),
                ("newest", worst(text, wash: 0), worst(text, wash: nil)),
            ]))
        }
    }
    return rows
}

let panelContrast = MainActor.assumeIsolated { contrastRows() }
for row in panelContrast {
    print("contrast \(row.id): " + row.values.map { String(format: "%@ %.2f → %.2f", $0.0, $0.1, $0.2) }.joined(separator: " · "))
}

try render("qp-panel-contrast", width: 1100) {
    Heading(title: "Words on the glass, before and after", note: "The worst spot under the docked panel's words, over each screen: the page blurred as the glass blurs it, the stand-in glass, the mesh's lightest colour or none, and after, the wash. Before is the lab's inks with no wash. 4.5:1 is the bar for words.")
    VStack(alignment: .leading, spacing: 8) {
        ForEach(panelContrast) { row in
            HStack(spacing: 18) {
                Text(row.id).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary).frame(width: 260, alignment: .leading)
                ForEach(row.values, id: \.0) { value in
                    VStack(alignment: .leading, spacing: 1) {
                        Caption(value.0)
                        Text(String(format: "%.2f → %.2f", value.1, value.2))
                            .font(ConchType.code)
                            .foregroundStyle(value.2 >= 4.5 ? ConchColor.textPrimary : ConchColor.attention)
                    }
                    .frame(width: 150, alignment: .leading)
                }
            }
        }
    }
}
