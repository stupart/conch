import AppKit
import ConchDesign
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

// First-run setup, drawn from the views the apps will host (Onboarding*.swift): the Mac window at each step, the tour
// over a screen, the iPhone's screens, every state that isn't the happy one, and the key transitions frame by frame.
//   swift run conch-design-gallery <outdir> onb

// MARK: - Assets, read from the repo

/// The repo's root, from this file's place in it.
let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func repoImage(_ path: String) -> Image? {
    NSImage(contentsOf: repoRoot.appendingPathComponent(path)).map { Image(nsImage: $0) }
}

let onbIcon = repoImage("assets/conch-icon-1024.png")
let onbMarks: [String: Image] = [
    "claude": repoImage("mac-app/conch-mac/Assets.xcassets/AgentClaude.imageset/AgentClaude-3x.png"),
    "codex": repoImage("mac-app/conch-mac/Assets.xcassets/AgentCodex.imageset/AgentCodex-3x.png"),
].compactMapValues { $0 }

/// A pairing code shaped like the real one: a link that opens conch (or the App Store), the relay's pairing after the
/// `#`, which a browser never sends anywhere. High error correction, so the icon can sit in its middle.
let onbQR: Image? = {
    let payload = #"{"endpoint":"https://relay.conch.app","roomId":"r_8Qz3kVt1xPbN4sWm","secret":"k7N0vB2yQx9LcR4tE1uH6sJ3aZ8dF5gP0wM2nX7qT4c","version":1}"#
    let code = "https://conch.app/pair#conch-relay-v1:" + Data(payload.utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(code.utf8)
    filter.correctionLevel = "H"
    guard let output = filter.outputImage else { return nil }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    guard let image = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return Image(decorative: image, scale: 1)
}()

/// Every onboarding page, with the icon and the marks the apps would pass. Rendered here rather than through `render`:
/// proposing the page's width to the renderer keeps its measuring pass and its drawing pass the same height.
func onb<Content: View>(_ name: String, width: CGFloat, @ViewBuilder _ content: () -> Content) throws {
    if let onlyPages, !name.hasPrefix(onlyPages) { return }
    try MainActor.assumeIsolated {
        for scheme in [ColorScheme.light, .dark] {
            let sheet = VStack(alignment: .leading, spacing: 28) { content() }
                .padding(40)
                .frame(width: width, alignment: .leading)
                .background(ConchColor.ground)
                .environment(\.colorScheme, scheme)
                .environment(\.conchRendersStatically, true)
                .environment(\.conchAppIcon, onbIcon)
                .environment(\.conchAgentMarks, onbMarks)
            let renderer = ImageRenderer(content: sheet)
            renderer.proposedSize = ProposedViewSize(width: width, height: nil)
            renderer.scale = 2
            guard let image = renderer.cgImage.map(trimmed),
                  let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                fatalError("could not render \(name)")
            }
            let file = outDir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
            try png.write(to: file)
            print(file.path)
        }
    }
}

/// `image` without fully transparent rows at its top and bottom. A page whose measuring pass comes out a few points taller
/// than its drawing pass leaves such a band; the page's own ground is opaque everywhere it draws.
func trimmed(_ image: CGImage) -> CGImage {
    let width = image.width, height = image.height
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let data = { context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)); return context.data }() else { return image }
    let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
    func opaque(_ row: Int) -> Bool {
        // Rows in the context run bottom-up; sample across the row's width.
        let base = (height - 1 - row) * width * 4
        return stride(from: 0, to: width, by: max(1, width / 64)).contains { pixels[base + $0 * 4 + 3] > 0 }
    }
    var top = 0, bottom = height - 1
    while top < bottom, !opaque(top) { top += 1 }
    while bottom > top, !opaque(bottom) { bottom -= 1 }
    guard top > 0 || bottom < height - 1 else { return image }
    return image.cropping(to: CGRect(x: 0, y: top, width: width, height: bottom - top + 1)) ?? image
}

// MARK: - Frames

/// A Mac window as the system draws one: its corner, its hairline, its shadow, and the three buttons over the rail.
struct OnbMacWindow<Content: View>: View {
    let content: Content
    var lights = true
    @Environment(\.colorScheme) private var scheme

    init(lights: Bool = true, @ViewBuilder content: () -> Content) {
        self.lights = lights
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        content
            .frame(width: OnboardingWindowMetrics.size.width, height: OnboardingWindowMetrics.size.height)
            .overlay(alignment: .topLeading) { if lights { TrafficLights().padding(.leading, 22).padding(.top, 22) } }
            .clipShape(shape)
            .overlay(shape.strokeBorder(scheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.1), lineWidth: 1))
            .background(shape.fill(Color.black.opacity(scheme == .dark ? 0.55 : 0.2)).blur(radius: 26).offset(y: 18).padding(10))
    }
}

struct TrafficLights: View {
    var body: some View {
        HStack(spacing: 8) {
            ForEach([Color(red: 1, green: 0.37, blue: 0.34), Color(red: 1, green: 0.74, blue: 0.18), Color(red: 0.16, green: 0.78, blue: 0.25)], id: \.self) { color in
                Circle().fill(color).overlay(Circle().strokeBorder(Color.black.opacity(0.12), lineWidth: 0.5)).frame(width: 12, height: 12)
            }
        }
    }
}

/// A desk for a window to sit on: a quiet wallpaper, so the window's edge and shadow read.
struct OnbDesk<Content: View>: View {
    let content: Content
    var padding: CGFloat = 52
    @Environment(\.colorScheme) private var scheme

    init(padding: CGFloat = 52, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .background(
                LinearGradient(
                    colors: scheme == .dark
                        ? [Color(red: 0.13, green: 0.15, blue: 0.21), Color(red: 0.17, green: 0.13, blue: 0.19), Color(red: 0.20, green: 0.15, blue: 0.13)]
                        : [Color(red: 0.82, green: 0.86, blue: 0.93), Color(red: 0.93, green: 0.88, blue: 0.86), Color(red: 0.88, green: 0.84, blue: 0.93)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous))
    }
}

/// An iPhone as a frame: the screen's corners, the island, the status bar and the home indicator. `dark` forces the
/// screen dark whatever the page is (the camera).
struct OnbPhone<Content: View>: View {
    let content: Content
    var darkScreen = false
    @Environment(\.colorScheme) private var scheme

    init(darkScreen: Bool = false, @ViewBuilder content: () -> Content) {
        self.darkScreen = darkScreen
        self.content = content()
    }

    static var size: CGSize { CGSize(width: 393, height: 852) }

    var body: some View {
        let screen = RoundedRectangle(cornerRadius: 55, style: .continuous)
        let light = !(darkScreen || scheme == .dark)
        ZStack(alignment: .top) {
            content
                .padding(.top, 54)
                .padding(.bottom, 20)
                .frame(width: Self.size.width, height: Self.size.height)
                .background(darkScreen ? AnyShapeStyle(Color.black) : AnyShapeStyle(ConchColor.ground))
            HStack {
                Text("9:41").font(.system(size: 17, weight: .semibold)).padding(.leading, 50)
                Spacer()
                HStack(spacing: 6) {
                    Image(systemName: "cellularbars")
                    Image(systemName: "wifi")
                    Image(systemName: "battery.100percent")
                }
                .font(.system(size: 15, weight: .semibold))
                .padding(.trailing, 34)
            }
            .foregroundStyle(light ? Color.black : Color.white)
            .frame(height: 54)
            Capsule().fill(Color.black).frame(width: 124, height: 36).padding(.top, 11)
            VStack {
                Spacer()
                Capsule().fill(light ? Color.black.opacity(0.85) : Color.white.opacity(0.85)).frame(width: 138, height: 5).padding(.bottom, 8)
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .environment(\.colorScheme, darkScreen ? .dark : scheme)
        .clipShape(screen)
        .padding(11)
        .background(screen.inset(by: -11).fill(Color(red: 0.12, green: 0.12, blue: 0.13)))
        .overlay(screen.inset(by: -11).strokeBorder(Color.white.opacity(0.12), lineWidth: 1.5))
        .shadow(color: .black.opacity(scheme == .dark ? 0.5 : 0.18), radius: 24, y: 14)
    }
}

// MARK: - Fixtures

func downloads(stt: OnboardingDownload.State, voices: OnboardingDownload.State) -> [OnboardingDownload] {
    [
        OnboardingDownload(id: "stt", title: "Speech recognition", purpose: "Hears your replies", state: stt),
        OnboardingDownload(id: "voices", title: "Natural voices", purpose: "Reads turns aloud", state: voices),
    ]
}

let dlEarly = downloads(stt: .downloading(done: 212e6, total: 574e6, secondsLeft: 70), voices: .downloading(done: 180e6, total: 1_660e6, secondsLeft: 260))
let dlMid = downloads(stt: .downloading(done: 488e6, total: 574e6, secondsLeft: 20), voices: .downloading(done: 610e6, total: 1_660e6, secondsLeft: 190))
let dlLate = downloads(stt: .ready, voices: .installing("Setting up the voices, step 3 of 4"))
let dlDone = downloads(stt: .ready, voices: .ready)

func progress(_ step: OnboardingStep, done: [OnboardingStep] = [], later: [OnboardingStep] = []) -> OnboardingProgress {
    var marks: [OnboardingStep: OnboardingMark] = [:]
    for item in done { marks[item] = .done }
    for item in later { marks[item] = .later }
    return OnboardingProgress(step: step, marks: marks)
}

let agentsFound = [
    OnboardingAgent(.claude, .connected(version: "2.1.280", from: "Homebrew"), openSessions: 3),
    OnboardingAgent(.codex, .found(version: "0.156.0", from: "Homebrew")),
]

let permissionsNow = [
    OnboardingPermission(.microphone, .granted),
    OnboardingPermission(.accessibility, .waiting),
    OnboardingPermission(.notifications, .notAsked),
]
let permissionsLater = [
    OnboardingPermission(.screenRecording, .notAsked),
    OnboardingPermission(.automation, .notAsked),
]

let micLevels: [Double] = (0..<44).map { index in
    let x = Double(index)
    let speech = index > 8 && index < 38 ? 0.35 + 0.55 * abs(sin(x * 0.7) * cos(x * 0.23)) : 0.04 + 0.03 * abs(sin(x))
    return min(1, speech)
}
let micQuiet: [Double] = (0..<44).map { 0.03 + 0.02 * abs(sin(Double($0))) }

let tylersPhone = "Tyler's iPhone"
let tylersMac = "Tyler's MacBook Pro"

// MARK: - The screens

@MainActor
struct OnbScreens {
    static func welcome(_ backdrop: OnboardingWelcome.Backdrop) -> some View {
        OnbMacWindow { OnboardingWelcome(backdrop: backdrop) }
    }

    static func agents(_ list: [OnboardingAgent] = agentsFound, downloads: [OnboardingDownload] = dlEarly) -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.agents), downloads: downloads) {
                OnboardingAgentsStep(agents: list)
            }
        }
    }

    static func permissions(_ now: [OnboardingPermission] = permissionsNow, later: [OnboardingPermission] = permissionsLater, downloads: [OnboardingDownload] = dlMid) -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.permissions, done: [.agents]), downloads: downloads, details: [.permissions: "1 of 3"]) {
                OnboardingPermissionsStep(now: now, whenNeeded: later)
            }
        }
    }

    static func voice(ring: VoiceRing = .ready(playing: 2), mic: MicCheck = MicCheck(device: "MacBook Pro Microphone", state: .heard("Testing, one, two, three."), levels: micLevels),
                      downloads: [OnboardingDownload] = dlDone) -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.voice, done: [.agents], later: [.permissions]), downloads: downloads) {
                OnboardingVoiceStep(ring: ring, mic: mic)
            }
        }
    }

    static func phone(_ state: PhoneStepState, downloads: [OnboardingDownload] = dlDone) -> some View {
        var marks = progress(.phone, done: [.agents, .voice], later: [.permissions])
        if case .finished = state { marks.marks[.phone] = .done }
        return OnbMacWindow {
            OnboardingWindow(progress: marks, downloads: downloads) {
                OnboardingPhoneStep(state: state, qr: onbQR)
            }
        }
    }

    static func practice() -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.practice, done: [.agents, .voice, .phone], later: [.permissions]), downloads: dlDone) {
                OnboardingPracticeStep {
                    ZStack(alignment: .top) {
                        TourDesktop().scaleEffect(0.62, anchor: .top).frame(width: 556, height: 236).clipped().blur(radius: 1.5)
                        Rectangle().fill(Color.black.opacity(0.04))
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
        }
    }

    static func done(later: Bool = true) -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.done, done: [.agents, .voice, .phone, .practice], later: later ? [.permissions] : []), downloads: dlLate) {
                OnboardingDoneStep(
                    summary: [
                        OnboardingSummaryLine(step: .agents, detail: "Claude Code and Codex connected", status: "", done: true),
                        OnboardingSummaryLine(step: .voice, detail: "conch heard you", status: "", done: true),
                        OnboardingSummaryLine(step: .phone, detail: "\(tylersPhone) paired", status: "", done: true),
                        OnboardingSummaryLine(step: .permissions, detail: "Accessibility later", status: "", done: !later),
                    ],
                    actions: [
                        OnboardingFirstAction(id: "answer", symbol: "waveform", title: "Answer dayloop",
                                              detail: "It finished a turn while you were setting up. conch reads it to you now."),
                        OnboardingFirstAction(id: "start", symbol: "plus", title: "Start a session",
                                              detail: "Claude Code or Codex, in a folder you pick. It opens in Terminal."),
                        OnboardingFirstAction(id: "wait", symbol: "cup.and.saucer", title: "Get on with your day",
                                              detail: "conch calls you when an agent has something."),
                    ]
                )
            }
        }
    }

    static func welcomeBack() -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.permissions, done: [.agents, .voice]), downloads: dlDone, details: [.permissions: "1 off", .phone: "New"]) {
                OnboardingWelcomeBack {
                    PermissionRow(permission: OnboardingPermission(.screenRecording, .notAsked))
                    OnboardingDivider()
                    OnboardingRow(tile: OnboardingTile(symbol: "iphone"), title: "Your iPhone",
                                  detail: "New: hear your agents and answer them from anywhere.") {
                        OnboardingButton("Pair", style: .row)
                    }
                }
            }
        }
    }
}

// MARK: - The tour, over a screen

let tourScreen = panelScreenSize
/// The browser window on the tour's screen, and the Join button in it, which the canvas beat marks up.
let tourWindow = CGRect(x: 330, y: 112, width: 1020, height: 720)
let tourJoin = CGRect(x: 394, y: 452, width: 150, height: 48)

/// The screen the tour happens over: a quiet wallpaper and a page open in a browser, as anyone's might be.
struct TourDesktop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        let ink = dark ? Color.white.opacity(0.9) : Color.black.opacity(0.82)
        ZStack(alignment: .topLeading) {
            LinearGradient(
                colors: dark
                    ? [Color(red: 0.10, green: 0.16, blue: 0.24), Color(red: 0.18, green: 0.13, blue: 0.22), Color(red: 0.24, green: 0.16, blue: 0.14)]
                    : [Color(red: 0.76, green: 0.85, blue: 0.94), Color(red: 0.93, green: 0.84, blue: 0.80), Color(red: 0.85, green: 0.80, blue: 0.93)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    TrafficLights()
                    Spacer()
                    HStack(spacing: 6) {
                        Image(systemName: "lock.fill").font(.system(size: 10, weight: .semibold))
                        Text("arch.blueprint.studio/join").font(.system(size: 13))
                    }
                    .foregroundStyle(ink.opacity(0.7))
                    .frame(width: 380, height: 30)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(dark ? Color.white.opacity(0.08) : Color.black.opacity(0.05)))
                    Spacer()
                    Color.clear.frame(width: 52)
                }
                .padding(.horizontal, 18)
                .frame(height: 52)
                .background(dark ? Color(red: 0.17, green: 0.17, blue: 0.18) : Color(red: 0.97, green: 0.97, blue: 0.96))
                Rectangle().fill(dark ? Color.white.opacity(0.08) : Color.black.opacity(0.08)).frame(height: 1)
                HStack(alignment: .top, spacing: 56) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Blueprint Studio").font(.system(size: 15, weight: .semibold)).foregroundStyle(ink)
                        Text("Join the Arch team").font(.system(size: 44, weight: .bold)).tracking(-0.8).foregroundStyle(ink).padding(.top, 96)
                        Text("You'll see Arch's boards and drafts as soon as you're in.").font(.system(size: 18)).foregroundStyle(ink.opacity(0.65)).padding(.top, 12)
                        HStack(spacing: 22) {
                            Text("Join").font(.system(size: 17, weight: .semibold)).foregroundStyle(dark ? Color.black : Color.white)
                                .frame(width: tourJoin.width, height: tourJoin.height)
                                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(ink))
                            Text("Maybe later").font(.system(size: 16, weight: .medium)).foregroundStyle(ink.opacity(0.6))
                        }
                        .padding(.top, 36)
                    }
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(LinearGradient(colors: [Color(red: 0.98, green: 0.78, blue: 0.64), Color(red: 0.74, green: 0.78, blue: 0.97)], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 360, height: 440)
                        .overlay(alignment: .bottomLeading) {
                            HStack(spacing: -10) {
                                ForEach(0..<4, id: \.self) { index in
                                    Circle().fill(Color.white.opacity(0.9 - Double(index) * 0.12)).frame(width: 40, height: 40)
                                        .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
                                }
                            }
                            .padding(24)
                        }
                }
                .padding(.horizontal, 64)
                .padding(.top, 52)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(dark ? Color(red: 0.11, green: 0.11, blue: 0.12) : Color.white)
            }
            .frame(width: tourWindow.width, height: tourWindow.height)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(dark ? 0.5 : 0.22), radius: 28, y: 16)
            .offset(x: tourWindow.minX, y: tourWindow.minY)
        }
        .frame(width: tourScreen.width, height: tourScreen.height, alignment: .topLeading)
    }
}

let tourBackdrops: [Bool: PanelBackdrop] = MainActor.assumeIsolated {
    var all: [Bool: PanelBackdrop] = [:]
    for dark in [false, true] {
        let renderer = ImageRenderer(content: TourDesktop().environment(\.colorScheme, dark ? .dark : .light))
        renderer.scale = 1
        if let image = renderer.cgImage { all[dark] = PanelBackdrop(dark ? "tour, dark" : "tour, light", image) }
    }
    return all
}

/// The menu bar across the top of the screen, with conch's mark in it.
struct OnbMenuBar: View {
    var voice: VoiceState = .talk
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 20) {
            Image(systemName: "apple.logo").font(.system(size: 14, weight: .semibold))
            Text("Safari").font(.system(size: 13, weight: .bold))
            ForEach(["File", "Edit", "View", "History", "Window"], id: \.self) { Text($0).font(.system(size: 13)) }
            Spacer()
            HStack(spacing: 16) {
                ConchMarkView(state: voice).frame(width: 18, height: 18)
                Image(systemName: "wifi")
                Image(systemName: "battery.75percent")
                Image(systemName: "switch.2")
                Text("Mon 27 Sep  9:41").font(.system(size: 13, weight: .medium))
            }
            .font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(scheme == .dark ? Color.white : Color.black.opacity(0.85))
        .padding(.horizontal, 18)
        .frame(height: panelMenuBar)
        .background(scheme == .dark ? Color.black.opacity(0.35) : Color.white.opacity(0.45))
    }
}

let practiceSession = FogSession(id: "practice", label: "Practice turn", agent: "conch", standing: .ready)
let practiceTurns = [
    ConversationTurn(id: "p1", fromYou: false, text: "Hi, I'm conch. When an agent finishes a turn, I read you what it did, then listen for your answer. Try it: say anything."),
    ConversationTurn(id: "p2", fromYou: true, text: "Show me what you made."),
    ConversationTurn(id: "p3", fromYou: false, text: "Here it is: a welcome card, waiting where the work lives. Click the pill, or look below. When you answer here, it goes to whoever spoke."),
]

/// One beat of the tour: the screen, the menu bar, the pill, and whatever else the beat shows, with its card.
struct TourScene<Extra: View>: View {
    let bar: ControlBar?
    let card: CoachCard
    let cardAt: CGPoint
    var voice: VoiceState = .talk
    var panel = false
    let extra: Extra
    @Environment(\.colorScheme) private var scheme

    init(bar: ControlBar?, card: CoachCard, cardAt: CGPoint, voice: VoiceState = .talk, panel: Bool = false, @ViewBuilder extra: () -> Extra) {
        self.bar = bar
        self.card = card
        self.cardAt = cardAt
        self.voice = voice
        self.panel = panel
        self.extra = extra()
    }

    var body: some View {
        let dark = scheme == .dark
        ZStack(alignment: .topLeading) {
            if panel, let backdrop = tourBackdrops[dark] {
                PanelScene(backdrop: backdrop, turns: practiceTurns, session: practiceSession)
            } else {
                TourDesktop()
            }
            extra
            OnbMenuBar(voice: voice).frame(width: tourScreen.width)
            if let bar {
                bar.frame(width: tourScreen.width).padding(.top, panelMenuBar + 10)
            }
            card.fixedSize().position(cardAt)
        }
        .frame(width: tourScreen.width, height: tourScreen.height, alignment: .topLeading)
        .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous))
    }
}

extension TourScene where Extra == EmptyView {
    init(bar: ControlBar?, card: CoachCard, cardAt: CGPoint, voice: VoiceState = .talk, panel: Bool = false) {
        self.init(bar: bar, card: card, cardAt: cardAt, voice: voice, panel: panel, extra: { EmptyView() })
    }
}

/// Marks over the tour's screen: Tyler's box round the Join button and a note on it in his orange, and an agent's arrow
/// at it in its violet.
let tourMarks: [CanvasMark] = {
    func at(_ x: CGFloat, _ y: CGFloat) -> CanvasPoint { CanvasPoint(x: x / tourScreen.width, y: y / tourScreen.height) }
    let box = tourJoin.insetBy(dx: -16, dy: -14)
    return [
        CanvasMark(kind: .box, points: [at(box.minX, box.minY), at(box.maxX, box.maxY)]),
        CanvasMark(kind: .note, points: [at(box.maxX - 6, box.minY + 18)], text: "bigger"),
        CanvasMark(kind: .arrow, author: .agent, points: [at(760, 640), at(box.maxX + 10, box.maxY - 6)]),
    ]
}()

enum Tour {
    static let pillCard = CGPoint(x: tourScreen.width / 2, y: panelMenuBar + 10 + 48 + 16 + 95)

    static func pill() -> some View {
        TourScene(
            bar: ControlBar(state: .talk, detail: "Practice turn", mode: .constant(.talk), news: "About to speak"),
            card: CoachCard(beat: 1, of: 5, title: "This is the pill",
                            text: "It sits at the top of your screen and says who's talking and what's ready. Talk reads each finished turn aloud; Quiet holds them until you ask.",
                            pointer: .up),
            cardAt: pillCard
        )
    }

    static func answer() -> some View {
        TourScene(
            bar: ControlBar(state: .listening, detail: "Practice turn", mode: .constant(.talk)),
            card: CoachCard(beat: 2, of: 5, title: "Answer out loud",
                            text: "conch read the practice turn, then opened the mic. Say anything, then pause. Your words go to whoever just spoke.",
                            heard: "Show me what you made.", pointer: .up),
            cardAt: CGPoint(x: pillCard.x, y: pillCard.y + 24),
            voice: .listening
        )
    }

    static func ready() -> some View {
        TourScene(
            bar: ControlBar(state: .talk, detail: "", mode: .constant(.talk), ready: ControlBar.Ready(label: "Welcome to conch", position: 1, count: 1), onTap: {}),
            card: CoachCard(beat: 3, of: 5, title: "Green means ready",
                            text: "An agent finished something for you. Click the pill and conch opens it where it lives: the page, the app, the file.",
                            pointer: .up, primary: "Open it"),
            cardAt: pillCard,
            voice: .ready
        )
    }

    static func panel() -> some View {
        TourScene(
            bar: ControlBar(state: .talk, detail: "Practice turn", mode: .constant(.talk)),
            card: CoachCard(beat: 4, of: 5, title: "The panel",
                            text: "The conversation, and a line to answer in. Drag it to any corner. ⌘↩ fills the screen, and ⌘. folds it away.",
                            chord: "⌘↩", pointer: .left),
            cardAt: CGPoint(x: dockedWindow.maxX + 190, y: dockedWindow.minY + 150),
            panel: true
        )
    }

    static func canvas() -> some View {
        let pillY = panelMenuBar + 10 + 48 + 14 + 21
        return TourScene(
            bar: ControlBar(state: .talk, detail: "Practice turn", mode: .constant(.talk)),
            card: CoachCard(beat: 5, of: 5, title: "Draw on anything",
                            text: "Mark up whatever's on screen and Send it to the agent. With the pen down, ⇧R records a Show instead. Agents draw too; theirs are violet.",
                            chord: "⌃⌥⌘P", chordLit: true, pointer: .left, primary: "Finish"),
            cardAt: CGPoint(x: tourScreen.width / 2 + 250 + 24 + 150, y: pillY - 40 + 104)
        ) {
            CanvasInkPreview(marks: tourMarks, size: tourScreen)
            CanvasToolPill(tool: .box, armed: true, canUndo: true, canSend: true, route: CanvasToolPill.Route(id: "practice", label: "Practice turn", sure: true),
                           onTool: { _ in }, onUndo: {}, onSend: {}, onShow: {}, onDiscard: {}, onDone: {})
                .fixedSize()
                .position(x: tourScreen.width / 2, y: pillY)
        }
    }
}

/// A scene at a fraction of its size, keeping its layout.
func scaled<Content: View>(_ scale: CGFloat, _ size: CGSize, @ViewBuilder _ content: () -> Content) -> some View {
    content()
        .scaleEffect(scale, anchor: .topLeading)
        .frame(width: size.width * scale, height: size.height * scale, alignment: .topLeading)
}

// MARK: - Motion, frame by frame

/// A spring's value at `t` seconds, from 0 toward 1, stepped as the apps step it.
func springAt(_ spring: ConchSpring, _ t: Double) -> CGFloat {
    var value: CGFloat = 0
    var velocity: CGFloat = 0
    spring.step(&value, velocity: &velocity, to: 1, dt: t)
    return value
}

func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }

/// Welcome giving way to the first step: welcome lifts off soft and a touch large, the rail slides in, the step's
/// words arrive from a little below, and the icon lands in the rail.
struct WelcomeToAgents: View {
    let t: Double
    var reduceMotion = false

    var body: some View {
        let out = springAt(ConchMotion.liftOff, t)
        let rail = springAt(ConchMotion.morph.resolved(reduceMotion: reduceMotion), max(0, t - 0.06))
        let words = springAt(ConchMotion.reveal.resolved(reduceMotion: reduceMotion), max(0, t - ConchMotion.revealDelay - 0.06))
        return OnbMacWindow {
            ZStack(alignment: .topLeading) {
                Rectangle().fill(ConchColor.ground)
                HStack(spacing: 0) {
                    OnboardingRail(progress: progress(.agents), downloads: dlEarly)
                        .padding(OnboardingWindowMetrics.railInset)
                        .padding(.trailing, -OnboardingWindowMetrics.railInset / 2)
                        .offset(x: reduceMotion ? 0 : lerp(-36, 0, rail))
                        .opacity(Double(rail))
                    OnboardingAgentsStep(agents: agentsFound)
                        .offset(y: reduceMotion ? 0 : lerp(ConchMotion.crossShift * 1.5, 0, words))
                        .blur(radius: reduceMotion ? 0 : lerp(ConchMotion.crossBlur, 0, words))
                        .opacity(Double(words))
                }
                OnboardingWelcome()
                    .scaleEffect(reduceMotion ? 1 : lerp(1, 1.03, out))
                    .blur(radius: reduceMotion ? 0 : lerp(0, 5, out))
                    .opacity(Double(1 - out))
            }
        }
    }
}

/// A permission turning on: Waiting's spinner gives way to the check, which pops in small and settles.
struct GrantRow: View {
    let t: Double
    var reduceMotion = false

    var body: some View {
        OnboardingCard {
            OnboardingRow(tile: OnboardingTile(symbol: "accessibility"), title: "Accessibility", detail: OnboardingPermission.Kind.accessibility.why) {
                GrantCross(t: t, reduceMotion: reduceMotion).frame(width: 96, alignment: .trailing)
            }
        }
        .frame(width: 556)
    }
}

/// Waiting giving way to Allowed without the two ever sharing the spot: Waiting leaves first, up and soft (the
/// crossfade's shift and blur), and Allowed follows 70 ms later, its check popping in from half size.
struct GrantCross: View {
    let t: Double
    var reduceMotion = false

    var body: some View {
        let fade = springAt(ConchMotion.liftOff, t)
        let pop = springAt(ConchMotion.pop.resolved(reduceMotion: reduceMotion), max(0, t - 0.07))
        return ZStack(alignment: .trailing) {
            OnboardingStatus(.working, "Waiting")
                .offset(y: reduceMotion ? 0 : -ConchMotion.crossShift / 2 * fade)
                .blur(radius: reduceMotion ? 0 : ConchMotion.crossBlur * fade)
                .opacity(Double(1 - fade))
            HStack(spacing: 6) {
                OnboardingCheck(size: 16).scaleEffect(reduceMotion ? 1 : lerp(0.5, 1, pop))
                Text("Allowed").font(.system(size: 12, weight: .medium)).foregroundStyle(ConchColor.textSecondary)
                    .offset(x: reduceMotion ? 0 : lerp(4, 0, pop))
            }
            .opacity(Double(min(1, pop * 1.4)))
        }
    }
}

/// Just the status of a row turning on, close up, on the row's own surface.
struct GrantStatus: View {
    let t: Double
    var reduceMotion = false

    var body: some View {
        GrantCross(t: t, reduceMotion: reduceMotion)
            .padding(.horizontal, 20)
        .frame(width: 200, height: 56, alignment: .trailing)
        .background(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).fill(ConchColor.surface))
        .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }
}

/// The code giving way to the phone, then the phone's stages ticking in as it reports them.
struct CodeToPhone: View {
    let t: Double
    var reduceMotion = false

    var body: some View {
        let out = springAt(ConchMotion.liftOff, t)
        let inn = springAt(ConchMotion.swap.resolved(reduceMotion: reduceMotion), max(0, t - 0.08))
        return ZStack(alignment: .topLeading) {
            HStack(alignment: .top, spacing: 28) {
                PairingCode(qr: onbQR, dimmed: true)
                VStack(alignment: .leading, spacing: 14) {
                    NumberedLineGallery(1, "Open the Camera on your iPhone.")
                    NumberedLineGallery(2, "Point it at the code.")
                    NumberedLineGallery(3, "Tap the conch banner that appears.")
                }
            }
            .scaleEffect(reduceMotion ? 1 : lerp(1, 1 / ConchMotion.swapScale, out), anchor: .leading)
            .blur(radius: reduceMotion ? 0 : lerp(0, ConchMotion.swapBlur, out))
            .opacity(Double(1 - out))
            HStack(alignment: .top, spacing: 28) {
                PhoneOutline(done: false).frame(width: 216, height: 216)
                VStack(alignment: .leading, spacing: 11) {
                    Text(tylersPhone).font(.system(size: 17, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                    ForEach(Array(PhoneSetupStage.mirrored.enumerated()), id: \.offset) { index, stage in
                        let row = springAt(ConchMotion.pop.resolved(reduceMotion: reduceMotion), max(0, t - 0.14 - Double(index) * ConchMotion.popStagger * 2))
                        MirrorLineGallery(stage: stage, handoff: PhoneHandoff(device: tylersPhone, stage: .paired))
                            .offset(y: reduceMotion ? 0 : lerp(ConchMotion.popShift, 0, row))
                            .opacity(Double(row))
                    }
                }
            }
            .scaleEffect(reduceMotion ? 1 : lerp(ConchMotion.swapScale, 1, inn), anchor: .leading)
            .blur(radius: reduceMotion ? 0 : lerp(ConchMotion.swapBlur, 0, inn))
            .opacity(Double(inn))
        }
        .frame(width: 556, height: 216, alignment: .topLeading)
    }
}

/// The phone handing back: the iPhone step, all ticked, gives way to Try it. The rail's highlight travels down a row on
/// pop and the iPhone step's check pops in; the page swaps (the old out soft and a touch large, the new in from a touch
/// small, on swap).
struct PhoneToPractice: View {
    let t: Double
    var reduceMotion = false

    var body: some View {
        let travel = springAt(ConchMotion.pop.resolved(reduceMotion: reduceMotion), t)
        let check = springAt(ConchMotion.pop.resolved(reduceMotion: reduceMotion), t)
        let out = springAt(ConchMotion.liftOff, t)
        let inn = springAt(ConchMotion.swap.resolved(reduceMotion: reduceMotion), max(0, t - 0.06))
        var rail = progress(.practice, done: [.agents, .voice, .phone], later: [.permissions])
        rail.step = t == 0 ? .phone : .practice
        return OnbMacWindow {
            HStack(spacing: 0) {
                OnboardingRail(progress: rail, downloads: dlDone)
                    .padding(OnboardingWindowMetrics.railInset)
                    .padding(.trailing, -OnboardingWindowMetrics.railInset / 2)
                    .environment(\.onboardingRailMove, t == 0 ? nil : OnboardingRailMove(from: .phone, travel: reduceMotion ? min(1, travel) : travel, check: reduceMotion ? 1 : lerp(0.5, 1, check)))
                ZStack(alignment: .topLeading) {
                    OnboardingPhoneStep(state: .finished(PhoneHandoff(device: tylersPhone, stage: .finished)), qr: onbQR)
                        .scaleEffect(reduceMotion ? 1 : lerp(1, 1 / ConchMotion.swapScale, out))
                        .blur(radius: reduceMotion ? 0 : lerp(0, ConchMotion.swapBlur, out))
                        .opacity(Double(1 - out))
                    OnboardingPracticeStep {
                        TourDesktop().scaleEffect(0.62, anchor: .top).frame(width: 556, height: 236).clipped()
                    }
                    .scaleEffect(reduceMotion ? 1 : lerp(ConchMotion.swapScale, 1, inn))
                    .blur(radius: reduceMotion ? 0 : lerp(ConchMotion.swapBlur, 0, inn))
                    .opacity(Double(inn))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(width: OnboardingWindowMetrics.size.width, height: OnboardingWindowMetrics.size.height)
            .background(ConchColor.ground)
        }
    }
}

/// The views the gallery borrows from the library's internals, redrawn with the same parts.
struct NumberedLineGallery: View {
    let number: Int
    let text: String
    init(_ number: Int, _ text: String) {
        self.number = number
        self.text = text
    }
    var body: some View {
        HStack(spacing: 10) {
            Text("\(number)").font(.system(size: 11, weight: .bold)).foregroundStyle(ConchColor.textSecondary)
                .frame(width: 20, height: 20).background(Circle().fill(ConchColor.fill))
            Text(text).font(.system(size: 14)).foregroundStyle(ConchColor.textPrimary)
        }
    }
}

struct MirrorLineGallery: View {
    let stage: PhoneSetupStage
    let handoff: PhoneHandoff
    var body: some View {
        let reached = handoff.stage > stage
        let here = handoff.stage == stage
        HStack(spacing: 10) {
            Group {
                if reached { OnboardingCheck(size: 18) } else if here { OnboardingSpinner(size: 16) } else {
                    Circle().strokeBorder(ConchColor.textTertiary.opacity(0.6), lineWidth: 1.2)
                }
            }
            .frame(width: 18, height: 18)
            Text(stage.title).font(.system(size: 13, weight: here ? .semibold : .regular))
                .foregroundStyle(reached || here ? ConchColor.textPrimary : ConchColor.textTertiary)
        }
    }
}

/// Frames of a transition in a row, each labelled with its time.
func filmstrip<Frame: View>(_ times: [Double], scale: CGFloat, size: CGSize, @ViewBuilder frame: @escaping (Double) -> Frame) -> some View {
    HStack(alignment: .top, spacing: 16) {
        ForEach(times, id: \.self) { t in
            VStack(alignment: .leading, spacing: 8) {
                scaled(scale, size) { frame(t) }
                Text("\(Int((t * 1000).rounded())) ms").font(ConchType.code).foregroundStyle(ConchColor.textSecondary)
            }
        }
    }
}

// MARK: - The pages

@MainActor
func renderOnboarding() throws {
    let windowPage = OnboardingWindowMetrics.size.width + 52 * 2 + 80

    // The whole flow at a glance: the Mac's steps in order, the phone's beside the step that hands to it.
    let thumb: CGFloat = 0.3
    let thumbSize = CGSize(width: OnboardingWindowMetrics.size.width + 20, height: OnboardingWindowMetrics.size.height + 20)
    func step<V: View>(_ caption: String, @ViewBuilder _ view: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Caption(caption)
            scaled(thumb, thumbSize) { view().padding(10) }
        }
    }
    try onb("onb-00-flow", width: (thumbSize.width * thumb + 20) * 4 + 80) {
        Heading(title: "Setup, start to finish", note: "The Mac's five steps between Welcome and You're set, the rail tracking them and the downloads under it the whole way. The iPhone branch runs on the phone while the Mac waits on step 4, and hands back.")
        HStack(alignment: .top, spacing: 20) {
            step("Welcome") { OnbScreens.welcome(.calm) }
            step("1 · Agents") { OnbScreens.agents() }
            step("2 · Permissions") { OnbScreens.permissions() }
            step("3 · Voice") { OnbScreens.voice() }
        }
        HStack(alignment: .top, spacing: 20) {
            step("4 · iPhone: the code") { OnbScreens.phone(.waiting(relay: true)) }
            step("4 · iPhone: following the phone") { OnbScreens.phone(.settingUp(PhoneHandoff(device: tylersPhone, stage: .microphone))) }
            step("5 · Try it") { OnbScreens.practice() }
            step("You're set") { OnbScreens.done() }
        }
        Caption("Meanwhile, on the iPhone (step 4)")
        HStack(alignment: .top, spacing: 20) {
            ForEach(Array([
                AnyView(PhoneConnecting(mac: tylersMac, connected: true)),
                AnyView(PhonePermissionAsk(.notifications)),
                AnyView(PhonePermissionAsk(.microphone)),
                AnyView(PhoneTourPage(page: 0)),
                AnyView(PhoneSetupDone(mac: tylersMac)),
            ].enumerated()), id: \.offset) { _, screen in
                scaled(0.34, CGSize(width: 415, height: 874)) { OnbPhone { screen } }
            }
        }
        Caption("Then the tour, over the real screen (step 5)")
        HStack(alignment: .top, spacing: 20) {
            scaled(0.15, tourScreen) { Tour.pill() }
            scaled(0.15, tourScreen) { Tour.answer() }
            scaled(0.15, tourScreen) { Tour.ready() }
            scaled(0.15, tourScreen) { Tour.panel() }
            scaled(0.15, tourScreen) { Tour.canvas() }
        }
    }

    try onb("onb-mac-01-welcome", width: OnboardingWindowMetrics.size.width * 2 + 52 * 2 + 32 + 80) {
        Heading(title: "Welcome", note: "Before the rail: one line, one button, and what setting up will take. Two backdrops to choose between: the app's own ground, or the shore.")
        OnbDesk {
            HStack(spacing: 32) {
                VStack(alignment: .leading, spacing: 10) { Caption("Calm: the app's ground, the icon the only colour"); OnbScreens.welcome(.calm) }
                VStack(alignment: .leading, spacing: 10) { Caption("Shore: water over sand, held back to a wash"); OnbScreens.welcome(.shore) }
            }
        }
    }

    try onb("onb-mac-02-agents", width: windowPage) {
        Heading(title: "1 · Agents", note: "What conch found, and one button per agent. Downloads started with Set up conch and run under the steps.")
        OnbDesk { OnbScreens.agents() }
    }

    try onb("onb-mac-03-permissions", width: windowPage) {
        Heading(title: "2 · Permissions", note: "Three asked now, each with conch's reason; the two most people skip are asked by the feature that needs them, the first time. Accessibility is waiting on System Settings, with the guide under its list.")
        OnbDesk {
            VStack(alignment: .leading, spacing: 28) {
                OnbScreens.permissions()
                VStack(alignment: .leading, spacing: 8) {
                    Caption("The guide, fixed under System Settings' list while conch waits (it never takes the focus)")
                    PermissionGuide(kind: .accessibility)
                }
            }
        }
    }

    try onb("onb-mac-04-voice", width: windowPage) {
        Heading(title: "3 · Voice", note: "A voice sample, then a microphone check that shows what speech recognition heard.")
        OnbDesk { OnbScreens.voice() }
    }

    try onb("onb-mac-05-phone", width: windowPage) {
        Heading(title: "4 · iPhone", note: "The code is a link: the iPhone's Camera opens conch, or the App Store when it isn't installed. The Mac waits, and moves on by itself.")
        OnbDesk { OnbScreens.phone(.waiting(relay: true)) }
    }

    try onb("onb-mac-05b-phone-handoff", width: windowPage) {
        Heading(title: "4 · iPhone, while the phone sets itself up", note: "Mirrored from the phone's reports through the pairing: the Mac shows each stage as the phone passes it, then carries on.")
        OnbDesk { OnbScreens.phone(.settingUp(PhoneHandoff(device: tylersPhone, stage: .microphone))) }
        OnbDesk { OnbScreens.phone(.finished(PhoneHandoff(device: tylersPhone, stage: .finished, declined: [.notifications]))) }
    }

    try onb("onb-mac-06-try", width: windowPage) {
        Heading(title: "5 · Try it", note: "A practice turn from conch itself: no agent, no cost. The window steps aside for the tour.")
        OnbDesk { OnbScreens.practice() }
    }

    let tourScale: CGFloat = 0.6
    try onb("onb-mac-07-tour", width: tourScreen.width * tourScale * 2 + 24 + 80) {
        Heading(title: "The tour", note: "Five beats on the real surfaces, each a thing to do rather than read: the pill, answering, Ready, the panel, the canvas. The glass is the gallery's stand-in.")
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) { Caption("1 · The pill"); scaled(tourScale, tourScreen) { Tour.pill() } }
                VStack(alignment: .leading, spacing: 8) { Caption("2 · Answer out loud"); scaled(tourScale, tourScreen) { Tour.answer() } }
            }
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) { Caption("3 · Ready"); scaled(tourScale, tourScreen) { Tour.ready() } }
                VStack(alignment: .leading, spacing: 8) { Caption("4 · The panel"); scaled(tourScale, tourScreen) { Tour.panel() } }
            }
            VStack(alignment: .leading, spacing: 8) { Caption("5 · Draw on anything"); scaled(tourScale, tourScreen) { Tour.canvas() } }
        }
    }

    try onb("onb-mac-07b-tour-ready", width: tourScreen.width + 80) {
        Heading(title: "The tour, full size: Ready", note: "The card hangs from the pill it's about, with the one thing to do on its button.")
        Tour.ready()
    }

    try onb("onb-mac-08-done", width: windowPage) {
        Heading(title: "You're set", note: "Setup ends on something to do, not a summary: answer a session that finished meanwhile, start one, or just go. What's set is one line each; the rest lives in Settings › Setup.")
        OnbDesk { OnbScreens.done() }
    }

    try onb("onb-mac-09-welcome-back", width: windowPage) {
        Heading(title: "Welcome back", note: "A Mac that already had conch: the rail ticks what's set, and the page asks only for what's new or off.")
        OnbDesk { OnbScreens.welcomeBack() }
    }

    try renderOnboardingStates()
    try renderOnboardingPhone()
    try renderOnboardingFilms()
}
