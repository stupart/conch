import AppKit
import Combine
import ConchDesign
import SwiftUI

extension Notification.Name {
    /// The Ready pill was clicked (the control bar's tap): the tip the tour left by it has been used, and goes.
    static let readyPillClicked = Notification.Name("com.conch.mac.ready-pill-clicked")
}

/// The tour, on the real surfaces (conch-design/onboarding/README.md §2 "5 · Try it", §5 Wave C): a card that never takes
/// focus, hanging off the pill, the conversation panel or the canvas's tools, moving on when the person does the thing.
///
/// The rule is ConchDesign's (`TourProgress`); this feeds it what happened and draws what it returns. What happened comes
/// from where it happens, never from a timer standing in for it:
///   1. the practice turn spoken, and
///   2. words reaching it: the daemon's published `practice` (`PracticeReport.tourEvents`);
///   3. the welcome card opened: the same, once the daemon marks it looked at;
///   4. the panel dragged, filled, folded or opened: `FloatingPanels.moves`;
///   5. ⌃⌥⌘P and a mark: `CanvasController.hotKeyPresses` and `marksDrawn`.
/// The card is a non-activating panel that can't become key: the app in front stays in front, and its keys stay there.
/// When the tour closes, one tip stays by the pill until the pill is first used (`PillTip`), then never again.
@MainActor
final class TourCoach: ObservableObject {
    static let shared = TourCoach()
    /// The daemon's practice session (src/practice.ts `PRACTICE_SESSION_ID`).
    static let practiceSessionId = "conch-practice"
    /// Where the tip stands, across launches (`PillTip.State`).
    static let tipKey = "conch.tour.pillTip"
    /// Room round the card for its pointer and its shadow.
    static let margin: CGFloat = 26

    @Published private(set) var progress = TourProgress()
    /// Which way the card points: the rule's, turned round when there's no room on the side it asks for.
    @Published private(set) var pointer: CoachCard.Pointer = .up
    private(set) var running = false

    private weak var store: StateStore?
    private var onClose: ((TourProgress.Outcome) -> Void)?
    private var card: FloatingPanel?
    private var tip: FloatingPanel?
    private var subscriptions: Set<AnyCancellable> = []
    private var tipObserver: NSObjectProtocol?
    private var sawPractice = false
    /// The conversation panel as the tour found it: put back when it closes, since putting the panel out for a beat, or
    /// the welcome card's first open, isn't the person turning it on (`FloatingPanels.putBack`).
    private var panelFound: FloatingPanels.Setting?
    private var settling: Task<Void, Never>?
    /// The card follows what it hangs from on the dock spring: where it is, where it's going, and how fast.
    private var follow: Timer?
    private var origin: CGPoint?
    private var velocity = CGVector.zero

    // MARK: Launch

    /// From the status item, once the panels are up: a tip still waiting from a tour on an earlier launch shows again.
    func install(store: StateStore) {
        self.store = store
        showTipIfPending()
    }

    // MARK: The tour

    /// The practice turn has started (setup's Try it): the tour runs until it's finished, skipped, or its practice goes.
    func start(store: StateStore, onClose: @escaping (TourProgress.Outcome) -> Void) {
        guard !running else { return }
        self.store = store
        self.onClose = onClose
        running = true
        progress = TourProgress()
        sawPractice = false
        panelFound = FloatingPanels.Setting.current
        hideTip()
        subscriptions.removeAll()
        store.$state
            .receive(on: RunLoop.main)
            .sink { [weak self] state in MainActor.assumeIsolated { self?.stateChanged(state) } }
            .store(in: &subscriptions)
        if let panels = FloatingPanels.installed {
            panels.$moves.dropFirst()
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.apply(.panelMoved) } }
                .store(in: &subscriptions)
        }
        CanvasController.shared.$hotKeyPresses.dropFirst()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.apply(.hotKey) } }
            .store(in: &subscriptions)
        CanvasController.shared.$marksDrawn.dropFirst()
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.apply(.stroke) } }
            .store(in: &subscriptions)
        showCard()
        announce()
    }

    /// The practice as the daemon publishes it, as the tour's events. Gone after it was seen: the practice ended.
    private func stateChanged(_ state: PublishedState?) {
        guard running else { return }
        if let practice = state?.practice {
            sawPractice = true
            for event in practice.tourEvents { apply(event) }
        } else if sawPractice, state != nil {
            apply(.practiceEnded)
        }
    }

    /// One event through the rule, and what it changed drawn.
    func apply(_ event: TourEvent) {
        guard running else { return }
        let before = progress
        let next = before.applying(event)
        guard next != before else { return }
        progress = next
        if let outcome = next.outcome { return close(outcome) }
        if next.showingSent, !before.showingSent {
            // Answer out loud holds what was sent a moment, then moves on by itself.
            settling?.cancel()
            settling = Task { [weak self] in
                try? await Task.sleep(for: .seconds(TourProgress.shownFor))
                guard !Task.isCancelled else { return }
                self?.apply(.settle)
            }
        }
        if next.beat != before.beat {
            beatBegan()
            announce()
        }
        fitCard()
    }

    /// A new beat: what it points at is put out for it, when it isn't out.
    private func beatBegan() {
        guard progress.beat == .panel, let panels = FloatingPanels.installed, !panels.conversationWindow.isVisible else { return }
        // The panel's beat needs a panel to point at; putting it out isn't the person's move, so it doesn't count.
        panels.bringOut()
    }

    /// The card's button: the beat's own thing where there is one, and the fallback either way.
    func primary() {
        guard let beat = progress.beat else { return }
        switch beat {
        case .ready:
            // Open it: the welcome card, opened as the pill opens it (the menu's per-session open, so it's this one).
            if let store, let panels = FloatingPanels.installed {
                panels.queue.open(session: Self.practiceSessionId, store: store, panels: panels)
            }
        case .answer:
            // Still listening: the mic closes, so the card is filed and Ready has something to open.
            if store?.state?.practice?.listening == true { store?.send(.stop()) }
        default:
            break
        }
        apply(.next)
    }

    /// The card's "Listen again", after a mic window that heard nothing.
    func retry() {
        Task { _ = await SetupDaemon.ask(SetupDaemonRequest(kind: "practice-listen"), timeout: 5, expecting: "practice-listening") }
    }

    func skip() {
        apply(.skip)
    }

    private func close(_ outcome: TourProgress.Outcome) {
        guard running else { return }
        running = false
        settling?.cancel()
        settling = nil
        subscriptions.removeAll()
        follow?.invalidate()
        follow = nil
        card?.orderOut(nil)
        card = nil
        origin = nil
        if let found = panelFound { FloatingPanels.installed?.putBack(found) }
        panelFound = nil
        let done = onClose
        onClose = nil
        done?(outcome)
        // The one tip, unless the tour ended under the person: then it wasn't theirs to close.
        if outcome != .ended {
            tipState = PillTip.after(tipState, tourClosed: true)
            showTipIfPending()
        }
    }

    /// VoiceOver hears each beat as it arrives: the card itself never takes focus to be found.
    private func announce() {
        guard let card = progress.card else { return }
        NSAccessibility.post(element: self.card ?? NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: card.announcement, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    // MARK: The card's panel

    private func showCard() {
        let panel = card ?? makePanel(accessibilityLabel: "Tour")
        card = panel
        panel.contentView = FirstClickHostingView(rootView: TourCardHost(coach: self))
        fitCard()
        place(immediately: true)
        panel.orderFrontRegardless()
        follow?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.place(immediately: false) }
        }
        RunLoop.main.add(timer, forMode: .common)
        follow = timer
    }

    /// The panel at the card's size: it changes height from beat to beat.
    private func fitCard() {
        guard let panel = card, let view = panel.contentView else { return }
        let size = view.fittingSize
        guard size.width > 0, size.height > 0, panel.frame.size != size else { return }
        panel.setContentSize(size)
    }

    /// Where the card goes for what it hangs from, and the spring there; at once under Reduce Motion.
    private func place(immediately: Bool) {
        guard let panel = card, let card = progress.card else { return }
        let size = panel.frame.size
        let (target, side) = Self.spot(for: card.anchor, pointer: card.pointer, size: size)
        if side != pointer { pointer = side }
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        guard var at = origin, !immediately, !reduce else {
            origin = target
            velocity = .zero
            panel.setFrameOrigin(target)
            return
        }
        var vx = velocity.dx, vy = velocity.dy
        let spring = ConchMotion.dock
        let doneX = spring.step(&at.x, velocity: &vx, to: target.x, dt: 1.0 / 60, epsilon: 0.5)
        let doneY = spring.step(&at.y, velocity: &vy, to: target.y, dt: 1.0 / 60, epsilon: 0.5)
        if doneX { at.x = target.x; vx = 0 }
        if doneY { at.y = target.y; vy = 0 }
        origin = at
        velocity = CGVector(dx: vx, dy: vy)
        if panel.frame.origin != at { panel.setFrameOrigin(at) }
    }

    /// The card's window origin for `anchor` (AppKit's coordinates), and the side it points from. Under the pill, pointing
    /// up; beside the panel or the canvas's tools, pointing at them, turned round when there's no room on their right.
    /// With nothing to hang from (the pill hidden, the panel full screen or folded), the next thing up, then the top of
    /// the screen.
    static func spot(for anchor: TourAnchor, pointer: CoachCard.Pointer, size: CGSize) -> (CGPoint, CoachCard.Pointer) {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? .zero
        let gap: CGFloat = 12, tip: CGFloat = 9
        func clamp(_ point: CGPoint) -> CGPoint {
            CGPoint(x: min(max(point.x, visible.minX - margin + 8), visible.maxX - size.width + margin - 8),
                    y: min(max(point.y, visible.minY - margin + 8), visible.maxY - size.height + margin))
        }
        func below(_ frame: CGRect) -> (CGPoint, CoachCard.Pointer) {
            (clamp(CGPoint(x: frame.midX - size.width / 2, y: frame.minY - gap / 2 - tip + margin - size.height)), .up)
        }
        func beside(_ frame: CGRect, pointAt y: CGFloat) -> (CGPoint, CoachCard.Pointer) {
            // The pointer's tip is 40 pt down the card (`CoachShape`).
            let top = y + 40 + margin
            let cardWidth = size.width - 2 * margin
            if frame.maxX + gap + tip + cardWidth <= visible.maxX - 8 {
                return (clamp(CGPoint(x: frame.maxX + gap + tip - margin, y: top - size.height)), .left)
            }
            return (clamp(CGPoint(x: frame.minX - gap - tip - cardWidth - margin, y: top - size.height)), .right)
        }
        let bar = controlBarGlass()
        switch anchor {
        case .controlBar:
            break
        case .panel:
            if let glass = FloatingPanels.installed?.glassFrame { return beside(glass, pointAt: glass.maxY - 60) }
        case .canvasPill:
            if let pill = CanvasController.shared.pillFrame { return beside(pill, pointAt: pill.midY) }
            if let glass = FloatingPanels.installed?.glassFrame { return beside(glass, pointAt: glass.maxY - 30) }
        }
        if let bar { return below(bar) }
        return below(CGRect(x: visible.midX - 1, y: visible.maxY - 8, width: 2, height: 2))
    }

    /// The control bar's glass while it shows: its window less `ControlBarHost`'s padding (x3 over, x6 each side, x10
    /// under), as the canvas finds it.
    private static func controlBarGlass() -> CGRect? {
        guard let bar = FloatingPanels.installed?.controlBarWindow, bar.isVisible else { return nil }
        let frame = bar.frame
        return CGRect(x: frame.minX + ConchSpace.x6, y: frame.minY + ConchSpace.x10,
                      width: frame.width - 2 * ConchSpace.x6, height: frame.height - ConchSpace.x3 - ConchSpace.x10)
    }

    /// Over everything but menus and alerts, as the canvas's tools are, and never key: a click on it acts, and the keys
    /// stay with the app in front.
    private func makePanel(accessibilityLabel: String) -> FloatingPanel {
        let panel = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .transient]
        panel.isExcludedFromWindowsMenu = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.title = accessibilityLabel
        return panel
    }

    // MARK: The tip

    private var tipState: PillTip.State {
        get { UserDefaults.standard.string(forKey: Self.tipKey).flatMap(PillTip.State.init(rawValue:)) ?? .none }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: Self.tipKey) }
    }

    /// The tip, under the pill, while it's pending and no tour is running.
    func showTipIfPending() {
        guard tipState == .pending, !running, let bar = Self.controlBarGlass() else { return }
        let panel = tip ?? makePanel(accessibilityLabel: "Tip")
        tip = panel
        let host = FirstClickHostingView(rootView: PillTipView { [weak self] in self?.tipUsed(dismissed: true) }
            .padding(Self.margin))
        panel.contentView = host
        let size = host.fittingSize
        panel.setContentSize(size)
        panel.setFrameOrigin(CGPoint(x: bar.midX - size.width / 2, y: bar.minY - 10 + Self.margin - size.height))
        panel.orderFrontRegardless()
        tipObserver = tipObserver ?? NotificationCenter.default.addObserver(forName: .readyPillClicked, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tipUsed(dismissed: false) }
        }
    }

    /// The pill used, or the tip closed: gone, and never again.
    private func tipUsed(dismissed: Bool) {
        tipState = PillTip.after(tipState, pillUsed: !dismissed, dismissed: dismissed)
        hideTip()
    }

    private func hideTip() {
        tip?.orderOut(nil)
        tip = nil
        if let tipObserver { NotificationCenter.default.removeObserver(tipObserver) }
        tipObserver = nil
    }
}

/// The card on the tour: the beat's own, changing on `swap` as the beat changes (a fade under Reduce Motion).
private struct TourCardHost: View {
    @ObservedObject var coach: TourCoach
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let card = coach.progress.card {
                CoachCard(card, pointer: coach.pointer, onPrimary: { coach.primary() }, onSkip: { coach.skip() }, onRetry: { coach.retry() })
                    .id(card.beat)
                    .transition(.onboardingSwap(reduceMotion: reduceMotion))
            }
        }
        .animation(ConchMotion.swap.animation(reduceMotion: reduceMotion), value: coach.progress.beat)
        .padding(TourCoach.margin)
        .fixedSize()
        .environment(\.conchAppIcon, Image(nsImage: NSApp.applicationIconImage))
    }
}
