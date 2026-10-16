import SwiftUI

// The Workdesk's browser, as views: the strip's tab and its +, the badge an agent's command wears, the address bar with
// its profile picker and Pause agents, the marks where an agent clicks and types, and a blank tab's page. Drawn the same
// in the Mac app (Workbench.swift there) and in a test's picture (WorkdeskRenderTests), from the design system's own
// tokens, so what is checked by picture is what ships.
//
// Tyler, 2026-10-16: "letting me sign-in in an in-conch browser session and letting agents use that browser in the app
// so i can watch them work".

/// The colour of an agent at work: the design system's `active` blue for its dots; for the badge's words a blue deep
/// enough to read at 10 points on the badge's own opaque fill, whatever it sits on (4.8:1 in light, 6:1 in dark; a
/// translucent tint over a selected tab measured 3.9:1); and, for the marks over a page, one blue in either scheme with
/// a white halo, since a page is whatever colour it is, not conch's.
enum WorkdeskInk {
    static let mark = ConchColor.active
    static let words = ConchColorToken("agentWords", .init(0x0060DF), .init(0x79B8FF))
    static let badge = ConchColorToken("agentBadge", .init(0xE3EEFD), .init(0x1E3550))
    static let pageMark = Color(.sRGB, red: 10 / 255, green: 132 / 255, blue: 1, opacity: 1)
    static let pageTint = Color(.sRGB, red: 10 / 255, green: 132 / 255, blue: 1, opacity: 0.1)
    static let halo = Color.white.opacity(0.9)
}

/// The bar's capsules (the Agent badge, the profile chip, Agents paused): one height and one inset.
enum WorkbenchCapsule {
    static let height: CGFloat = 18
    static let inset: CGFloat = 7
}

/// A field in the Workdesk, drawn by conch rather than AppKit's bezel, so its edges sit on the column it is in (the
/// bezel drew 1 point outside it on both sides) and its border can be read (the bezel measured 1.23:1 in light, 1.10:1
/// in dark). The command palette's field, a step firmer: a 1-point line of the secondary text colour, firmer again while
/// it has the keyboard, at a tab's 6-point corner.
enum WorkdeskField {
    static let radius: CGFloat = 6
    /// Resting: 1.57:1 in light, 1.58:1 in dark, measured.
    static let border = AnyShapeStyle(ConchColor.textSecondary.opacity(0.3))
    /// With the keyboard, and the address field's ring: 2.43:1 in light, 2.75:1 in dark.
    static let focused = AnyShapeStyle(ConchColor.textSecondary.opacity(0.55))
}

// MARK: - The strip

/// A browser tab in the Workdesk's strip: a globe and the page's name, in the strip's own tab style. Under the pointer
/// the globe becomes its ×, in the globe's own place, as Safari's tabs do, so the tabs after it stay where they are.
/// While an agent's command runs in it the Agent badge follows its name; a tab an agent acted in that isn't shown has a
/// dot; a tab the user paused agents in shows a raised hand in place of the globe.
public struct WorkbenchTabButton: View {
    let tab: Workbench.Tab
    let isSelected: Bool
    let agentWorking: Bool
    let hasActivity: Bool
    let open: () -> Void
    let close: () -> Void

    @State private var isHovered: Bool

    public init(
        tab: Workbench.Tab,
        isSelected: Bool,
        agentWorking: Bool = false,
        hasActivity: Bool = false,
        isHovered: Bool = false,
        open: @escaping () -> Void,
        close: @escaping () -> Void
    ) {
        self.tab = tab
        self.isSelected = isSelected
        self.agentWorking = agentWorking
        self.hasActivity = hasActivity
        _isHovered = State(initialValue: isHovered)
        self.open = open
        self.close = close
    }

    private var label: String { Workbench.label(title: tab.title, url: tab.url) }

    /// The globe's place, and the ×'s: the globe at the strip's 10 points is 10 wide.
    private static let mark: CGFloat = 10

    private var accessibility: String {
        [label, "browser tab", tab.openedByUser ? "opened by you" : nil, agentWorking ? "an agent is working in it" : nil,
         hasActivity ? "new agent activity" : nil, tab.paused ? "agents paused" : nil]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    public var body: some View {
        HStack(spacing: 5) {
            ZStack {
                if isHovered {
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(ConchColor.textSecondary)
                            .frame(width: Self.mark + 8, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Close this tab")
                    .accessibilityLabel("Close \(label)")
                } else {
                    Image(systemName: tab.paused ? "hand.raised.fill" : "globe")
                        .font(.system(size: 10))
                        .accessibilityHidden(true)
                }
            }
            // Its own width whichever it shows, so nothing moves when it changes.
            .frame(width: Self.mark)

            Button(action: open) {
                Text(label)
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 180, alignment: .leading)
                    .frame(height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(tab.isBlank ? "New tab" : "\(label)\n\(tab.url)")
            .accessibilityLabel(accessibility)

            if agentWorking {
                WorkdeskAgentBadge(size: .tab)
                    .transition(.opacity)
            } else if hasActivity {
                WorkdeskActivityDot()
            }
        }
        .foregroundStyle(isSelected ? ConchColor.textPrimary : ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .contentShape(Rectangle())
        // A click on the tab's padding or its globe opens it, as the whole tab did.
        .onTapGesture(perform: open)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? AnyShapeStyle(ConchColor.rowSelected) : (isHovered ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear)))
        )
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Close Tab", action: close)
        }
    }
}

/// The strip's +: a browser tab of the user's own for the session in view, to sign in or to browse alongside its agents.
/// It wears its capsule at rest, a tab's height and corner, so it reads as the strip's one button whatever the tabs
/// beside it are doing: before, the capsule was hover's alone, and a full strip ran its last tab into the bare +.
public struct WorkdeskNewTabButton: View {
    let action: () -> Void
    @State private var isHovered: Bool

    /// A tab's height, square. With the strip's 6-point inset its centre is 18 from the edge, the bar's close button's axis.
    public static let side: CGFloat = 24

    public init(isHovered: Bool = false, action: @escaping () -> Void) {
        _isHovered = State(initialValue: isHovered)
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isHovered ? ConchColor.textPrimary : ConchColor.textSecondary)
                .frame(width: Self.side, height: Self.side)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isHovered ? ConchColor.rowSelected : ConchColor.fill)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(Workdesk.newTabHelp)
        .accessibilityLabel("New browser tab")
    }
}

/// The strip's run of tabs after its places (Files, Shell): the browser tabs and the filed work, any number of them. They
/// scroll; an edge with more beyond it fades, by as much as there is out of sight, so a tab cut there dissolves rather
/// than stopping mid-letter; the one shown is kept in view, clear of the fade, as it changes (a tab just opened, an
/// agent's tab coming forward); and they end a fixed gutter before the + (`WorkdeskNewTabButton`), which sits outside the
/// scroll at the strip's end, so however many there are it is never scrolled away or run into.
///
/// Tyler's strip, full, 2026-10-16: the last tab was cut mid-letter against the + ("…in light anc"), and a tab he had
/// just opened could be out of sight. Each tab names itself with `workdeskTab(_:)`, by the id `shown` uses.
public struct WorkdeskTabRun<Content: View>: View {
    let shown: AnyHashable?
    let newTab: (() -> Void)?
    let newTabHovered: Bool
    let content: Content

    /// How far an edge fades at its fullest: about the last word of a tab.
    public static var fade: CGFloat { 28 }
    /// Between the run's end and the +: room for the fade to finish before the button starts.
    public static var gutter: CGFloat { 6 }

    @State private var extent = RunExtent()

    public init(shown: AnyHashable?, newTab: (() -> Void)? = nil, newTabHovered: Bool = false, @ViewBuilder content: () -> Content) {
        self.shown = shown
        self.newTab = newTab
        self.newTabHovered = newTabHovered
        self.content = content()
    }

    public var body: some View {
        HStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    HStack(spacing: 2) { content }
                        // Where the content is against the scroller's visible bounds: it moves as it scrolls.
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView) } action: { frame in extent.content = frame }
                }
                .scrollIndicators(.never)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in extent.visible = width }
                .mask(RunFadeMask(leading: extent.leadingFade, trailing: extent.trailingFade))
                .onAppear { reveal(in: proxy, animated: false) }
                .onChange(of: shown) { _, _ in reveal(in: proxy, animated: true) }
            }
            if let newTab {
                WorkdeskNewTabButton(isHovered: newTabHovered, action: newTab)
                    .padding(.leading, Self.gutter)
            }
        }
    }

    /// The shown tab into view, with the fade's width to spare on either side, after the layout that brought it has
    /// settled: a tab that only just arrived has no frame to scroll to before then.
    private func reveal(in proxy: ScrollViewProxy, animated: Bool) {
        guard let shown else { return }
        DispatchQueue.main.async {
            if animated {
                withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo(RunReveal(id: shown)) }
            } else {
                proxy.scrollTo(RunReveal(id: shown))
            }
        }
    }
}

extension View {
    /// A tab in a `WorkdeskTabRun`, by the id the run's `shown` names it with: what the run scrolls to. Its target reaches
    /// a fade's width past the tab on either side, so a tab scrolled to clears the fade instead of stopping under it.
    public func workdeskTab(_ id: AnyHashable) -> some View {
        background(alignment: .center) {
            Color.clear
                .padding(.horizontal, -WorkdeskTabRun<EmptyView>.fade)
                .id(RunReveal(id: id))
                .accessibilityHidden(true)
        }
    }
}

/// What a tab is scrolled to by (`workdeskTab`), apart from any id the tab has of its own.
private struct RunReveal: Hashable {
    let id: AnyHashable
}

/// Where the run's content is in its scroller, and how wide the scroller shows: the fades follow from the two.
struct RunExtent: Equatable {
    var content: CGRect = .zero
    var visible: CGFloat = 0

    /// Each edge fades by the share of a fade's width that is scrolled past it, so a fade comes in and goes as the
    /// content reaches the edge rather than snapping on and off.
    var leadingFade: CGFloat { min(max(-content.minX, 0), WorkdeskTabRun<EmptyView>.fade) / WorkdeskTabRun<EmptyView>.fade }
    var trailingFade: CGFloat { min(max(content.maxX - visible, 0), WorkdeskTabRun<EmptyView>.fade) / WorkdeskTabRun<EmptyView>.fade }
}

/// Opaque in the middle, each edge running out over `WorkdeskTabRun.fade` to as little as its strength leaves.
private struct RunFadeMask: View {
    let leading: CGFloat
    let trailing: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            LinearGradient(stops: Self.stops(leading).reversed().map { Gradient.Stop(color: $0.color, location: 1 - $0.location) }, startPoint: .leading, endPoint: .trailing)
                .frame(width: WorkdeskTabRun<EmptyView>.fade)
            Rectangle()
            LinearGradient(stops: Self.stops(trailing), startPoint: .leading, endPoint: .trailing)
                .frame(width: WorkdeskTabRun<EmptyView>.fade)
        }
    }

    /// From opaque to `1 - strength`, eased so the words thin out before they go rather than at an even rate.
    static func stops(_ strength: CGFloat) -> [Gradient.Stop] {
        let floor = 1 - strength
        return [0, 0.35, 0.7, 1].map { location in
            let eased = location * location * (3 - 2 * location)
            return Gradient.Stop(color: .black.opacity(1 - (1 - floor) * eased), location: location)
        }
    }
}

/// "Agent", while an agent's command runs in a tab: in its strip tab, and, with what it is doing, in its address bar.
public struct WorkdeskAgentBadge: View {
    public enum Size { case tab, bar }

    let size: Size
    /// What it is doing (`Workbench.agentWords`), in the bar; never what it typed.
    let words: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    public init(size: Size = .tab, words: String? = nil) {
        self.size = size
        self.words = words
    }

    public var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(WorkdeskInk.mark)
                .frame(width: 5, height: 5)
                .opacity(dim ? 0.35 : 1)
            Text(words.map { "Agent · \($0)" } ?? "Agent")
                .font(.system(size: size == .tab ? 9.5 : 10, weight: .semibold))
                .foregroundStyle(WorkdeskInk.words)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.horizontal, size == .tab ? 5 : WorkbenchCapsule.inset)
        .frame(height: size == .tab ? 15 : WorkbenchCapsule.height)
        .background(Capsule().fill(WorkdeskInk.badge))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { dim = true }
        }
        .help("An agent is working in this tab")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words.map { "An agent is \($0.lowercased()) in this tab" } ?? "An agent is working in this tab")
    }
}

/// A tab an agent acted in while it wasn't shown: there until it is looked at.
public struct WorkdeskActivityDot: View {
    public init() {}

    public var body: some View {
        Circle()
            .fill(WorkdeskInk.mark)
            .frame(width: 6, height: 6)
            .accessibilityLabel("New agent activity")
    }
}

// MARK: - The address bar

/// A tab's bar: back, forward, reload, the address (edit it and press Return to go), the Agent badge while a command
/// runs, the profile it is signed in with (a picker while the tab is blank), Pause agents, Open in Browser, and close.
public struct WorkbenchBar: View {
    /// What the bar says about its page.
    public struct Facts: Equatable {
        public var canGoBack: Bool
        public var canGoForward: Bool
        public var isLoading: Bool
        public var isSecure: Bool
        public var hasPage: Bool
        public var popupCount: Int
        /// The profile's name, and whether it is the built-in one.
        public var profileName: String
        public var isDefaultProfile: Bool
        /// How many profiles the user has, Default included: with only Default, every tab signs in the same way and a
        /// loaded tab's bar says nothing about it.
        public var profileCount: Int
        /// A blank tab of the user's: its profile can still change.
        public var canPickProfile: Bool
        /// What an agent is doing in it now (`Workbench.agentWords`), or nil.
        public var agentWork: String?
        public var paused: Bool

        /// A loaded tab names its profile whenever there is more than one to be signed in with, Default included: that
        /// is when "which sign-ins is this?" has an answer worth reading. With Default alone the label would say the same
        /// word on every tab, so it says nothing.
        public var namesProfile: Bool { !canPickProfile && (profileCount > 1 || !isDefaultProfile) }

        public init(
            canGoBack: Bool = false,
            canGoForward: Bool = false,
            isLoading: Bool = false,
            isSecure: Bool = false,
            hasPage: Bool = false,
            popupCount: Int = 0,
            profileName: String = "Default",
            isDefaultProfile: Bool = true,
            profileCount: Int = 1,
            canPickProfile: Bool = false,
            agentWork: String? = nil,
            paused: Bool = false
        ) {
            self.canGoBack = canGoBack
            self.canGoForward = canGoForward
            self.isLoading = isLoading
            self.isSecure = isSecure
            self.hasPage = hasPage
            self.popupCount = popupCount
            self.profileName = profileName
            self.isDefaultProfile = isDefaultProfile
            self.profileCount = profileCount
            self.canPickProfile = canPickProfile
            self.agentWork = agentWork
            self.paused = paused
        }
    }

    public struct Actions {
        public var back: () -> Void
        public var forward: () -> Void
        public var reloadOrStop: () -> Void
        public var go: (String) -> Void
        public var togglePause: () -> Void
        public var closePopup: () -> Void
        public var openInBrowser: () -> Void
        public var close: () -> Void

        public init(
            back: @escaping () -> Void = {},
            forward: @escaping () -> Void = {},
            reloadOrStop: @escaping () -> Void = {},
            go: @escaping (String) -> Void = { _ in },
            togglePause: @escaping () -> Void = {},
            closePopup: @escaping () -> Void = {},
            openInBrowser: @escaping () -> Void = {},
            close: @escaping () -> Void = {}
        ) {
            self.back = back
            self.forward = forward
            self.reloadOrStop = reloadOrStop
            self.go = go
            self.togglePause = togglePause
            self.closePopup = closePopup
            self.openInBrowser = openInBrowser
            self.close = close
        }
    }

    let facts: Facts
    @Binding var draft: String
    let editing: FocusState<Bool>.Binding
    /// The profile picker, open under its chip (`WorkbenchProfileList`), while the tab is blank.
    @Binding var pickingProfile: Bool
    let profilePicker: AnyView?
    let actions: Actions

    public init(
        facts: Facts,
        draft: Binding<String>,
        editing: FocusState<Bool>.Binding,
        pickingProfile: Binding<Bool> = .constant(false),
        profilePicker: AnyView? = nil,
        actions: Actions
    ) {
        self.facts = facts
        _draft = draft
        self.editing = editing
        _pickingProfile = pickingProfile
        self.profilePicker = profilePicker
        self.actions = actions
    }

    public var body: some View {
        HStack(spacing: 4) {
            barButton("chevron.left", help: "Back", enabled: facts.canGoBack, action: actions.back)
            barButton("chevron.right", help: "Forward", enabled: facts.canGoForward, action: actions.forward)
            barButton(facts.isLoading ? "xmark" : "arrow.clockwise", help: facts.isLoading ? "Stop loading" : "Reload", action: actions.reloadOrStop)
            address
            if let work = facts.agentWork {
                WorkdeskAgentBadge(size: .bar, words: work)
                    .transition(.opacity)
            }
            profileChip
            pauseControl
            if facts.popupCount > 0 {
                barButton("xmark.rectangle", help: "Close the window this page opened", action: actions.closePopup)
            }
            barButton("safari", help: "Open in your browser", enabled: facts.hasPage, action: actions.openInBrowser)
            barButton("xmark", help: "Close this tab", action: actions.close)
        }
        .foregroundStyle(ConchColor.textSecondary)
        // A filed page's address line, to the point (ReviewContent): 26 tall, its first mark 15 in and its last 14 from
        // the pane's edges, so moving between a page tab and a filed page moves nothing.
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ConchColor.surfaceRaised)
    }

    /// Where the tab is, and where it goes when edited: the lock or globe and the field. With the keyboard it is ringed as
    /// a field, so a new tab's waiting field reads as waiting before anything is typed (Tyler saw neither a caret nor a
    /// ring there, and it looked unfocused). The ring is drawn behind, outside the layout, so nothing moves when it comes
    /// and goes.
    private var address: some View {
        HStack(spacing: 4) {
            Image(systemName: facts.isSecure ? "lock" : "globe")
                .font(.system(size: 9.5))
                // A slot of its own width, so the address starts at one place whichever mark it is.
                .frame(width: 11)
                .padding(.leading, 4)
                // 6 to the address, a filed page's own gap (ReviewContent's address line).
                .padding(.trailing, 2)
            // Its placeholder drawn here, lighter than an address: a plain field's own is the system's, darker than the
            // address it stands in for.
            TextField("", text: $draft)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .lineLimit(1)
                .focused(editing)
                .onSubmit {
                    actions.go(draft)
                    editing.wrappedValue = false
                }
                .background(alignment: .leading) {
                    if draft.isEmpty {
                        Text("Search or type an address")
                            .font(.system(size: 11))
                            .foregroundStyle(ConchColor.textTertiary)
                            .lineLimit(1)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .accessibilityLabel("Address")
                // Room before the ring's right side, so a long address's last letter is never on its line.
                .padding(.trailing, 4)
        }
        .background {
            if editing.wrappedValue {
                RoundedRectangle(cornerRadius: WorkdeskField.radius, style: .continuous)
                    .fill(ConchColor.surface)
                    .overlay(RoundedRectangle(cornerRadius: WorkdeskField.radius, style: .continuous).strokeBorder(WorkdeskField.focused, lineWidth: 1))
                    .frame(height: WorkbenchBar.ringHeight)
                    // 2 out past the field's group on the left, so the globe has 6 inside the ring, a field's inset.
                    .padding(.leading, -2)
                    .allowsHitTesting(false)
            }
        }
    }

    /// The address ring's height: inside the bar's 22-point row with a point to spare above and below.
    static let ringHeight: CGFloat = 20

    /// The profile it is signed in with: a picker while the tab is blank; once it has gone somewhere, a quiet label beside
    /// Pause agents (`Facts.namesProfile`), since a loaded tab's profile can't change.
    @ViewBuilder
    private var profileChip: some View {
        if facts.canPickProfile {
            Button { pickingProfile.toggle() } label: {
                HStack(spacing: 3) {
                    Text(facts.profileName)
                        .font(.system(size: 10, weight: .medium))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 7, weight: .bold))
                }
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, WorkbenchCapsule.inset)
                .frame(height: WorkbenchCapsule.height)
                .background(Capsule().fill(ConchColor.fill))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("The profile this tab signs in with: each has its own sign-ins")
            .accessibilityLabel("Profile: \(facts.profileName). Change")
            .popover(isPresented: $pickingProfile, arrowEdge: .bottom) { profilePicker }
        } else if facts.namesProfile {
            // Quiet: no capsule, which in this bar means a control, and the tertiary text colour, under the address's.
            HStack(spacing: 3) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 9.5))
                Text(facts.profileName)
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(ConchColor.textTertiary)
            .frame(maxWidth: 140)
            .fixedSize(horizontal: true, vertical: false)
            .frame(height: WorkbenchCapsule.height)
            // 5 more before Pause agents' 22-point target: the label's last letter sits 16.5 from the hand, the gap
            // between the hand, Open in Browser and close, so the row keeps one rhythm.
            .padding(.trailing, 5)
            .help("Signed in with \(facts.profileName)")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Signed in with \(facts.profileName)")
        }
    }

    /// Pause agents in this tab: a raised hand, and while it is on, words that say so.
    private var pauseControl: some View {
        Button(action: actions.togglePause) {
            HStack(spacing: 4) {
                Image(systemName: facts.paused ? "hand.raised.fill" : "hand.raised")
                    .font(.system(size: 10, weight: .semibold))
                if facts.paused {
                    Text("Agents paused")
                        .font(.system(size: 10, weight: .medium))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .foregroundStyle(facts.paused ? ConchColor.textPrimary : ConchColor.textSecondary)
            // While on, a capsule the profile chip's height; the button keeps the bar's 22-point target either way.
            .padding(.horizontal, facts.paused ? WorkbenchCapsule.inset : 0)
            .frame(minWidth: facts.paused ? 0 : 22, minHeight: WorkbenchCapsule.height)
            .background(Capsule().fill(facts.paused ? AnyShapeStyle(ConchColor.fill) : AnyShapeStyle(Color.clear)))
            .frame(minWidth: 22, minHeight: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(facts.paused
            ? "Agents are paused in this tab: their commands here are refused. Click to let them back in"
            : "Pause agents in this tab: it's yours until you resume")
        .accessibilityLabel(facts.paused ? "Resume agents in this tab" : "Pause agents in this tab")
        .accessibilityAddTraits(facts.paused ? .isSelected : [])
    }

    /// Dimmed when it can't act by SwiftUI's own disabled plain button, as the app's other plain buttons are (the
    /// composer's, the conversation's): 2.24:1 in light, 2.70:1 in dark. It used to dim itself to 40% on top of that,
    /// which came out at 20% (1.34:1), too faint to read as a control.
    private func barButton(_ symbol: String, help: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .help(help)
        .accessibilityLabel(help)
    }
}

// MARK: - The profile picker

/// What the bar's profile chip opens, while a tab is blank: the profiles, the one it signs in with checked, and a new
/// one by name.
public struct WorkbenchProfileList: View {
    public struct Profile: Identifiable, Equatable, Sendable {
        public let id: String
        public let name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    let profiles: [Profile]
    let selected: String
    let pick: (String) -> Void
    /// Make a profile by name; nil when it was made, else why not.
    let create: (String) async -> String?

    @State private var naming: Bool
    @State private var draft: String
    @State private var problem: String?
    @State private var working = false
    @State private var hovered: String?
    @FocusState private var nameFocused: Bool
    /// The name field takes the keyboard when it appears; a test's picture of it at rest turns this off.
    var focusesName = true

    public init(
        profiles: [Profile],
        selected: String,
        naming: Bool = false,
        draft: String = "",
        pick: @escaping (String) -> Void,
        create: @escaping (String) async -> String?
    ) {
        self.profiles = profiles
        self.selected = selected
        _naming = State(initialValue: naming)
        _draft = State(initialValue: draft)
        self.pick = pick
        self.create = create
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Sign in with")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(ConchColor.textTertiary)
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .padding(.bottom, 4)
            ForEach(profiles) { profile in
                row(profile)
            }
            Rectangle()
                .fill(ConchColor.hairline)
                .frame(height: 1)
                .padding(.vertical, 5)
            if naming {
                newProfile
                    .padding(.top, 2)
            } else {
                Button {
                    naming = true
                    nameFocused = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .semibold))
                            .frame(width: 12)
                        Text("New profile…")
                            .font(.system(size: 12))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(ConchColor.textPrimary)
                    .padding(.horizontal, 12)
                    .frame(height: 26)
                    .background(RoundedRectangle(cornerRadius: 5).fill(hovered == "new" ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 4)
                .onHover { hovered = $0 ? "new" : (hovered == "new" ? nil : hovered) }
            }
            Text("Each profile keeps its own sign-ins, and this session's agents can use this tab.")
                .font(.system(size: 10.5))
                .foregroundStyle(ConchColor.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .padding(.bottom, 4)
        }
        .padding(.vertical, 6)
        .frame(width: 240)
    }

    private func row(_ profile: Profile) -> some View {
        Button {
            pick(profile.id)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 12)
                    .opacity(profile.id == selected ? 1 : 0)
                Text(profile.name)
                    .font(.system(size: 12))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(ConchColor.textPrimary)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 5).fill(hovered == profile.id ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .onHover { hovered = $0 ? profile.id : (hovered == profile.id ? nil : hovered) }
        .accessibilityLabel(profile.name)
        .accessibilityAddTraits(profile.id == selected ? .isSelected : [])
    }

    private var newProfile: some View {
        VStack(alignment: .leading, spacing: 6) {
            // conch's field, not AppKit's bezel: the bezel drew a point outside the column on both sides, at 1.23:1.
            TextField("Profile name, e.g. Work", text: $draft)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($nameFocused)
                .onSubmit(make)
                // Asked for as it appears: set with `naming` in the same press, the field wasn't there yet to take it.
                .onAppear { if focusesName { nameFocused = true } }
                .padding(.horizontal, 7)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: WorkdeskField.radius, style: .continuous).fill(ConchColor.surface))
                .overlay(
                    RoundedRectangle(cornerRadius: WorkdeskField.radius, style: .continuous)
                        .strokeBorder(nameFocused ? WorkdeskField.focused : WorkdeskField.border, lineWidth: 1)
                )
            if let problem {
                Text(problem)
                    .font(.system(size: 10.5))
                    .foregroundStyle(ConchColor.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                Button("Cancel") {
                    naming = false
                    draft = ""
                    problem = nil
                }
                .controlSize(.small)
                Button("Create", action: make)
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || working)
            }
        }
        .padding(.horizontal, 12)
    }

    private func make() {
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !working else { return }
        working = true
        Task { @MainActor in
            problem = await create(name)
            working = false
            if problem == nil {
                naming = false
                draft = ""
            }
        }
    }
}

// MARK: - Where an agent clicks and types

/// A mark over the page where an agent's command lands: the element's box, in the view's points, and when it went down.
public struct WorkbenchMark: Equatable, Sendable {
    public enum Kind: Sendable { case click, type }

    public let kind: Kind
    public let rect: CGRect
    /// A new mark each time, even on the same element.
    public let serial: Int
    /// When it went down: its motion is timed from here, so a pane shown part way through draws it part way through, and
    /// one shown after never replays it.
    public let at: Date
    /// When a type's command was done with: its outline goes from here. A click's plays out on its own.
    public let endedAt: Date?

    public init(kind: Kind, rect: CGRect, serial: Int, at: Date = Date(), endedAt: Date? = nil) {
        self.kind = kind
        self.rect = rect
        self.serial = serial
        self.at = at
        self.endedAt = endedAt
    }

    /// The same mark, its command done with.
    public func ended(at time: Date = Date()) -> WorkbenchMark {
        WorkbenchMark(kind: kind, rect: rect, serial: serial, at: at, endedAt: time)
    }

    /// Where a click lands: the middle of the box, where the page's click was sent.
    public var point: CGPoint { CGPoint(x: rect.midX, y: rect.midY) }
}

/// How a mark moves, as a function of time, so what is drawn live (`WorkbenchMarks`) and what a test draws at a moment are
/// the same frame. Timed to be followed by someone watching without feeling slow, against WebKit in a harness:
///
/// - A click: the outline and the point come in (80 ms), and the click is sent `clickLead` after the mark goes down, long
///   enough for an eye drawn by it to get there (a saccade takes about 200 ms to start). The ripple starts as the click
///   lands, not as the mark goes down: before, it was a third grown when the click was sent. The outline holds through the
///   click and goes with the ripple; all of it is gone by 0.69 s.
/// - A type: the outline and its tint come in, hold while the field fills, stay `typeHold` on the finished field, then
///   fade (`fadeOut`). Before, it came on at once and was dropped in a frame.
public enum WorkbenchMarkMotion {
    /// From a click's mark going down to the click being sent.
    public static let clickLead: TimeInterval = 0.24
    /// The ripple out from where the click landed, until it is gone.
    public static let ripple: TimeInterval = 0.45
    /// A mark comes in over this, rather than appearing in a frame.
    public static let fadeIn: TimeInterval = 0.08
    /// A type's outline stays this long on the filled field, then goes over `fadeOut`.
    public static let typeHold: TimeInterval = 0.3
    public static let fadeOut: TimeInterval = 0.2
    /// A type whose end never came (its command ran out of time): its mark goes anyway.
    public static let typeLimit: TimeInterval = 8

    /// One frame: how strongly each part is drawn, and the ripple's size.
    public struct Look: Equatable, Sendable {
        /// The element's outline and its tint.
        public var outline: Double
        /// The point a click lands on, and its size against its rest.
        public var point: Double
        public var pointScale: Double
        /// The ripple: across, in points, and how strongly.
        public var ring: Double
        public var ringOpacity: Double

        public static let none = Look(outline: 0, point: 0, pointScale: 1, ring: 0, ringOpacity: 0)

        public var isVisible: Bool { outline > 0.001 || point > 0.001 || ringOpacity > 0.001 }
    }

    /// The ripple's size: from the point's own to this across.
    public static let ringStart: Double = 12
    public static let ringEnd: Double = 52

    /// The frame `since` seconds after the mark went down, a type's command having ended `ended` seconds after it did.
    public static func look(_ kind: WorkbenchMark.Kind, since t: TimeInterval, ended: TimeInterval? = nil, reduceMotion: Bool = false) -> Look {
        guard t >= 0 else { return .none }
        let arriving = smooth(t / fadeIn)
        switch kind {
        case .click:
            let end = clickLead + ripple
            guard t < end else { return .none }
            let landed = t - clickLead
            if reduceMotion {
                // Still: the outline and the point, there and then gone, no ripple.
                let leaving = 1 - smooth((t - (end - fadeOut)) / fadeOut)
                return Look(outline: min(arriving, leaving), point: min(arriving, leaving), pointScale: 1, ring: 0, ringOpacity: 0)
            }
            // The outline holds through the click, then goes with the ripple.
            let outline = min(arriving, 1 - smooth((landed - 0.12) / (ripple - 0.12)))
            // The point settles in, gives a little as the click lands, and goes in the first half of the ripple.
            let settle = 0.6 + 0.4 * easeOut(t / fadeIn)
            let press = landed < 0 ? 1 : 1 - 0.25 * sin(.pi * min(landed / 0.12, 1))
            let point = landed < 0 ? arriving : 1 - smooth(landed / (ripple * 0.55))
            guard landed >= 0 else {
                return Look(outline: outline, point: point, pointScale: settle, ring: 0, ringOpacity: 0)
            }
            let grown = easeOut(landed / ripple)
            return Look(outline: outline, point: point, pointScale: press, ring: ringStart + (ringEnd - ringStart) * grown, ringOpacity: 1 - smooth(landed / ripple))
        case .type:
            let ending = ended ?? typeLimit
            let leaving = 1 - smooth((t - ending) / fadeOut)
            let outline = reduceMotion ? (t < ending + fadeOut / 2 ? 1 : 0) : min(arriving, leaving)
            return outline > 0 ? Look(outline: outline, point: 0, pointScale: 1, ring: 0, ringOpacity: 0) : .none
        }
    }

    /// The frame for a mark at a moment.
    public static func look(_ mark: WorkbenchMark, at date: Date, reduceMotion: Bool = false) -> Look {
        look(mark.kind, since: date.timeIntervalSince(mark.at), ended: mark.endedAt?.timeIntervalSince(mark.at), reduceMotion: reduceMotion)
    }

    /// When nothing is left of a mark to draw.
    public static func end(of mark: WorkbenchMark) -> Date {
        switch mark.kind {
        case .click: return mark.at.addingTimeInterval(clickLead + ripple)
        case .type: return (mark.endedAt ?? mark.at.addingTimeInterval(typeLimit)).addingTimeInterval(fadeOut)
        }
    }

    /// 0 to 1, easing in and out: for a fade.
    static func smooth(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return t * t * (3 - 2 * t)
    }

    /// 0 to 1, fast then settling: for growth.
    static func easeOut(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return 1 - (1 - t) * (1 - t) * (1 - t)
    }
}

/// One frame of a mark (`WorkbenchMarkMotion.Look`): the element outlined and lightly tinted; for a click, the point it
/// lands on and the ripple out from it. Blue with a white halo, so it reads on any page.
public struct WorkbenchMarkView: View {
    let mark: WorkbenchMark
    let look: WorkbenchMarkMotion.Look

    public init(mark: WorkbenchMark, look: WorkbenchMarkMotion.Look) {
        self.mark = mark
        self.look = look
    }

    /// The frame `since` seconds after the mark went down.
    public init(mark: WorkbenchMark, since: TimeInterval) {
        self.mark = mark
        look = WorkbenchMarkMotion.look(mark.kind, since: since, ended: mark.endedAt?.timeIntervalSince(mark.at))
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(WorkdeskInk.halo, lineWidth: 4)
                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(WorkdeskInk.pageMark, lineWidth: 2))
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(WorkdeskInk.pageTint))
                .frame(width: mark.rect.width + 8, height: mark.rect.height + 8)
                .position(x: mark.rect.midX, y: mark.rect.midY)
                .opacity(look.outline)
            if mark.kind == .click {
                Circle()
                    .stroke(WorkdeskInk.halo, lineWidth: 4.5)
                    .overlay(Circle().stroke(WorkdeskInk.pageMark, lineWidth: 2.5))
                    .frame(width: look.ring, height: look.ring)
                    .position(mark.point)
                    .opacity(look.ringOpacity)
                Circle()
                    .fill(WorkdeskInk.pageMark)
                    .overlay(Circle().stroke(WorkdeskInk.halo, lineWidth: 1))
                    .frame(width: 10, height: 10)
                    .scaleEffect(look.pointScale)
                    .position(mark.point)
                    .opacity(look.point)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The marks, live: each drawn from `WorkbenchMarkMotion` on the display's clock while it has anything to show, and not
/// at all once it is over, so a finished mark costs nothing and a pane shown again never replays one. Never takes a
/// click: the page beneath is the user's.
public struct WorkbenchMarks: View {
    let mark: WorkbenchMark?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The last mark whose motion is over.
    @State private var over: WorkbenchMark?

    public init(mark: WorkbenchMark?) {
        self.mark = mark
    }

    public var body: some View {
        ZStack {
            if let mark, mark != over {
                TimelineView(.animation) { context in
                    WorkbenchMarkView(mark: mark, look: WorkbenchMarkMotion.look(mark, at: context.date, reduceMotion: reduceMotion))
                }
            }
        }
        .allowsHitTesting(false)
        // Its clock stops when the mark is over, and starts again for a new one or for a type's end.
        .task(id: mark) {
            guard let mark else { return }
            let wait = WorkbenchMarkMotion.end(of: mark).timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            over = mark
        }
    }
}

// MARK: - A blank tab

/// What a tab the user opened shows before it goes anywhere: where to type, which profile it signs in with, and that
/// this session's agents can use it.
public struct WorkbenchBlankPage: View {
    let profileName: String

    public init(profileName: String) {
        self.profileName = profileName
    }

    public var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "globe")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(ConchColor.textTertiary)
            Text("Type an address or search above")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(ConchColor.textPrimary)
            Text("Signed in with \(profileName). This session's agents can use this tab too: sign in here, and they work where you can watch. Pause agents keeps it yours.")
                .font(.system(size: 11.5))
                .foregroundStyle(ConchColor.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 340)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchColor.surface)
    }
}
