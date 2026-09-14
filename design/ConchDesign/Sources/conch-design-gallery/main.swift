// Renders every token and component, light and dark, to PNGs, so the design is checked by picture
// without opening an app window:  swift run conch-design-gallery <outdir>
import AppKit
import ConchDesign
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
