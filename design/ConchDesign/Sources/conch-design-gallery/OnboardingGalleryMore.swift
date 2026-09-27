import ConchDesign
import SwiftUI

// Setup's other pages: every state that isn't the happy one, the iPhone's screens, and the transitions frame by frame.

/// A caption over a card of one row, for the state sheets.
func stateCard<Row: View>(_ caption: String, width: CGFloat = 556, @ViewBuilder row: () -> Row) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Caption(caption)
        OnboardingCard { row() }.frame(width: width)
    }
}

/// A rail-coloured panel holding the downloads, the way the rail's foot shows them.
func trayCard(_ caption: String, _ items: [OnboardingDownload]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Caption(caption)
        DownloadsTray(downloads: items)
            .padding(10)
            .frame(width: OnboardingWindowMetrics.railWidth, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(ConchColor.fill))
    }
}

/// The menu bar's menu with setup still open: the reminder at the top, then the menu as it always is.
struct SetupMenuPicture: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                AppIconView(size: 26)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Finish setting up conch").font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
                    Text("2 left: Permissions, iPhone").font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(ConchColor.textTertiary)
            }
            .padding(.horizontal, 10)
            .frame(height: 46)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(ConchColor.rowHover))
            .padding(.horizontal, 6)
            .padding(.top, 6)
            Rectangle().fill(ConchColor.hairlineStrong).frame(height: 1).padding(.horizontal, 12).padding(.vertical, 6)
            ForEach([("checkmark", "Talk"), ("", "Quiet")], id: \.1) { tick, title in
                HStack(spacing: 6) {
                    Image(systemName: tick.isEmpty ? "checkmark" : tick).font(.system(size: 11, weight: .semibold)).opacity(tick.isEmpty ? 0 : 1)
                    Text(title).font(.system(size: 13))
                }
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, 14)
                .frame(height: 24)
            }
            Rectangle().fill(ConchColor.hairlineStrong).frame(height: 1).padding(.horizontal, 12).padding(.vertical, 6)
            Text("Open conch").font(.system(size: 13)).foregroundStyle(ConchColor.textPrimary).padding(.horizontal, 32).frame(height: 24)
                .padding(.bottom, 6)
        }
        .frame(width: 280, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(ConchColor.surfaceRaised))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
        .conchElevation(.floating)
    }
}

@MainActor
func renderOnboardingStates() throws {
    try onb("onb-mac-states-agents", width: 556 * 2 + 24 + 80) {
        Heading(title: "Agents: every state", note: "One row per agent, one button per row. Installing runs the agent's own installer with its last line showing; a failure keeps the command to run by hand.")
        let rows: [(String, OnboardingAgent)] = [
            ("Found, not connected", OnboardingAgent(.codex, .found(version: "0.156.0", from: "Homebrew"))),
            ("Connecting: writing the hooks and the plugin", OnboardingAgent(.codex, .connecting(version: "0.156.0", from: "Homebrew"))),
            ("Connected, with sessions that were already open", OnboardingAgent(.claude, .connected(version: "2.1.280", from: "Homebrew"), openSessions: 3)),
            ("Not on this Mac", OnboardingAgent(.codex, .missing)),
            ("Installing, its own installer's last line under it", OnboardingAgent(.codex, .installing(line: "==> Downloading codex-0.156.0-aarch64-apple-darwin.tar.gz  (38.2 MB)"))),
            ("The install failed", OnboardingAgent(.codex, .failed(reason: "The install stopped: Homebrew said the cask is already being installed.", command: "brew install --cask codex"))),
            ("Installed, not signed in yet", OnboardingAgent(.codex, .signIn(version: "0.156.0"))),
            ("Two copies that disagree", OnboardingAgent(.claude, .twoCopies(conch: "2.1.266  /opt/homebrew/Caskroom/claude-code/2.1.266/claude", shell: "2.1.280  ~/.local/bin/claude"))),
        ]
        VStack(alignment: .leading, spacing: 20) {
            ForEach(0..<4, id: \.self) { row in
                HStack(alignment: .top, spacing: 24) {
                    ForEach(0..<2, id: \.self) { column in
                        let item = rows[row * 2 + column]
                        stateCard(item.0) { OnboardingAgentRow(agent: item.1) }
                    }
                }
            }
        }
        Caption("Neither agent on this Mac: the step becomes Get an agent, and one installs while the other waits.")
        OnbDesk {
            OnbMacWindow {
                OnboardingWindow(progress: progress(.agents), downloads: dlEarly) {
                    OnboardingAgentsStep(agents: [OnboardingAgent(.claude, .installing(line: "Downloading Claude Code 2.1.280…  62%")), OnboardingAgent(.codex, .missing)])
                }
            }
        }
    }

    try onb("onb-mac-states-permissions", width: 880 * 0.62 * 2 + 24 + 80) {
        Heading(title: "Permissions: every state", note: "The rows are Settings' own, so each status and its one button read the same in both places: Allow… where macOS hasn't asked, Open Settings where it's a switch by hand or was turned off, Reopen conch where it's on but only reaches a new process.")
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Caption("Nothing asked yet")
                OnbDesk(padding: 0) { OnbScreens.permissions([:].merging(ConchPermission.allCases.map { ($0, .notAsked) }) { a, _ in a }, waitingOn: nil, downloads: dlEarly) }
                    .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
            VStack(alignment: .leading, spacing: 8) {
                Caption("The microphone turned down, and Accessibility on but a reopen away")
                OnbDesk(padding: 0) { OnbScreens.permissions([.microphone: .denied, .accessibility: .needsRelaunch, .automation: .granted, .screenRecording: .notAsked], waitingOn: nil) }
                    .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
        }
        VStack(alignment: .leading, spacing: 8) {
            Caption("All three allowed: no buttons left, Continue")
            OnbDesk(padding: 0) { OnbScreens.permissions([.microphone: .granted, .accessibility: .granted, .automation: .granted, .screenRecording: .notAsked], waitingOn: nil, downloads: dlLate) }
                .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
        }
        Caption("The guide under System Settings' list: waiting, then on. It closes itself a moment after.")
        HStack(alignment: .top, spacing: 24) {
            PermissionGuide(permission: .screenRecording)
            PermissionGuide(permission: .screenRecording, granted: true)
        }
        .padding(.vertical, 20)
    }

    try onb("onb-mac-states-downloads", width: (OnboardingWindowMetrics.railWidth + 24) * 4 + 80) {
        Heading(title: "Downloads: every state", note: "Under the steps the whole way. They never block a step; the one that needs speech recognition (the microphone check) says how far it is.")
        HStack(alignment: .top, spacing: 24) {
            trayCard("Both downloading", dlEarly)
            trayCard("Voices setting up", dlLate)
            trayCard("Failed, retrying by itself", downloads(stt: .failed("The connection dropped at 212 MB. Trying again in a minute; it carries on from there."), voices: .installing("Installing the voices (1.3 GB), step 3 of 4")))
            trayCard("Offline", downloads(stt: .offline(done: 212e6, total: 574e6), voices: .installing("Installing Python, step 1 of 4")))
        }
        HStack(alignment: .top, spacing: 24) {
            trayCard("No room", downloads(stt: .ready, voices: .noSpace(needs: 1.7e9, free: 0.9e9)))
            trayCard("Voices off: an Intel Mac", downloads(stt: .ready, voices: .failed("Natural voices need Apple silicon. conch speaks with the Mac's own voice.")))
            trayCard("Queued behind the first", downloads(stt: .downloading(done: 488e6, total: 574e6, secondsLeft: 20), voices: .queued))
            trayCard("All ready", dlDone)
        }
    }

    try onb("onb-mac-states-voice", width: 556 * 2 + 24 + 80) {
        Heading(title: "Voice: every state", note: "The level always works once the microphone is allowed; only the words wait on speech recognition. Silence is said, with where to look.")
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Caption("Voices still setting up")
                OnbDesk(padding: 0) { OnbScreens.voice(ring: .settingUp("Step 3 of 4"), mic: MicCheck(device: "MacBook Pro Microphone", state: .listening, levels: micLevels), downloads: dlLate) }
                    .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
            VStack(alignment: .leading, spacing: 8) {
                Caption("Speech recognition still downloading: the level moves, the words wait")
                OnbDesk(padding: 0) { OnbScreens.voice(mic: MicCheck(device: "MacBook Pro Microphone", state: .waitingForRecognition(0.74), levels: micLevels), downloads: dlMid) }
                    .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
        }
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Caption("Silent: nothing above the room's noise for five seconds")
                OnbDesk(padding: 0) { OnbScreens.voice(mic: MicCheck(device: "Studio Display Microphone", state: .silent, levels: micQuiet)) }
                    .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
            VStack(alignment: .leading, spacing: 8) {
                Caption("The microphone skipped on the step before: asked for here, where it's needed")
                OnbDesk(padding: 0) { OnbScreens.voice(ring: .unavailable("This Mac speaks with its own voice: natural voices need Apple silicon."), mic: MicCheck(device: "MacBook Pro Microphone", state: .needsPermission, levels: [])) }
                    .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
        }
    }

    try onb("onb-mac-states-phone", width: 880 * 0.62 * 2 + 24 + 80) {
        Heading(title: "iPhone: every state", note: "Connecting, Wi-Fi only (no relay set up), and a code that ran out.")
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Caption("Scanned: connecting")
                OnbDesk(padding: 0) { OnbScreens.phone(.connecting) }.scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
            VStack(alignment: .leading, spacing: 8) {
                Caption("No relay: this Wi-Fi only, with the short code")
                OnbDesk(padding: 0) { OnbScreens.phone(.waiting(relay: false)) }.scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
            }
        }
        VStack(alignment: .leading, spacing: 8) {
            Caption("Couldn't pair")
            OnbDesk(padding: 0) { OnbScreens.phone(.failed("The relay didn't answer for 20 seconds. Check this Mac is online, then make a new code; the old one stops working.")) }
                .scaleEffect(0.62, anchor: .topLeading).frame(width: 880 * 0.62, height: 620 * 0.62, alignment: .topLeading)
        }
    }

    try onb("onb-mac-states-later", width: 620 + 280 + 24 + 80 + 40) {
        Heading(title: "Later, and again", note: "Closing setup part way puts it away: the menu keeps a quiet reminder until it's done, and Settings › Setup holds all of it for good.")
        HStack(alignment: .top, spacing: 40) {
            VStack(alignment: .leading, spacing: 8) {
                Caption("The menu bar menu, with setup put away")
                SetupMenuPicture()
            }
            VStack(alignment: .leading, spacing: 8) {
                Caption("Settings › Setup")
                OnboardingSettingsPane(lines: [
                    OnboardingSummaryLine(step: .agents, detail: "Claude Code 2.1.280 and Codex 0.156.0", status: "Connected", done: true),
                    OnboardingSummaryLine(step: .permissions, detail: "Screen Recording is off", status: "Turn on", done: false),
                    OnboardingSummaryLine(step: .voice, detail: "MacBook Pro Microphone · 8 natural voices", status: "Ready", done: true),
                    OnboardingSummaryLine(step: .phone, detail: "Not paired", status: "Pair", done: false),
                ], downloads: dlDone)
                .clipShape(RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous).strokeBorder(ConchColor.hairline, lineWidth: 1))
            }
        }
    }
}

// MARK: - The iPhone

func phoneRow<Content: View>(_ items: [(String, AnyView)], dark: [Bool] = [], @ViewBuilder extra: () -> Content = { EmptyView() }) -> some View {
    HStack(alignment: .top, spacing: 30) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
            VStack(alignment: .leading, spacing: 12) {
                Caption(item.0)
                OnbPhone(darkScreen: dark.indices.contains(index) && dark[index]) { item.1 }
            }
        }
    }
}

let phoneWidth: CGFloat = 393 + 22 + 30

@MainActor
func renderOnboardingPhone() throws {
    try onb("onb-phone-flow", width: phoneWidth * 6 + 80) {
        Heading(title: "iPhone, from the Mac's code", note: "Paired, then only what the phone needs, each shown before iOS asks, with one button that leads to iOS's own alert (Apple's rule for a screen before a permission): notifications, then the microphone and speech recognition. A three-page tour, then back to the Mac, which has already moved on.")
        phoneRow([
            ("1 · Scanned: connecting", AnyView(PhoneConnecting(mac: tylersMac, connected: false))),
            ("2 · Connected", AnyView(PhoneConnecting(mac: tylersMac, connected: true))),
            ("3 · Notifications, asked in context", AnyView(PhonePermissionAsk(.notifications))),
            ("4 · The microphone", AnyView(PhonePermissionAsk(.microphone))),
            ("5 · The tour, page 1 of 3", AnyView(PhoneTourPage(page: 0))),
            ("6 · Back to the Mac", AnyView(PhoneSetupDone(mac: tylersMac))),
        ])
    }

    try onb("onb-phone-tour", width: phoneWidth * 3 + 80) {
        Heading(title: "The iPhone's tour", note: "Three pages, swiped or tapped: the ledger, a session, and something ready. Skip is always there.")
        phoneRow([
            ("What needs you, first", AnyView(PhoneTourPage(page: 0))),
            ("Tap in, then talk", AnyView(PhoneTourPage(page: 1))),
            ("Green means look", AnyView(PhoneTourPage(page: 2))),
        ])
    }

    try onb("onb-phone-first", width: phoneWidth * 4 + 80) {
        Heading(title: "iPhone first", note: "Installed from the App Store with no Mac yet. conch lives on the Mac, so the way there comes first; once the Mac shows its code, this is the same flow as from the Mac.")
        phoneRow([
            ("1 · Welcome", AnyView(PhoneFirstWelcome())),
            ("2 · No Mac yet: the link to send to it", AnyView(PhoneGetMac())),
            ("3 · The scanner", AnyView(PhoneScanner())),
            ("4 · Then the same flow", AnyView(PhoneConnecting(mac: tylersMac, connected: true))),
        ], dark: [false, false, true, false])
    }

    try onb("onb-phone-states", width: phoneWidth * 5 + 80) {
        Heading(title: "iPhone: when it doesn't go to plan", note: "Each says what happened and the one thing to do. Local network is asked only for a Wi-Fi pairing; the relay never needs it.")
        phoneRow([
            ("Camera off", AnyView(PhoneScanner(denied: true))),
            ("The code ran out", AnyView(PhonePairingProblem(.expired))),
            ("The Mac isn't answering", AnyView(PhonePairingProblem(.macNotAnswering(tylersMac)))),
            ("Wi-Fi pairing only: local network", AnyView(PhonePermissionAsk(.localNetwork))),
            ("Done, notifications turned down", AnyView(PhoneSetupDone(mac: tylersMac, declined: ["Notifications are off."]))),
        ], dark: [true])
    }
}

// MARK: - Transitions

@MainActor
func renderOnboardingFilms() throws {
    let times: [Double] = [0, 0.06, 0.12, 0.2, 0.32, 0.6]
    let windowScale: CGFloat = 0.36
    let windowFrame = CGSize(width: OnboardingWindowMetrics.size.width + 20, height: OnboardingWindowMetrics.size.height + 20)
    let filmWidth = (windowFrame.width * windowScale + 16) * CGFloat(times.count) + 80

    try onb("onb-film-welcome", width: filmWidth) {
        Heading(title: "Welcome → Agents", note: "Welcome lifts off (liftOff: soft and a touch large as it goes); the rail slides in on morph; the step's words arrive 120 ms after, from a little below and out of a 4 pt blur (reveal). Reduce Motion: the same timing, fades only.")
        filmstrip(times, scale: windowScale, size: windowFrame) { t in WelcomeToAgents(t: t).padding(10) }
        Caption("Reduce Motion")
        filmstrip(times, scale: windowScale, size: windowFrame) { t in WelcomeToAgents(t: t, reduceMotion: true).padding(10) }
    }

    let grantTimes: [Double] = [0, 0.03, 0.06, 0.1, 0.16, 0.24, 0.4]
    try onb("onb-film-grant", width: (200 * 1.4 + 16) * CGFloat(grantTimes.count) + 80) {
        Heading(title: "A permission turning on", note: "The moment System Settings says yes, the row's status, close up: Waiting fades on liftOff, the check pops in from half size on pop (small things bounce more), and Allowed slides 4 pt into place. The rail's count ticks with it. Reduce Motion: the same timing, fades only.")
        filmstrip(grantTimes, scale: 1.4, size: CGSize(width: 200, height: 56)) { t in GrantStatus(t: t) }
        Caption("Reduce Motion")
        filmstrip(grantTimes, scale: 1.4, size: CGSize(width: 200, height: 56)) { t in GrantStatus(t: t, reduceMotion: true) }
        Caption("In the row, before and after")
        HStack(spacing: 16) {
            GrantRow(t: 0)
            GrantRow(t: 0.4)
        }
    }

    try onb("onb-film-resume", width: filmWidth) {
        Heading(title: "Back to the Mac", note: "The phone reports its last stage; the Mac holds \"All set on your iPhone\" for a beat (1.2 s), then carries on by itself: the iPhone step's check pops in, the rail's highlight travels to Try it on pop, and the page swaps on swap. Frame 0 is the held beat; the times are from when the swap starts.")
        filmstrip(times, scale: windowScale, size: windowFrame) { t in PhoneToPractice(t: t).padding(10) }
        Caption("Reduce Motion")
        filmstrip(times, scale: windowScale, size: windowFrame) { t in PhoneToPractice(t: t, reduceMotion: true).padding(10) }
    }

    let handoffTimes: [Double] = [0, 0.06, 0.12, 0.2, 0.3, 0.5]
    try onb("onb-film-handoff", width: (556 * 0.5 + 16) * CGFloat(handoffTimes.count) + 80) {
        Heading(title: "The code gives way to the phone", note: "The phone scans: the code leaves soft and a touch large, the phone arrives from a touch small (swap), and its stages drop in one by one (pop, 36 ms apart), each ticking as the phone reports it.")
        filmstrip(handoffTimes, scale: 0.5, size: CGSize(width: 556, height: 216)) { t in CodeToPhone(t: t) }
        Caption("Reduce Motion")
        filmstrip(handoffTimes, scale: 0.5, size: CGSize(width: 556, height: 216)) { t in CodeToPhone(t: t, reduceMotion: true) }
    }
}
