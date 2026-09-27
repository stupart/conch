import AVFoundation
import ConchDesign
import Speech
import SwiftUI
import UIKit

// The iPhone's own setup, after a code is scanned or typed: Connecting (names the Mac, with Cancel), Connected, the
// microphone asked in context, a short tour, and back to the Mac. The screens are ConchDesign's (OnboardingPhone.swift);
// this hosts them, keeps where the phone is, and tells the Mac each stage as it's reached (`setup-stage`), which is how
// the Mac's setup window follows along and moves on by itself at the end. There is no notifications screen: the app
// sends no notifications yet (decision 11).

/// The phone's setup, kept where a relaunch finds it, and the Mac kept up to date with it.
@MainActor
final class PhoneSetupStore: ObservableObject {
    static let key = "conch.phone-setup.v1"

    /// Nil on a phone paired before setup existed: it goes on straight to the ledger, as it always did.
    @Published private(set) var flow: PhoneSetupFlow?
    /// Nil in a DEBUG preview: nothing is kept.
    private let defaults: UserDefaults?
    /// The reports being sent, one at a time; asked for again while it runs, it runs again after (`sync`).
    private var draining: Task<Void, Never>?
    private var drainAgain = false
    private var linking = false

    init(defaults: UserDefaults? = .standard, flow: PhoneSetupFlow? = nil) {
        #if DEBUG
        // `-conchSetupBegin <screen>`: a setup begun at that screen, kept nowhere, for driving the real flow against
        // a test daemon from a simulator that can't tap (with CONCH_PAIR_HOST / CONCH_PAIR_TOKEN).
        if flow == nil, let begin = UserDefaults.standard.string(forKey: "conchSetupBegin"), let screen = PhoneSetupScreen(rawValue: begin) {
            self.defaults = nil
            self.flow = PhoneSetupFlow(screen: screen)
            return
        }
        #endif
        self.defaults = defaults
        if let flow {
            self.flow = flow
        } else if let data = defaults?.data(forKey: Self.key) {
            self.flow = try? JSONDecoder().decode(PhoneSetupFlow.self, from: data)
        }
    }

    /// Setup shows instead of the ledger: a pairing started it and "Open conch" hasn't ended it.
    var showing: Bool { flow?.showing ?? false }

    /// This phone's name as the Mac shows it, and nothing more: on iOS 16 and later it is "iPhone" on every phone.
    static var device: String { UIDevice.current.name }

    /// Where this install's id is kept: UserDefaults, which a reinstall empties, so a reinstall is a new install.
    static let installKey = "conch.install-id.v1"

    /// This install of the app, which the Mac keeps this phone's setup by (a second phone, or this one reinstalled,
    /// starts its own): a random id, made once and kept. A DEBUG preview keeps nothing, so its id lives as long as it does.
    private(set) lazy var install: String = {
        if let kept = defaults?.string(forKey: Self.installKey), !kept.isEmpty { return kept }
        let made = UUID().uuidString
        defaults?.set(made, forKey: Self.installKey)
        return made
    }()

    // MARK: Moving through

    /// A code was scanned or typed (`PairingView.onPaired`).
    func paired() { update { $0.paired() } }

    /// Cancel on Connecting, or unpairing part way: an unfinished setup starts again with the next pairing. A finished
    /// one is kept, so the next Mac is only told it's done.
    func forget() {
        guard let flow, !flow.finished else { return }
        self.flow = nil
        defaults?.removeObject(forKey: Self.key)
    }

    func next() { update { $0.next() } }
    func skipTour() { update { $0.skipTour() } }
    func showTourPage(_ page: Int) { update { $0.tourPage = max(0, min(PhoneSetupFlow.tourPages - 1, page)) } }
    func answeredMicrophone(microphone: Bool, speech: Bool) { update { $0.answeredMicrophone(microphone: microphone, speech: speech) } }

    private func update(_ change: (inout PhoneSetupFlow) -> Void) {
        var next = flow ?? PhoneSetupFlow()
        change(&next)
        guard next != flow else { return }
        flow = next
        if let data = try? JSONEncoder().encode(next) { defaults?.set(data, forKey: Self.key) }
    }

    // MARK: Telling the Mac

    /// The link to the Mac is up. On Connecting the Mac is told first, so Connected already carries its name. Past it, the
    /// Mac is told again where this phone is: after a restart, or having last heard from another install, it follows this
    /// one rather than deciding this phone has nothing to report. Then whatever it hasn't heard.
    func linkUp(_ bridge: BridgeClient) async {
        guard !linking else { return }
        linking = true
        defer { linking = false }
        if flow?.screen == .connecting {
            apply(await bridge.reportSetup(stage: .paired, declined: [], device: Self.device, install: install, within: .seconds(4)), for: .paired, bridge: bridge)
            update { $0.linked() }
        } else if let flow, let stage = flow.reportable {
            apply(await bridge.reportSetup(stage: stage, declined: flow.declined, device: Self.device, install: install), for: stage, bridge: bridge)
        }
        await sync(bridge)
    }

    /// Tell the Mac whatever it hasn't heard, one report at a time; a stage reached meanwhile goes next. Asked while a run
    /// is under way, it runs again once that one ends, so a report asked for then (a new screen, the link back) is never
    /// dropped. A report that isn't heard while the link is still up is sent again, a little later each time; one that
    /// isn't heard because the link went waits for it to come back (`linkUp`, or the app's own reconnect).
    func sync(_ bridge: BridgeClient) async {
        guard draining == nil else {
            drainAgain = true
            return
        }
        // Its own task, not the caller's: a screen's `.task` is cancelled when the screen changes, and a run cut short
        // there would drop what it was sending.
        draining = Task { [weak self] in await self?.drain(bridge) }
    }

    private func drain(_ bridge: BridgeClient) async {
        defer { draining = nil }
        var pause: Duration = .seconds(1)
        repeat {
            drainAgain = false
            while bridge.isConnected, let flow, let stage = flow.unreported {
                let outcome = await bridge.reportSetup(stage: stage, declined: flow.declined, device: Self.device, install: install)
                if outcome == .unheard {
                    try? await Task.sleep(for: pause)
                    pause = min(pause * 2, .seconds(30))
                    continue
                }
                pause = .seconds(1)
                apply(outcome, for: stage, bridge: bridge)
            }
        } while drainAgain
    }

    private func apply(_ outcome: BridgeClient.SetupReportOutcome, for stage: PhoneSetupStage, bridge: BridgeClient) {
        switch outcome {
        case let .answered(_, mac):
            update { $0.acknowledge(stage, mac: mac) }
        case .notFollowed:
            // A Mac from before setup: nothing there follows along, so there is nothing to catch up.
            update { $0.acknowledge(stage, mac: nil) }
        case let .refused(reason):
            // Sending it again won't change the answer; the Mac's log gets why.
            update { $0.acknowledge(stage, mac: nil) }
            Task { await bridge.reportAppError(operation: "setup-stage", message: "\(stage.rawValue) refused: \(reason)") }
        case .unheard:
            break
        }
    }
}

/// Setup's screens, one at a time, on ConchMotion's swap: the old one leaves soft and a touch large, the new one arrives
/// from a touch small. Reduce Motion keeps the timing and only fades.
enum SetupSwap {
    static func transition(reduceMotion: Bool) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .modifier(
                active: SwapLook(scale: ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0),
                identity: SwapLook(scale: 1, blur: 0, opacity: 1)
            ),
            removal: .modifier(
                active: SwapLook(scale: 1 / ConchMotion.swapScale, blur: ConchMotion.swapBlur, opacity: 0),
                identity: SwapLook(scale: 1, blur: 0, opacity: 1)
            )
        )
    }

    struct SwapLook: ViewModifier {
        let scale: CGFloat
        let blur: CGFloat
        let opacity: Double

        func body(content: Content) -> some View {
            content.scaleEffect(scale).blur(radius: blur).opacity(opacity)
        }
    }
}

struct SetupFlow: View {
    @ObservedObject var bridge: BridgeClient
    @ObservedObject var store: PhoneSetupStore
    /// Cancel, or "Scan a different Mac": the pairing goes, and the welcome comes back.
    let onCancel: () -> Void
    /// A new code, scanned or typed from the expired-code screen: it replaces the pairing the Mac refused.
    let onRepaired: (BridgeClient.Pairing) -> Void

    @State private var trouble: PhonePairingProblem.Problem?
    /// The expired-code screen's "Scan again": the scanner, for the fresh code the Mac is showing.
    @State private var rescanning = false
    /// Its "Enter a code instead": the typed code, with this pairing left as it is until a new one works.
    @State private var enteringCode = false
    /// The link has been down a while, somewhere past Connecting.
    @State private var reconnecting = false
    @State private var attempt = 0
    @State private var asking = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How long Connecting waits before saying what's wrong. The link keeps trying underneath, and moves on by itself.
    static let patience: Duration = .seconds(15)
    /// A drop shorter than this is a blip, not news.
    static let quietBeforeSaying: Duration = .seconds(3)

    init(bridge: BridgeClient, store: PhoneSetupStore, trouble: PhonePairingProblem.Problem? = nil,
         onCancel: @escaping () -> Void, onRepaired: @escaping (BridgeClient.Pairing) -> Void) {
        self.bridge = bridge
        self.store = store
        self.onCancel = onCancel
        self.onRepaired = onRepaired
        _trouble = State(initialValue: trouble)
    }

    private var flow: PhoneSetupFlow { store.flow ?? PhoneSetupFlow() }

    /// Connecting and Connected are one screen changing its words; every other screen swaps.
    private var pageKey: String {
        if trouble != nil { return "trouble" }
        return flow.screen == .connected ? PhoneSetupScreen.connecting.rawValue : flow.screen.rawValue
    }

    var body: some View {
        ZStack {
            page
                .id(pageKey)
                .transition(SetupSwap.transition(reduceMotion: reduceMotion))
        }
        .animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: pageKey)
        .overlay(alignment: .top) {
            if reconnecting, trouble == nil, flow.screen != .connecting {
                ReconnectingNote(mac: flow.macName)
                    .padding(.top, 6)
                    .transition(.opacity)
            }
        }
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: reconnecting)
        .background(Palette.bg.ignoresSafeArea())
        .task(id: bridge.isConnected) {
            if bridge.isConnected {
                reconnecting = false
                trouble = nil
                await store.linkUp(bridge)
            } else {
                try? await Task.sleep(for: Self.quietBeforeSaying)
                if !Task.isCancelled { reconnecting = true }
            }
        }
        // Each screen tells the Mac as it's reached.
        .task(id: flow.screen) { await store.sync(bridge) }
        .task(id: attempt) { await watchConnecting() }
        .onChange(of: bridge.pairingRejected) { _, rejected in
            if rejected, flow.screen == .connecting { trouble = .expired }
        }
        .fullScreenCover(isPresented: $rescanning) {
            SetupScanner(
                onCode: rescanned,
                onEnterCode: {
                    rescanning = false
                    enteringCode = true
                },
                onClose: { rescanning = false }
            )
        }
        .fullScreenCover(isPresented: $enteringCode) {
            PairingView(startingAt: .code, onBack: { enteringCode = false }) { newPairing in
                enteringCode = false
                repaired(newPairing)
            }
        }
    }

    /// A code scanned from the expired-code screen: only one that decodes reaches here (`SetupScanner`), and it pairs.
    private func rescanned(_ scanned: String) {
        guard let relay = try? RelayPairingPayload.decodePairingCode(scanned) else { return }
        rescanning = false
        repaired(.relay(relay))
    }

    /// The new pairing replaces the refused one, and Connecting starts over on it, with its own patience.
    private func repaired(_ pairing: BridgeClient.Pairing) {
        trouble = nil
        attempt += 1
        onRepaired(pairing)
    }

    @ViewBuilder
    private var page: some View {
        if let trouble {
            switch trouble {
            case .expired:
                // The code the Mac refused won't work again: "Scan again" scans the fresh one it's showing, and "Enter a
                // code instead" types one, leaving this pairing until a new one works. Neither retries the refused one.
                PhonePairingProblem(trouble, onPrimary: { rescanning = true }, onSecondary: { enteringCode = true })
            case .macNotAnswering, .relayUnreachable:
                PhonePairingProblem(trouble, onPrimary: retry, onSecondary: onCancel)
            }
        } else {
            switch flow.screen {
            case .connecting, .connected:
                PhoneConnecting(
                    mac: flow.macName,
                    connected: flow.screen == .connected,
                    onContinue: { store.next() },
                    onCancel: onCancel
                )
            case .microphone:
                PhonePermissionAsk(.microphone, onAllow: askMicrophone)
                    .disabled(asking)
            case .tour:
                TabView(selection: Binding(get: { flow.tourPage }, set: { store.showTourPage($0) })) {
                    ForEach(0..<PhoneSetupFlow.tourPages, id: \.self) { index in
                        PhoneTourPage(page: index, onNext: { store.next() }, onSkip: { store.skipTour() })
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: flow.tourPage)
            case .done:
                PhoneSetupDone(mac: flow.macNameStartingASentence, declined: flow.declinedSentences, onDone: { store.next() })
            }
        }
    }

    /// One Continue, then iOS's own alerts: the microphone, then speech recognition (Talk turns speech into text on the
    /// phone). A no to either is reported and setup carries on; a no already given answers at once, with no alert.
    private func askMicrophone() {
        guard !asking else { return }
        asking = true
        Task { @MainActor in
            let microphone = await AVAudioApplication.requestRecordPermission()
            let speech = microphone ? await Self.speechRecognitionAllowed() : false
            asking = false
            store.answeredMicrophone(microphone: microphone, speech: speech)
        }
    }

    private static func speechRecognitionAllowed() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status == .authorized) }
        }
    }

    // MARK: When it doesn't go to plan

    private func retry() {
        trouble = nil
        bridge.reconnectNow()
        attempt += 1
    }

    /// Connecting for longer than `patience`: say what's wrong, and keep trying underneath.
    private func watchConnecting() async {
        guard flow.screen == .connecting, trouble == nil else { return }
        try? await Task.sleep(for: Self.patience)
        guard !Task.isCancelled, flow.screen == .connecting, !bridge.isConnected, trouble == nil else { return }
        let diagnosis = await diagnose()
        if flow.screen == .connecting, !bridge.isConnected { trouble = diagnosis }
    }

    /// The Mac, or the way to it: a relay that doesn't answer this phone at all is this phone's connection (or the
    /// relay), and no amount of opening conch on the Mac fixes that.
    private func diagnose() async -> PhonePairingProblem.Problem {
        if bridge.pairingRejected { return .expired }
        if let relay = bridge.relayEndpoint, !(await Self.answers(relay)) {
            return .relayUnreachable(relay.host ?? relay.absoluteString)
        }
        return .macNotAnswering(flow.macNameStartingASentence)
    }

    /// Whether the relay's host answers at all: its root, over HTTPS, with nothing of the pairing in the request.
    private static func answers(_ endpoint: URL) async -> Bool {
        var components = URLComponents()
        components.scheme = "https"
        components.host = endpoint.host
        components.port = endpoint.port
        components.path = "/"
        guard let url = components.url else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 6
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return (try? await URLSession.shared.data(for: request)) != nil
    }
}

/// Past Connecting, a dropped link doesn't stop setup: it carries on here, and catches the Mac up when it's back.
struct ReconnectingNote: View {
    let mac: String

    var body: some View {
        HStack(spacing: 8) {
            OnboardingSpinner(size: 12)
            Text("Reconnecting to \(mac)…")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.textDim)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 34)
        .background(Capsule().fill(Palette.raised))
        .overlay(Capsule().strokeBorder(Palette.divider, lineWidth: 1))
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Reconnecting to \(mac)")
    }
}

#if DEBUG
/// `-conchSetupScreen <name>`: one setup screen, drawn by the real views with nothing paired, for the headless
/// simulator screenshots. `-conchSetupMac <name>` is the name the Mac would give. Nothing is kept.
struct SetupPreview: View {
    let name: String
    let mac: String?
    let fixture: URL?

    var body: some View {
        switch name {
        case "welcome": PairingView { _ in }
        case "code": PairingView(startingAt: .code) { _ in }
        case "scanner": PhoneScanner(onClose: {})
        case "scanner-denied": PhoneScanner(denied: true, onClose: {})
        case "scanner-unreadable": PhoneScanner(message: PhoneScanner.unreadableCode, onClose: {})
        case "getmac": GetMacSheet()
        default: flowScreen
        }
    }

    @ViewBuilder
    private var flowScreen: some View {
        let parts = name.split(separator: "-").map(String.init)
        let screen = PhoneSetupScreen(rawValue: parts.first == "tour" ? "tour" : parts.first ?? "") ?? .connecting
        let page = parts.first == "tour" ? Int(parts.dropFirst().first ?? "0") ?? 0 : 0
        let declined: Set<PhoneSetupStage> = parts.contains("declined") ? [.microphone] : []
        let trouble: PhonePairingProblem.Problem? = switch name {
        case "not-answering": .macNotAnswering(mac ?? "Your Mac")
        case "relay-unreachable": .relayUnreachable("relay.example.com")
        case "expired": .expired
        default: nil
        }
        // Connected screens ride a Mac that answers (the fixture); Connecting, a reconnect and trouble ride one that doesn't.
        let silent = screen == .connecting || trouble != nil || parts.contains("reconnecting")
        let transport: BridgeTransport = silent || fixture == nil ? SilentTransport() : FixtureTransport(url: fixture!)
        SetupPreviewHost(
            bridge: BridgeClient(pairing: .lan(host: "192.168.1.20:8674", token: ""), transport: transport),
            store: PhoneSetupStore(defaults: nil, flow: PhoneSetupFlow(
                screen: screen, tourPage: page, declined: declined, mac: mac,
                acknowledged: screen.reports
            )),
            trouble: trouble
        )
    }
}

private struct SetupPreviewHost: View {
    @StateObject var bridge: BridgeClient
    @StateObject var store: PhoneSetupStore
    let trouble: PhonePairingProblem.Problem?

    var body: some View {
        SetupFlow(bridge: bridge, store: store, trouble: trouble, onCancel: {}, onRepaired: { _ in })
    }
}
#endif
