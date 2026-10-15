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
public struct WorkdeskNewTabButton: View {
    let action: () -> Void
    @State private var isHovered: Bool

    public init(isHovered: Bool = false, action: @escaping () -> Void) {
        _isHovered = State(initialValue: isHovered)
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isHovered ? ConchColor.textPrimary : ConchColor.textSecondary)
                // 20 wide: with the strip's 8-point inset its centre is 18 from the edge, the bar's close button's axis.
                .frame(width: 20, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isHovered ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear))
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(Workdesk.newTabHelp)
        .accessibilityLabel("New browser tab")
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
        /// The profile's name, and whether it is the built-in one (shown only when it isn't, or while it can change).
        public var profileName: String
        public var isDefaultProfile: Bool
        /// A blank tab of the user's: its profile can still change.
        public var canPickProfile: Bool
        /// What an agent is doing in it now (`Workbench.agentWords`), or nil.
        public var agentWork: String?
        public var paused: Bool

        public init(
            canGoBack: Bool = false,
            canGoForward: Bool = false,
            isLoading: Bool = false,
            isSecure: Bool = false,
            hasPage: Bool = false,
            popupCount: Int = 0,
            profileName: String = "Default",
            isDefaultProfile: Bool = true,
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

    /// The profile it is signed in with: a picker while the tab is blank, a label otherwise, and only when it isn't the
    /// built-in one.
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
        } else if !facts.isDefaultProfile {
            Text(facts.profileName)
                .font(.system(size: 10, weight: .medium))
                .lineLimit(1)
                .padding(.horizontal, WorkbenchCapsule.inset)
                .frame(height: WorkbenchCapsule.height)
                .background(Capsule().fill(ConchColor.fill))
                .help("Signed in with the \(facts.profileName) profile")
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

    private func barButton(_ symbol: String, help: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
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
            TextField("Profile name, e.g. Work", text: $draft)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
                .focused($nameFocused)
                .onSubmit(make)
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

/// A mark over the page where an agent's command lands: the element's box, in the view's points.
public struct WorkbenchMark: Equatable, Sendable {
    public enum Kind: Sendable { case click, type }

    public let kind: Kind
    public let rect: CGRect
    /// A new mark each time, even on the same element.
    public let serial: Int

    public init(kind: Kind, rect: CGRect, serial: Int) {
        self.kind = kind
        self.rect = rect
        self.serial = serial
    }

    /// Where a click lands: the middle of the box, where the page's click was sent.
    public var point: CGPoint { CGPoint(x: rect.midX, y: rect.midY) }
}

/// One frame of a mark, `progress` 0 to 1: a click's ring grows out from where it landed and fades, with the element's
/// outline; a type's outline holds while the field fills.
public struct WorkbenchMarkView: View {
    let mark: WorkbenchMark
    let progress: Double

    public init(mark: WorkbenchMark, progress: Double) {
        self.mark = mark
        self.progress = min(max(progress, 0), 1)
    }

    public var body: some View {
        // Full strength while the click lands, then gone; a type's holds while the field fills.
        let outline = mark.kind == .type ? 1 - max(0, progress - 0.85) / 0.15 : (progress < 0.5 ? 1 : 1 - (progress - 0.5) / 0.5)
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(WorkdeskInk.halo, lineWidth: 4)
                .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(WorkdeskInk.pageMark, lineWidth: 2))
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(WorkdeskInk.pageTint))
                .frame(width: mark.rect.width + 8, height: mark.rect.height + 8)
                .position(x: mark.rect.midX, y: mark.rect.midY)
                .opacity(outline)
            if mark.kind == .click {
                let ring = 12 + 40 * progress
                Circle()
                    .stroke(WorkdeskInk.halo, lineWidth: 4.5)
                    .overlay(Circle().stroke(WorkdeskInk.pageMark, lineWidth: 2.5))
                    .frame(width: ring, height: ring)
                    .position(mark.point)
                    .opacity(1 - progress)
                Circle()
                    .fill(WorkdeskInk.pageMark)
                    .overlay(Circle().stroke(WorkdeskInk.halo, lineWidth: 1))
                    .frame(width: 10, height: 10)
                    .position(mark.point)
                    .opacity(1 - progress * progress)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The marks, live: each new one plays once (a click about three quarters of a second, a type's outline until its
/// command is done), and none is left behind. Never takes a click: the page beneath is the user's.
public struct WorkbenchMarks: View {
    let mark: WorkbenchMark?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var progress: Double = 1

    public init(mark: WorkbenchMark?) {
        self.mark = mark
    }

    public var body: some View {
        ZStack {
            if let mark {
                WorkbenchMarkView(mark: mark, progress: progress)
            }
        }
        .allowsHitTesting(false)
        // Not on appearing: a pane shown again never replays a mark that already played.
        .onChange(of: mark?.serial) { _, _ in
            guard let mark else { return }
            progress = mark.kind == .type ? 0.3 : 0
            let duration = reduceMotion ? 0.01 : (mark.kind == .type ? 1.2 : 0.75)
            withAnimation(.easeOut(duration: duration)) { progress = mark.kind == .type ? 0.85 : 1 }
        }
        .onChange(of: mark == nil) { _, cleared in
            if cleared { progress = 1 }
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
