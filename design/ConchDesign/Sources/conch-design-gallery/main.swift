// Renders every token and component, light and dark, to PNGs, so the design is checked by picture
// without opening an app window:  swift run conch-design-gallery <outdir> [name prefix]
import AppKit
import ConchDesign
import SwiftUI

let outDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "gallery", isDirectory: true)
/// Only the pages whose names start with this, when given: one area's pictures without the whole gallery's.
let onlyPages = CommandLine.arguments.dropFirst(2).first
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

/// `CONCH_GALLERY_ONLY=<prefix>` renders only the sheets whose names start with it (the Terminal tab's, say), so a
/// review folder holds what it is for.
let galleryOnly = ProcessInfo.processInfo.environment["CONCH_GALLERY_ONLY"].flatMap { $0.isEmpty ? nil : $0 }

// Native start-account fixtures at desktop and phone widths. Use the host's
// actual provider assets, just as the shared component does in either app.
if onlyPages?.hasPrefix("start-account") == true || galleryOnly?.hasPrefix("start-account") == true {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    var marks: [String: Image] = [:]
    for name in ["AgentClaude", "AgentCodex"] {
        let path = root.appendingPathComponent("mac-app/conch-mac/Assets.xcassets/\(name).imageset/\(name)-3x.png")
        if let image = NSImage(contentsOf: path) { marks[name] = Image(nsImage: image).renderingMode(.template) }
    }
    let now = Date()
    let stamp = ISO8601DateFormatter()
    let profiles = [
        StartAccountProfile(id: "work", label: "Business", status: "signed-in", email: "alex@studio.example", subscription: "Max"),
        StartAccountProfile(id: "personal", label: "Personal", status: "signed-in", email: "alex@example.com", subscription: "Max"),
        StartAccountProfile(id: "new", label: "New account", status: "signed-in", email: "alex@new.example")
    ]
    let readings = [
        StartAccountUsage(id: "work", status: "ok", windows: [
            StartAccountWindow(name: "5 hour", pct: 24, resetsAt: stamp.string(from: now.addingTimeInterval(7200))),
            StartAccountWindow(name: "7 day", pct: 61, resetsAt: stamp.string(from: now.addingTimeInterval(172800)))
        ], fetchedAt: stamp.string(from: now), lastGood: false),
        StartAccountUsage(id: "personal", status: "ok", windows: [
            StartAccountWindow(name: "5 hour", pct: 100, resetsAt: stamp.string(from: now.addingTimeInterval(3600))),
            StartAccountWindow(name: "7 day", pct: 88, resetsAt: stamp.string(from: now.addingTimeInterval(86400)))
        ], fetchedAt: stamp.string(from: now), lastGood: false)
    ]
    let catalog = StartAccountCatalog(accounts: profiles, usage: StartAccountUsageDashboard(accounts: readings))
    for (name, width, selection, provider) in [
        ("start-account-mac", 480.0, "work", "claude"),
        ("start-account-phone-limit", 390.0, "personal", "claude"),
        ("start-account-phone-unknown", 390.0, "new", "codex")
    ] {
        try render(name, width: width) {
            VStack(alignment: .leading, spacing: 18) {
                Text("Start a session").font(.title2.weight(.medium))
                HStack {
                    Text("Account").font(.caption)
                    Spacer()
                    Label("\(provider == "claude" ? "Claude" : "Codex") · This Mac", systemImage: "desktopcomputer").font(.caption)
                }.foregroundStyle(ConchColor.textSecondary)
                StartAccountPicker(catalog: catalog, provider: provider, selection: .constant(selection), now: now,
                    providerMark: marks[provider == "codex" ? "AgentCodex" : "AgentClaude"])
                    .padding(14).background(ConchColor.surface, in: RoundedRectangle(cornerRadius: 12))
                Text("Advanced   ›").font(.callout)
                Text("Component fixture · accounts are examples").font(.caption).foregroundStyle(ConchColor.textSecondary)
            }
        }
    }
}

// Top-level code here is not main-actor isolated, but it does run on the main thread, which ImageRenderer needs.
func render<Content: View>(_ name: String, width: CGFloat = 960, @ViewBuilder _ content: () -> Content) throws {
    if let galleryOnly, !name.hasPrefix(galleryOnly) { return }
    try MainActor.assumeIsolated { try renderOnMain(name, width: width, content) }
}

@MainActor
func renderOnMain<Content: View>(_ name: String, width: CGFloat, _ content: () -> Content) throws {
    if let onlyPages, !name.hasPrefix(onlyPages) { return }
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
    Heading(title: "The conch mark", note: "Menu bar only: the circle, looking. 18 pt, a template image in every state, drawn from its own 1x and 2x grids.")
    HStack(alignment: .top, spacing: 18) {
        ForEach(VoiceState.allCases, id: \.self) { state in
            VStack(alignment: .leading, spacing: 12) {
                ConchMarkView(state: state)
                    .frame(width: 96, height: 96)
                    .frame(width: 150, height: 130)
                    .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.surface))
                Text(state.title).font(ConchType.uiEmphasis).foregroundStyle(ConchColor.textPrimary)
                // The real status item image, at menu bar size, in a strip like the bar, inked as the bar inks a template.
                HStack(spacing: 10) {
                    Image(nsImage: ConchMark.statusImage(for: state))
                        .renderingMode(.template)
                        .foregroundStyle(ConchColor.textPrimary)
                        .frame(width: ConchMark.side, height: ConchMark.side)
                        .padding(.horizontal, 4)
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
    VoiceStateLabel(state: .ready, detail: "Morrow brand page", orbSize: 30)
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(width: 290, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.surface))
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
                            case .off: Color.clear
                            }
                        }
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 12)
                        if let dot = item.dot {
                            Image(systemName: dot.symbol).font(.system(size: 7)).foregroundStyle(dot.colour)
                        }
                        Text(item.title).font(.system(size: 13)).padding(.leading, CGFloat(item.indent) * 12)
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
    voice: .ready, quiet: false, exchangeActive: false,
    ready: [.init(id: "r1", label: "About page wireframe"), .init(id: "r2", label: "Morrow brand page")],
    working: [.init(id: "w1", label: "Parser refactor"), .init(id: "w2", label: "Invite tests")]
)

try render("m2-status-menu", width: 1180) {
    Heading(title: "Menu bar menu", note: "M2. StatusMenu's rows. Ready for you rows open the item, ⌥ opens conch; working is a filled blue dot.")
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
            Caption("Listening, in Quiet")
            MenuPicture(rows: StatusMenu.rows(StatusMenu.Input(
                voice: .listening, quiet: true, exchangeActive: true, ready: [], working: [.init(id: "w1", label: "Parser refactor")]
            )), voice: .listening, detail: "You turned on the mic")
        }
    }
}

/// A module a session published as a folder, as the tree rail lists it: a listing made up here, with what the session
/// changed and what the agent pointed out.
enum InviteModule {
    static let root = "/Users/tyler/Projects/morrow/web/invite"
    static let focus = ["src/InviteCard.tsx", "src/join.ts", "test"]
    static let changed = ["src/InviteCard.tsx", "src/join.ts", "test/join.test.ts", "README.md"]

    private static func entry(_ relative: String, directory: Bool = false) -> ConchFileEntry {
        ConchFileEntry(path: root + "/" + relative, name: (relative as NSString).lastPathComponent, isDirectory: directory)
    }

    static let directories: Set<String> = ["src", "src/copy", "test", "public"].map { root + "/" + $0 }.reduce(into: []) { $0.insert($1) }

    static let listings: [String: [ConchFileEntry]] = [
        root: ConchFileTree.sorted([entry("src", directory: true), entry("test", directory: true), entry("public", directory: true),
                                    entry("README.md"), entry("package.json"), entry(".env.example")]),
        root + "/src": ConchFileTree.sorted([entry("src/copy", directory: true), entry("src/InviteCard.tsx"), entry("src/join.ts"),
                                             entry("src/emailCheck.ts"), entry("src/index.ts")]),
        root + "/test": [entry("test/join.test.ts"), entry("test/emailCheck.test.ts")],
    ]
}

/// The file tree beside the file picked in it, across the real divider, at a width the divider can be dragged to: six of
/// a folder's nine files pointed out, the second picked (the folder Tyler asked about, 2026-10-29), and the invite module.
struct TreeRailPicture: View {
    let width: CGFloat
    var module = false
    /// What Tyler has opened of what was pointed out, by the keys the daemon holds them by.
    var seen: [String] = []
    var title = "final"

    static let root = "/Users/tyler/Projects/conch/shots/final"
    static let names = ["01-skills-installed.png", "02-skill-detail.png", "03-skills-discover.png", "04-benchmarks.png",
                        "05-skills-narrow.png", "06-skills-dark.png", "notes.md", "README.md", "skills-page.html"]

    var body: some View {
        ConchSplitView(split: .fileTree, width: .constant(Double(width)), label: "Resize the file list") {
            rail
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(ConchColor.surfaceRaised)
        } trailing: {
            RoundedRectangle(cornerRadius: 8)
                .fill(ConchColor.fill)
                .overlay(Text(module ? "InviteCard.tsx" : "02-skill-detail.png").font(ConchType.meta).foregroundStyle(ConchColor.textTertiary))
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ConchColor.surface)
        }
        .frame(height: module ? 350 : 262)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(ConchColor.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var shotsFocus: ConchFileFocus { ConchFileFocus(focus: Array(Self.names.prefix(6)), relativeTo: Self.root) }

    @ViewBuilder private var rail: some View {
        if module {
            let root = InviteModule.root
            let focus = ConchFileFocus(focus: InviteModule.focus, relativeTo: root)
            let expanded = focus.expanded(isDirectory: { InviteModule.directories.contains($0) })
            ConchFileTreeRail(
                rows: ConchFileTree.rows(root: root, listings: InviteModule.listings, expanded: expanded),
                selected: root + "/src/InviteCard.tsx",
                expanded: expanded,
                changed: ConchFileChanges(changed: InviteModule.changed, relativeTo: root),
                focus: focus,
                seen: focus.seen(Dictionary(uniqueKeysWithValues: seen.map { ($0, 1.0) })),
                title: "invite",
                onPick: { _ in }
            )
        } else {
            let entries = Self.names.map { ConchFileEntry(path: Self.root + "/" + $0, name: $0, isDirectory: false) }
            ConchFileTreeRail(
                rows: ConchFileTree.rows(root: Self.root, listings: [Self.root: ConchFileTree.sorted(entries)], expanded: []),
                selected: Self.root + "/02-skill-detail.png",
                expanded: [],
                changed: ConchFileChanges(changed: [], relativeTo: Self.root),
                focus: shotsFocus,
                seen: shotsFocus.seen(Dictionary(uniqueKeysWithValues: seen.map { ($0, 1.0) })),
                title: title,
                onPick: { _ in }
            )
        }
    }
}

try render("tree-rail", width: 760) {
    Heading(title: "The file tree, and the line beside it", note: "What the agent pointed out has a short violet rule in the margin, quieter on a folder on the way to it, and the header says how many are left to look at. Once opened in the viewer the rule goes grey, until the agent points at it again in a newer version or the file changes. What the session changed has its dot after the name. The grip on the line beside the tree says it drags; double-click it to put it back.")
    Caption("At its standard width, 232, nothing opened yet")
    TreeRailPicture(width: 232)
    Caption("Two of the six opened: their rules go grey and their names step back; the header counts what is left")
    TreeRailPicture(width: 232, seen: ["01-skills-installed.png", "02-skill-detail.png"])
    Caption("All six opened: every rule grey, and the header's too")
    TreeRailPicture(width: 232, seen: Array(TreeRailPicture.names.prefix(6)))
    Caption("Dragged to its narrowest, 160: the header says less, the folder's name first")
    TreeRailPicture(width: 160, seen: ["01-skills-installed.png", "02-skill-detail.png"])
    Caption("At 160 with a long folder name: the count down to its number, the name in the middle cut")
    TreeRailPicture(width: 160, seen: ["01-skills-installed.png", "02-skill-detail.png"], title: "skills-page-screenshots")
    Caption("Dragged wide, 360: a module, two files and a folder pointed out, with what the session changed. Both files in src opened, so src has nothing left to lead to; test still has")
    TreeRailPicture(width: 360, module: true, seen: ["src/InviteCard.tsx", "src/join.ts"])
}

/// A page standing in for another app's, which the receipts' thumbnails picture.
struct OtherApp: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        let ink = dark ? Color.white.opacity(0.85) : Color.black.opacity(0.78)
        ZStack(alignment: .topLeading) {
            LinearGradient(
                colors: dark
                    ? [Color(red: 0.20, green: 0.14, blue: 0.24), Color(red: 0.10, green: 0.15, blue: 0.25), Color(red: 0.24, green: 0.15, blue: 0.12)]
                    : [Color(red: 0.96, green: 0.79, blue: 0.66), Color(red: 0.73, green: 0.80, blue: 0.95), Color(red: 0.85, green: 0.77, blue: 0.93)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(alignment: .leading, spacing: 16) {
                Text("Blueprint Studio").font(.system(size: 16, weight: .semibold))
                Spacer().frame(height: 60)
                Text("Join the Morrow team").font(.system(size: 44, weight: .bold))
                Text("You'll see Morrow's boards and drafts as soon as you're in.").font(.system(size: 18))
                RoundedRectangle(cornerRadius: 12).frame(width: 360, height: 52).opacity(0.85)
                RoundedRectangle(cornerRadius: 12).frame(width: 360, height: 52).opacity(0.3)
            }
            .foregroundStyle(ink)
            .padding(.leading, 420)
            .padding(.top, 56)
        }
    }
}

let m3Screen = CGSize(width: 1200, height: 750)

/// A markup over the screen the receipts picture, 0 to 1 across it: a box round the invite card, a note in it, an
/// arrow, a stroke and a highlight. Drawn by `CanvasInk`, as the canvas receipt's picture is.
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

// Something Tyler sent through conch, as his own row in the conversation (`SentReceiptRow`): a canvas, a Show, a video
// from the phone, and a canvas whose picture hasn't been read yet, between his words and a reply so the row can be
// judged against the bubble beside it. The thumbnails are the pictures each one sends: the canvas's flat.png, a frame,
// and a contact sheet.
do {
    var document = CanvasDocument(anchor: CanvasAnchor(id: 1, frame: CGRect(origin: .zero, size: m3Screen)), id: "receipts", at: 0)
    canvasMarks.forEach { document.add($0) }
    let screen = MainActor.assumeIsolated { () -> CGImage? in
        let renderer = ImageRenderer(content: OtherApp().frame(width: m3Screen.width, height: m3Screen.height).environment(\.conchRendersStatically, true))
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
    /// Blocked on a question: the one state whose summary earns the row a second line (`SidebarRowText.subtitle`).
    var asks = false

    static let working = SidebarMark(symbol: "circle.fill", size: 8, colour: AnyShapeStyle(ConchColor.active), meaning: "Working — an agent is running, nothing needed from you", breathes: true)
    static let waitingOnAgents = SidebarMark(symbol: "person.2.fill", size: 9, colour: AnyShapeStyle(SidebarInk.waiting), meaning: "Its agents are working — you can talk to it")
    static let listening = SidebarMark(symbol: "mic.fill", size: 10, colour: AnyShapeStyle(SidebarInk.micOpen), meaning: "Mic open — it is hearing you", live: true)
    static let waiting = SidebarMark(symbol: "circle.inset.filled", size: 8, colour: AnyShapeStyle(SidebarInk.waiting), meaning: "Ready for you — its turn is over", wantsYou: true)
    static let needs = SidebarMark(symbol: "exclamationmark.circle.fill", size: 10.5, colour: AnyShapeStyle(ConchColor.attention), meaning: "Blocked — needs an answer", wantsYou: true, asks: true)
    static let review = SidebarMark(symbol: "checkmark.circle.fill", size: 10.5, colour: AnyShapeStyle(ConchColor.ready), meaning: "Ready for you — work to look at")
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

/// `DashboardRow`'s anatomy: the live rail, the 16 pt mark, the name with the line to itself (fading at its end when it
/// doesn't fit), the quiet mark; the age only on the hovered or selected row; and a second line only for the question a
/// blocked row is waiting on. Other summaries are the tooltip's (SidebarRow.swift).
struct SidebarSessionRow: View {
    let mark: SidebarMark
    let label: String
    var summary = ""
    var age = "4m"
    var phase = 0.5
    /// `SessionVoice.mark`: quiet, or let speak while the rest are quiet. Beside the age; the status mark is untouched.
    var voice: SessionVoice.Mark? = nil
    /// Hovered or selected: the row shows its age.
    var selected = false

    var body: some View {
        HStack(spacing: 8) {
            Capsule(style: .continuous)
                .fill(mark.colour)
                .frame(width: 3, height: 22)
                .opacity(mark.live ? 1 : 0)
                .frame(width: 10)
            SidebarGlyph(mark: mark, phase: phase).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    TailFadeText(label)
                        .font(.system(size: 13, weight: mark.wantsYou ? .semibold : .regular))
                        .foregroundStyle(ConchColor.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let voice {
                        SessionVoiceGlyph(voice, pointSize: 9.5).frame(width: 16, height: 16)
                    }
                    if selected {
                        Text(age).font(.system(size: 11).monospacedDigit()).foregroundStyle(ConchColor.textTertiary)
                    }
                }
                if mark.asks, !summary.isEmpty {
                    TailFadeText(summary, fade: 24)
                        .font(.system(size: 11))
                        .foregroundStyle(ConchColor.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.trailing, 10)
        .padding(.vertical, mark.asks && !summary.isEmpty ? 5 : 0)
        .frame(minHeight: 30)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(ConchColor.rowSelected).opacity(selected ? 1 : 0))
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
            TailFadeText(label, fade: 24)
                .font(.system(size: 11.5, weight: mark.asks ? .semibold : .regular))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
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

// conch's macOS permissions (2026-09-27): Settings › Permissions, one row each, and the line conch's window shows where a
// feature stopped for want of one. Drawn in the Settings window's own type, SF at its sizes, as the app does.
func settingsFont(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }

func permissionsTab(_ statuses: [ConchPermission: ConchPermissionStatus], notes: [ConchPermission: String] = [:],
                    progress: [ConchPermission: String] = [:], caution: String? = nil, moreCautions: [String] = [],
                    launchd: Bool = false) -> some View {
    VStack(spacing: 0) {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("Permissions").font(settingsFont(18, .semibold)).foregroundStyle(ConchColor.textPrimary)
                Text("macOS asks once for each. One grant to conch covers everything that needs it.")
                    .font(settingsFont(12)).foregroundStyle(ConchColor.textSecondary)
            }
            Spacer()
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
        Rectangle().fill(ConchColor.hairline).frame(height: 1)
        ConchPermissionList(
            statuses: statuses, notes: notes, progress: progress, caution: caution, moreCautions: moreCautions,
            cautionAction: launchd ? (title: "Let the app own it", run: {}) : nil,
            titleFont: settingsFont(14, .medium), detailFont: settingsFont(12), statusFont: settingsFont(11), inset: 22,
            onAction: { _, _ in }
        )
        .padding(.bottom, 12)
    }
    .frame(width: 680)
    .background(ConchColor.ground)
    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium))
    .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
}

let allAllowed = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.granted) })

try render("permissions-settings", width: 780) {
    Heading(title: "Settings › Permissions", note: "Each of the four, where it stands, and its one button. Read silently at launch, on coming back to conch, and on opening Settings.")
    Caption("Mixed: one allowed, one macOS hasn't asked, one a reopen away, one off")
    permissionsTab([
        .accessibility: .granted,
        .automation: .notAsked,
        .screenRecording: .needsRelaunch,
        .microphone: .denied,
    ])
    Caption("All allowed: nothing to do, so no buttons")
    permissionsTab(allAllowed)
}

try render("permissions-settings-cautions", width: 780) {
    Heading(title: "Settings › Permissions, when conch can't speak for itself", note: "A daemon started from a terminal answers to that terminal; Terminal closed leaves Automation open; a button's own failure is said under its row.")
    Caption("The daemon was started from a terminal")
    permissionsTab([
        .accessibility: .denied,
        .automation: ConchPermissionReading.automation([("Terminal", ConchPermissionReading.procNotFound), ("System Events", 0)]),
        .screenRecording: .denied,
        .microphone: .restricted,
    ], notes: [.accessibility: "Couldn't open System Settings. It is under Privacy & Security › Accessibility."], caution: ConchPermissionHost.caution(startedBy: "terminal"))
    Caption("The launchd service owns the daemon: the handover the app already has")
    permissionsTab(allAllowed, caution: ConchPermissionHost.caution(startedBy: "launchd"), launchd: true)
}

// Every state has a way to finish it (2026-11-11). Tyler: "it says i need to connect permissions but can't." A refused
// Automation prompt never comes back and System Settings can't add conch by hand: Reset…. A grant made to a build signed
// differently shows on in System Settings while this build is refused: said, with the off-and-on fix. A reopen says it
// is happening, and Automation with Terminal closed asks after opening it in the background.
try render("permissions-settings-ways-out", width: 780) {
    Heading(title: "Settings › Permissions: a way out of every state", note: "Reset… where macOS won't ask again, the off-and-on fix where System Settings shows a switch for another build, and words for what each press is doing.")
    Caption("Refused once: Automation and the Microphone, each with Reset… beside Open Settings")
    permissionsTab([
        .accessibility: .granted,
        .automation: .denied,
        .screenRecording: .granted,
        .microphone: .denied,
    ], progress: [.microphone: "Reset. Press Allow… and macOS asks again."])
    Caption("A switch for another build, a reopen under way, and Automation with Terminal closed")
    permissionsTab([
        .accessibility: .needsRelaunch,
        .automation: .unanswered("Terminal isn't open, so macOS can't say yet."),
        .screenRecording: .grantedToAnotherBuild,
        .microphone: .granted,
    ], progress: [.accessibility: "Reopening conch…"],
       moreCautions: [ConchPermissionHost.signatureCaution(adHoc: true)!])
    Caption("Back from System Settings, still off: the off-and-on fix where you are looking")
    permissionsTab([
        .accessibility: .denied,
        .automation: .granted,
        .screenRecording: .granted,
        .microphone: .granted,
    ], progress: [.accessibility: ConchPermissionGrantMemory.stillOff(.accessibility)])
}

try render("permissions-notices", width: 1040) {
    Heading(title: "Where a feature stopped for want of a permission", note: "One line in conch's window, the first that applies, with the button that fixes it; × puts it away until it happens again.")
    let denied = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.denied) })
    ForEach(Array([
        ("A keystroke System Events refused (the daemon's accessibility-permission-denied)", ConchPermissionNotice(trouble: .typing, status: .denied)),
        ("Apple Events to Terminal refused, never asked", ConchPermissionNotice(trouble: .controlling, status: .notAsked)),
        ("Apple Events to Terminal refused", ConchPermissionNotice(trouble: .controlling, status: .denied)),
        ("The microphone off for conch: every listen hears silence", ConchPermissionNotice(trouble: .hearing, status: .denied)),
        ("The phone's snapshot refused, and Screen Recording turned on since launch", ConchPermissionNotice(trouble: .screen, status: .needsRelaunch)),
        ("No Accessibility: the front window read as the app alone", ConchPermissionNotice.current(noted: [], statuses: denied.merging([.microphone: .granted]) { $1 }, daemonIsConchs: true)!),
    ].enumerated()), id: \.offset) { _, item in
        VStack(alignment: .leading, spacing: 6) {
            Caption(item.0)
            VStack(spacing: 0) {
                ConchPermissionNoticeBar(notice: item.1, font: settingsFont(11.5), onAction: { _ in }, onDismiss: {})
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
                Rectangle().fill(ConchColor.ground).frame(height: 28)
            }
            .frame(width: 900)
            .clipShape(RoundedRectangle(cornerRadius: ConchRadius.small))
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.small).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
        }
    }
    Caption("The same send, as the conversation and the phone say it")
    Text(ConchSendFailure.sentence(reason: "accessibility-permission-denied", onClipboard: true))
        .font(ConchType.secondary)
        .foregroundStyle(ConchColor.attention)
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
            SidebarSessionRow(mark: .waiting, label: "Settings copy", summary: "Done — three options", age: "6m", selected: true)
            SidebarSessionRow(mark: .needs, label: "Deploy script", summary: "Allow rm -rf build?", age: "1m")
            SidebarSessionRow(mark: .review, label: "Invite page copy and the email check it waits on", summary: "The button reads Join", age: "12m")
            SidebarSessionRow(mark: .working, label: "Nightly cleanup", age: "1h", voice: .quiet)
            SidebarSessionRow(mark: .recording, label: "Docs pass", age: "now")
            SidebarSessionRow(mark: .transcribing, label: "Docs pass", age: "now")
            SidebarSessionRow(mark: .speaking, label: "Settings copy", age: "now")
            SidebarSessionRow(mark: .idle, label: "Scratch", age: "2d")
        }
        .frame(width: 400)

        VStack(alignment: .leading, spacing: 10) {
            Caption("The legend (Keyboard Shortcuts)")
            ForEach([SidebarMark.working, .waitingOnAgents, .listening, .waiting, .needs, .review, .recording, .speaking, .transcribing, .paused, .idle], id: \.meaning) { mark in
                HStack(spacing: 10) {
                    Image(systemName: mark.symbol)
                        .font(.system(size: 10.5))
                        .foregroundStyle(mark.colour)
                        .frame(width: 16)
                    Text(mark.meaning).font(.system(size: 12.5)).foregroundStyle(ConchColor.textPrimary)
                }
            }
            ForEach(SessionVoice.Mark.allCases, id: \.symbol) { voice in
                HStack(spacing: 10) {
                    SessionVoiceGlyph(voice, pointSize: 10.5).frame(width: 16)
                    Text(voice.meaning).font(.system(size: 12.5)).foregroundStyle(ConchColor.textPrimary)
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

// Quiet, not paused (`SessionVoice`): the same four sessions in auto with one quieted by name, in manual, and in
// manual with one let speak. Every mark beside an age comes from `SessionVoice.mark`, so this page draws the rule.

/// One session as the quiet page lists it: its status, and the two flags that decide its voice.
struct QuietCase {
    let mark: SidebarMark
    let label: String
    var summary = ""
    var age = "4m"
    var sessionQuiet = false
    var exempt = false
}

struct QuietColumn: View {
    let title: String
    let everythingQuiet: Bool
    let cases: [QuietCase]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Caption(title)
            VStack(alignment: .leading, spacing: 0) {
                // The header's Manual/Auto, as `ModeToggle` draws it.
                HStack(spacing: 5) {
                    Image(systemName: everythingQuiet ? "hand.raised.fill" : "waveform.circle.fill")
                        .font(.system(size: 11, weight: .medium))
                    Text(everythingQuiet ? "Manual" : "Auto").font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(everythingQuiet ? AnyShapeStyle(ConchColor.textSecondary) : AnyShapeStyle(SidebarInk.micOpen))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, 8)
                .frame(height: 26)
                ForEach(cases, id: \.label) { item in
                    SidebarSessionRow(
                        mark: item.mark,
                        label: item.label,
                        summary: item.summary,
                        age: item.age,
                        voice: SessionVoice(sessionQuiet: item.sessionQuiet, exempt: item.exempt, everythingQuiet: everythingQuiet).mark
                    )
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.ground))
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
        }
        .frame(width: 380)
    }
}

/// The Mac's toast after P (ContentView's `QuietToastView`).
struct QuietToastSample: View {
    let mark: SessionVoice.Mark
    let text: String

    var body: some View {
        HStack(spacing: 7) {
            SessionVoiceGlyph(mark, pointSize: 10.5)
            Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textPrimary).lineLimit(1)
        }
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(Capsule(style: .continuous).fill(ConchColor.surfaceRaised))
        .overlay(Capsule(style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
        .conchElevation(.floating)
        .fixedSize()
    }
}

try render("quiet-marks", width: 1320) {
    Heading(title: "Quiet, not paused", note: "A session conch won't read aloud keeps working, so its status mark stays and a speaker mark sits by the age. Everything quiet (Manual) subsumes it; the one let speak through it is marked instead. Click the mark, or press P on the row, to undo.")
    let brand = "Conch brand identity and strategy"
    HStack(alignment: .top, spacing: 24) {
        QuietColumn(title: "Auto, one session quieted by name", everythingQuiet: false, cases: [
            QuietCase(mark: .working, label: "Parser refactor", summary: "Running the suite"),
            QuietCase(mark: .working, label: brand, age: "2m", sessionQuiet: true),
            QuietCase(mark: .waiting, label: "Settings copy", summary: "Done — three options", age: "6m", sessionQuiet: true),
            QuietCase(mark: .review, label: "Invite page", summary: "The button reads Join", age: "12m"),
        ])
        QuietColumn(title: "Manual: every session quiet, no row marked", everythingQuiet: true, cases: [
            QuietCase(mark: .working, label: "Parser refactor", summary: "Running the suite"),
            QuietCase(mark: .working, label: brand, age: "2m", sessionQuiet: true),
            QuietCase(mark: .waiting, label: "Settings copy", summary: "Done — three options", age: "6m", sessionQuiet: true),
            QuietCase(mark: .review, label: "Invite page", summary: "The button reads Join", age: "12m"),
        ])
        QuietColumn(title: "Manual, one let speak (exempt)", everythingQuiet: true, cases: [
            QuietCase(mark: .working, label: "Parser refactor", summary: "Running the suite"),
            QuietCase(mark: .working, label: brand, age: "2m", sessionQuiet: true),
            QuietCase(mark: .listening, label: "Docs pass", age: "now", exempt: true),
            QuietCase(mark: .review, label: "Invite page", summary: "The button reads Join", age: "12m"),
        ])
    }
    VStack(alignment: .leading, spacing: 10) {
        Caption("After P (ContentView's toast), read from the state before the press")
        HStack(spacing: 14) {
            QuietToastSample(mark: .quiet, text: SessionVoice(sessionQuiet: false, exempt: false, everythingQuiet: false).toggledToast(label: brand))
            QuietToastSample(mark: .speaks, text: SessionVoice(sessionQuiet: false, exempt: false, everythingQuiet: true).toggledToast(label: "Docs pass"))
            QuietToastSample(mark: .quiet, text: SessionVoice.toggledAllToast(nowQuiet: true, stillQuiet: 0))
        }
    }
    HStack(alignment: .top, spacing: 40) {
        VStack(alignment: .leading, spacing: 10) {
            Caption("Tooltips (the mark, and the header's Manual/Auto with a row selected)")
            ForEach([
                SessionVoice.Mark.quiet.help(on: .mac),
                SessionVoice.Mark.speaks.help(on: .mac),
                SessionVoice(sessionQuiet: true, exempt: false, everythingQuiet: false).modeHelp(label: brand),
                SessionVoice.modeHelp(everythingQuiet: true, on: .mac),
            ], id: \.self) { line in
                Text(line).font(.system(size: 11.5)).foregroundStyle(ConchColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: 560, alignment: .leading)
            }
        }
        VStack(alignment: .leading, spacing: 10) {
            Caption("The phone (SessionRowView)")
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: "circle.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(ConchColor.active)
                    .activeBreath(pointSize: 15, phase: 0.5)
                    .frame(width: 22)
                Text(brand).font(.body.weight(.semibold)).foregroundStyle(ConchColor.textPrimary).lineLimit(1)
                SessionVoiceGlyph(.quiet, pointSize: 11).frame(width: 28, height: 22)
            }
            .padding(14)
            .frame(width: 330, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: ConchRadius.medium).fill(ConchColor.ground))
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
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

// First-run setup (OnboardingGallery.swift).
try MainActor.assumeIsolated { try renderOnboarding() }
try renderFailureTickets()
try renderFloatingPill()
// Messages between agent sessions (PeerMessagesGallery.swift).
try renderPeerMessages()

// MARK: - Infinite scroll

// The top of a conversation's recorded history, in every state it can be in. Tyler: "Why do I keep seeing 'show all'
// or 'show more' in the convo … those should just smooth infinite scroll". So none of these has a button: scrolling
// up reads further back, a long message is read whole as it nears the viewport, and the top says only what is true.

/// A transcript row as the Mac draws it: your turn in a fill bubble, a reply as a document, a tool step as a line.
struct ScrollGalleryRow: View {
    enum Kind { case you, reply, tool }
    let kind: Kind
    let text: String

    var body: some View {
        switch kind {
        case .you:
            HStack {
                Spacer(minLength: 48)
                Text(text).font(ConchType.readingBody).lineSpacing(ConchType.readingLineSpacing)
                    .foregroundStyle(ConchColor.textPrimary)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(ConchColor.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))
            }
        case .reply:
            MarkdownView(text: text).lineSpacing(ConchType.readingLineSpacing)
                .foregroundStyle(ConchColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .tool:
            HStack(spacing: 8) {
                Image(systemName: "chevron.right").font(.system(size: 8)).foregroundStyle(ConchColor.textTertiary)
                Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(ConchColor.textSecondary)
            }
        }
    }
}

struct ScrollGalleryEntry {
    let kind: ScrollGalleryRow.Kind
    let text: String
}

/// The conversation panel's column: the history region, then a live row, on the stage's surface.
struct ScrollGalleryPanel: View {
    let edge: HistoryEdge
    var note: String? = nil
    let rows: [ScrollGalleryEntry]
    var live: [ScrollGalleryEntry] = []
    var width: CGFloat = 700
    var gap: CGFloat = 22
    var edgeFont: Font = .system(size: 11)
    @StateObject private var model = HistoryRegionModel()

    var body: some View {
        VStack(alignment: .leading, spacing: gap) {
            HistoryRegion(
                model: model,
                edge: edge,
                note: note,
                entries: rows.enumerated().map { HistoryEntry(id: "row-\($0.offset)", estimate: 0, payload: $0.element) },
                gap: gap,
                edgeFont: edgeFont
            ) { entry in
                ScrollGalleryRow(kind: entry.kind, text: entry.text)
            }
            ForEach(Array(live.enumerated()), id: \.offset) { _, entry in
                ScrollGalleryRow(kind: entry.kind, text: entry.text)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: width, alignment: .leading)
        .background(ConchColor.surface, in: RoundedRectangle(cornerRadius: ConchRadius.large))
        .overlay(RoundedRectangle(cornerRadius: ConchRadius.large).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }
}

let scrollReplies: [ScrollGalleryEntry] = [
    .init(kind: .you, text: "Can the phone read a whole session now, or does it still stop somewhere?"),
    .init(kind: .reply, text: "It reads the whole session. The phone used to stop at a thousand rows because every row it held was also laid out; now only the rows near the screen are views, so it keeps going."),
    .init(kind: .tool, text: "Worked 42s · 6 steps"),
    .init(kind: .reply, text: "What it **holds** is still bounded: past a thousand items the pages farthest from you are let go, and read again with their own cursor if you scroll back to them."),
]

func scrollPaging(pages: Int, previous: String?, coverage: HistoryCoverage, status: HistoryFailure? = nil, loading: Bool = false) -> HistoryPaging {
    var paging = HistoryPaging(session: "gallery")
    for page in 0..<pages {
        let items = (0..<3).map { HistoryItem(id: "p\(page)-\($0)", preview: "x") }
        paging.apply(page: HistoryPage(items: items, previousCursor: page == pages - 1 ? previous : "c\(page)", epoch: "e", coverage: coverage),
                     generation: paging.beginLoad())
    }
    if let status { paging.apply(failure: status, generation: paging.beginLoad()) }
    if loading { paging.beginLoad() }
    return paging
}

let complete = HistoryCoverage(sources: 1, statuses: ["complete": 1], indexedBytes: 10, observedBytes: 10)

try render("scroll-1-top-of-history", width: 800) {
    Heading(title: "Scrolling up, more above", note: "The page before was asked for a screen and a half ago and has not been needed yet. Nothing is said: no button, no spinner. The line at the top keeps its height, so what arrives above never moves what you are reading.")
    ScrollGalleryPanel(edge: HistoryEdge.of(scrollPaging(pages: 2, previous: "more", coverage: complete), liveIsWhole: false, slow: false),
                       rows: scrollReplies)
}

try render("scroll-2-mid-fetch", width: 800) {
    Heading(title: "A read that is slow", note: "Only after 300 ms does a quiet spinner show, in the line's own height. A long reply further down is still arriving whole: its preview ends in an ellipsis rather than mid-word until the rest lands, a screen or two before it is seen.")
    ScrollGalleryPanel(edge: HistoryEdge.of(scrollPaging(pages: 2, previous: "more", coverage: complete, loading: true), liveIsWhole: false, slow: true),
                       rows: [scrollReplies[0], .init(kind: .reply, text: "The record keeps the whole of every message and the snapshot keeps its newest part, so a reply the daemon cut is joined back together: the record supplies the head and the snapshot the tail, where they overlap, and a message still being written is read again every few seconds until it can be…"), scrollReplies[2]])
}

try render("scroll-3-start", width: 800) {
    Heading(title: "The start of the conversation", note: "Read back to the first item, with nothing missing: a subtle line, and the first things said.")
    ScrollGalleryPanel(edge: HistoryEdge.of(scrollPaging(pages: 1, previous: nil, coverage: complete), liveIsWhole: false, slow: false),
                       rows: [.init(kind: .you, text: "Let's make the conversation scroll forever."), .init(kind: .reply, text: "Starting with where the reader is, and what moves when a page lands above them.")])
}

try render("scroll-4-unavailable", width: 800) {
    Heading(title: "Where history genuinely is not there", note: "Said once, at the top, in the plain sentences the record store already had. No buttons: there is nothing to press that would change them, except turning records on.")
    VStack(alignment: .leading, spacing: 18) {
        Caption("The record answered and holds nothing for this session, while the live window says there was more")
        ScrollGalleryPanel(edge: HistoryEdge.of({ var p = HistoryPaging(session: "g"); p.apply(page: HistoryPage(items: [], previousCursor: nil, epoch: "e", coverage: complete), generation: p.beginLoad()); return p }(), liveIsWhole: false, slow: false),
                           rows: [], live: [scrollReplies[1]])
        Caption("Recorded, but not from the start")
        ScrollGalleryPanel(edge: HistoryEdge.of(scrollPaging(pages: 1, previous: nil, coverage: HistoryCoverage(sources: 1, statuses: ["complete": 1], indexedBytes: 5, observedBytes: 9)),
                                                liveIsWhole: false, slow: false, oldest: "12 Sep 2026 at 09:14"),
                           rows: [scrollReplies[0]])
        Caption("A branch conch can't place, and the record still reading")
        ScrollGalleryPanel(edge: HistoryEdge(mark: .none, notes: [HistoryNotice.allBranches, "Still reading this session's history — earlier messages may appear."]),
                           rows: [scrollReplies[0]])
        Caption("Records off")
        ScrollGalleryPanel(edge: HistoryEdge.of({ var p = HistoryPaging(session: "g"); p.apply(failure: .off, generation: p.beginLoad()); return p }(), liveIsWhole: false, slow: false),
                           rows: [], live: [scrollReplies[1]])
        Caption("A read that failed: said while it tries again on its own")
        ScrollGalleryPanel(edge: HistoryEdge.of(scrollPaging(pages: 1, previous: "more", coverage: complete, status: .message("conch's record store is busy."), loading: true), liveIsWhole: false, slow: true),
                           rows: [scrollReplies[0]])
    }
}

let scrollLongReply: String = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Tests/ConchDesignTests/Fixtures/migration-plan.md")
    let whole = (try? String(contentsOf: url, encoding: .utf8)) ?? String(repeating: "A long reply. ", count: 700)
    // Past the 4,000-character cut with room to spare; the whole document is a picture too tall to encode.
    let head = whole.prefix(8_500)
    return String(head[..<(head.range(of: "\n\n", options: .backwards)?.lowerBound ?? head.endIndex)])
}()

try render("scroll-5-long-message-whole", width: 800) {
    Heading(title: "A long message, whole", note: "\(scrollLongReply.count) characters — past the daemon's 4,000-character cut — read back from the record and drawn whole. Where \"Show the rest\" was, there is the rest. Its parse is cached by text, so scrolling away and back does not parse it again.")
    ScrollGalleryPanel(edge: HistoryEdge(mark: .none), rows: [.init(kind: .you, text: "Write up the migration plan."), .init(kind: .reply, text: scrollLongReply)])
}

try render("scroll-6-phone", width: 900) {
    Heading(title: "The phone", note: "The same region and the same top line, at the phone's measure and 14 between rows.")
    HStack(alignment: .top, spacing: 24) {
        ScrollGalleryPanel(edge: HistoryEdge(mark: .loading), rows: Array(scrollReplies.prefix(2)), width: 390, gap: 14, edgeFont: .system(size: 13))
        ScrollGalleryPanel(edge: HistoryEdge(mark: .start), rows: Array(scrollReplies.prefix(2)), width: 390, gap: 14, edgeFont: .system(size: 13))
    }
}

// MARK: - The Terminal tab

/// A capture tmux really made (the test fixtures), read from beside the tests.
func terminalFixture(_ name: String) -> String {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Tests/ConchDesignTests/Fixtures/\(name).ansi")
    return (try? String(contentsOf: url, encoding: .utf8)) ?? "(fixture \(name) missing)"
}

/// The strip's places as DashboardView draws them: the Terminal button (↗, it leads out of conch), and — with Debug › Show
/// Terminal Mirror on — the Mirror tab beside it, selected. Drawn here only to show where each sits.
struct TerminalStripPicture: View {
    var mirror = true

    var body: some View {
        HStack(spacing: 2) {
            tab("folder", "Files", selected: !mirror)
            tab("chevron.left.forwardslash.chevron.right", "Shell", selected: false)
            HStack(spacing: 4) {
                Text("Terminal").font(.system(size: 11))
                Image(systemName: "arrow.up.forward").font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(ConchColor.textSecondary)
            .padding(.horizontal, 8)
            .frame(height: 24)
            if mirror { tab("terminal", "Mirror", selected: true) }
            Rectangle().fill(ConchColor.hairline).frame(width: 1, height: 14).padding(.horizontal, 2)
            tab("doc.richtext", "Invite page · 3m", selected: false)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchColor.surface)
    }

    private func tab(_ symbol: String, _ title: String, selected: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(title).font(.system(size: 11))
        }
        .foregroundStyle(selected ? ConchColor.textPrimary : ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? AnyShapeStyle(ConchColor.rowSelected) : AnyShapeStyle(Color.clear)))
    }
}

/// A FIXTURE standing in for ScreenCaptureKit's picture of a Terminal window: the window's chrome drawn around a real
/// tmux capture in Terminal's Basic colours. No Terminal window was opened to make it.
struct TerminalWindowFixture: View {
    let screen: ConchTerminalScreen

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach([0xFF5F57, 0xFEBC2E, 0x28C840], id: \.self) { hex in
                    Circle().fill(ConchRGBA(UInt32(hex)).color).frame(width: 12, height: 12)
                }
                Spacer()
                Text("Conch — codex — 100×22").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(white: 0.75))
                Spacer()
                Color.clear.frame(width: 52, height: 12)
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Color(white: 0.22))
            ConchTerminalScreenView(screen: screen)
                .environment(\.colorScheme, .dark)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.85))
    }
}

let terminalClaude = ConchTerminalScreen(capture: terminalFixture("terminal-claude-tui"), columns: 100, rows: 22)
let terminalCodex = ConchTerminalScreen(capture: terminalFixture("terminal-codex-tui"), columns: 100, rows: 22)

func terminalSheet<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(spacing: 0) {
        TerminalStripPicture()
        Rectangle().fill(ConchColor.hairline).frame(height: 1)
        content()
    }
    .frame(width: 920, height: 520)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(ConchColor.hairlineStrong))
}

try render("terminal-button", width: 1000) {
    Heading(title: "The strip's Terminal: a button", note: "A press brings the session's own terminal forward — its Terminal window and tab, out of the Dock, or its tmux window and pane in the terminal attached to it. The pane stays where it was; nothing is read and nothing is asked. Only for a session with a terminal of its own. Option on it opens the Terminal Mirror, the debug view below.")
    TerminalStripPicture(mirror: false)
        .frame(width: 920)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(ConchColor.hairlineStrong))
}

try render("terminal-tab-tmux", width: 1000) {
    Heading(title: "Terminal Mirror (Debug › Show Terminal Mirror): a session in tmux", note: "The daemon's capture-pane -e of the session's pane, re-read every 300 ms and drawn as text in SF Mono with the terminal's colours: Claude Code's 24-bit orange, its painted diff lines, its own cursor cell. Selectable and copyable. No permission needed.")
    terminalSheet {
        ConchAgentTerminalPane(agent: "Claude Code", state: .screen(terminalClaude), place: "tmux %7 · 100×22", onOpen: {}, onPermission: { _ in }) { EmptyView() }
    }
    Caption("Fixture: a real tmux capture of a frame drawn with Claude Code's escape sequences (Tests/ConchDesignTests/Fixtures/terminal-claude-tui.ansi).")
}

try render("terminal-tab-terminal-app", width: 1000) {
    Heading(title: "Terminal Mirror (debug): a session in a Terminal window", note: "ScreenCaptureKit, that one window, at up to 5 frames a second and only while the mirror is on screen. It pictures the window even behind others.")
    terminalSheet {
        ConchAgentTerminalPane(agent: "Codex", state: .window(4242), place: "Terminal · ttys012", onOpen: {}, onPermission: { _ in }) {
            TerminalWindowFixture(screen: terminalCodex)
        }
    }
    Caption("FIXTURE IMAGE: the window's picture is drawn here from a tmux capture, not taken from a live Terminal window.")
}

try render("terminal-tab-permission", width: 1000) {
    Heading(title: "Terminal Mirror (debug): Screen Recording not yet allowed", note: "Never a blank: the reason and the permission's one button, over Terminal's own text for the tab (contents of tab) — the words without their colours — until the picture can be taken.")
    terminalSheet {
        ConchAgentTerminalPane(agent: "Codex", state: .text(ConchTerminalScreen(plain: terminalCodex.plainText), .needsScreenRecording(.denied)), place: "Terminal · ttys012", onOpen: {}, onPermission: { _ in }) { EmptyView() }
    }
    Caption("After a grant, before conch reopens:")
    terminalSheet {
        ConchAgentTerminalPane(agent: "Codex", state: .text(ConchTerminalScreen(plain: terminalCodex.plainText), .needsScreenRecording(.needsRelaunch)), place: "Terminal · ttys012", onOpen: {}, onPermission: { _ in }) { EmptyView() }
    }
}

try render("terminal-tab-other-states", width: 1000) {
    Heading(title: "Terminal Mirror (debug): the other states", note: "The session's tab behind another in its window, and a session in a terminal conch can't see into.")
    terminalSheet {
        ConchAgentTerminalPane(agent: "Claude Code", state: .text(ConchTerminalScreen(plain: terminalClaude.plainText), .otherTab), place: "Terminal · ttys004", openFailure: "conch isn't allowed to control Terminal: allow conch in Automation.", onOpen: {}, onPermission: { _ in }) { EmptyView() }
    }
    terminalSheet {
        ConchAgentTerminalPane(agent: "Claude Code", state: .unavailable("This session isn't running in a terminal conch can see: only Terminal and tmux are mirrored here."), onOpen: nil, onPermission: { _ in }) { EmptyView() }
    }
}
