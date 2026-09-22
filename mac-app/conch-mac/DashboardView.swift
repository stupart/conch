import AppKit
import ConchDesign
import SwiftUI

extension Notification.Name {
    /// ⌘B, from the menu — posted like the palette's, so the shortcut works whatever has focus.
    static let toggleSidebar = Notification.Name("com.conch.mac.toggle-sidebar")

    /// ⌘1 ⌘2 ⌘3 (§3), carrying the StageMode as its object. Posted from the menu for the
    /// same reason ⌘B is: the shortcut has to work whatever holds focus.
    static let setStage = Notification.Name("com.conch.mac.set-stage")

    /// ⌘3 — the deliverable, opened where it actually LIVES rather than filling more of
    /// conch. Posted from the menu for the same reason the others are.
    static let openDeliverableInPlace = Notification.Name("com.conch.mac.open-deliverable-in-place")
}

struct DashboardActions {
    let onStartSession: () -> Void
    let onSelectSession: (SessionRow) -> Void
    let onBeginRename: (SessionRow) -> Void
    let onCommitRename: (SessionRow) -> Void
    let onCancelRename: () -> Void
    let onDismiss: (SessionRow) -> Void
    let onRestore: (DismissedSessionRow) -> Void
    let onUndoDismiss: () -> Void
    let onDismissNewerDaemonWarning: () -> Void
    let onToggleLogs: () -> Void
    /// Opens Settings on the Phone tab, where the pairing QR lives.
    let onConnectPhone: () -> Void
    let onShowKeyboardShortcuts: () -> Void
    /// ⌘K (B4): the command palette for the selected session.
    let onShowCommandPalette: () -> Void
    let onTalkOrStop: () -> Void
    let onPauseOrResume: () -> Void
    let onRecite: () -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void
    let onReleaseSelection: () -> Void
}

struct DashboardView: View {
    let onSelectRemote: (RemoteSessionID) -> Void
    /// Put away and brought back with ⌘B, and remembered: a window that reopens with the
    /// sidebar back after you deliberately closed it is a window arguing with you.
    @AppStorage("conch.sidebarCollapsed") private var sidebarCollapsed = false
    /// Dragged, and remembered. Tyler: "wnat ot be able ot collapse and open the left side bar /
    /// drag to change side of main area and therefore make it smaller if I want." 264 was the
    /// hardcoded width; it is now only the starting one.
    @AppStorage("conch.sidebarWidth") private var storedSidebarWidth = 264.0
    /// The drag in progress, before it is banked into `storedSidebarWidth` on release.
    @State private var sidebarDrag: CGFloat = 0
    @EnvironmentObject private var store: StateStore
    @EnvironmentObject private var daemon: DaemonHost
    @EnvironmentObject private var audio: AudioHolderStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let renamingSessionID: SessionRow.ID?
    @Binding var renameDraft: String
    let actions: DashboardActions

    var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                DashboardHeader(
                    state: state,
                    selectedSessionID: selectedSessionID,
                    titleBarInset: proxy.safeAreaInsets.top,
                    isLogDrawerOpen: store.isLogDrawerOpen,
                    daemonMessage: store.daemonMessage,
                    newerDaemonWarningVisible: store.newerDaemonWarningVisible,
                    onDismissNewerDaemonWarning: actions.onDismissNewerDaemonWarning,
                    actions: actions
                )

                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)

                // The app and the plugin are two halves and neither installs the
                // other, so someone who only ran the brew install never learns the
                // other half exists. Said once, dismissible, never nagged again.
                // A newer conch is on disk and this process is still the old
                // one. Nothing else on screen can tell you that, and everything
                // you see may be behaviour that has already been fixed.
                WorkspaceNotices()

                HStack(spacing: 0) {
                    if !sidebarCollapsed {
                    SessionLedger(
                        onSelectRemote: onSelectRemote,
                        state: state,
                        selectedSessionID: selectedSessionID,
                        renamingSessionID: renamingSessionID,
                        renameDraft: $renameDraft,
                        rowMessages: store.rowMessages,
                        undoDismissal: store.undoDismissal,
                        actions: actions
                    )
                    .frame(width: sidebarWidth)
                    .opacity(store.isLedgerFrozen ? 0.82 : 1)
                    .grayscale(store.isLedgerFrozen ? 1 : 0)
                    .animation(
                        reduceMotion ? nil : .easeOut(duration: 0.18),
                        value: store.isLedgerFrozen
                    )

                    sidebarResizer
                    }

                    // §3: the stage is a `surface` panel inset 8 from the window, radius 12,
                    // with a 0.5 pt hairline shadow — "No other cards." The lab's `#stage`
                    // gives the exact values: inset 8 on all four sides, `--surface`, radius
                    // 12, and `--shPanel` (a 0.5 ring at 8% plus a 1 px drop at 4%).
                    //
                    // The window ground shows through that inset, which is what makes this
                    // read as a panel ON a ground rather than one flat surface. The sidebar's
                    // 1 pt rule is gone with it: the panel's own edge is the separation, and
                    // `#stage` has no left border.
                    //
                    // `--shPanel` has its own level now: radius 1.5 / y 1 at 4% in light, and
                    // on dark the ring ALONE — the lab drops the panel's shadow there, which
                    // `.raised` (a selected segment's shadow) never could express. No
                    // ConchElevation case carries a ring, so it is drawn explicitly, the same
                    // way the composer does it.
                    ConversationPane(
                        state: state,
                        onSelectSession: actions.onSelectSession
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(ConchPalette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous)
                            .strokeBorder(ConchPalette.divider, lineWidth: 0.5)
                    )
                    .conchElevation(.panel)
                    .padding(8)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if store.isLogDrawerOpen {
                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)

                    DaemonLogDrawer(lines: store.logLines)
                        .frame(height: min(220, max(132, proxy.size.height * 0.27)))
                }

            }
            // E1. The window hides its title bar but SwiftUI still insets
            // content below the strip the traffic lights sit in (32pt on
            // macOS 26), so the 38pt header stacked under 32pt of nothing.
            // The stack extends under the strip and the header BECOMES it:
            // wordmark, status and app controls beside the traffic lights,
            // and the ledger starts 39pt higher. The reader outside stays
            // inset on purpose — a reader that ignores the strip reports its
            // height as 0, and the header needs the number.
            .ignoresSafeArea(.container, edges: .top)
            // The dashboard owns this state, so it takes the message itself rather than
            // threading another closure down through the window.
            .onReceive(NotificationCenter.default.publisher(for: .toggleSidebar)) { _ in
                withAnimation(ConchMotion.morph.animation(reduceMotion: reduceMotion)) {
                    sidebarCollapsed.toggle()
                }
            }
        }
        .background(ConchPalette.bg)
        .font(ConchTypography.font(size: 12.5))
        .tracking(-0.3)
    }

    /// Fixed, at the spec's 264 (workspace-v1 §3). It used to scale with the window —
    /// min 280, max 380, 30% — so the stage's measure moved every time the window did.
    /// Between a usable ledger and half the window: a session's name needs room, and a sidebar
    /// that can eat the stage is a sidebar that can hide the work.
    private static let sidebarBounds: ClosedRange<CGFloat> = 180...520
    private var sidebarWidth: CGFloat {
        min(max(storedSidebarWidth + sidebarDrag, Self.sidebarBounds.lowerBound), Self.sidebarBounds.upperBound)
    }

    /// A grab strip on the sidebar's edge. Two points wide to look at, wider to hit — a resize you
    /// have to aim for is one nobody finds.
    private var sidebarResizer: some View {
        Rectangle()
            .fill(Color.clear)
            // 16, not 10. Tyler: "Make the area where my cursor shows that it can make the
            // panels larger". 10 pt is the width a mouse crosses in one flick, so the cursor
            // changed shape only if you aimed at it. Not wider than 16: session rows are
            // clickable to the sidebar's edge, and a grab area that swallows a row's right
            // side trades one miss for another.
            .frame(width: 16)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(coordinateSpace: .global)
                    .onChanged { sidebarDrag = $0.translation.width }
                    .onEnded { _ in
                        storedSidebarWidth = sidebarWidth
                        sidebarDrag = 0
                    }
            )
            .accessibilityLabel("Resize the sidebar")
    }
}

private struct DashboardHeader: View {
    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    /// The title-bar strip this row now lives in: 32pt on macOS 26 with the
    /// window's own title bar hidden, 0 in full screen where the traffic
    /// lights are gone and the row keeps a plain 28pt of its own.
    let titleBarInset: CGFloat
    let isLogDrawerOpen: Bool
    let daemonMessage: String?
    let newerDaemonWarningVisible: Bool
    let onDismissNewerDaemonWarning: () -> Void
    let actions: DashboardActions

    /// Measured on macOS 26: the zoom button ends at x=69 and the lights sit
    /// 9pt in from the edge, so the wordmark gets the same 9pt after them.
    private static let trafficLightClearance: CGFloat = 78

    private var selectedRow: SessionRow? {
        guard let selectedSessionID else { return nil }
        return state?.rows.first { $0.id == selectedSessionID }
    }

    /// Auto or manual, for what used to be called pause.
    ///
    /// These were never two features. Auto reads finished turns aloud and opens
    /// the mic on its own; manual does neither, while everything else keeps
    /// working — you read, and press recite on what you want to hear. That is
    /// exactly what pause always did, named for what it does rather than for
    /// the button being pressed.
    ///
    /// A session inside a manual conch is manual whatever its own flag says,
    /// which is why this reads the global state as well as the row's.
    private var isManual: Bool {
        state?.mode.paused == true || selectedRow?.paused == true
    }

    private var modeScope: String {
        selectedRow == nil ? "everything" : "this session"
    }

    /// What conch is DOING, which is not the same as what mode it is in.
    ///
    /// The daemon's at-rest live state can be the mode itself, so reporting it
    /// verbatim prints the mode a second time, three inches from the toggle that
    /// already says it. Only genuine activity belongs here.
    private static let activityStates: Set<String> = [
        "speaking", "listening", "recording", "transcribing",
    ]

    private var doingText: String? {
        guard let state else { return nil }
        if Self.activityStates.contains(state.live.state) {
            return state.live.label.isEmpty
                ? state.live.state
                : "\(state.live.state) ‹\(state.live.label)›"
        }
        // The MODE is the toggle's job now. What it cannot show is the
        // consequence: how much work is waiting for you.
        if state.mode.paused, state.mode.holding > 0 {
            return "holding \(state.mode.holding)"
        }
        return nil
    }

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 5) {
                // ⌘B put the sidebar away and a menu item said so, but nothing on
                // SCREEN did — Tyler: "i see the sidebar drag but how do i full close
                // / collapse it?" A shortcut you have to be told about is not an
                // affordance. The glyph is, and it sits where every Mac app puts it:
                // the leading edge of the strip, just inside the traffic lights.
                //
                // It posts the same notification the menu item does rather than
                // touching the flag, so the button and ⌘B are one code path and the
                // collapse animates identically whichever you use.
                HeaderButton(
                    symbol: "sidebar.leading",
                    help: "Toggle sidebar (⌘B)",
                    action: { NotificationCenter.default.post(name: .toggleSidebar, object: nil) }
                )

                Text("conch")
                    .font(ConchTypography.font(size: 12, weight: .medium))
                    .tracking(-0.2)
                    .foregroundStyle(ConchPalette.textDim)
            }

            Spacer(minLength: 12)

            if let daemonMessage {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 10, weight: .medium))
                    Text(daemonMessage)
                        .font(ConchTypography.font(size: 10.5))
                }
                .foregroundStyle(ConchPalette.statusNeeds.opacity(0.86))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(2)
                .accessibilityElement(children: .combine)
            } else if newerDaemonWarningVisible {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 10, weight: .medium))
                    Text("app is out of date")
                        .font(ConchTypography.font(size: 10.5))

                    Button(action: onDismissNewerDaemonWarning) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8.5, weight: .semibold))
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss")
                    .accessibilityLabel("Dismiss app out of date notice")
                }
                .foregroundStyle(ConchPalette.statusWaiting.opacity(0.88))
                .lineLimit(1)
                .layoutPriority(2)
            } else if let doingText {
                Text(doingText)
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.textDim)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
            }
            // The global controls, moved up out of a bar of their own.
            //
            // The bottom strip held Talk — a duplicate of the mic now sitting in
            // the composer — plus mode, Settings, Logs and ?. The session
            // actions belong beside the session; the rest belong in the app's
            // own chrome. Deleting the strip gave the ledger and composer the
            // full height of the window; E1 then folded this row into the
            // title-bar strip, so the wordmark costs no height at all.
            HeaderControls(
                isManual: isManual,
                modeScope: modeScope,
                isLogDrawerOpen: isLogDrawerOpen,
                audioHeldElsewhere: state?.audioControl.isLocal == false,
                actions: actions
            )
        }
        .lineLimit(1)
        .padding(.leading, titleBarInset > 0 ? Self.trafficLightClearance : 16)
        .padding(.trailing, 8)
        .frame(height: max(titleBarInset, 28))
        .background(ConchPalette.bg)
    }
}

/// Mode, settings, logs, shortcuts — the things that act on conch itself rather
/// than on one session.
private struct HeaderControls: View {
    let isManual: Bool
    let modeScope: String
    let isLogDrawerOpen: Bool
    /// C9b Cut B: another Mac holds the audio, so auto/manual is not this window's to set.
    let audioHeldElsewhere: Bool
    let actions: DashboardActions

    var body: some View {
        HStack(spacing: 2) {
            // One control, two modes, and the word for the mode you are IN.
            ModeToggle(
                isManual: isManual,
                scope: modeScope,
                isDisabled: audioHeldElsewhere,
                action: actions.onPauseOrResume
            )
            HeaderButton(
                symbol: "gearshape",
                help: "Settings — connect a phone, and everything else",
                action: actions.onConnectPhone
            )
            HeaderButton(
                symbol: "text.alignleft",
                help: isLogDrawerOpen ? "Hide logs" : "Show logs",
                isSelected: isLogDrawerOpen,
                action: actions.onToggleLogs
            )
            HeaderButton(
                symbol: "command",
                help: "Command palette (⌘K)",
                action: actions.onShowCommandPalette
            )
            HeaderButton(
                symbol: "questionmark",
                help: "Keyboard shortcuts",
                action: actions.onShowKeyboardShortcuts
            )
        }
    }
}

private struct HeaderButton: View {
    let symbol: String
    let help: String
    var isSelected = false
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            // `.ib{width:28px;height:28px;border-radius:7px;color:var(--text2)}`, with three
            // states the lab keeps apart and this button had collapsed into one:
            //
            //   `.ib:hover{background:var(--hover);color:var(--text)}`
            //   `.ib.on{background:var(--sel);color:var(--text)}`
            //
            // Hover and selected painted the SAME fill, so a pressed-on control (logs open)
            // was indistinguishable from the one the pointer happened to be over.
            //
            // The radius is a literal, not `ConchRadius.small`: that token is 6, the lab asks
            // for 7 here, and redefining a shared token to fix one button would move every
            // other surface that leans on it.
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))
                )
                .foregroundStyle(isSelected || isHovered ? ConchPalette.textPrimary : ConchPalette.textDim)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}


private struct SessionLedger: View {
    let onSelectRemote: (RemoteSessionID) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let renamingSessionID: SessionRow.ID?
    @Binding var renameDraft: String
    let rowMessages: [SessionRow.ID: String]
    let undoDismissal: SessionDismissUndo?
    let actions: DashboardActions

    /// Which row the ledger keeps in view. The same question the pane answers, so it asks the
    /// same rule (ConchDesign/Workspace.swift) rather than keeping a chain — and a label
    /// match — of its own.
    private var focusID: SessionRow.ID? {
        WorkspaceFocus.viewed(in: Workspace(state), pinned: selectedSessionID)
    }

    /// Remembered like the order above, for the same reason: a folded folder is a decision
    /// about the sidebar, and a relaunch used to unfold every one.
    @AppStorage("conch.collapsedFolders") private var storedCollapsedFolders = ""
    private var collapsedFolders: Set<String> {
        get { Set(storedCollapsedFolders.split(separator: "\n").map(String.init)) }
        nonmutating set { storedCollapsedFolders = newValue.sorted().joined(separator: "\n") }
    }
    /// The folder a header drag is currently over, for the tint that says "this slot".
    @State private var dropTargetFolderID: String?
    /// The order Tyler dragged the folders into, newline-joined like the other sidebar
    /// preferences (`conch.sidebarWidth`, `conch.sidebarCollapsed`) so it survives a relaunch;
    /// `WorkspaceModel` is in-memory and forgets everything at quit. The rule for what the
    /// order means — and why rows are not draggable — is ConchDesign/SessionGrouping.swift.
    @AppStorage("conch.folderOrder") private var storedFolderOrder = ""
    private var folderOrder: [String] {
        get { storedFolderOrder.split(separator: "\n").map(String.init) }
        nonmutating set { storedFolderOrder = newValue.joined(separator: "\n") }
    }
    /// Dismissed sessions start folded away, as the lab starts them (`showDismissed: false`).
    @State private var showsDismissed = false

    /// …except while an Undo is being offered: that button lives ON the dismissed row, so
    /// folding the group the instant you dismiss would take the undo with it.
    private var showsDismissedRows: Bool { showsDismissed || undoDismissal != nil }

    /// The rows grouped by the folder they run in. A folder the reader collapsed keeps its
    /// rows out of the list entirely, which is why the count moves onto its header.
    private var sessionFolders: [SessionFolder] {
        let grouped = SessionGrouping.folders(
            for: (state?.rows ?? []).map {
                ($0.id, $0.workFolder, $0.parentSessionId ?? $0.startedBySessionId)
            }
        )
        .map { folder in
            // A session started in the home folder headed the list with the account name —
            // "tylerstupart" — which reads like a project and is not one. Seen on the live
            // window, not in any test: every fixture uses a project path.
            guard folder.id == NSHomeDirectory() else { return folder }
            return SessionFolder(id: folder.id, name: "Home", sessionIDs: folder.sessionIDs)
        }
        return SessionGrouping.ordered(grouped, by: folderOrder)
    }

    /// A folder header dropped on another takes its slot (SessionGrouping.order). Anything
    /// else that lands here as text — a dragged selection from the transcript — is refused.
    private func dropFolder(_ items: [String], onto target: String) -> Bool {
        guard let dragged = items.first, dragged != target,
              sessionFolders.contains(where: { $0.id == dragged }) else { return false }
        let next = SessionGrouping.order(
            folderOrder, moving: dragged, onto: target, visible: sessionFolders.map(\.id)
        )
        // §4: a list changing shape is a morph, and Reduce Motion drops the bounce rather
        // than the move (mac-phase1-source.test.ts guards the form).
        withAnimation(ConchMotion.morph.animation(reduceMotion: reduceMotion)) { folderOrder = next }
        return true
    }

    private func rows(in folder: SessionFolder) -> [SessionRow] {
        guard let state else { return [] }
        let byID = Dictionary(state.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return folder.sessionIDs.compactMap { byID[$0] }
    }

    private func toggleFolder(_ folderID: String) {
        if collapsedFolders.contains(folderID) {
            collapsedFolders.remove(folderID)
        } else {
            collapsedFolders.insert(folderID)
        }
    }

    private var rowOrder: [SessionRow.ID] {
        guard let state else { return [] }
        return state.rows.map(\.id) + state.dismissedRows.map { "dismissed:\($0.id)" }
    }

    var body: some View {
        Group {
            if let state, !state.rows.isEmpty || !state.dismissedRows.isEmpty {
                ScrollViewReader { proxy in
                    TimelineView(.periodic(from: .now, by: 10)) { timeline in
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                // The way back to "everything".
                                //
                                // Escape released a selection, and Escape stops
                                // reaching the dashboard the moment a composer
                                // holds focus — which is now most of the time.
                                // With no way to deselect, manual mode stayed
                                // scoped to one session forever: Tyler "seem[ed]
                                // to lose the ability to pause the entire app
                                // once I've started using it". A keystroke that
                                // a text field can swallow is not an adequate
                                // home for the only exit from a mode.
                                AllSessionsRow(
                                    isSelected: selectedSessionID == nil,
                                    onSelect: actions.onReleaseSelection,
                                    onStart: actions.onStartSession
                                )

                                // Grouped by the folder each session runs in, so a dozen
                                // agents read as the two or three projects they are actually
                                // in. The rule — and the cases that make it interesting, two
                                // checkouts of one repo and a child whose folder differs from
                                // its parent's — is ConchDesign/SessionGrouping.swift.
                                ForEach(sessionFolders) { folder in
                                    if !folder.name.isEmpty {
                                        FolderHeader(
                                            name: folder.name,
                                            count: folder.sessionIDs.count,
                                            isCollapsed: collapsedFolders.contains(folder.id),
                                            isDropTarget: dropTargetFolderID == folder.id,
                                            onToggle: { toggleFolder(folder.id) }
                                        )
                                        // Drag a folder onto another to take its slot. Only
                                        // headers move: a row's place is its folder's place,
                                        // so there is nothing a row could be dragged to that
                                        // would not contradict where it runs.
                                        // ponytail: the payload is the path as plain text;
                                        // a custom UTType if a stray text drop ever misfires.
                                        .draggable(folder.id)
                                        .dropDestination(for: String.self) { items, _ in
                                            dropFolder(items, onto: folder.id)
                                        } isTargeted: { over in
                                            if over {
                                                dropTargetFolderID = folder.id
                                            } else if dropTargetFolderID == folder.id {
                                                dropTargetFolderID = nil
                                            }
                                        }
                                        .id("folder:\(folder.id)")
                                    }

                                    if !collapsedFolders.contains(folder.id) {
                                        ForEach(rows(in: folder), id: \.id) { row in
                                            DashboardRow(
                                                row: row,
                                                now: timeline.date,
                                                isSelected: selectedSessionID == row.id,
                                                isRenaming: renamingSessionID == row.id,
                                                renameDraft: $renameDraft,
                                                rowMessage: rowMessages[row.id],
                                                onSelect: { actions.onSelectSession(row) },
                                                onBeginRename: { actions.onBeginRename(row) },
                                                onCommitRename: { actions.onCommitRename(row) },
                                                onCancelRename: actions.onCancelRename,
                                                onDismiss: { actions.onDismiss(row) },
                                                // The starter's current label, so a rename
                                                // there reads through here (C15).
                                                startedByLabel: row.startedBySessionId.flatMap { id in
                                                    state.rows.first(where: { $0.id == id })?.label
                                                }
                                            )
                                            // Folder-style: a subagent sits under its parent (C4),
                                            // a started session under its starter (C15).
                                            .padding(.leading, row.parentSessionId == nil && row.startedBySessionId == nil ? 0 : 30)
                                            .id(row.id)
                                        }
                                    }
                                }

                                if !state.dismissedRows.isEmpty {
                                    // Dismissing a session is asking for it to be GONE. The app
                                    // kept every dismissed row on screen under a DISMISSED
                                    // divider, so dismissing moved a row down and greyed it
                                    // rather than removing it from the list.
                                    //
                                    // The lab folds them away and offers them back: a group
                                    // header with a reveal (line 998), `showDismissed: false` to
                                    // begin with. The same `FolderHeader` the folders use,
                                    // because this is the same gesture — a group you can fold —
                                    // and a second collapse mechanism is how two lists that
                                    // behave alike start behaving differently.
                                    FolderHeader(
                                        name: "Dismissed",
                                        count: state.dismissedRows.count,
                                        isCollapsed: !showsDismissedRows,
                                        onToggle: { showsDismissed.toggle() }
                                    )
                                    .id("dismissed-header")

                                    if showsDismissedRows {
                                        ForEach(state.dismissedRows, id: \.id) { row in
                                            DismissedDashboardRow(
                                                row: row,
                                                rowMessage: rowMessages[row.id],
                                                showsUndo: undoDismissal?.id == row.id,
                                                onUndo: actions.onUndoDismiss,
                                                onRestore: { actions.onRestore(row) }
                                            )
                                            .id("dismissed:\(row.id)")
                                        }
                                    }
                                }
                                RemoteMacGroups(onSelect: onSelectRemote)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 8)
                        }
                        .scrollIndicators(.visible)
                        .onAppear {
                            scrollToUndoOrFocus(proxy, animated: false)
                        }
                        .onChange(of: focusID) { _, _ in
                            scrollToUndoOrFocus(proxy, animated: true)
                        }
                        .onChange(of: rowOrder) { _, _ in
                            scrollToUndoOrFocus(proxy, animated: true)
                        }
                        .onChange(of: undoDismissal?.id) { _, _ in
                            scrollToUndoOrFocus(proxy, animated: true)
                        }
                        .onChange(of: rowMessages) { previous, current in
                            if undoDismissal != nil {
                                scrollToUndoOrFocus(proxy, animated: true)
                                return
                            }
                            let changedID = current.keys.sorted().first { id in
                                current[id] != previous[id] && current[id] != nil
                            }
                            guard let changedID,
                                  let targetID = rowTargetID(for: changedID) else {
                                return
                            }
                            scroll(proxy, to: targetID, animated: true)
                        }
                    }
                }
            } else {
                ScrollView {
                    VStack {
                        DashboardEmptyState(hasSnapshot: state != nil)
                        RemoteMacGroups(onSelect: onSelectRemote)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.bg)
    }

    private func scrollToFocus(_ proxy: ScrollViewProxy, animated: Bool) {
        guard let focusID else { return }
        scroll(proxy, to: focusID, animated: animated)
    }

    private func scrollToUndoOrFocus(
        _ proxy: ScrollViewProxy,
        animated: Bool
    ) {
        if let undoDismissal {
            scroll(
                proxy,
                to: "dismissed:\(undoDismissal.id)",
                animated: animated
            )
        } else {
            scrollToFocus(proxy, animated: animated)
        }
    }

    private func rowTargetID(for sessionID: SessionRow.ID) -> String? {
        guard let state else { return nil }
        if state.rows.contains(where: { $0.id == sessionID }) {
            return sessionID
        }
        if state.dismissedRows.contains(where: { $0.id == sessionID }) {
            return "dismissed:\(sessionID)"
        }
        return nil
    }

    private func scroll(
        _ proxy: ScrollViewProxy,
        to targetID: String,
        animated: Bool
    ) {
        if animated && !reduceMotion {
            withAnimation(.easeOut(duration: 0.18)) {
                proxy.scrollTo(targetID, anchor: .center)
            }
        } else {
            proxy.scrollTo(targetID, anchor: .center)
        }
    }
}

/// One folder's header in the session list.
///
/// The name is the shortest tail of the path no other folder on screen shares, so two
/// checkouts of one repo don't both read `conch`. Clicking it collapses the folder.
private struct FolderHeader: View {
    let name: String
    let count: Int
    let isCollapsed: Bool
    /// Another folder's header is being dragged over this one and will take its slot.
    var isDropTarget = false
    let onToggle: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                    // The chevron is chrome until you need it: it shows on hover, and stays
                    // put while collapsed so a folded folder never looks like a dead heading.
                    .opacity(hovering || isCollapsed ? 1 : 0.35)
                    .frame(width: 10)
                Text(name)
                    .font(ConchTypography.font(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if isCollapsed {
                    Text("\(count)")
                        .font(ConchTypography.font(size: 10, weight: .medium))
                        .monospacedDigit()
                }
            }
            // §3: textTertiary. A folder name is a place, not a thing to read.
            .foregroundStyle(ConchPalette.textFaint)
            .padding(.horizontal, 6)
            .padding(.top, 8)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The same ring the composer draws for a file drop (`ConchPalette.dropTarget`):
        // one drop colour for the whole window.
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(ConchPalette.dropTarget, lineWidth: isDropTarget ? 2 : 0)
        )
        .onHover { hovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isCollapsed ? "\(name), \(count) sessions, collapsed" : name)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct DashboardRow: View {
    /// `.row{height:var(--rowH)}` with `--rowH:30px`. The row is ONE line — mark, label,
    /// agent, summary, age, glyph — and carried 42, which is a line and a half of air. At
    /// a sidebar's usual height that is nine sessions you could not see.
    static let rowHeight: CGFloat = 30

    let row: SessionRow
    let now: Date
    let isSelected: Bool
    let isRenaming: Bool
    @Binding var renameDraft: String
    let rowMessage: String?
    let onSelect: () -> Void
    let onBeginRename: () -> Void
    let onCommitRename: () -> Void
    let onCancelRename: () -> Void
    let onDismiss: () -> Void
    /// The label of the session whose process started this one (C15); nil for
    /// a session nobody listed started.
    var startedByLabel: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovered = false
    @State private var reviewPulseOpacity = 0.0
    @State private var pulseTask: Task<Void, Never>?
    @FocusState private var renameFocused: Bool

    private var reviewIdentity: ReviewItem.ID? {
        ReviewItem(row: row)?.id
    }

    private var isDimmed: Bool {
        row.paused
    }

    private var isLiveSession: Bool {
        row.hasPublishedLiveState
    }

    private var inlineDetail: String {
        if let rowMessage, !rowMessage.isEmpty {
            return rowMessage
        }
        if let review = row.review {
            return review.summary
        }
        if row.status == .needs {
            return row.detail ?? ""
        }
        // Why a row has no terminal: a closed or app-server Codex thread, or
        // a background job no window is attached to.
        return row.noTerminal ?? ""
    }


    private var age: String? {
        // A working row ages from its status; only a ready deliverable ages from its filing.
        let timestamp = (row.status != .working ? row.review?.at : nil) ?? row.at
        return timestamp.flatMap { relativeAge(epochMilliseconds: $0, now: now) }
    }

    var body: some View {
        Group {
            if isRenaming {
                rowContent
            } else {
                Button(action: onSelect) {
                    rowContent
                }
                .buttonStyle(.plain)
                .help(row.label)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Self.rowHeight)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(
                        isSelected
                            ? ConchPalette.selection
                            : isHovered ? ConchPalette.hover : .clear
                    )

                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(ConchPalette.raised)
                    .opacity(reviewPulseOpacity)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        // Double-click renames, because renaming a thing by double-clicking its
        // name is what every file list has taught. It was reachable only from
        // the context menu, which means it was reachable only by someone who
        // already suspected it existed — Tyler asked for a feature conch has
        // had all along.
        //
        // Before the context menu, so the gesture wins over the row's own tap.
        .onTapGesture(count: 2, perform: onBeginRename)
        .contextMenu {
            Button("Rename", action: onBeginRename)
            Button("Dismiss", action: onDismiss)
        }
        .onHover { hovering in
            isHovered = hovering
        }
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.14),
            value: isHovered
        )
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.18),
            value: isSelected
        )
        .onChange(of: reviewIdentity) { previousIdentity, currentIdentity in
            guard previousIdentity != currentIdentity, currentIdentity != nil else {
                return
            }
            pulseForReview()
        }
        .onDisappear {
            pulseTask?.cancel()
        }
    }

    private var rowContent: some View {
        HStack(spacing: 8) {
            // Full brand cyan means "your mic is open". The rail was painting it
            // on speaking and transcribing rows too — a bigger patch of it than
            // the glyph — so it contradicted the very invariant the glyph sets.
            Capsule(style: .continuous)
                .fill(
                    LedgerVisual(row: row) == .listening || LedgerVisual(row: row) == .recording
                        ? ConchPalette.statusMicOpen
                        : ConchPalette.statusWorking
                )
                .frame(width: 3, height: 22)
                .opacity(isLiveSession ? 1 : 0)
                .frame(width: 10)
                .accessibilityHidden(true)

            // The mark leads the row, as it does in the lab (`${mark(v)}${label}`) and on the
            // phone (`SessionRowView`: the symbol, then the label). The Mac was the only one
            // of the three trailing it, hard right after the age — Tyler: "having the icons on
            // the left side of the items on the left sidebar ... seems to work a bit better".
            //
            // A scanning eye reads down the left edge. A verdict parked on the right is found
            // only after crossing the label and the summary, which is the wrong order for the
            // question this list answers: which of these needs me?
            //
            // `.mk{width:16px;height:16px}` — the 16 pt slot is unchanged, and so is every
            // colour and size: the glyph is deliberately NOT dimmed with the rest of the row,
            // because dimming a manual row once dropped its verdict to 2.45:1, and the pixel
            // answering "why is this one silent?" must not be the least legible thing on a
            // screen in a product whose failure mode IS silence.
            DashboardStatusGlyph(visual: LedgerVisual(row: row))
                .frame(width: 16)

            if isRenaming {
                TextField("Session name", text: $renameDraft)
                    .textFieldStyle(.plain)
                    .font(ConchTypography.font(size: 13.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .focused($renameFocused)
                    .onSubmit(onCommitRename)
                    .onExitCommand(perform: onCancelRename)
                    .frame(minWidth: 72, idealWidth: 104, maxWidth: 132)
                    .layoutPriority(4)
                    .accessibilityLabel("Rename \(row.label)")
                    .onAppear {
                        DispatchQueue.main.async {
                            renameFocused = true
                        }
                    }
            } else {
                Text(row.label)
                    // §3: 13 pt, and semibold when the row wants you. The sidebar's job is to
                    // show which sessions need a person without being read word by word.
                    // Same predicate the status mark already uses, rather than a third opinion
                    // about what "wants you" means.
                    .font(ConchTypography.font(
                        size: 13,
                        weight: row.status == .waiting || row.status == .needs ? .semibold : .medium
                    ))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .lineLimit(1)
                    // Sibling sessions share a prefix far more often than a
                    // suffix ("dayloop-feature-flags" vs "…-rollout"), so tail
                    // truncation made two different rows read identically. The
                    // distinguishing end survives a middle ellipsis.
                    .truncationMode(.middle)
                    .contentTransition(.opacity)
                    // The label is near-fixed prose and should size to its
                    // content; the deliverable summary beside it is the variable
                    // part and should take the flex. Hard-capping the label at
                    // 116pt did the opposite: "dayloop-feature…" truncated while
                    // "portal" left dead space, and the summary — the answer to
                    // "what did it make for me?" — was cut to "Rebuilt th…".
                    //
                    // Do NOT add .fixedSize here: it overrides the lineLimit and
                    // truncationMode above, so a long label runs over the age and
                    // draws straight through the status glyph. The higher
                    // layoutPriority already gets the label its ideal width and
                    // lets it truncate only when it genuinely cannot fit.
                    // No maxWidth: a frame with one is GREEDY — it expands to
                    // whatever it is offered, so the label claimed 190pt no
                    // matter how short it was and starved the summary down to
                    // "R…". A bare Text with lineLimit + truncationMode takes
                    // its ideal width and yields under real pressure, which is
                    // exactly the behaviour wanted. The age is protected by its
                    // own fixedSize + priority, not by capping this.
                    .frame(minWidth: 54, alignment: .leading)
                    .layoutPriority(1)
                    .opacity(isDimmed ? 0.58 : 1)
            }

            // A session another session started (C15): say by whom, in the
            // small type the summary uses. The agent badge that follows is
            // what tells a Claude-started Codex from its starter at a glance.
            if let startedByLabel, !isRenaming {
                Text("started by \(startedByLabel)")
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityLabel("Started by \(startedByLabel)")
                    .opacity(isDimmed ? 0.58 : 1)
            }

            if row.prioritized {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 5.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textDim.opacity(0.82))
                    .accessibilityLabel("Prioritized")
                    .help("Prioritized")
            }

            AgentBadge(backend: row.backend)

            // NEITHER of these two may carry a maxWidth frame. A frame with a
            // maxWidth — 190 or .infinity alike — is GREEDY: it expands to
            // whatever it is offered and then may not use it. Capping the label
            // starved the summary to "R…"; giving the summary .infinity and a
            // higher priority simply inverted it, pinning every label to its
            // 54pt floor so two different sessions both read "daylo…".
            //
            // With equal priority and no greedy frame, HStack sizes the less
            // flexible child (the label, small ideal) to its ideal and passes
            // the remainder to the summary; under real pressure they split.
            if !inlineDetail.isEmpty {
                Text(inlineDetail)
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(
                        rowMessage == nil
                            ? ConchPalette.textDim
                            : ConchPalette.statusNeeds.opacity(0.90)
                    )
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .layoutPriority(rowMessage == nil ? 1 : 5)
                    .accessibilityLabel(inlineDetail)
                    .help(inlineDetail)
                    .opacity(isDimmed ? 0.58 : 1)
            }

            // Always trails, so the age and glyph stay hard right whether or not
            // this row has a summary.
            Spacer(minLength: 0)


            if let age {
                Text(age)
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                    .monospacedDigit()
                    .lineLimit(1)
                    // The age had no truncationMode and lost the layout fight to
                    // a long label, so it was CLIPPED mid-string: a session that
                    // finished 10 minutes ago rendered "1". On a dashboard whose
                    // job is "who has been waiting longest", a plausible wrong
                    // number is worse than no number. It is short and fixed —
                    // it should never be the thing that gives way.
                    .truncationMode(.tail)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(4)
                    .opacity(isDimmed ? 0.58 : 1)
            }

        }
        .padding(.trailing, 4)
        .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func pulseForReview() {
        pulseTask?.cancel()
        guard !reduceMotion else { return }

        reviewPulseOpacity = 0
        withAnimation(.easeOut(duration: 0.12)) {
            reviewPulseOpacity = 1
        }

        pulseTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 180_000_000)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.34)) {
                reviewPulseOpacity = 0
            }
        }
    }
}

/// Internal, not file-private: the composer's destination chip draws one too.
struct AgentBadge: View {
    let backend: String?

    private var label: String {
        switch backend?.lowercased() {
        // Claude sessions predate the backend field. Treating absence as
        // Claude keeps old live rows identified instead of making only Codex
        // earn a mark after upgrading one half of the pair.
        case nil, "", "claude": return "Claude"
        case "codex": return "Codex"
        default: return backend?.capitalized ?? "Claude"
        }
    }

    /// A mark, not a word in a box.
    ///
    /// The name in a stroked pill read as a label to be parsed — two of them in
    /// a list and you are reading "Claude" and "Codex" over and over to learn
    /// something you only need peripherally. A glyph is recognised without
    /// being read.
    ///
    /// The real marks, as template images.
    ///
    /// SF Symbols stand-ins — an asterisk and a hexagon — were close enough to
    /// describe and not close enough to recognise, which defeats the point of a
    /// glyph. These are the actual burst and knot, lifted from the installed
    /// apps' own icons and reduced to alpha, so SwiftUI tints them like any
    /// symbol and one asset serves grey here and any colour later.
    private var asset: String {
        backend?.lowercased() == "codex" ? "AgentCodex" : "AgentClaude"
    }

    var body: some View {
        Image(asset)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(ConchPalette.textFaint)
            // Fixed box so both marks occupy identical space: the burst is
            // square and the knot is not, and letting each size itself left
            // the gap to the session name visibly different per row.
            .frame(width: 11, height: 11)
            .help(label)
            .accessibilityLabel("Agent: \(label)")
    }
}

private struct SessionContextMeter: View {
    let context: SessionContext

    private var fill: Color {
        // Only two bands can reach the screen now that the meter is not drawn below 85%;
        // the quiet third colour it used to carry went with the rows it used to sit on.
        // `statusWaiting` is (0.96,0.60,0.13) against the lab's `--listening:#FF9F0A` —
        // the same orange to the eye, so the escalation at 97% stays as it is rather than
        // being flattened by a px pass that has no business picking the state colours.
        context.fraction >= 0.97 ? ConchPalette.statusNeeds : ConchPalette.statusWaiting
    }

    private var label: String {
        "\(Self.tokens(context.usedTokens)) / \(Self.tokens(context.limitTokens))"
    }

    var body: some View {
        // A number, not a bar, and only where you have already committed to
        // looking at one session.
        //
        // Tyler: "it adds visual clutter and a lot of importance to a not super
        // important piece of data". A filled capsule beside every session name
        // gave context pressure the same weight as the session itself, on the
        // one surface you scan constantly. Colour still carries the warning,
        // because that is the part worth interrupting for.
        // `.ctxwarn{font-size:12px;color:var(--listening)}`, and §5: "87% context at 85% and
        // above". Below that it is not drawn at all — which is Tyler's own complaint about it
        // ("a lot of importance to a not super important piece of data") carried further than
        // colour alone could.
        if context.fraction >= 0.85 {
            Text("\(Int((context.fraction * 100).rounded()))% context")
                .font(ConchTypography.font(size: 12))
                .foregroundStyle(fill)
                .monospacedDigit()
                .fixedSize()
                .help("Context \(label) tokens · \(Int((context.fraction * 100).rounded()))% full")
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Context \(label) tokens")
                .accessibilityValue("\(Int((context.fraction * 100).rounded())) percent full")
        }
    }

    private static func tokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            return String(format: "%.1fm", Double(count) / 1_000_000)
                .replacingOccurrences(of: ".0m", with: "m")
        }
        if count >= 1_000 {
            return String(format: "%.0fk", Double(count) / 1_000)
        }
        return String(count)
    }
}


private struct DismissedDashboardRow: View {
    let row: DismissedSessionRow
    let rowMessage: String?
    let showsUndo: Bool
    let onUndo: () -> Void
    let onRestore: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "minus")
                .font(.system(size: 8, weight: .medium))
                .frame(width: 10)
                .accessibilityHidden(true)

            Text(row.label)
                .font(ConchTypography.font(size: 12.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 126, alignment: .leading)

            if let rowMessage, !rowMessage.isEmpty {
                Text(rowMessage)
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel(rowMessage)
            } else {
                Spacer(minLength: 0)
            }

            if showsUndo {
                Button("Undo", action: onUndo)
                    .buttonStyle(.plain)
                    .font(ConchTypography.font(size: 10.5, weight: .medium))
                    .foregroundStyle(ConchPalette.statusWaiting)
                    .padding(.horizontal, 8)
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
                    .accessibilityHint("Restores the dismissed session")
            }
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, minHeight: DashboardRow.rowHeight)
        .foregroundStyle(ConchPalette.textDim)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(isHovered ? ConchPalette.hover.opacity(0.62) : .clear)
        )
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .opacity(0.62)
        .grayscale(1)
        .contextMenu {
            Button("Restore", action: onRestore)
        }
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Dismissed session \(row.label)")
    }
}

private struct DashboardStatusGlyph: View {
    let visual: LedgerVisual

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            ForEach(LedgerVisual.allCases) { candidate in
                Image(systemName: candidate.symbol)
                    .font(.system(size: candidate.symbolSize, weight: .medium))
                    .foregroundStyle(candidate.color)
                    .opacity(candidate == visual ? 1 : 0)
            }
        }
        .frame(height: 16)
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.25),
            value: visual
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(visual.accessibilityLabel)
        .help(visual.accessibilityLabel)
    }
}

private enum LedgerVisual: String, CaseIterable, Identifiable {
    case idle
    case working
    case waiting
    case needs
    case review
    case manual
    case speaking
    case listening
    case recording
    case transcribing

    var id: String { rawValue }

    init(status: RowStatus?) {
        switch status {
        case .working:
            self = .working
        case .waiting:
            self = .waiting
        case .needs:
            self = .needs
        case .review:
            self = .review
        case .none, .unknown:
            self = .idle
        }
    }

    init(row: SessionRow) {
        // The deliverable stays on a working row, but the mark means "waiting
        // for you to look", which a working session is not.
        if (row.review != nil && row.status != .working) || row.status == .review {
            self = .review
            return
        }
        // A mode glyph must not hide work waiting on the person. The row's dimmed
        // label already carries manual mode; waiting and needs-response keep the
        // more consequential glyph.
        let wantsUser = row.status == .waiting || row.status == .needs
        if row.paused, !wantsUser {
            self = .manual
            return
        }
        switch row.live {
        case "speaking":
            self = .speaking
        case "listening":
            self = .listening
        case "recording":
            self = .recording
        case "transcribing":
            self = .transcribing
        default:
            self.init(status: row.status)
        }
    }

    var symbol: String {
        switch self {
        case .idle:
            return "circle.dotted"
        case .working:
            return "circle.fill"
        case .listening:
            // Was identical to .working, so the ledger could not tell you
            // whether your MICROPHONE was open — the single most consequential
            // distinction in a voice product.
            return "mic.fill"
        case .waiting:
            return "circle.inset.filled"
        case .needs:
            // A bare hairline glyph carried the most urgent state while calmer
            // states were filled discs — urgency rising as ink fell.
            return "exclamationmark.circle.fill"
        case .review:
            // A CHECK, not a star. The lab draws this mark as `ic('check')` on
            // `--ready` (line 895) and §5 calls it "`ready` green circle with
            // ✓"; the star was the app's own invention, and it read as
            // "favourite" on the one surface scanned most.
            return "checkmark.circle.fill"
        case .manual:
            return "pause.fill"
        case .speaking:
            return "play.fill"
        case .recording:
            return "record.circle.fill"
        case .transcribing:
            return "ellipsis"
        }
    }

    var symbolSize: CGFloat {
        switch self {
        case .needs, .review, .recording:
            return 10.5
        case .manual, .speaking:
            return 9
        case .transcribing:
            return 11
        case .listening:
            return 10
        case .idle, .working, .waiting:
            return 8
        }
    }

    var color: Color {
        switch self {
        case .working:
            return ConchPalette.statusWorking
        case .listening:
            // Full brand cyan is reserved for "your mic is open" — the state
            // with the highest cost of being wrong about.
            return ConchPalette.statusMicOpen
        case .waiting:
            return ConchPalette.statusWaiting
        case .needs:
            return ConchPalette.statusNeeds
        case .review:
            return ConchPalette.statusReview
        case .speaking:
            // Speaking is LIVENESS, not a demand. Sharing gold with .review left
            // the one colour that means "act" claimed by a session merely
            // talking, so a real review no longer stood out.
            return ConchPalette.statusWorking
        case .recording:
            return ConchPalette.statusMicOpen
        case .transcribing:
            return ConchPalette.statusWorking.opacity(0.78)
        case .idle:
            return ConchPalette.textFaint
        case .manual:
            // "Why is this one silent?" is a question the user actually asks;
            // textFaint answered it at 2.63:1, below AA.
            return ConchPalette.textDim
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .idle:
            return "Idle"
        case .working:
            return "Working"
        case .waiting:
            return "Waiting for you"
        case .needs:
            return "Needs a response"
        case .review:
            return "Needs review"
        case .manual:
            return "Manual"
        case .speaking:
            return "Speaking"
        case .listening:
            return "Mic open"
        case .recording:
            return "Recording"
        case .transcribing:
            return "Transcribing"
        }
    }
}

private struct ConversationPane: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: PublishedState?
    let onSelectSession: (SessionRow) -> Void

    @EnvironmentObject private var store: StateStore
    /// The one owner of which session is being looked at, which one the voice is on, where a
    /// message goes, and how each session is presented (ConchDesign/Workspace.swift).
    @EnvironmentObject private var workspace: WorkspaceModel
    @StateObject private var transcriptContent = TranscriptContentModel()
    /// Shared with the conversation fog (M3): one draft per session wherever it is typed.
    @ObservedObject private var composerDrafts = ComposerDraftStore.shared
    /// `.ib:hover` for the session-actions menu, which a `Menu` label does not get for free.
    @State private var isHoveringActions = false
    @State private var sessionPendingClose: SessionRow?
    /// How tall the composer is right now — it grows with lines and attachments, so this is
    /// measured rather than guessed. The transcript leaves exactly this much room beneath its
    /// last message, which is what lets the content scroll UNDER the card and still be read.
    @State private var composerHeight: CGFloat = 0
    /// Bumped when a question's "Something else…" row is pressed, so the
    /// composer takes the cursor.
    @State private var composerFocusRequest = 0
    /// The session whose capabilities are being inspected, if any.
    @State private var inspectingSession: SessionRow?
    @State private var debugExpandInspector = false
    /// A link in the fallback (AppKit) conversation renderer that would not
    /// open, shown under it in the OS's own words (A13).
    @State private var fallbackLinkFailure: String?
    /// The address the deliverable pane is showing, published upward by it. The arrow and ⌘3
    /// both open THIS, so neither can send you back to a page you already left.
    @State private var deliverableAddress: String?
    /// §3: the header grows a hairline only once the transcript has scrolled under it.
    @State private var transcriptScrolled = false

    /// Which page this session is on: false = the deliverable in front.
    ///
    /// Per session, and moved only by an explicit choice — the perspective control, or
    /// opening the artifact from its inline preview. A newly filed artifact used to set this
    /// back to the conversation, which takes someone off the deliverable they were
    /// inspecting; new work must not replace what you are reading. It still arrives as a
    /// preview inline in the conversation, which is how it asks to be looked at.
    private func stage(for row: SessionRow?) -> StageMode {
        workspace.presentation(for: row?.id).stage
    }

    /// What the mic is doing FOR THIS ROW, by identity.
    ///
    /// The composer is built per row, and its mic both draws from this and acts on it — so a
    /// row the voice is not on must report nothing, or every open composer mirrors the same
    /// words, which reads as though conch is about to send them everywhere. Which session the
    /// voice is on comes from the daemon's published live state rather than from a name: a
    /// label can be changed, and two sessions can share one.
    private func voiceState(for row: SessionRow) -> String {
        workspace.voiceState(of: row, in: state)
    }

    private func voiceLevel(for row: SessionRow) -> Double {
        workspace.voiceLevel(of: row, in: state)
    }

    /// The words being transcribed, in the composer they were spoken into and nowhere else.
    private func dictation(for row: SessionRow) -> String {
        workspace.dictation(of: row, in: state)
    }

    /// The session the reader PICKED, which can be a subagent the daemon no longer lists.
    private var selectedRow: SessionRow? {
        guard let id = workspace.viewing else { return nil }
        return state?.row(id) ?? subagentRow(id: id)
    }

    /// A subagent opened from the block that started it, when the daemon lists
    /// no row for it (C4). The daemon publishes rows only for agents still in
    /// flight, but the transcript of a finished one is still on disk and the
    /// tool block still names it — so the pane builds the row from that block
    /// and reads the transcript the way it reads any session's last reply.
    private func subagentRow(id: SessionRow.ID) -> SessionRow? {
        guard let conversations = state?.conversations else { return nil }
        for conversation in conversations.values {
            guard let item = conversation.items.first(where: { $0.tool?.subagent?.id == id }) else {
                continue
            }
            return SessionRow(
                id: id,
                label: item.text.isEmpty ? id : item.text,
                backend: "claude",
                status: nil,
                at: nil,
                needsResponse: false,
                detail: nil,
                review: nil,
                paused: false,
                live: nil,
                active: false,
                snippet: nil,
                transcriptPath: item.tool?.subagent?.transcriptPath,
                voice: nil,
                prioritized: false,
                navSelected: false,
                parentSessionId: conversation.sessionId
            )
        }
        return nil
    }

    /// What the pane is showing: the reader's pick, else the session the voice is on, else
    /// the work. The chain itself lives in ConchDesign/Workspace.swift, where the overlay
    /// reads it too — one decision, not two that drift.
    private var focusedRow: SessionRow? {
        selectedRow ?? workspace.viewedRow(in: state)
    }

    private var selectedReview: ReviewItem? {
        // The pane's contract is "show the FOCUSED session's content" — and a
        // review is that session's content. Requiring an explicit selection
        // here (alone of all the pane's surfaces) meant the review you were
        // just pinged about was invisible when the window opened, until you
        // clicked the row that was already in front of you.
        let held = deliverables
        guard !held.isEmpty else { return nil }
        // The reader's pick while the session still holds it, else the newest — the rule is
        // shared, because the phone will answer this the same way (ConchDesign/Workspace).
        let shown = SessionPresentation.shown(
            in: held.map(\.id),
            picked: workspace.presentation(for: focusedRow?.id).selectedDeliverable
        )
        return held.first { $0.id == shown } ?? held.last
    }

    /// The session's working folder, when it has one worth opening.
    ///
    /// A session conch merely observes may report none, and a tree rooted at nothing is a
    /// promise the pane cannot keep — the same rule the deliverable pages already follow.
    private var workingFolder: String? {
        guard let folder = focusedRow?.workFolder, !folder.isEmpty else { return nil }
        return folder
    }

    /// Is there anything to put in the work half at all?
    ///
    /// This used to be "is there a deliverable", which is why Cmd-2 and Cmd-3 did nothing in a
    /// session that had not filed one — even though its files were there the whole time.
    private var hasWorkPane: Bool { selectedReview != nil || workingFolder != nil }

    /// How much of a side-by-side stage the CONVERSATION gets.
    ///
    /// This reverses "two equal claims on the width, rather than a measured fraction". Half
    /// each was right while the two halves were interchangeable; they are not any more — a
    /// file tree and a terminal want width that a transcript does not, and which one needs it
    /// changes with what you are doing. Tyler: "drag the center diviger ... to change the
    /// proportions given to the left and right panels".
    ///
    /// Bounded so neither half can be dragged away to nothing, and remembered like the
    /// sidebar's width rather than per session: it is a preference about how you read, not a
    /// fact about one conversation.
    @AppStorage("conch.splitFraction") private var storedSplitFraction = 0.5
    @State private var splitDrag: CGFloat = 0
    /// All the way to either edge, on purpose.
    ///
    /// Filling the stage stopped being a MODE: the way to see only the deliverable is to pull
    /// the conversation off the left of the divider, and the way back is to pull it out again.
    /// Clamping at 0.25 made the thing the user asked for impossible by construction. Tyler:
    /// "there's no like full view artifact in the app unless you like pull the convo part of
    /// the panel view down to 0 and have the sidebar closed". The resizer keeps its 10 pt grab
    /// area at either end, so a half dragged to nothing can always be dragged back.
    private static let splitBounds: ClosedRange<Double> = 0...1

    private func splitFraction(in width: CGFloat) -> Double {
        guard width > 0 else { return storedSplitFraction }
        let dragged = storedSplitFraction + Double(splitDrag / width)
        return min(max(dragged, Self.splitBounds.lowerBound), Self.splitBounds.upperBound)
    }

    /// The divider, and the ten points either side of it that answer the pointer.
    ///
    /// A one-point target is a target you miss, so the hairline draws at 1 and the grab area
    /// is 10 — the same split the sidebar's resizer already uses.
    private func splitResizer(in width: CGFloat) -> some View {
        Rectangle()
            .fill(ConchPalette.divider)
            .frame(width: 1)
            .overlay(
                Rectangle()
                    .fill(Color.clear)
                    // 16 against a 1 pt line: the visible hairline stays hairline-thin, and
                    // only the invisible target grows. Same reasoning as the sidebar's, and the
                    // same ceiling — the transcript selects text right up to this edge.
                    .frame(width: 16)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
                    }
                    .gesture(
                        DragGesture(coordinateSpace: .global)
                            .onChanged { splitDrag = $0.translation.width }
                            .onEnded { _ in
                                storedSplitFraction = splitFraction(in: width)
                                splitDrag = 0
                            }
                    )
            )
            .accessibilityLabel("Resize the split between the conversation and the work")
    }

    /// More than one thing to choose between, so the strip is worth drawing.
    private func hasWorkTabs(for row: SessionRow) -> Bool {
        // A working folder is worth TWO: the files in it, and a terminal running in it.
        // Artifacts count, not filings: six versions of one page are one tab. A lone tab with
        // older versions under it is still drawn, or those versions could not be reached at all.
        let groups = deliverableGroups
        return groups.count + (workingFolder == nil ? 0 : 2) > 1 || groups.contains(where: \.hasOlderVersions)
    }

    /// Which content the work half is on, never trusting the remembered choice blindly: a
    /// session that has been asked for its files and then loses its folder falls back to the
    /// deliverable rather than showing an empty tree.
    private func workPane(for row: SessionRow) -> WorkPane {
        let chosen = workspace.presentation(for: row.id).work
        if chosen == .files, workingFolder != nil { return .files }
        // A terminal needs somewhere to run as much as a tree needs somewhere to read.
        if chosen == .terminal, workingFolder != nil { return .terminal }
        if selectedReview != nil { return .deliverable }
        return workingFolder != nil ? .files : .deliverable
    }

    /// What this session changed, resolved against its own folder.
    ///
    /// Read from the conversation the daemon published FOR THIS ROW, with the same session
    /// check the transcript uses: the daemon publishes one conversation at a time, and marking
    /// another session's edits on this session's tree would be a confident lie about work.
    private func changedFiles(for row: SessionRow) -> ConchFileChanges {
        let conversation = state?.conversations?[row.id] ?? state?.conversation
        let items = conversation?.sessionId == row.id ? conversation?.items ?? [] : []
        return ConchFileChanges(
            changed: items.compactMap { $0.change?.path },
            relativeTo: row.workFolder ?? ""
        )
    }

    /// The work half's content: the files, or the deliverable.
    ///
    /// One builder called from both stages, so side-by-side and fill-the-stage cannot drift
    /// into showing different things.
    @ViewBuilder
    private func workContent(for row: SessionRow) -> some View {
        if workPane(for: row) == .files, let folder = workingFolder {
            WorkspaceFilesView(root: folder, rowID: row.id, changed: changedFiles(for: row))
        } else if workPane(for: row) == .terminal, let folder = workingFolder {
            // Keyed on the session: a shell started in one session's folder must never be
            // handed to another because SwiftUI reused the view.
            TerminalPaneView(cwd: folder).id(row.id)
        } else if let selectedReview {
            InlineReviewView(
                item: selectedReview,
                onOpenInPlace: openDeliverableInPlace,
                liveAddress: $deliverableAddress
            )
            // Only the WEB pane publishes an address, but this state belongs to the pane, which
            // outlives the deliverable it was showing. So opening a web deliverable and then
            // switching to an image left the last URL sitting here, and the arrow opened that
            // instead of the image. Tyler: "sometimes it just opens the browser not to the
            // things was looking at at all".
            //
            // Both hooks, because they cover different routes back: `onChange` for switching
            // between deliverable tabs, `onAppear` for returning from the Files or Terminal tab,
            // where this view was gone and onChange never fires.
            .onChange(of: selectedReview.id) { _, _ in deliverableAddress = nil }
            .onAppear { deliverableAddress = nil }
        }
    }

    /// Every deliverable the focused session is still holding, oldest first: one tab each.
    /// A daemon too old to send them all yields the single newest, which is today's behaviour.
    private var deliverables: [ReviewItem] {
        guard let row = focusedRow else { return [] }
        let held = row.reviews ?? row.review.map { [$0] } ?? []
        return held.map { ReviewItem(row: row, review: $0) }
    }

    /// The same deliverables as ARTIFACTS: every filing of one link is a version of one thing.
    /// The rule is shared and tested in ConchDesign/Workspace, not decided here.
    private var deliverableGroups: [DeliverableGroup] {
        DeliverableGroups.grouped(deliverables.map { DeliverableVersion(id: $0.id, link: $0.link) })
    }

    private var watchesTranscriptForRow: SessionRow? {
        // A row keyed per window (`<id>#<pid>`) shares its transcript with
        // another window, and only the daemon can tell whose branch is whose
        // (A8). Reading the file here would show whichever wrote last, so
        // such a row shows its own snippet until the daemon's stack arrives.
        selectedReview == nil && !isFocusedSessionLive && focusedRow?.id.contains("#") != true
            ? focusedRow
            : nil
    }

    /// Is the session in front of the reader the one the voice is on? They are allowed to
    /// differ: that is what dictating to one session while reading another looks like.
    private var isFocusedSessionLive: Bool {
        workspace.isAddressed(focusedRow, in: state)
    }

    private var document: ConversationDocument {
        ConversationDocument(
            state: state,
            targetRow: focusedRow,
            isTargetLive: isFocusedSessionLive,
            staticContent: transcriptContent.content(for: focusedRow)
        )
    }

    /// The deliverable, handed to whatever actually owns it.
    ///
    /// Direction, 2026-09-19: "Full screen means the deliverable's own home, not conch's."
    /// The old third page filled the conch window, which is not leaving the app — it just
    /// made conch bigger. This opens the browser for a URL and the file's own app for a file
    /// (`openLink` resolves both, and checks a file is reachable before LaunchServices can
    /// put up a dialog of its own), and leaves the pane exactly where it was, so what you
    /// were reading is still behind it.
    ///
    /// Reuses the conversation's failure line rather than inventing a second one.
    private func openDeliverableInPlace() {
        guard let review = selectedReview, let link = review.link else { return }
        fallbackLinkFailure = nil
        // Where the pane is, falling back to what was filed for a deliverable that cannot browse.
        let target = deliverableAddress ?? link
        store.openLink(target, cwd: focusedRow?.cwd, rowId: focusedRow?.id) { fallbackLinkFailure = $0 }
    }

    private var note: String? {
        switch state?.live.state {
        case "speaking":
            return "space to cut in · the mic opens when it finishes"
        case "listening", "recording":
            // "pause to send" meant a pause in your SPEECH, but conch also has
            // a pause mode, so it read as a control — Tyler: "it also says
            // 'pause to send' but idk what they means."
            return "stop talking to send · space to cancel · say \"send\" to submit now"
        case "transcribing":
            return "transcribing…"
        default:
            return nil
        }
    }

    var body: some View {
        Group {
            if let reviewRow = focusedRow, hasWorkPane, stage(for: reviewRow) != .conversation {
                VStack(spacing: 0) {
                    sessionBar(for: reviewRow)

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)

                    if hasWorkTabs(for: reviewRow) {
                        deliverableTabs(for: reviewRow)

                        Rectangle()
                            .fill(ConchPalette.divider)
                            .frame(height: 1)
                    }

                    if stage(for: reviewRow) == .sideBySide {
                        // OVER the split, the way the conversation page floats it over the
                        // transcript (#334). As a sibling under the HStack it took its own height
                        // off both halves and cut the transcript at its top edge — Tyler: "the
                        // input panel is still creating that cutoff blank space on the panels
                        // view (we fixed it on the conversation view)".
                        //
                        // The room goes to the conversation half alone, through `bottomInset`:
                        // that is the half that can scroll under the card. The work half cannot —
                        // a terminal's prompt and a page's last lines sit on its bottom edge, and
                        // there is no inset to hand a web view or a PDF — so it ends above the
                        // card, as it did. The card stays centred on the stage rather than on the
                        // conversation column: the split reaches 0, and a card that followed the
                        // column would leave with it on the very page a deliverable is answered from.
                        ZStack(alignment: .bottom) {
                            // A dragged fraction, not half each. The conversation is sized and the
                            // work takes the rest, so the two cannot disagree about the total by a
                            // rounding point and leave a seam.
                            GeometryReader { split in
                                HStack(spacing: 0) {
                                    conversationBody(for: reviewRow)
                                        .frame(width: max(0, split.size.width * splitFraction(in: split.size.width)))

                                    splitResizer(in: split.size.width)

                                    workContent(for: reviewRow)
                                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                                        .padding(.bottom, composerHeight)
                                }
                            }

                            floatingComposer(for: reviewRow)
                        }
                    } else {
                        workContent(for: reviewRow)

                        Spacer(minLength: 0)

                        floatingComposer(for: reviewRow)
                    }
                }
            } else {
                VStack(spacing: 0) {
                    if let row = focusedRow {
                        sessionBar(for: row)

                        // §3: only once the transcript has scrolled. A rule under a header
                        // with nothing above it is just a line. The deliverable pages keep
                        // theirs unconditionally — there a pane IS open, which is the spec's
                        // other reason for drawing it.
                        if transcriptScrolled {
                            Rectangle()
                                .fill(ConchPalette.divider)
                                .frame(height: 1)
                        }
                    }

                    // Typing belongs where you are reading. Putting the composer
                    // here rather than in a separate panel means the reply you
                    // are answering is directly above the field you answer in.
                    // A subagent has no pane of its own to type into (C4).
                    //
                    // OVER the transcript rather than above it: the card is narrower than the
                    // pane, so the text either side of it stays readable and the rule across
                    // its top reads as the page continuing behind it rather than stopping at
                    // it. Tyler: "we should just be able to see the content where its not
                    // covered by the input box." The room it needs is handed to the stack as
                    // `bottomInset`, so nothing is hidden — it is scrolled past, not cut off.
                    ZStack(alignment: .bottom) {
                        conversationBody(for: focusedRow)

                        if let row = focusedRow, row.parentSessionId == nil {
                            floatingComposer(for: row)
                        }
                    }
                }
            }
        }
        // §4: the stage's pages are a big view changing shape, so they move on `morph`
        // (bounce 0.12, response 0.46). They did not move at all before — the deliverable
        // replaced the conversation between one frame and the next.
        .animation(ConchMotion.morph.animation(reduceMotion: reduceMotion), value: stage(for: focusedRow))
        // Inside the stage panel, so it paints the panel's surface. Painting the window ground
        // here covered the panel's own fill: right shape, wrong colour.
        .background(ConchPalette.surface)
        .onReceive(NotificationCenter.default.publisher(for: .setStage)) { note in
            // Only where there is somewhere to go: with no deliverable filed, side by side is
            // a promise the pane cannot keep — the same reason the perspective bar draws
            // nothing until there is one.
            guard let mode = note.object as? StageMode, let row = focusedRow else { return }
            guard mode == .conversation || hasWorkPane else { return }
            workspace.show(stage: mode, for: row.id)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openDeliverableInPlace)) { _ in
            openDeliverableInPlace()
        }
        .task(id: TranscriptWatchID(row: watchesTranscriptForRow)) {
            await transcriptContent.monitor(row: watchesTranscriptForRow)
        }
        .onChange(of: state?.live.dictated?.id) { _, _ in
            // Spoken words land in the composer, added to whatever was typed.
            // Keyed on the dictation's id for the same reason the review above
            // is keyed on identity: the daemon republishes constantly, and
            // anything keyed on the TEXT would re-append it every frame.
            //
            // Delivered to the session that ASKED, never to whatever is focused
            // now. Transcription takes seconds; a person who starts dictating
            // to one session and clicks another while it runs was addressing
            // the first one, and putting the words in the second is worse than
            // losing them.
            composerDrafts.apply(state?.live.dictated)
        }
        .alert(
            "Close \(sessionPendingClose?.label ?? "session")?",
            isPresented: Binding(
                get: { sessionPendingClose != nil },
                set: { if !$0 { sessionPendingClose = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) {
                sessionPendingClose = nil
            }
            Button("Close Session", role: .destructive) {
                guard let row = sessionPendingClose else { return }
                sessionPendingClose = nil
                store.closeSession(row)
            }
        } message: {
            Text("conch will ask the agent to exit cleanly. Its transcript stays available to resume later.")
        }
        .sheet(item: $inspectingSession) { row in
            CapabilityInspectorSheet(row: row, expandAll: debugExpandInspector) {
                inspectingSession = nil
                debugExpandInspector = false
            }
        }
        .onChange(of: store.debugInspectRequest) { _, wanted in
            guard let wanted else { return }
            store.debugInspectRequest = nil
            // A trailing "!" asks for every row open — a capture proving what
            // the detail renders, not a state any click can reach.
            let expand = wanted.hasSuffix("!")
            debugExpandInspector = expand
            let target = expand ? String(wanted.dropLast()) : wanted
            let rows = store.state?.rows ?? []
            inspectingSession = target.isEmpty
                ? selectedRow ?? rows.first
                : rows.first { $0.id == target || $0.id.hasPrefix(target) || $0.label == target }
        }
    }

    private func sessionTitle(_ row: SessionRow) -> some View {
        Text(row.label)
            // `.ttl{font:600 14px;letter-spacing:-.01em}` — it was 12.5 medium, a size the
            // header's own meta text could match. This is the line that says what you are
            // looking at, so it outranks everything beside it.
            .font(ConchTypography.font(size: 14, weight: .semibold))
            .tracking(-0.14)
            .foregroundStyle(ConchPalette.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    /// Close lives behind the least accidental control in the pane, while the
    /// identity and context pressure remain visible without interaction.
    private func sessionBar(for row: SessionRow) -> some View {
        HStack(spacing: 8) {
            // The way back from a subagent to the session it runs inside (C4).
            if let parentID = row.parentSessionId,
               let parent = state?.rows.first(where: { $0.id == parentID }) {
                Button { onSelectSession(parent) } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(ConchPalette.textDim)
                        .frame(width: 20, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Back to \(parent.label)")
                .accessibilityLabel("Back to \(parent.label)")
            }

            // Click the title to raise the session's terminal (C10). It is a
            // button only when the daemon knows the process: a session conch
            // merely observes has nothing to raise and must not look clickable.
            if row.revealable {
                Button { store.reveal(row) } label: { sessionTitle(row) }
                    .buttonStyle(.plain)
                    .help("Bring this session's terminal to the front")
                    .accessibilityLabel("Bring \(row.label) to the front")
            } else {
                sessionTitle(row)
            }

            AgentBadge(backend: row.backend)

            Spacer(minLength: 8)

            if let context = row.context, context.limitTokens > 0 {
                SessionContextMeter(context: context)
                    .fixedSize(horizontal: true, vertical: false)
            }

            // The view switch, and only when there is a deliverable (§3). With nothing on
            // the other side the control is a promise the header cannot keep.
            //
            // Icons alone here, where the bar below could afford words: labelled segments
            // measure far too wide for a header whose job is the title. The old lone-control
            // worry does not apply to a track where the selected position is filled — you can
            // see where you are without decoding anything, which was the actual point.
            //
            // TWO positions now, not three. Filling the conch window was never leaving it, so
            // it stopped being a page you switch to and became an arrow on the deliverable
            // itself. Chat and panel are the in-app toggles; the third door leads OUT.
            if hasWorkPane {
                // `.seg{padding:2px;border-radius:8px;background:var(--fill);gap:1px;margin-right:4px}`.
                // Loose buttons read as unrelated controls; one track with the selected
                // position filled reads as one control that knows where it is.
                HStack(spacing: 1) {
                    PerspectiveOption(
                        label: "Conversation",
                        symbol: "text.bubble",
                        isSelected: stage(for: row) == .conversation,
                        help: "The exchange that produced it (⌘1)",
                        action: { workspace.show(stage: .conversation, for: row.id) }
                    )
                    PerspectiveOption(
                        label: "Side by side",
                        symbol: "rectangle.split.2x1",
                        isSelected: stage(for: row) == .sideBySide,
                        help: "The work and the exchange together (⌘2)",
                        action: { workspace.show(stage: .sideBySide, for: row.id) }
                    )
                }
                .padding(2)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(ConchPalette.fill)
                )
                .padding(.trailing, 4)
            }

            // A subagent is not a session: nothing to inspect, no process to
            // close (C4).
            if row.parentSessionId == nil {
                Menu {
                    Button("What this session carries…") {
                        inspectingSession = row
                    }
                    Divider()
                    Button("Close session…", role: .destructive) {
                        sessionPendingClose = row
                    }
                    // Close is a clean exit typed into the terminal, or
                    // `claude stop` for a background job, which needs none.
                    .disabled(row.noTerminal != nil && !row.attachable)
                } label: {
                    // The same `.ib` as the controls opposite it: 28 square at radius 7. It
                    // was 28x26 — two points shorter than its siblings — and the only icon
                    // button in the header that never answered the pointer at all.
                    Image(systemName: "ellipsis")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(isHoveringActions ? ConchPalette.textPrimary : ConchPalette.textDim)
                        .frame(width: 28, height: 28)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(isHoveringActions ? ConchPalette.hover : .clear)
                        )
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .onHover { isHoveringActions = $0 }
                .help("Session actions")
                .accessibilityLabel("Actions for \(row.label)")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        // §3: the header is 52 tall. It had been 36, which is a toolbar's height — fine for a
        // strip of buttons, mean for the line that names what you are looking at and now also
        // carries the view switch.
        .frame(height: 52)
        .background(ConchPalette.surface)
    }

    /// One tab per ARTIFACT the session holds, oldest first, so a new one arrives on the right
    /// and what you have already reviewed stays where you left it. Drawn only when there is more
    /// than one: with a single deliverable this pane is exactly what it always was.
    ///
    /// Per artifact, not per filing. Measured on 2026-09-20: one session held six deliverables
    /// with one link between them — six tabs for one page, each republish a competing tab. Now
    /// the filings of one link are one tab standing for its newest, with the older ones a menu
    /// away, and every tab carries its age so old and new are told apart at a glance. The
    /// grouping rule is `DeliverableGroups` (ConchDesign/Workspace), where it is tested.
    private func deliverableTabs(for row: SessionRow) -> some View {
        let held = deliverables
        let byID = Dictionary(held.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let picked = workspace.presentation(for: row.id).selectedDeliverable
        // Nothing is the shown deliverable while the files are up, or two tabs would read as
        // selected at once.
        let shown = workPane(for: row) == .deliverable ? selectedReview?.id : nil
        // The ages tick on the ledger's own clock, ten seconds, for the same reason: "3h" is
        // a claim about now, and a tab left open all afternoon must not still say "2m".
        return TimelineView(.periodic(from: .now, by: 10)) { timeline in
            HStack(spacing: 2) {
                // The working folder LEADS, and is pinned outside the scroller.
                //
                // It is not one of the outputs, competing for room with however many there are:
                // it is the place the session works in, so its position must not drift as
                // deliverables accumulate. Found by looking rather than by reasoning — a session
                // holding six deliverables filled this strip edge to edge and pushed the folder
                // clean off the right of the pane, where nothing could reach it.
                if workingFolder != nil {
                    FilesTab(
                        isSelected: workPane(for: row) == .files,
                        action: { workspace.show(work: .files, for: row.id) }
                    )

                    TerminalTab(
                        isSelected: workPane(for: row) == .terminal,
                        action: { workspace.show(work: .terminal, for: row.id) }
                    )

                    if !held.isEmpty {
                        // The place, and the work that came out of it, are different kinds of
                        // thing. A hairline says so without a word.
                        Rectangle()
                            .fill(ConchPalette.divider)
                            .frame(width: 1, height: 14)
                            .padding(.horizontal, 2)
                    }
                }

                // The filed work scrolls, because there can be any number of it. It used to be a
                // plain row that simply ran out of pane: the sixth tab reached the edge and
                // everything after it was laid out where no one could see or click it.
                ScrollView(.horizontal) {
                    HStack(spacing: 2) {
                        ForEach(deliverableGroups) { group in
                            let versions = group.versions.compactMap { byID[$0] }
                            DeliverableTab(
                                versions: versions,
                                current: byID[group.shown(picked: picked)] ?? versions[0],
                                isSelected: shown.map(group.versions.contains) ?? false,
                                now: timeline.date,
                                open: { item in
                                    workspace.show(work: .deliverable, for: row.id)
                                    workspace.select(deliverable: item.id, for: row.id)
                                    // Looking at it is what marks it, and only the daemon's copy
                                    // makes that survive a relaunch and reach the phone. The
                                    // version actually opened is the one marked — never the whole
                                    // group — so `markReviewViewed`'s rules hold as they are: no
                                    // restamping, and no id the session does not hold.
                                    if item.viewedAt == nil, state?.features?.viewedState != nil {
                                        store.markReviewViewed(sessionId: row.id, review: item.id)
                                    }
                                }
                            )
                        }
                    }
                }
                .scrollIndicators(.never)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
        }
    }

    /// The exchange itself, drawn the same way wherever it appears.
    ///
    /// Side by side shows this and the deliverable at once (§3), so it cannot be a second,
    /// smaller rendering of the conversation — two renderings of one exchange is how they
    /// drift apart. The deliverable page used to keep exactly that: a bounded strip of the
    /// old single-reply document, which side by side now replaces properly.
    @ViewBuilder
    private func conversationBody(for row: SessionRow?) -> some View {
        // The stack when the daemon has one FOR THIS SESSION, and
        // the old single-reply document otherwise. The session check
        // is not paranoia: the daemon publishes one conversation at
        // a time, so without it, focusing a second session would
        // show it the first one's messages under its own name.
        // Look up THIS row's conversation. The daemon publishes
        // one per visible session precisely so the app never has to
        // agree with it about which session is "showing" — the
        // terminal dashboard holds its own cursor, and every attempt
        // to reconcile them left the stack silently falling back.
        if let row,
           let conversation = state?.conversations?[row.id] ?? state?.conversation,
           !conversation.items.isEmpty,
           conversation.sessionId == row.id {
            ConversationStackView(
                conversation: conversation,
                history: store.history,
                onAnswer: { label in
                    store.send(
                        .inject(
                            sessionId: row.id,
                            label: row.label,
                            text: label
                        )
                    )
                },
                artifact: row.review,
                // An older daemon never reports viewedAt, so every deliverable would look
                // unviewed and the card would show exactly as it does today.
                reportsViewedState: state?.features?.viewedState != nil,
                // Not twice. With the work half already showing a deliverable, the card at the
                // end of the transcript is the same thing again three inches away — Tyler: "if
                // the arifcat is open on the other side you probably don't need the artifact in
                // the conversation". It comes back the moment the pane is closed, which is what
                // makes the card the way IN rather than a duplicate.
                //
                // After `reportsViewedState`, not before: a memberwise init takes its arguments
                // in declaration order, and the compiler says so.
                artifactShownBeside: stage(for: row) != .conversation && workPane(for: row) == .deliverable,
                cwd: row.cwd,
                onOpenArtifact: {
                    // BESIDE the conversation, not instead of it. Clicking the card used to
                    // replace the exchange with the artifact, so the thing that explains the
                    // deliverable vanished at the moment you went to look at it. Tyler: "when
                    // im in the conversation view on the app and i click on the aritifact it
                    // should open the panel view instead of the artifact only view."
                    //
                    // Seeing it alone is still reachable — drag the conversation off the left
                    // of the divider — but it is a WIDTH now, not a mode to find the way out of.
                    workspace.show(stage: .sideBySide, for: row.id)
                    // Opening it IS looking at it. Only the tab strip marked anything before,
                    // so the commonest way in — the card in the conversation — left the dot on
                    // forever: every deliverable on this Mac still read as unviewed.
                    if let review = row.review, review.viewedAt == nil,
                       state?.features?.viewedState != nil {
                        store.markReviewViewed(
                            sessionId: row.id,
                            review: ReviewItem(row: row, review: review).id
                        )
                    }
                },
                onFreeform: { composerFocusRequest += 1 },
                onScrolled: { transcriptScrolled = $0 },
                bottomInset: composerHeight,
                onOpenSubagent: { agent in
                    // Its live row when the daemon lists one, else
                    // a row built from the block — the same pane
                    // either way, and the parent's row is the way
                    // back (C4).
                    if let target = state?.rows.first(where: { $0.id == agent.id })
                        ?? subagentRow(id: agent.id) {
                        onSelectSession(target)
                    }
                },
                noTerminal: row.noTerminal,
                onOpenInTerminal: row.attachable ? { store.openInTerminal(row) } : nil
            )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ConversationTextView(
                attributedText: document.text,
                scrollTarget: document.scrollTarget,
                contentID: document.contentID,
                onOpenLink: { link in
                    fallbackLinkFailure = nil
                    store.openLink(link, cwd: focusedRow?.cwd, rowId: focusedRow?.id) {
                        fallbackLinkFailure = $0
                    }
                }
            )
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) {
                LinkFailureLine(message: $fallbackLinkFailure)
            }
        }
    }

    /// The composer, wherever you are.
    ///
    /// It used to exist only on the conversation pane, so opening an artifact
    /// left you looking at work you could not respond to — no text field, no
    /// mic, and no way back. That inverts the product: conch is meant to hand
    /// you something and let you react to it. Tyler: "the user just gets
    /// presented with artifacts and verbally or via writing reacts to them and
    /// that's all".
    @ViewBuilder
    /// The composer, floating over the transcript and reporting its own height.
    ///
    /// The height comes back through a preference rather than being written during layout: the
    /// control bar already reports its size this way (`ControlBarSize`), and assigning state
    /// inside a layout pass is how SwiftUI gets told a view changed while it is drawing it.
    /// Rounded up to whole points so a fractional height cannot oscillate the inset.
    private func floatingComposer(for row: SessionRow) -> some View {
        composer(for: row)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(key: ComposerHeight.self, value: proxy.size.height.rounded(.up))
                }
            )
            .onPreferenceChange(ComposerHeight.self) { height in
                guard composerHeight != height else { return }
                composerHeight = height
            }
    }

    private func composer(for row: SessionRow) -> some View {
        ComposerView(
            sessionID: row.id,
            sessionLabel: row.label,
            backend: row.backend,
            draft: composerDrafts.textBinding(for: row.id),
            attachments: composerDrafts.attachmentsBinding(for: row.id),
            dictation: dictation(for: row),
            isWorking: row.status == .working,
            voiceState: voiceState(for: row),
            voiceLevel: voiceLevel(for: row),
            audioHeldElsewhere: state?.audioControl.isLocal == false,
            noTerminal: row.noTerminal,
            onOpenInTerminal: row.attachable ? { store.openInTerminal(row) } : nil,
            onSend: { text in
                store.send(.inject(sessionId: row.id, label: row.label, text: text))
            },
            onInterrupt: {
                store.send(.interrupt(sessionId: row.id, label: row.label))
            },
            onTalk: {
                // The same button both ways. It showed a live waveform and
                // still only ever OPENED the mic, so the one control that
                // looks like it is running had no way to stop the thing it
                // was showing — you had to find the spacebar, which a text
                // field now swallows anyway.
                if LiveState.isExchangeActive(voiceState(for: row)) {
                    store.send(.stop())
                } else {
                    // The mic BESIDE a text field fills that field. It used to
                    // send the spoken half straight past the composer into the
                    // session, so what you typed and what you said could not be
                    // one message.
                    store.send(.dictate(sessionId: row.id, label: row.label))
                }
            },
            onRecite: {
                store.send(.recite(sessionId: row.id, label: row.label))
            },
            onDraftStarted: {
                // Selecting is what pins the pane: `focusedRow` prefers an
                // explicit selection over the live session, so this is the
                // existing mechanism rather than a new one.
                onSelectSession(row)
            },
            focusRequest: composerFocusRequest
        )
        .onAppear {
            composerDrafts.claimPreviewSeed(for: row.id)
        }
        .overlay(alignment: .top) {
            noteOverlay.offset(y: -26)
        }
    }

    /// The hint, floating over the conversation rather than under the composer.
    ///
    /// Reserving a row stopped the layout jumping but left a permanent empty
    /// black bar — Tyler: "this jank black bar below the input box". Both
    /// problems come from the same premise, that a transient hint deserves
    /// permanent layout. It does not: it now sits ON the conversation's bottom
    /// edge, so it costs no space when silent and displaces nothing when it
    /// appears.
    ///
    /// The state it describes also has a home now — the mic button in the
    /// composer changes shape and colour — so this line is a detail, not the
    /// only signal.
    private var noteOverlay: some View {
        Group {
            if let note {
                Text(note)
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(ConchPalette.raised.opacity(0.92))
                    )
                    .padding(.bottom, 6)
                    .transition(.opacity)
                    .accessibilityLabel(note)
            }
        }
        .animation(.easeOut(duration: 0.15), value: note)
    }

}

/// One deliverable in the strip above the pane.
///
/// Three states and only three: one nobody has looked at carries the mark at full strength,
/// one that has been looked at greys, and whichever is on screen is filled. "Looked at" is the
/// daemon's record, so it is the same answer on the phone and after a relaunch.
/// The working folder, as a tab beside the deliverables.
///
/// Deliberately not a DeliverableTab with a fake ReviewItem: that type's whole vocabulary is
/// "filed, and not yet looked at", and a folder is neither.
private struct FilesTab: View {
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "folder")
                    .font(.system(size: 10))
                Text("Files")
                    .font(ConchTypography.font(size: 11))
            }
            .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("This session's working folder, and what it changed")
        .accessibilityLabel("Files")
    }
}

/// Commands run in the session's folder, beside the folder itself.
///
/// Both of these are the PLACE the session works, which is why they sit together ahead of the
/// hairline and the outputs scroll on the far side of it.
private struct TerminalTab: View {
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 10))
                Text("Terminal")
                    .font(ConchTypography.font(size: 11))
            }
            .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("Run a command where this session runs")
        .accessibilityLabel("Terminal")
    }
}

/// One artifact's tab: the version it stands for, how old that is, and — only when the
/// session holds older filings of the same link — a menu of them.
/// The composer's measured height, so the transcript can leave room for a card that floats
/// over it. A preference rather than a binding: state written during layout tells SwiftUI the
/// view changed while it is drawing it.
private struct ComposerHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct DeliverableTab: View {
    /// Every filing of this artifact the session still holds, newest first.
    let versions: [ReviewItem]
    /// The one the tab stands for: the reader's pick when it is one of these, else the newest.
    let current: ReviewItem
    let isSelected: Bool
    let now: Date
    /// Open one version: the tab's own click opens `current`, the menu opens the one chosen.
    let open: (ReviewItem) -> Void

    @State private var isHovered = false

    /// Unread belongs to the ARTIFACT, and the artifact's news is its newest filing. Six
    /// unviewed versions of one page are one piece of news, not six dots; and once the newest
    /// has been looked at, an older one nobody opened is superseded, not unread.
    private var isUnviewed: Bool { versions[0].viewedAt == nil }

    /// The ledger's vocabulary — "<1m", "12m", "3h", "2d" — rather than a second one. The exact
    /// time is in the tooltip, where an unambiguous answer costs no width.
    private var age: String? {
        current.reviewedAt.flatMap { relativeAge(epochMilliseconds: $0, now: now) }
    }

    private static func filed(_ item: ReviewItem) -> String? {
        item.reviewedAt.map { Date(timeIntervalSince1970: $0 / 1_000).formatted(date: .abbreviated, time: .shortened) }
    }

    private var help: String {
        var lines = [current.summary]
        if let filed = Self.filed(current) { lines.append("Filed \(filed)") }
        if versions.count > 1 { lines.append("\(versions.count) versions — the newest is what a click opens") }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        HStack(spacing: 0) {
            Button(action: { open(current) }) {
                HStack(spacing: 5) {
                    if isUnviewed {
                        // Ink, not the ready green. The green says the WORK is ready — the row
                        // glyph and the pill already say so — where this dot says the reader has
                        // not looked; and measured, the green is 2.41–2.72:1 on the light grounds,
                        // under the 3:1 a mark needs (RowStateTokenTests pins both numbers).
                        Circle()
                            .fill(ConchPalette.ink)
                            .frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                    }
                    Text(current.summary)
                        .font(ConchTypography.font(size: 11, weight: isUnviewed ? .medium : .regular))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        // Capped, or the strip stops being scannable.
                        //
                        // Squashed into a plain row these shared the width and every tab stayed
                        // visible. Inside a scroller they take their INTRINSIC width instead, and
                        // a summary is a whole sentence — the first tab ran about a thousand
                        // points and pushed every other one out of sight, which is worse than the
                        // clipping the scroller was added to fix. The full text is still a hover
                        // away, and now so are the tabs after it.
                        .frame(maxWidth: 220, alignment: .leading)
                    if let age {
                        Text(age)
                            .font(ConchTypography.font(size: 10.5))
                            .foregroundStyle(ConchPalette.textFaint)
                            .monospacedDigit()
                            // Short and fixed: never the thing that gives way, for the reason the
                            // ledger's age records — a clipped "10m" reads as a plausible "1".
                            .fixedSize()
                    }
                }
                .foregroundStyle(isUnviewed ? ConchPalette.textPrimary : ConchPalette.textDim)
                .padding(.leading, 8)
                .padding(.trailing, versions.count > 1 ? 4 : 8)
                .frame(height: 24)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(help)
            .accessibilityLabel(
                [current.summary, age, isUnviewed ? "not yet looked at" : nil].compactMap { $0 }.joined(separator: ", ")
            )

            // The older versions, and only when there are any: with one filing there is nothing
            // to choose, so the control is simply not there. It is beside the tab's own button,
            // not inside it, so the common case — open the newest — stays one click.
            if versions.count > 1 {
                Menu {
                    ForEach(versions) { version in
                        Button {
                            open(version)
                        } label: {
                            if version.id == current.id {
                                Image(systemName: "checkmark")
                            }
                            Text(Self.menuLine(version, now: now))
                        }
                    }
                } label: {
                    // ONE Text, with the chevron interpolated. `.borderlessButton` rebuilds its
                    // label the way an NSMenuItem is built — image first, title second, its own
                    // chrome — so an HStack of count-then-chevron came out "⌄ 3" with the pill
                    // behind it dropped. Seen in the worktree build, not reasoned about.
                    Text("\(versions.count)\u{2009}\(Image(systemName: "chevron.down"))")
                        .font(ConchTypography.font(size: 10, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(ConchPalette.textDim)
                        .padding(.horizontal, 4)
                        .frame(height: 18)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .padding(.trailing, 5)
                .help("\(versions.count) versions of this — pick an older one")
                .accessibilityLabel("\(versions.count) versions of \(current.summary)")
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))
        )
        .onHover { isHovered = $0 }
    }

    /// A menu row: the age first, so the versions read as a timeline, then the summary — which
    /// is what tells one version from the next. A summary can run to 200 characters and an
    /// NSMenu grows to fit, so it is cut here rather than letting the menu span the screen.
    private static func menuLine(_ item: ReviewItem, now: Date) -> String {
        let age = item.reviewedAt.flatMap { relativeAge(epochMilliseconds: $0, now: now) } ?? "—"
        let summary = item.summary.count > 72 ? String(item.summary.prefix(71)) + "…" : item.summary
        return "\(age) · \(summary)"
    }
}

private struct PerspectiveOption: View {
    let label: String
    let symbol: String
    let isSelected: Bool
    let help: String
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
                // `.seg button{width:30px;height:24px;border-radius:6px}` and
                // `.seg button.on{background:var(--fillSel);box-shadow:var(--shRaised)}`.
                //
                // `--shRaised` IS defined (lab line 17, and line 20 for dark); an earlier
                // grep looked for it at the start of a line and missed it in the minified
                // `:root`, so this control shipped flat. The ring is drawn at the call site
                // because no ConchElevation case carries one — the same split the composer
                // uses, and the same shape ConchDesign's own segmented thumb uses.
                //
                // The hover fill is the app's own: the lab gives `.seg button` no `:hover`
                // rule at all. Kept, because these are buttons and everything else in this
                // header answers the pointer — but it is not a value from the prototype.
                .frame(width: 30, height: 24)
                .background {
                    if isSelected {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(ConchPalette.fillSelected)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .strokeBorder(ConchPalette.divider, lineWidth: 0.5)
                            )
                            .conchElevation(.raised)
                    } else if isHovered {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(ConchPalette.hover)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

private struct DashboardEmptyState: View {
    let hasSnapshot: Bool

    var body: some View {
        // The calmest screen in the product was painted in the alarm colour, and
        // said nothing twice ("No sessions" here, "No sessions yet." in the
        // pane) without ever saying how a session gets here.
        VStack(spacing: 10) {
            Image(systemName: hasSnapshot ? "terminal" : "ellipsis")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(ConchPalette.textFaint)

            Text(hasSnapshot ? "Nothing running yet" : "Waiting for conch")
                .font(ConchTypography.font(size: 13, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)

            Text(
                hasSnapshot
                    ? "Start a Claude Code or Codex session and it appears here — conch reads its finished turns aloud."
                    : "Checking whether the conch daemon is running."
            )
            .font(ConchTypography.font(size: 11.5))
            .foregroundStyle(ConchPalette.textFaint)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 250)
        }
        .padding(.horizontal, 16)
    }
}

private func relativeAge(epochMilliseconds: Double, now: Date) -> String? {
    guard epochMilliseconds.isFinite, epochMilliseconds > 0 else { return nil }
    let elapsed = max(0, now.timeIntervalSince1970 - epochMilliseconds / 1_000)
    if elapsed < 60 {
        return "<1m"
    }
    if elapsed < 3_600 {
        return "\(Int(elapsed / 60))m"
    }
    if elapsed < 86_400 {
        return "\(Int(elapsed / 3_600))h"
    }
    return "\(Int(elapsed / 86_400))d"
}

/// "All sessions" — selected when nothing else is, and the way back when
/// something is.
private struct AllSessionsRow: View {
    let isSelected: Bool
    let onSelect: () -> Void
    let onStart: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onSelect) {
                HStack(spacing: 8) {
                    Image(systemName: "square.stack")
                        .font(.system(size: 10.5))
                        .frame(width: 14)
                    Text("All sessions")
                        .font(ConchTypography.font(size: 12.5, weight: .medium))
                    Spacer(minLength: 8)
                }
                .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Act on every session — pause and mode apply to all")

            // A plus where the count was.
            //
            // The count restated something the list already shows by being a
            // list. This is the one thing you would reach for at the top of a
            // session list and could not do from here — and it sits where the
            // sessions are, not in the app's chrome beside settings and logs,
            // because starting one acts on the LIST.
            Button(action: onStart) {
                Image(systemName: "plus")
                    .font(.system(size: 11.5, weight: .semibold))
                    .frame(width: 22, height: 22)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(isHovered ? ConchPalette.hover : .clear)
                    )
                    .foregroundStyle(isHovered ? ConchPalette.textPrimary : ConchPalette.textFaint)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { isHovered = $0 }
            .help("Start a Claude or Codex session, new or resumed")
            .accessibilityLabel("New session")
        }
        .padding(.leading, 12)
        // 7, not 12, so the plus lands on the same vertical line as the status
        // glyphs below it: those sit in a 16pt frame with 10pt of trailing
        // padding, putting their centres 18pt in. An 22pt chip needs 7 to
        // match. Two things in a column that are ALMOST aligned read as a
        // mistake in a way that being obviously apart does not.
        .padding(.trailing, 7)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(isSelected ? ConchPalette.selection : .clear)
        )
        .accessibilityElement(children: .contain)
    }
}

/// Auto ⇄ manual. Named for what conch is doing, not for what the button does.
private struct ModeToggle: View {
    let isManual: Bool
    let scope: String
    var isDisabled = false
    let action: () -> Void

    @State private var isHovered = false

    private var help: String {
        if isDisabled { return "Controlled by another Mac — press Take it to switch modes here." }
        return isManual
            ? "Manual — conch stays quiet and waits. Switch \(scope) to auto."
            : "Auto — finished turns read aloud and the mic opens itself. Switch \(scope) to manual."
    }

    private var symbol: String {
        return isManual ? "hand.raised.fill" : "waveform.circle.fill"
    }

    private var tint: Color {
        return isManual ? ConchPalette.textDim : ConchPalette.brandCyan
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                Text(isManual ? "Manual" : "Auto")
                    .font(ConchTypography.font(size: 11, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isHovered ? ConchPalette.hover : .clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.35 : 1)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

private extension SessionRow {
    var hasPublishedLiveState: Bool {
        switch live {
        case "listening", "recording", "speaking", "transcribing":
            return true
        default:
            return false
        }
    }
}
