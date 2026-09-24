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
    .quiet: "Blueprint monorepo", .ready: "Arch brand page",
]

try render("m3-control-bar") {
    Heading(title: "Control bar", note: "M3. A non-activating panel under the menu bar, one row per voice state. The conversation is shown and hidden from the menu bar menu.")
    ForEach(VoiceState.allCases, id: \.self) { state in
        ZStack {
            OtherApp(compact: true)
            ControlBar(
                state: state,
                detail: barDetails[state] ?? "",
                mode: .constant(state == .quiet ? .quiet : .talk)
            )
        }
        .frame(width: 880, height: 104)
        .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large))
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

func canvasPill(tool: CanvasMark.Kind = .box, armed: Bool = true, drawn: Bool = true, sending: Bool = false, route: String? = "Arch brand page", message: String? = nil, recording: CanvasToolPill.Recording? = nil) -> some View {
    CanvasToolPill(tool: tool, armed: armed, canUndo: drawn, canSend: (drawn || recording != nil) && route != nil, sending: sending, route: route, message: message, onTool: { _ in }, onUndo: {}, onSend: {}, recording: recording, onShow: {}, onDiscard: drawn || recording != nil ? {} : nil)
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
    canvasPill(armed: false, route: nil, message: "Nothing to send this to: no session owns what is on screen, and the panel has none.")
    // Show: recording, 23 seconds in; in its last fifteen; stopped at the cap, waiting for Send or the ×.
    canvasPill(tool: .pen, recording: .since(Date().addingTimeInterval(-23)))
    canvasPill(armed: false, drawn: false, recording: .since(Date().addingTimeInterval(-108)))
    canvasPill(armed: false, message: "Stopped at 2:00. Send it, or × to throw it away.", recording: .stopped(120))
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
