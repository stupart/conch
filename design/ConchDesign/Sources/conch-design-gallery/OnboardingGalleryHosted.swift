import ConchDesign
import SwiftUI

// Setup as the Mac app hosts it (OnboardingController.swift): the pages with the words and rows the app gives them,
// where they differ from the design sheets. The rail without Try it until the practice turn exists; a row waiting to hear
// from its agent; the in-app pairing code; Welcome back asking only the three setup permissions; the tray's own words.

/// The rail the app shows today: no Try it (`OnboardingReadiness.practiceAvailable` is false).
let hostedRail = OnboardingReadiness.fresh.rail

@MainActor
struct OnbHosted {
    static func agents() -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.agents), steps: hostedRail, downloads: [
                OnboardingReports.speechRecognition(SpeechEngineReport(state: "downloading", progress: .init(bytes: 212e6, total: 574e6)), secondsLeft: 70),
                OnboardingReports.naturalVoices(NaturalVoicesReport(state: "setting-up", step: 1, steps: 4))!,
            ]) {
                OnboardingAgentsStep(agents: [
                    OnboardingReports.agent(AgentSetupReport(agent: "claude", found: true, version: "2.1.280", source: "Homebrew",
                                                             hooksWired: true, pluginInstalled: true))!,
                    OnboardingReports.agent(AgentSetupReport(agent: "codex", found: true, version: "0.156.0", source: "Homebrew",
                                                             hooksWired: true, pluginInstalled: true, signedIn: true))!,
                ])
            }
        }
    }

    static func permissions() -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.permissions, done: [.agents]), steps: hostedRail, downloads: dlMid, details: [.permissions: "2 of 3"]) {
                OnboardingPermissionsStep(
                    statuses: [.microphone: .granted, .accessibility: .granted, .automation: .notAsked, .screenRecording: .granted],
                    deferred: [ConchPermission.screenRecording.rawValue: .granted, OnboardingDeferredAsk.notifications.id: .notAsked]
                )
            }
        }
    }

    static func voice(_ mic: MicCheck, ring: VoiceRing = .settingUp("Step 3 of 4")) -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.voice, done: [.agents, .permissions]), steps: hostedRail, downloads: dlLate) {
                OnboardingVoiceStep(ring: ring, mic: mic, devices: ["MacBook Pro Microphone", "Studio Display Microphone"])
            }
        }
    }

    static func phone(relay: Bool) -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.phone, done: [.agents, .permissions, .voice]), steps: hostedRail, downloads: dlDone) {
                OnboardingPhoneStep(state: .waiting(relay: relay), qr: onbQR, kind: .inApp, lanCode: "482 193", lanHost: relay ? nil : "192.168.1.20:8674")
            }
        }
    }

    static func welcomeBack() -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: OnboardingProgress.welcomingBack(missing: [.permissions, .phone], readiness: OnboardingReadiness(
                agentsFound: 2, agentsConnected: 1, microphone: true, permissionsMissing: 1, engineReady: true)),
                             steps: hostedRail, downloads: dlDone, details: [.permissions: "1 off", .phone: "New"]) {
                OnboardingWelcomeBack(count: 2) {
                    ConchPermissionRow(permission: .accessibility, status: .denied, onAction: { _ in })
                        .padding(.horizontal, ConchSpace.x4)
                        .padding(.vertical, 12)
                    OnboardingDivider(leading: 54)
                    OnboardingActionRow.phone()
                }
            }
        }
    }

    static func done() -> some View {
        OnbMacWindow {
            OnboardingWindow(progress: progress(.done, done: [.agents, .voice, .phone], later: [.permissions]), steps: hostedRail, downloads: dlDone) {
                OnboardingDoneStep(
                    summary: [
                        OnboardingSummaryLine(step: .agents, detail: "Claude Code and Codex connected", status: "", done: true),
                        OnboardingSummaryLine(step: .voice, detail: "conch heard you", status: "", done: true),
                        OnboardingSummaryLine(step: .phone, detail: "\(tylersPhone) paired", status: "", done: true),
                        OnboardingSummaryLine(step: .permissions, detail: "Automation later", status: "", done: false),
                    ],
                    actions: [
                        OnboardingFirstAction(id: "start", symbol: "plus", title: "Start a session",
                                              detail: "Claude Code or Codex, in a folder you pick. It opens in Terminal."),
                        OnboardingFirstAction(id: "wait", symbol: "cup.and.saucer", title: "Get on with your day",
                                              detail: "conch calls you when an agent has something."),
                    ],
                    openAtLogin: false,
                    loginNote: "Move conch to your Applications folder, then turn this on."
                )
            }
        }
    }
}

/// The tray as the rail's foot shows it in the app: with a Retry wherever one helps.
func hostedTray(_ caption: String, _ items: [OnboardingDownload]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Caption(caption)
        DownloadsTray(downloads: items, onRetry: { _ in })
            .padding(10)
            .frame(width: OnboardingWindowMetrics.railWidth, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ConchColor.fill))
    }
}

@MainActor
func renderOnboardingHosted() throws {
    let windowPage = OnboardingWindowMetrics.size.width + 52 * 2 + 80
    let half = 880 * 0.62 * 2 + 24 + 80
    func small<V: View>(_ caption: String, @ViewBuilder _ view: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Caption(caption)
            OnbDesk(padding: 0) { view() }
                .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
        }
    }

    try onb("onb-hosted-agents", width: windowPage) {
        Heading(title: "Hosted · Agents", note: "As the app shows it: wired is not green. A row turns Connected on the agent's first hook event. The rail has no Try it until the practice turn exists.")
        OnbDesk { OnbHosted.agents() }
    }
    try onb("onb-hosted-permissions", width: windowPage) {
        Heading(title: "Hosted · Permissions", note: "The three setup asks, as Settings' rows. A deferred ask already allowed says so; the other offers Allow now.")
        OnbDesk { OnbHosted.permissions() }
    }
    try onb("onb-hosted-voice", width: half) {
        Heading(title: "Hosted · Voice", note: "The voices say their build step from the daemon's numbers; a check that can't run says why in the card.")
        HStack(alignment: .top, spacing: 24) {
            small("Listening, voices on step 3 of 4") { OnbHosted.voice(MicCheck(device: "MacBook Pro Microphone", state: .listening, levels: micLevels)) }
            small("The check couldn't run") {
                OnbHosted.voice(MicCheck(device: "MacBook Pro Microphone", state: .problem("conch is still speaking. It checks the microphone once it's done."), levels: micQuiet), ring: .ready(playing: 2))
            }
        }
    }
    try onb("onb-hosted-phone", width: half) {
        Heading(title: "Hosted · iPhone", note: "Today's in-app code (conch-relay-v1:), so the steps say to scan from conch, not the Camera. Without a relay: the host and the code to type.")
        HStack(alignment: .top, spacing: 24) {
            small("With a relay") { OnbHosted.phone(relay: true) }
            small("This Wi-Fi only") { OnbHosted.phone(relay: false) }
        }
    }
    try onb("onb-hosted-back", width: half) {
        Heading(title: "Hosted · Welcome back and You're set", note: "Welcome back asks only the setup permissions that are off, and the iPhone when none is set up. You're set with the login switch's own note when it can't turn on.")
        HStack(alignment: .top, spacing: 24) {
            small("Welcome back") { OnbHosted.welcomeBack() }
            small("You're set, conch outside Applications") { OnbHosted.done() }
        }
    }
    try onb("onb-hosted-downloads", width: (OnboardingWindowMetrics.railWidth + 24) * 4 + 80) {
        Heading(title: "Hosted · Downloads", note: "From the published speech engine and voices: offline and no room said as such, a retry that happens by itself says when, Retry only where it helps.")
        HStack(alignment: .top, spacing: 24) {
            hostedTray("Offline, where it stopped", [
                OnboardingReports.speechRecognition(SpeechEngineReport(state: "downloading", progress: .init(bytes: 212e6, total: 574e6), problem: .init(kind: "offline"), retryAt: 1)),
                OnboardingReports.naturalVoices(NaturalVoicesReport(state: "setting-up", step: 3, steps: 4))!,
            ])
            hostedTray("Stopped, trying again by itself", [
                OnboardingReports.speechRecognition(SpeechEngineReport(state: "downloading", progress: .init(bytes: 212e6, total: 574e6), retryAt: Date().timeIntervalSince1970 * 1000 + 55_000)),
                OnboardingReports.naturalVoices(NaturalVoicesReport(state: "setting-up", stage: "prefetch"))!,
            ])
            hostedTray("No room for the voices", [
                OnboardingReports.speechRecognition(SpeechEngineReport(state: "ready")),
                OnboardingReports.naturalVoices(NaturalVoicesReport(state: "off", reason: "setup failed", space: .init(needs: 1.7e9, free: 9e8)))!,
            ])
            hostedTray("Gave up: Retry", [
                OnboardingReports.speechRecognition(SpeechEngineReport(state: "off", reason: "download failed")),
                OnboardingReports.naturalVoices(NaturalVoicesReport(state: "ready"))!,
            ])
        }
    }
}
