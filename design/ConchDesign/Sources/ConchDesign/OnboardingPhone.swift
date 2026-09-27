import SwiftUI

// The iPhone's setup. Most people arrive from the Mac: its code opens conch on the phone, the two pair, the phone asks for
// what it needs in context, shows a short tour, and hands back to the Mac. Some arrive first (from the App Store); they
// get the way to the Mac before anything else. Every screen reports its stage to the Mac through the pairing
// (`PhoneSetupStage`), which is how the Mac follows along.

/// A phone screen's frame: the art at the top, the words, and the buttons within the thumb's reach.
public struct PhoneSetupPage<Art: View>: View {
    let title: String
    let text: String
    let primary: String?
    let secondary: String?
    let footnote: String?
    let art: Art
    let onPrimary: () -> Void
    let onSecondary: () -> Void

    public init(title: String, text: String, primary: String? = "Continue", secondary: String? = nil, footnote: String? = nil,
                onPrimary: @escaping () -> Void = {}, onSecondary: @escaping () -> Void = {}, @ViewBuilder art: () -> Art) {
        self.title = title
        self.text = text
        self.primary = primary
        self.secondary = secondary
        self.footnote = footnote
        self.art = art()
        self.onPrimary = onPrimary
        self.onSecondary = onSecondary
    }

    public var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 56)
            art
                .frame(maxWidth: .infinity)
                .frame(height: 300)
            VStack(spacing: 10) {
                Text(title)
                    .font(OnboardingType.Phone.title)
                    .tracking(-0.4)
                    .foregroundStyle(ConchColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(text)
                    .font(OnboardingType.Phone.body)
                    .foregroundStyle(ConchColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 32)
            .padding(.top, 28)
            Spacer(minLength: 0)
            VStack(spacing: 6) {
                if let footnote {
                    Text(footnote)
                        .font(OnboardingType.Phone.footnote)
                        .foregroundStyle(ConchColor.textTertiary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 10)
                }
                if let primary { OnboardingButton(primary, size: .phone, action: onPrimary) }
                if let secondary { OnboardingButton(secondary, style: .quiet, size: .phone, action: onSecondary).frame(height: 44) }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, secondary == nil ? 22 : 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchColor.ground)
    }
}

// MARK: - From the Mac

/// The phone and the Mac finding each other: a moment, never a form.
public struct PhoneConnecting: View {
    let mac: String
    let connected: Bool
    let onContinue: () -> Void

    public init(mac: String, connected: Bool, onContinue: @escaping () -> Void = {}) {
        self.mac = mac
        self.connected = connected
        self.onContinue = onContinue
    }

    public var body: some View {
        PhoneSetupPage(
            title: connected ? "Connected to \(mac)" : "Connecting to \(mac)",
            text: connected
                ? "A few things on this iPhone, then you're back on your Mac. About a minute."
                : "Checking the code and setting up an encrypted link. Keep conch open on your Mac.",
            primary: connected ? "Continue" : nil,
            secondary: connected ? nil : "Cancel",
            onPrimary: onContinue
        ) {
            VStack(spacing: 28) {
                PairedDevices(connected: connected)
                if !connected { OnboardingSpinner(size: 20) }
            }
        }
    }
}

/// The Mac and this phone, joined by a line that fills in when the two are paired.
struct PairedDevices: View {
    let connected: Bool

    var body: some View {
        HStack(spacing: 0) {
            DeviceBadge(symbol: "laptopcomputer")
            ZStack {
                HStack(spacing: 7) {
                    ForEach(0..<6, id: \.self) { index in
                        Circle()
                            .fill(connected ? AnyShapeStyle(VoiceOrb.readyFill.color) : AnyShapeStyle(ConchColor.textTertiary.opacity(index < 3 ? 0.9 : 0.35)))
                            .frame(width: 6, height: 6)
                    }
                }
                if connected {
                    OnboardingCheck(size: 30)
                        .padding(4)
                        .background(Circle().fill(ConchColor.ground))
                }
            }
            .frame(width: 96)
            DeviceBadge(symbol: "iphone")
        }
    }
}

struct DeviceBadge: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 40, weight: .light))
            .foregroundStyle(ConchColor.textPrimary)
            .frame(width: 96, height: 96)
            .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(ConchColor.surface).conchElevation(.floating))
            .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }
}

/// Asked in context, one at a time, with what it's for shown rather than described. Local network appears only when the
/// pairing is over Wi-Fi; a relay pairing never needs it.
public struct PhonePermissionAsk: View {
    public enum Kind: Sendable {
        case notifications
        case microphone
        case localNetwork
    }

    let kind: Kind
    let onAllow: () -> Void
    let onLater: () -> Void

    public init(_ kind: Kind, onAllow: @escaping () -> Void = {}, onLater: @escaping () -> Void = {}) {
        self.kind = kind
        self.onAllow = onAllow
        self.onLater = onLater
    }

    public var body: some View {
        switch kind {
        case .notifications:
            PhoneSetupPage(
                title: "Know when work is ready",
                text: "conch taps you when an agent finishes something for you or needs an answer. Nothing else.",
                primary: "Continue",
                footnote: "Next, iOS asks. You can change it any time in Settings.",
                onPrimary: onAllow
            ) { NotificationPreview() }
        case .microphone:
            PhoneSetupPage(
                title: "Answer out loud",
                text: "Tap Talk and say your reply. It becomes text on this iPhone, and only the text goes to your Mac.",
                primary: "Continue",
                footnote: "Next, iOS asks twice: for the microphone, then for speech recognition.",
                onPrimary: onAllow
            ) { TalkPreview() }
        case .localNetwork:
            PhoneSetupPage(
                title: "Find your Mac on this Wi-Fi",
                text: "You paired over Wi-Fi, so conch looks for your Mac on this network. A relay pairing never needs this.",
                primary: "Continue",
                footnote: "Next, iOS asks about your local network.",
                onPrimary: onAllow
            ) { DeviceBadge(symbol: "wifi") }
        }
    }
}

/// A notification as it will arrive, with conch's words in it.
struct NotificationPreview: View {
    var body: some View {
        VStack(spacing: 10) {
            notification(title: "dayloop has something for you", body: "The invite page reads Join, and the tests pass.", time: "now")
            notification(title: "Arch brand page needs you", body: "Allow npm install in arch-website?", time: "2m ago")
                .scaleEffect(0.94)
                .opacity(0.55)
        }
        .padding(.horizontal, 24)
    }

    private func notification(title: String, body: String, time: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AppIconView(size: 38)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(ConchColor.textPrimary).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(time).font(.system(size: 13)).foregroundStyle(ConchColor.textTertiary)
                }
                Text(body).font(.system(size: 15)).foregroundStyle(ConchColor.textPrimary).lineLimit(2)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(ConchColor.surface).conchElevation(.floating))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
    }
}

/// The Talk button mid-sentence: the words as they're heard, and the mic's colour.
struct TalkPreview: View {
    var body: some View {
        VStack(spacing: 26) {
            Text("“Ship it, then do the same for the mobile layout.”")
                .font(.system(size: 22, weight: .medium))
                .tracking(-0.2)
                .foregroundStyle(ConchColor.textPrimary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
            LevelMeter(levels: TalkPreview.levels)
            VoiceOrb(state: .listening, size: 64)
        }
    }

    static let levels: [Double] = [0.2, 0.35, 0.6, 0.9, 0.7, 0.45, 0.8, 1, 0.65, 0.4, 0.55, 0.85, 0.6, 0.3, 0.5, 0.75, 0.4, 0.2, 0.12, 0.3]
}

/// The short tour: three things, one a page, swiped or tapped through.
public struct PhoneTourPage: View {
    let page: Int
    let onNext: () -> Void
    let onSkip: () -> Void

    public init(page: Int, onNext: @escaping () -> Void = {}, onSkip: @escaping () -> Void = {}) {
        self.page = page
        self.onNext = onNext
        self.onSkip = onSkip
    }

    private var words: (title: String, text: String) {
        switch page {
        case 0: ("What needs you, first", "Every session on your Mac, sorted so whatever needs you is on top. One working quietly says nothing.")
        case 1: ("Tap in, then talk", "Open a session to hear its last reply and answer by voice. Your AirPods work too.")
        default: ("Green means look", "When an agent made something, open it right here: a page, a screenshot, a video, a diff.")
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                OnboardingButton("Skip", style: .quiet, size: .phone, action: onSkip).frame(height: 44)
            }
            .padding(.horizontal, 16)
            PhoneSetupPage(title: words.title, text: words.text, primary: page == 2 ? "Done" : "Next", onPrimary: onNext) {
                VStack(spacing: 18) {
                    Group {
                        switch page {
                        case 0: TourLedger()
                        case 1: TourSession()
                        default: TourReview()
                        }
                    }
                    .frame(height: 250)
                    HStack(spacing: 6) {
                        ForEach(0..<3, id: \.self) { index in
                            Capsule()
                                .fill(index == page ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textTertiary.opacity(0.35)))
                                .frame(width: index == page ? 16 : 6, height: 6)
                        }
                    }
                }
            }
        }
        .background(ConchColor.ground)
    }
}

/// The ledger, in miniature.
struct TourLedger: View {
    var body: some View {
        VStack(spacing: 0) {
            row(mark: AnyView(Image(systemName: "exclamationmark.circle.fill").font(.system(size: 17)).foregroundStyle(ConchColor.attention)),
                name: "Arch brand page", what: "Needs an answer")
            OnboardingDivider(leading: 48)
            row(mark: AnyView(Image(systemName: "checkmark.circle.fill").font(.system(size: 17)).foregroundStyle(VoiceOrb.readyFill.color)),
                name: "dayloop", what: "Has work to look at")
            OnboardingDivider(leading: 48)
            row(mark: AnyView(VoiceGlyph(.speaking, size: 16).foregroundStyle(ConchColor.textSecondary)), name: "Docs pass", what: "Reading aloud")
            OnboardingDivider(leading: 48)
            row(mark: AnyView(ActiveMark(pointSize: 9, phase: 0.5)), name: "Parser refactor", what: "")
        }
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(ConchColor.surface).conchElevation(.floating))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
        .padding(.horizontal, 28)
    }

    private func row(mark: AnyView, name: String, what: String) -> some View {
        HStack(spacing: 12) {
            mark.frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.system(size: 16, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                if !what.isEmpty { Text(what).font(.system(size: 14)).foregroundStyle(ConchColor.textSecondary) }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textTertiary)
        }
        .padding(.horizontal, 14)
        .frame(height: 56)
    }
}

/// A session opened: its last reply, and Talk.
struct TourSession: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("dayloop").font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            Text("Changed. The button reads Join, and it still waits for the email check. Tests pass.")
                .font(.system(size: 20, weight: .medium))
                .tracking(-0.2)
                .foregroundStyle(ConchColor.textPrimary)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack {
                Spacer()
                HStack(spacing: 8) {
                    Image(systemName: "mic.fill").font(.system(size: 16, weight: .semibold))
                    Text("Talk").font(.system(size: 17, weight: .semibold))
                }
                .foregroundStyle(ConchColor.onAccent)
                .padding(.horizontal, 26)
                .frame(height: 50)
                .background(Capsule().fill(ConchColor.accent))
                Spacer()
            }
        }
        .padding(20)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(ConchColor.surface).conchElevation(.floating))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
        .padding(.horizontal, 28)
    }
}

/// Something ready: the work itself, full width, with the agent's note.
struct TourReview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                LinearGradient(colors: [Color(red: 0.96, green: 0.82, blue: 0.72), Color(red: 0.76, green: 0.82, blue: 0.96)],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Join the Arch team").font(.system(size: 19, weight: .bold)).foregroundStyle(Color.black.opacity(0.8))
                    RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.78)).frame(width: 110, height: 32)
                        .overlay(Text("Join").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
            }
            .frame(height: 150)
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 17)).foregroundStyle(VoiceOrb.readyFill.color)
                VStack(alignment: .leading, spacing: 1) {
                    Text("dayloop · invite page").font(.system(size: 15, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                    Text("Check the button at phone width").font(.system(size: 13)).foregroundStyle(ConchColor.textSecondary)
                }
            }
            .padding(14)
        }
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(ConchColor.surface))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
        .conchElevation(.floating)
        .padding(.horizontal, 28)
    }
}

/// The hand back: this phone is done, and the Mac carries on.
public struct PhoneSetupDone: View {
    let mac: String
    /// What was turned down on the way, each its own sentence: "Notifications are off."
    let declined: [String]
    let onDone: () -> Void

    public init(mac: String, declined: [String] = [], onDone: @escaping () -> Void = {}) {
        self.mac = mac
        self.declined = declined
        self.onDone = onDone
    }

    public var body: some View {
        PhoneSetupPage(
            title: "You're set. Back to your Mac.",
            text: "\(mac) has picked up where it left off. From now on, anything that needs you shows up here too.",
            primary: "Open conch",
            footnote: declined.isEmpty ? nil : declined.joined(separator: " ") + " Settings › conch has it whenever you want it.",
            onPrimary: onDone
        ) {
            BackToMac()
        }
    }
}

/// The Mac, with setup carrying on in it.
struct BackToMac: View {
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(ConchColor.surface)
                    .frame(width: 220, height: 142)
                    .overlay(
                        HStack(spacing: 0) {
                            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(ConchColor.fill).frame(width: 58).padding(6)
                            VStack(alignment: .leading, spacing: 6) {
                                Capsule().fill(ConchColor.textPrimary.opacity(0.75)).frame(width: 90, height: 8)
                                Capsule().fill(ConchColor.textTertiary.opacity(0.5)).frame(width: 120, height: 5)
                                Capsule().fill(ConchColor.textTertiary.opacity(0.5)).frame(width: 104, height: 5)
                                Spacer()
                                HStack { Spacer(); Capsule().fill(ConchColor.accent).frame(width: 40, height: 12) }
                            }
                            .padding(.vertical, 14)
                            .padding(.trailing, 12)
                        }
                    )
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ConchColor.textTertiary.opacity(0.55), lineWidth: 2.5))
                    .conchElevation(.floating)
                UnevenRoundedRectangle(bottomLeadingRadius: 8, bottomTrailingRadius: 8, style: .continuous)
                    .fill(ConchColor.textTertiary.opacity(0.4))
                    .frame(width: 262, height: 9)
            }
            OnboardingCheck(size: 34)
                .padding(4)
                .background(Circle().fill(ConchColor.ground))
                .offset(x: 14, y: 4)
        }
    }
}

// MARK: - iPhone first

/// Installed from the App Store with no Mac yet: conch lives on the Mac, so the way there comes first.
public struct PhoneFirstWelcome: View {
    let onScan: () -> Void
    let onGetMac: () -> Void

    public init(onScan: @escaping () -> Void = {}, onGetMac: @escaping () -> Void = {}) {
        self.onScan = onScan
        self.onGetMac = onGetMac
    }

    public var body: some View {
        PhoneSetupPage(
            title: "rally your agents.",
            text: "conch runs on your Mac, beside Claude Code and Codex, and brings them here: what they finished, what needs you, and your answer by voice.",
            primary: "Scan the code on my Mac",
            secondary: "I don't have conch on my Mac",
            onPrimary: onScan,
            onSecondary: onGetMac
        ) {
            AppIconView(size: 132, lifted: true)
        }
    }
}

/// The scanner: the camera, a frame to aim with, and a way round it.
public struct PhoneScanner: View {
    let denied: Bool

    public init(denied: Bool = false) { self.denied = denied }

    public var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.13, green: 0.14, blue: 0.16), Color(red: 0.05, green: 0.05, blue: 0.06)], startPoint: .top, endPoint: .bottom)
            if denied {
                VStack(spacing: 14) {
                    Image(systemName: "camera").font(.system(size: 34, weight: .light)).foregroundStyle(.white.opacity(0.85))
                    Text("conch can't use the camera").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                    Text("It's only for reading the code on your Mac. Turn it on in Settings, or type the code instead.")
                        .font(.system(size: 16)).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center)
                        .padding(.horizontal, 36)
                    Text("Open Settings").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color(red: 0.11, green: 0.11, blue: 0.12))
                        .padding(.horizontal, 22).frame(height: 44).background(Capsule().fill(.white)).padding(.top, 6)
                }
            } else {
                VStack(spacing: 0) {
                    Text("Scan the code in conch on your Mac")
                        .font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(.top, 90)
                    Text("It's in Settings › iPhone, and in setup.")
                        .font(.system(size: 15)).foregroundStyle(.white.opacity(0.7))
                        .padding(.top, 6)
                    Spacer()
                    Viewfinder().frame(width: 250, height: 250)
                    Spacer()
                }
            }
            VStack {
                Spacer()
                Text("Enter a code instead").font(.system(size: 17, weight: .medium)).foregroundStyle(.white)
                    .padding(.horizontal, 20).frame(height: 46).background(Capsule().fill(.white.opacity(0.16)))
                    .padding(.bottom, 44)
            }
        }
    }
}

/// Four corners, rounded, to aim the code into.
struct Viewfinder: View {
    var body: some View {
        GeometryReader { proxy in
            let side = proxy.size.width
            let arm: CGFloat = 38
            Path { path in
                for corner in 0..<4 {
                    let left = corner % 2 == 0
                    let top = corner < 2
                    let x = left ? 0 : side
                    let y = top ? 0 : side
                    path.move(to: CGPoint(x: x, y: y + (top ? arm : -arm)))
                    path.addArc(tangent1End: CGPoint(x: x, y: y), tangent2End: CGPoint(x: x + (left ? arm : -arm), y: y), radius: 18)
                    path.addLine(to: CGPoint(x: x + (left ? arm : -arm), y: y))
                }
            }
            .stroke(Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
        }
    }
}

/// No Mac yet: the link, to send to the Mac however is easiest.
public struct PhoneGetMac: View {
    public init() {}

    public var body: some View {
        PhoneSetupPage(
            title: "Get conch for Mac",
            text: "Open this link on your Mac. After setup there, it shows a code; scan it here and you're done.",
            primary: "Share the link",
            secondary: "Copy link",
            footnote: "AirDrop, Messages or Mail all work.",
            onPrimary: {},
            onSecondary: {}
        ) {
            VStack(spacing: 16) {
                AppIconView(size: 84, lifted: true)
                HStack(spacing: 8) {
                    Image(systemName: "link").font(.system(size: 14, weight: .semibold))
                    Text("conch.app/mac").font(.system(size: 17, weight: .semibold))
                }
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, 18)
                .frame(height: 44)
                .background(Capsule().fill(ConchColor.surface).conchElevation(.floating))
                .overlay(Capsule().strokeBorder(ConchColor.hairline, lineWidth: 1))
            }
        }
    }
}

/// Pairing didn't work: what happened, and the one thing to do.
public struct PhonePairingProblem: View {
    public enum Problem: Sendable {
        case expired
        case macNotAnswering(String)
    }

    let problem: Problem

    public init(_ problem: Problem) { self.problem = problem }

    public var body: some View {
        switch problem {
        case .expired:
            PhoneSetupPage(
                title: "That code has run out",
                text: "Your Mac has a fresh one waiting on the same screen. Scan it again.",
                primary: "Scan again",
                secondary: "Enter a code instead"
            ) { DeviceBadge(symbol: "qrcode") }
        case let .macNotAnswering(mac):
            PhoneSetupPage(
                title: "\(mac) isn't answering",
                text: "Is conch open on it? It needs to be running for this iPhone to pair. conch keeps trying.",
                primary: "Try again",
                secondary: "Scan a different Mac"
            ) { DeviceBadge(symbol: "laptopcomputer.trianglebadge.exclamationmark") }
        }
    }
}
