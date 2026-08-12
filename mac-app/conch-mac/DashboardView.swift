import AppKit
import SwiftUI

enum ConchPalette {
    static let bg = Color(
        red: 0.043,
        green: 0.051,
        blue: 0.047
    )
    // Selection must outrank hover. It used to measure 1.07:1 against bg while
    // hover measured 1.17:1, so a hovered row read as MORE selected than the
    // selected one — and 1.07:1 is below the ~1.2:1 where a surface step is
    // perceptible at all. Measured now: selection 1.56:1, hover 1.22:1.
    static let raised = Color(
        red: 0.186,
        green: 0.209,
        blue: 0.198
    )
    static let hover = Color(
        red: 0.122,
        green: 0.136,
        blue: 0.130
    )
    static let textPrimary = Color(
        red: 0.91,
        green: 0.93,
        blue: 0.91
    )
    static let textDim = Color(
        red: 0.48,
        green: 0.52,
        blue: 0.50
    )
    static let accent = Color(
        red: 0.957,
        green: 0.44,
        blue: 0.0
    )
    static let brandCyan = Color(
        red: 88.0 / 255.0,
        green: 201.0 / 255.0,
        blue: 212.0 / 255.0
    )
    // A calm -> act-now ladder, matching the terminal. "working" is the only
    // restful state; "waiting" means a finished turn is sitting on YOU, so it
    // reads as attention rather than inert grey; "needs" is blocking and
    // outranks it.
    // Machine-busy states share a calmer cyan so the brand cyan at full strength
    // can mean one thing only: your microphone is open. That is the state with
    // the highest cost of being wrong about.
    static let statusWorking = Color(
        red: 0.31,
        green: 0.55,
        blue: 0.60
    )
    static let statusMicOpen = brandCyan
    // Waiting and review were 20/255 apart in a single channel — the same gold,
    // separated only by glyph shape. Waiting now sits at the orange end, where
    // "a finished turn is sitting on you" belongs.
    static let statusWaiting = Color(
        red: 0.96,
        green: 0.60,
        blue: 0.13
    )
    static let statusNeeds = Color(
        red: 0.94,
        green: 0.38,
        blue: 0.24
    )
    static let statusReview = Color(
        red: 0.98,
        green: 0.84,
        blue: 0.32
    )

    // 0.62 put this at 2.63:1, below AA, while carrying the row age. Now 4.54:1.
    static let textFaint = textDim.opacity(0.93)
    static let divider = Color.white.opacity(0.075)
}

enum ConchTypography {
    private static let family = "Helvetica Neue"

    /// `relativeTo:` is what makes a custom face respect the system text-size
    /// setting. Without it every size here was a fixed point value and the app
    /// ignored Dynamic Type entirely — bad for a dashboard meant to be
    /// glanceable from across a room.
    static func font(
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo style: Font.TextStyle = .body
    ) -> Font {
        guard NSFont(name: family, size: size) != nil else {
            return .system(size: size, weight: weight)
        }
        return .custom(family, size: size, relativeTo: style).weight(weight)
    }

    static func nsFont(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        guard let base = NSFont(name: family, size: size) else {
            return .systemFont(ofSize: size, weight: weight)
        }
        guard weight >= .medium else { return base }
        return NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask)
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

struct DashboardActions {
    let onSelectSession: (SessionRow) -> Void
    let onExpandReview: (SessionRow) -> Void
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
    let onTalkOrStop: () -> Void
    let onPauseOrResume: () -> Void
    let onMuteOrUnmute: () -> Void
    let onRecite: () -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void
    let onReleaseSelection: () -> Void
}

struct DashboardView: View {
    @EnvironmentObject private var store: StateStore
    @EnvironmentObject private var daemon: DaemonHost
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let renamingSessionID: SessionRow.ID?
    @Binding var renameDraft: String
    let actions: DashboardActions

    /// Nil while conch is working, so the bar only appears when it earns its
    /// space. A daemon we adopted from a terminal is working fine and needs no
    /// banner — it is simply not ours to stop.
    private var daemonTrouble: String? {
        switch daemon.state {
        case .running, .adopted: return nil
        case .starting: return "Starting conch…"
        case .stopped: return "conch is off."
        case .failed(let reason): return reason
        }
    }

    var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                DashboardHeader(
                    state: state,
                    selectedSessionID: selectedSessionID,
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
                if store.staleBuild {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.trianglehead.2.clockwise")
                            .font(.system(size: 10.5, weight: .medium))
                        Text("A newer conch is installed — this window is still running the old one.")
                            .font(ConchTypography.font(size: 11.5))
                        Spacer(minLength: 8)
                        Button("Relaunch", action: store.relaunchForNewBuild)
                            .buttonStyle(.plain)
                            .font(ConchTypography.font(size: 11, weight: .medium))
                            .foregroundStyle(ConchPalette.statusWorking)
                    }
                    .foregroundStyle(ConchPalette.statusWaiting)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ConchPalette.raised)

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)
                }

                // The daemon runs inside this app, so when it is down the app
                // is the only place that can say so. Silence here is what
                // "couldn't reach your Mac" looked like from the outside.
                if let trouble = daemonTrouble {
                    HStack(spacing: 10) {
                        Image(systemName: "bolt.horizontal.circle")
                            .font(.system(size: 10.5, weight: .medium))
                        Text(trouble)
                            .font(ConchTypography.font(size: 11.5))
                        Spacer(minLength: 8)
                        Button("Start", action: daemon.start)
                            .buttonStyle(.plain)
                            .font(ConchTypography.font(size: 11, weight: .medium))
                            .foregroundStyle(ConchPalette.statusWorking)
                    }
                    .foregroundStyle(ConchPalette.statusWaiting)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(ConchPalette.raised)

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)
                }

                if store.pluginHintVisible {
                    PluginHintBar(onDismiss: store.dismissPluginHint)
                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)
                }

                HStack(spacing: 0) {
                    SessionLedger(
                        state: state,
                        selectedSessionID: selectedSessionID,
                        renamingSessionID: renamingSessionID,
                        renameDraft: $renameDraft,
                        rowMessages: store.rowMessages,
                        undoDismissal: store.undoDismissal,
                        actions: actions
                    )
                    .frame(width: ledgerWidth(for: proxy.size.width))
                    .opacity(store.isLedgerFrozen ? 0.82 : 1)
                    .grayscale(store.isLedgerFrozen ? 1 : 0)
                    .animation(
                        reduceMotion ? nil : .easeOut(duration: 0.18),
                        value: store.isLedgerFrozen
                    )

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(width: 1)

                    ConversationPane(
                        state: state,
                        selectedSessionID: selectedSessionID,
                        onExpandReview: actions.onExpandReview,
                        onSelectSession: actions.onSelectSession
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        }
        .background(ConchPalette.bg)
        .font(ConchTypography.font(size: 12.5))
        .tracking(-0.3)
    }

    private func ledgerWidth(for totalWidth: CGFloat) -> CGFloat {
        min(380, max(280, totalWidth * 0.30))
    }
}

/// One quiet line telling the user the editor plugin exists.
private struct PluginHintBar: View {
    let onDismiss: () -> Void
    @State private var copied = false

    private static let command = "/plugin marketplace add Blueprint-Studio-AI/claude-code-marketplace"

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(ConchPalette.textDim)

            Text("Talk to your sessions from inside Claude Code or Codex — add the conch plugin.")
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 8)

            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(Self.command, forType: .string)
                copied = true
            } label: {
                Text(copied ? "Copied" : "Copy command")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(copied ? ConchPalette.statusWorking : ConchPalette.textPrimary)
            }
            .buttonStyle(.plain)
            .help(Self.command)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(ConchPalette.raised)
    }
}

private struct DashboardHeader: View {
    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let isLogDrawerOpen: Bool
    let daemonMessage: String?
    let newerDaemonWarningVisible: Bool
    let onDismissNewerDaemonWarning: () -> Void
    let actions: DashboardActions

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

    /// Mute is no longer offered, but it is still reachable from the CLI and
    /// from older clients — and a state you can enter without a way out is a
    /// trap. When something IS muted the toggle says so and unmutes it.
    private var isMuted: Bool {
        state?.mode.muted == true || selectedRow?.muted == true
    }

    private var modeScope: String {
        selectedRow == nil ? "everything" : "this session"
    }

    /// What conch is DOING, which is not the same as what mode it is in.
    ///
    /// The daemon's at-rest live state is the mode itself — it publishes
    /// "muted" or "paused" when nothing is happening — so reporting live.state
    /// verbatim printed the mode a second time, three inches from the toggle
    /// that already says it. Removing the separate mode branch below did not
    /// help, because this one returns first. Only genuine activity belongs
    /// here.
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
        // The MODE is the toggle's job now — saying "muted" here as well put
        // the same word on screen twice, three inches apart. What the toggle
        // cannot show is the consequence: how much work is waiting for you.
        if state.mode.paused, state.mode.holding > 0 {
            return "holding \(state.mode.holding)"
        }
        return nil
    }

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 5) {
                Text("\u{1F41A}")
                    .font(.system(size: 11))
                    .accessibilityHidden(true)
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
            // the composer — plus pause, mute, Settings, Logs and ?. Two of
            // those are per-session and belong beside the session; the rest are
            // app-level and belong in the app's own chrome. Deleting the strip
            // gives the ledger and the composer the full height of the window,
            // and stops the header being 42pt of wordmark.
            HeaderControls(
                isManual: isManual,
                isMuted: isMuted,
                modeScope: modeScope,
                isLogDrawerOpen: isLogDrawerOpen,
                actions: actions
            )
        }
        .lineLimit(1)
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(height: 38)
        .background(ConchPalette.bg)
    }
}

/// Pause, mute, settings, logs, shortcuts — the things that act on conch itself
/// rather than on one session.
private struct HeaderControls: View {
    let isManual: Bool
    let isMuted: Bool
    let modeScope: String
    let isLogDrawerOpen: Bool
    let actions: DashboardActions

    var body: some View {
        HStack(spacing: 2) {
            // One control, two modes, and the word for the mode you are IN.
            //
            // Pause and mute sat side by side doing almost the same thing, and
            // the more dangerous of the two wore the friendlier icon: mute
            // FORGETS finished turns and has cost Tyler two of them. Mute is
            // gone, and its only unique behaviour with it.
            ModeToggle(
                isManual: isManual,
                isMuted: isMuted,
                scope: modeScope,
                action: isMuted ? actions.onMuteOrUnmute : actions.onPauseOrResume
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
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .frame(width: 26, height: 26)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isSelected || isHovered ? ConchPalette.hover : .clear)
                )
                .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}


private struct SessionLedger: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let renamingSessionID: SessionRow.ID?
    @Binding var renameDraft: String
    let rowMessages: [SessionRow.ID: String]
    let undoDismissal: SessionDismissUndo?
    let actions: DashboardActions

    private var focusID: SessionRow.ID? {
        guard let state else { return selectedSessionID }
        return selectedSessionID
            ?? state.rows.first(where: \.navSelected)?.id
            ?? state.rows.first(where: \.active)?.id
            ?? state.reply.flatMap { reply in
                state.rows.first(where: { $0.id == reply.sessionId })?.id
            }
            ?? state.rows.first(where: {
                !$0.label.isEmpty && $0.label == state.live.label
            })?.id
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
                                // With no way to deselect, pause and mute stayed
                                // scoped to one session forever: Tyler "seem[ed]
                                // to lose the ability to pause the entire app
                                // once I've started using it". A keystroke that
                                // a text field can swallow is not an adequate
                                // home for the only exit from a mode.
                                AllSessionsRow(
                                    isSelected: selectedSessionID == nil,
                                    count: state.rows.count,
                                    action: actions.onReleaseSelection
                                )

                                ForEach(
                                    state.rows,
                                    id: \.id
                                ) { row in
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
                                        onDismiss: { actions.onDismiss(row) }
                                    )
                                    .id(row.id)
                                }

                                if !state.dismissedRows.isEmpty {
                                    DismissedRowsDivider()

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
                DashboardEmptyState(hasSnapshot: state != nil)
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

private struct DashboardRow: View {
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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovered = false
    @State private var reviewPulseOpacity = 0.0
    @State private var pulseTask: Task<Void, Never>?
    @FocusState private var renameFocused: Bool

    private var reviewIdentity: ReviewItem.ID? {
        ReviewItem(row: row)?.id
    }

    private var isDimmed: Bool {
        row.paused || row.muted
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
        return ""
    }


    private var age: String? {
        let timestamp = row.review?.at ?? row.at
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
        .frame(maxWidth: .infinity, minHeight: 42)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(
                        isSelected
                            ? ConchPalette.raised
                            : isHovered ? ConchPalette.hover : .clear
                    )

                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(ConchPalette.raised)
                    .opacity(reviewPulseOpacity)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
        HStack(spacing: 7) {
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
                    .font(ConchTypography.font(size: 13.5, weight: .medium))
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

            if row.prioritized {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 5.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textDim.opacity(0.82))
                    .accessibilityLabel("Prioritized")
                    .help("Prioritized")
            }

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

            // The status glyph reads as the row's verdict, so it sits at the end
            // of the line where the eye lands last — after the age, hard right.
            //
            // It is deliberately NOT dimmed with the rest of the row. Dimming a
            // muted row used to fade the glyph too, dropping it to 2.45:1 — so
            // the pixel answering "why is this one silent?" became the least
            // legible thing on screen, in a product whose failure mode IS
            // silence. The row recedes; its verdict does not.
            DashboardStatusGlyph(visual: LedgerVisual(row: row))
                .frame(width: 16)
        }
        .padding(.trailing, 10)
        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
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

private struct DismissedRowsDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            Text("DISMISSED")
                .font(ConchTypography.font(size: 9.5, weight: .medium))
                .tracking(1.1)
                .foregroundStyle(ConchPalette.textFaint)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)
        }
        .padding(.horizontal, 7)
        .padding(.top, 7)
        .padding(.bottom, 3)
        .accessibilityHidden(true)
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
        .frame(maxWidth: .infinity, minHeight: 34)
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
    case muted
    case paused
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
        if row.review != nil || row.status == .review {
            self = .review
            return
        }
        // Muting silences ANNOUNCEMENTS; it is not a request to stop tracking
        // the session. These checks used to run before status, so a muted
        // session that had finished showed only the mute glyph and its waiting
        // turn became invisible — the worst possible failure in a product whose
        // failure mode IS silence. The row's dimmed label and age already say
        // "silenced"; the glyph goes on saying what the session actually needs.
        let wantsUser = row.status == .waiting || row.status == .needs
        if row.muted, !wantsUser {
            self = .muted
            return
        }
        if row.paused, !wantsUser {
            self = .paused
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
            return "star.fill"
        case .muted:
            return "speaker.slash.fill"
        case .paused:
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
        case .muted, .paused, .speaking:
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
        case .muted, .paused:
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
        case .muted:
            return "Muted"
        case .paused:
            return "Paused"
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
    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let onExpandReview: (SessionRow) -> Void
    let onSelectSession: (SessionRow) -> Void

    @EnvironmentObject private var store: StateStore
    @StateObject private var transcriptContent = TranscriptContentModel()

    /// False = the deliverable in front, which is the pane's long-standing
    /// default: a session that produced an artifact is showing it to you.
    /// This state only ever loses to that default — a NEW artifact resets it
    /// (see the onChange below), because a fresh deliverable is the agent
    /// asking to be looked at, not background noise to read past.
    @State private var showsConversation = false

    /// Only the session actually being dictated to shows the live transcript.
    /// Without the label check every open composer would mirror the same words,
    /// which reads as though conch is about to send them everywhere.
    /// What conch's voice loop is doing for the session in front of you.
    private var voiceStateForFocusedRow: String {
        guard let state, let row = focusedRow else { return "" }
        guard state.live.label.isEmpty || state.live.label == row.label else { return "" }
        return state.live.state
    }

    private var dictationForFocusedRow: String {
        guard let state, let row = focusedRow else { return "" }
        guard state.live.label.isEmpty || state.live.label == row.label else { return "" }
        return state.live.partial
    }

    private var selectedRow: SessionRow? {
        guard let selectedSessionID else { return nil }
        return state?.rows.first { $0.id == selectedSessionID }
    }

    private var liveRow: SessionRow? {
        guard let state, state.live.isExchangeActive else { return nil }
        if let publishedLive = state.rows.first(where: \.hasPublishedLiveState) {
            return publishedLive
        }
        if let replyID = state.reply?.sessionId,
           !replyID.isEmpty,
           let replied = state.rows.first(where: { $0.id == replyID }) {
            return replied
        }
        if !state.live.label.isEmpty,
           let labelled = state.rows.first(where: { $0.label == state.live.label }) {
            return labelled
        }
        return state.rows.first(where: \.active)
    }

    private var focusedRow: SessionRow? {
        guard let state else { return nil }
        return selectedRow
            ?? liveRow
            ?? state.rows.first(where: \.active)
            ?? state.reply.flatMap { reply in
                state.rows.first(where: { $0.id == reply.sessionId })
            }
            ?? state.rows.first
    }

    /// The row whose review the pane is showing: the explicit selection, or the
    /// focused fallback when nothing is selected. Must match selectedReview.
    private var reviewOwnerRow: SessionRow? {
        selectedRow ?? (selectedSessionID == nil ? focusedRow : nil)
    }

    private var selectedReview: ReviewItem? {
        // The pane's contract is "show the FOCUSED session's content" — and a
        // review is that session's content. Requiring an explicit selection
        // here (alone of all the pane's surfaces) meant the review you were
        // just pinged about was invisible when the window opened, until you
        // clicked the row that was already in front of you.
        guard let row = reviewOwnerRow else { return nil }
        return ReviewItem(row: row)
    }

    private var watchesTranscriptForRow: SessionRow? {
        selectedReview == nil && !isFocusedSessionLive ? focusedRow : nil
    }

    private var isFocusedSessionLive: Bool {
        guard let state,
              state.live.isExchangeActive,
              let focusedRow,
              let liveRow else {
            return false
        }
        return focusedRow.id == liveRow.id
    }

    private var document: ConversationDocument {
        ConversationDocument(
            state: state,
            targetRow: focusedRow,
            isTargetLive: isFocusedSessionLive,
            staticContent: transcriptContent.content(for: focusedRow)
        )
    }

    private var note: String? {
        switch state?.live.state {
        case "speaking":
            return "space to cut in · the mic opens when it finishes"
        case "listening", "recording":
            return "pause to send · space to stop · say \"send\" to submit now"
        case "transcribing":
            return "transcribing…"
        default:
            return nil
        }
    }

    var body: some View {
        Group {
            if let selectedReview, let reviewRow = reviewOwnerRow, !showsConversation {
                VStack(spacing: 0) {
                    perspectiveBar

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(height: 1)

                    InlineReviewView(
                        item: selectedReview,
                        onExpand: { onExpandReview(reviewRow) }
                    )

                    if isFocusedSessionLive {
                        Rectangle()
                            .fill(ConchPalette.divider)
                            .frame(height: 1)

                        ConversationTextView(
                            attributedText: document.text,
                            scrollTarget: document.scrollTarget,
                            contentID: document.contentID
                        )
                        .textSelection(.enabled)
                        .frame(minHeight: 96, idealHeight: 150, maxHeight: 190)
                    }

                    Spacer(minLength: 0)

                    composer(for: reviewRow)
                }
            } else {
                VStack(spacing: 0) {
                    // Only when there is a deliverable to swap back to. With
                    // nothing on the other side the control is a promise the
                    // pane can't keep, and the pane already reads fine as
                    // plain conversation without a mode label.
                    if selectedReview != nil {
                        perspectiveBar

                        Rectangle()
                            .fill(ConchPalette.divider)
                            .frame(height: 1)
                    }

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
                    if let rowID = focusedRow?.id,
                       let conversation = state?.conversations?[rowID] ?? state?.conversation,
                       !conversation.items.isEmpty,
                       conversation.sessionId == rowID {
                        ConversationStackView(conversation: conversation)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ConversationTextView(
                            attributedText: document.text,
                            scrollTarget: document.scrollTarget,
                            contentID: document.contentID
                        )
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }

                    // Typing belongs where you are reading. Putting the composer
                    // here rather than in a separate panel means the reply you
                    // are answering is directly above the field you answer in.
                    if let row = focusedRow {
                        composer(for: row)
                    }
                }
            }
        }
        .background(ConchPalette.bg)
        .task(id: TranscriptWatchID(row: watchesTranscriptForRow)) {
            await transcriptContent.monitor(row: watchesTranscriptForRow)
        }
        .onChange(of: selectedReview?.id) { _, current in
            // Keyed off the review's IDENTITY (row + timestamp), not the
            // published state: the daemon republishes constantly, and
            // re-asserting the deliverable on every publish would fight any
            // attempt to actually read the conversation.
            if current != nil { showsConversation = false }
        }
    }

    /// Two labelled segments rather than one button naming the destination.
    /// Lone controls in this app keep getting read as their opposite (the
    /// counterclockwise arrow as undo, the dim speaker as idle); a pair shows
    /// where you are AND where you can go without decoding anything, which is
    /// also what makes this read as two perspectives on one session rather
    /// than navigation away from it — same pane, same composer underneath.
    private var perspectiveBar: some View {
        HStack(spacing: 2) {
            PerspectiveOption(
                label: "Deliverable",
                symbol: "doc.richtext",
                isSelected: !showsConversation,
                help: "What the session produced",
                action: { showsConversation = false }
            )
            PerspectiveOption(
                label: "Conversation",
                symbol: "text.bubble",
                isSelected: showsConversation,
                help: "The exchange that produced it",
                action: { showsConversation = true }
            )
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
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
    private func composer(for row: SessionRow) -> some View {
        ComposerView(
            sessionID: row.id,
            sessionLabel: row.label,
            dictation: dictationForFocusedRow,
            isWorking: row.status == .working,
            voiceState: voiceStateForFocusedRow,
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
                if voiceStateForFocusedRow.isEmpty || voiceStateForFocusedRow == "idle" {
                    store.send(.wake(sessionId: row.id, label: row.label))
                } else {
                    store.send(.stop())
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
            }
        )
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

    /// Kept for the review pane, which has no composer to hang a hint on. A
    /// reserved row is right THERE, where nothing else moves; it was only wrong
    /// under the composer, where it was a permanent empty bar.
    private var noteBar: some View {
        Text(note ?? " ")
            .font(ConchTypography.font(size: 10.5))
            .foregroundStyle(ConchPalette.textFaint)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .frame(height: 32)
            .opacity(note == nil ? 0 : 1)
            .animation(.easeOut(duration: 0.15), value: note)
            .accessibilityHidden(note == nil)
            .accessibilityLabel(note ?? "")
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
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                Text(label)
                    .font(ConchTypography.font(size: 11, weight: .medium))
            }
            .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? ConchPalette.raised : (isHovered ? ConchPalette.hover : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

struct ConversationDocument {
    let text: NSAttributedString
    let scrollTarget: ConversationScrollTarget
    /// Which session's reply this is. Scroll position resets when the CONTENT
    /// changes identity, never merely because a streaming reply got longer.
    let contentID: String

    init(
        state: PublishedState?,
        targetRow: SessionRow?,
        isTargetLive: Bool,
        staticContent: SessionStaticContent
    ) {
        contentID = targetRow?.id ?? ""
        guard let state else {
            text = NSAttributedString(
                string: "Waiting for Conch…",
                attributes: ConversationDocument.attributes(
                    color: NSColor(ConchPalette.textDim)
                )
            )
            scrollTarget = .none
            return
        }

        guard isTargetLive else {
            let content: SessionStaticContent
            if targetRow == nil, state.rows.isEmpty {
                content = SessionStaticContent(
                    rowID: nil,
                    text: "",
                    isPlaceholder: true
                )
            } else {
                content = staticContent
            }
            let staticAttributes = ConversationDocument.attributes(
                color: NSColor(
                    content.isPlaceholder
                        ? ConchPalette.textDim
                        : ConchPalette.textPrimary
                )
            )
            // A placeholder is our own prose, never markdown; a real reply is an
            // agent's markdown and must render as prose, not as source. This is
            // the path a session spends MOST of its life in — only the live
            // reading path was being rendered before.
            text = content.isPlaceholder
                ? NSAttributedString(string: content.text, attributes: staticAttributes)
                : ConversationDocument.markdown(content.text, attributes: staticAttributes)
            scrollTarget = .none
            return
        }

        let live = state.live
        let isDictating = live.isCapturing || live.state == "transcribing"

        var replyText = ""
        var spokenFraction = 0.0
        var isQuotedReply = false
        var showsReadingProgress = false

        if isDictating {
            if let reading = live.reading, !reading.text.isEmpty {
                replyText = reading.displayText
                spokenFraction = reading.spokenFraction
            } else if let reply = state.reply, !reply.text.isEmpty {
                replyText = reply.displayText
                spokenFraction = reply.spokenFraction
            }
            isQuotedReply = true
        } else if let reading = live.reading, !reading.text.isEmpty {
            replyText = reading.displayText
            spokenFraction = reading.spokenFraction
            showsReadingProgress = true
        } else if let reply = state.reply, !reply.text.isEmpty {
            replyText = reply.displayText
            spokenFraction = reply.spokenFraction
            showsReadingProgress = true
        }

        var transcript = live.transcriptPrefix
        if !transcript.isEmpty && !live.partial.isEmpty {
            transcript += " "
        }
        transcript += live.partial

        let output = NSMutableAttributedString()
        let body = ConversationDocument.attributes(color: NSColor(ConchPalette.textPrimary))
        let dim = ConversationDocument.attributes(color: NSColor(ConchPalette.textDim))
        let accent = ConversationDocument.attributes(color: NSColor(ConchPalette.brandCyan))
        var spokenLocation: Int?

        if !replyText.isEmpty {
            if isDictating {
                output.append(NSAttributedString(string: "↪ replying to · ", attributes: dim))
            }

            if isQuotedReply {
                output.append(ConversationDocument.markdown(replyText, attributes: dim))
            } else if live.state == "speaking", showsReadingProgress {
                // Parse the WHOLE reply once, then dim the unspoken tail.
                //
                // Rendering the two halves separately corrupts block structure:
                // a list straddling the boundary is parsed twice, so one half
                // loses its bullets and the other injects one mid-sentence.
                let rendered = NSMutableAttributedString(
                    attributedString: ConversationDocument.markdown(replyText, attributes: body)
                )
                // Progress arrives as a fraction of the SPOKEN text, which has no
                // markdown in it — so a character offset from it cannot index the
                // rendered string. Scale the fraction onto the rendered length.
                let spokenLength = min(
                    Int((Double(rendered.length) * spokenFraction).rounded()),
                    rendered.length
                )
                if spokenLength < rendered.length {
                    rendered.addAttribute(
                        .foregroundColor,
                        value: NSColor(ConchPalette.textDim),
                        range: NSRange(
                            location: spokenLength,
                            length: rendered.length - spokenLength
                        )
                    )
                }
                spokenLocation = output.length + spokenLength
                output.append(rendered)
            } else {
                output.append(ConversationDocument.markdown(replyText, attributes: body))
            }
        }

        if isDictating {
            if output.length > 0 {
                output.append(NSAttributedString(string: "\n\n", attributes: body))
            }
            output.append(NSAttributedString(string: transcript, attributes: body))
            if live.isCapturing {
                output.append(NSAttributedString(string: "▌", attributes: accent))
            }
        }

        if output.length == 0 {
            let label: String
            if let targetRow, !targetRow.label.isEmpty {
                label = " from ‹\(targetRow.label)›"
            } else {
                label = ""
            }
            let placeholder = live.state == "transcribing"
                ? "Transcribing…"
                : "Waiting for a reply\(label)…"
            output.append(NSAttributedString(string: placeholder, attributes: dim))
        }

        text = output
        if isDictating {
            scrollTarget = .end
        } else if live.state == "speaking", let spokenLocation {
            scrollTarget = .character(spokenLocation)
        } else {
            scrollTarget = .none
        }
    }

    static func attributes(color: NSColor) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 5
        paragraph.paragraphSpacing = 0
        paragraph.lineBreakMode = .byWordWrapping
        return [
            .font: ConchTypography.nsFont(size: 16),
            .foregroundColor: color,
            .kern: -0.25,
            .paragraphStyle: paragraph,
        ]
    }

    /// Render an agent reply as markdown rather than showing its syntax.
    ///
    /// Foundation gives us a parse tree, not a layout: `.inlineOnly` leaves
    /// `## `, `- ` and `> ` markers visible, while `.full` strips them but drops
    /// every newline (a three-item list arrives as "onetwothree"). So we parse
    /// with `.full` and rebuild the block layout ourselves — separators between
    /// blocks, bullets and ordinals for list items, an indent for quotes and
    /// code, and heading weight — then apply inline emphasis within each run.
    ///
    /// Unparseable input falls back to the literal string, so a malformed reply
    /// can never blank the pane. The caller styles spoken vs unspoken by passing
    /// different base attributes per half, so base is applied FIRST and the
    /// parsed emphasis re-applied over it — bold must survive in both halves.
    static func markdown(
        _ text: String,
        attributes base: [NSAttributedString.Key: Any]
    ) -> NSAttributedString {
        guard !text.isEmpty else { return NSAttributedString(string: "", attributes: base) }
        guard let parsed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                allowsExtendedAttributes: true,
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ), !parsed.characters.isEmpty else {
            return NSAttributedString(string: text, attributes: base)
        }

        let baseFont = (base[.font] as? NSFont) ?? ConchTypography.nsFont(size: 16)
        let output = NSMutableAttributedString()
        var previousBlock: Int?
        var previousWasListItem = false
        var previousWasTableCell = false

        for run in parsed.runs {
            let piece = NSMutableAttributedString(
                attributedString: NSAttributedString(AttributedString(parsed[run.range]))
            )
            guard piece.length > 0 else { continue }
            var whole = NSRange(location: 0, length: piece.length)
            piece.addAttributes(base, range: whole)

            let intent = run.presentationIntent
            let blockID = intent?.components.first?.identity
            let isNewBlock = blockID != previousBlock

            // Block styling: heading weight, monospace for code, indent for
            // quotes/code. `.full` erases the source newlines, so reinsert one
            // blank line between blocks and a single break between list items.
            var prefix = ""
            var indent: CGFloat = 0
            var blockFont = baseFont
            var isTableCell = false
            var startsTableRow = false
            var isHeaderRow = false
            var isListItem = false
            if let components = intent?.components {
                // Nesting depth drives the indent: a list inside a list carries
                // two listItem components, so count them rather than assuming one.
                let listDepth = components.filter {
                    if case .listItem = $0.kind { return true }
                    return false
                }.count
                for component in components {
                    switch component.kind {
                    case .header(let level):
                        let size = baseFont.pointSize + (level <= 1 ? 5 : level == 2 ? 3 : 1)
                        let descriptor = baseFont.fontDescriptor.withSymbolicTraits(.bold)
                        blockFont = NSFont(descriptor: descriptor, size: size)
                            ?? NSFont.boldSystemFont(ofSize: size)
                    case .listItem(let ordinal):
                        isListItem = true
                        // "Is ANY ancestor an ordered list" made a bullet nested
                        // under a numbered item render as a number, and left the
                        // "◦ " branch unreachable. What matters is the list this
                        // item actually belongs to: the NEAREST list ancestor.
                        let ordered: Bool = {
                            for candidate in components {
                                if case .orderedList = candidate.kind { return true }
                                if case .unorderedList = candidate.kind { return false }
                            }
                            return false
                        }()
                        // Only the OUTERMOST listItem marks this line; the inner
                        // components describe ancestors, whose bullets already ran.
                        if isNewBlock, prefix.isEmpty {
                            prefix = ordered ? "\(ordinal). " : (listDepth > 1 ? "◦ " : "• ")
                        }
                        indent = CGFloat(listDepth) * 16
                    case .blockQuote:
                        // Dimming a quote collides with reading progress, which
                        // dims the text the voice has NOT reached yet: during a
                        // read-aloud a quote looked unread and unread text looked
                        // quoted. Indent carries the quote instead.
                        indent = 22
                    case .codeBlock:
                        blockFont = NSFont.monospacedSystemFont(
                            ofSize: baseFont.pointSize - 1,
                            weight: .regular
                        )
                        indent = 16
                    // A table arrives as one run PER CELL. Without this every
                    // cell became its own line, so a 2x2 table rendered as four
                    // stacked fragments. Keep a row on one line, separated, and
                    // bold the header row.
                    case .tableCell(let column):
                        isTableCell = true
                        if column == 0 { startsTableRow = true }
                        blockFont = NSFont.monospacedSystemFont(
                            ofSize: baseFont.pointSize - 1,
                            weight: .regular
                        )
                    case .tableHeaderRow:
                        isHeaderRow = true
                    default:
                        break
                    }
                }
            }
            if isTableCell, isHeaderRow {
                let descriptor = blockFont.fontDescriptor.withSymbolicTraits(.bold)
                blockFont = NSFont(descriptor: descriptor, size: blockFont.pointSize) ?? blockFont
            }
            piece.addAttribute(.font, value: blockFont, range: whole)

            // We own the newlines, so a newline the parser did leave in (code
            // blocks keep theirs) would double up against our own separator.
            while piece.length > 0, piece.string.hasSuffix("\n") {
                piece.deleteCharacters(in: NSRange(location: piece.length - 1, length: 1))
            }
            guard piece.length > 0 else { continue }
            whole = NSRange(location: 0, length: piece.length)

            // The indent has to be on the WHOLE LINE, not just the text: AppKit
            // takes a paragraph's style from its FIRST character, which for a
            // list item is the bullet. Styling only the text left it dead.
            var lineAttributes = base
            if indent > 0, let paragraph = (base[.paragraphStyle] as? NSParagraphStyle)?
                .mutableCopy() as? NSMutableParagraphStyle {
                paragraph.firstLineHeadIndent = indent
                // Hanging indent so a wrapped item lines up under its own text
                // rather than sliding back under the bullet.
                paragraph.headIndent = indent + (prefix.isEmpty ? 0 : 14)
                lineAttributes[.paragraphStyle] = paragraph
                piece.addAttribute(
                    .paragraphStyle,
                    value: paragraph,
                    range: NSRange(location: 0, length: piece.length)
                )
            }

            // Tab stops are what make a table read as columns. Placed after
            // lineAttributes exists so the separator and the cell share them.
            if isTableCell,
               let tabbed = (base[.paragraphStyle] as? NSParagraphStyle)?
                   .mutableCopy() as? NSMutableParagraphStyle {
                tabbed.tabStops = (1...8).map {
                    NSTextTab(textAlignment: .left, location: CGFloat($0) * 118)
                }
                tabbed.defaultTabInterval = 118
                lineAttributes[.paragraphStyle] = tabbed
                piece.addAttribute(.paragraphStyle, value: tabbed, range: whole)
            }

            if isTableCell {
                // Row breaks come from the first cell; cells within a row are
                // separated inline so the row reads as a row.
                if output.length > 0 {
                    // A table is a block like any other: it needs air above it,
                    // not to be welded onto the sentence before it. Rows within
                    // the table stay tight.
                    let separator = startsTableRow
                        ? (previousWasTableCell ? "\n" : "\n\n")
                        : "\t"
                    output.append(NSAttributedString(string: separator, attributes: base))
                }
            } else {
                if isNewBlock, output.length > 0 {
                    // Blocks only read as blocks with air between them. The
                    // exception is a run of list items, which is visually ONE
                    // block — a blank line between bullets looks broken.
                    let tight = isListItem && previousWasListItem
                    output.append(
                        NSAttributedString(string: tight ? "\n" : "\n\n", attributes: base)
                    )
                }
                if !prefix.isEmpty {
                    output.append(NSAttributedString(string: prefix, attributes: lineAttributes))
                }
            }

            // Inline emphasis within the block.
            piece.enumerateAttribute(.inlinePresentationIntent, in: whole) { value, range, _ in
                guard let raw = value as? UInt else { return }
                let inline = InlinePresentationIntent(rawValue: raw)
                if inline.contains(.code) {
                    piece.addAttribute(
                        .font,
                        value: NSFont.monospacedSystemFont(
                            ofSize: blockFont.pointSize - 1,
                            weight: .regular
                        ),
                        range: range
                    )
                    return
                }
                if inline.contains(.strikethrough) {
                    piece.addAttribute(
                        .strikethroughStyle,
                        value: NSUnderlineStyle.single.rawValue,
                        range: range
                    )
                }
                var traits: NSFontDescriptor.SymbolicTraits = []
                if inline.contains(.stronglyEmphasized) { traits.insert(.bold) }
                if inline.contains(.emphasized) { traits.insert(.italic) }
                guard !traits.isEmpty else { return }
                let descriptor = blockFont.fontDescriptor.withSymbolicTraits(traits)
                if let styled = NSFont(descriptor: descriptor, size: blockFont.pointSize) {
                    piece.addAttribute(.font, value: styled, range: range)
                }
            }

            output.append(piece)
            previousBlock = blockID
            previousWasListItem = isListItem
            previousWasTableCell = isTableCell
        }

        guard output.length > 0 else { return NSAttributedString(string: text, attributes: base) }
        return output
    }
}

enum ConversationScrollTarget: Equatable {
    case none
    case character(Int)
    case end
}

private struct ConversationTextView: NSViewRepresentable {
    let attributedText: NSAttributedString
    let scrollTarget: ConversationScrollTarget
    let contentID: String

    final class Coordinator {
        var previousText = NSAttributedString(string: "")
        var previousScrollTarget = ConversationScrollTarget.none
        var previousContentID = ""
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.borderType = .noBorder

        let textView = NSTextView()
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.importsGraphics = false
        textView.allowsUndo = false
        textView.usesFindBar = false
        textView.focusRingType = .none
        textView.textContainerInset = NSSize(width: 24, height: 24)
        textView.minSize = .zero
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        // Measure is capped rather than tracking the view: at full width a wide
        // window ran ~95 characters per line, well past the 60-75 that reads
        // comfortably, and it got worse the wider the window went.
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: ConversationTextView.maxMeasure,
            height: CGFloat.greatestFiniteMagnitude
        )
        scrollView.documentView = textView
        return scrollView
    }

    /// ~75 characters at the 16pt body size.
    static let maxMeasure: CGFloat = 580

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        // Centre the capped measure. Left-aligning it left ~800pt of dead black
        // to the right of the text on a wide pane, which reads as broken rather
        // than as a deliberate column.
        let available = max(200, scrollView.contentSize.width - 48)
        let measure = min(available, Self.maxMeasure)
        let sideInset = max(24, (scrollView.contentSize.width - measure) / 2)
        if textView.textContainerInset.width != sideInset {
            textView.textContainerInset = NSSize(width: sideInset, height: 24)
        }
        if textView.textContainer?.containerSize.width != measure {
            textView.textContainer?.containerSize = NSSize(
                width: measure,
                height: CGFloat.greatestFiniteMagnitude
            )
        }
        textView.frame.size.width = scrollView.contentSize.width
        let textChanged = !context.coordinator.previousText.isEqual(to: attributedText)
        let targetChanged = context.coordinator.previousScrollTarget != scrollTarget

        if textChanged {
            let selectedRanges = textView.selectedRanges
            textView.textStorage?.setAttributedString(attributedText)
            let restoredRanges: [NSValue] = selectedRanges.compactMap { value -> NSValue? in
                let range = value.rangeValue
                guard range.location <= attributedText.length else { return nil }
                return NSValue(
                    range: NSRange(
                        location: range.location,
                        length: min(range.length, attributedText.length - range.location)
                    )
                )
            }
            textView.selectedRanges = restoredRanges.isEmpty
                ? [NSValue(range: NSRange(location: attributedText.length, length: 0))]
                : restoredRanges
            context.coordinator.previousText = attributedText.copy() as? NSAttributedString
                ?? attributedText
        }

        context.coordinator.previousScrollTarget = scrollTarget
        // Resetting on ANY text change dragged the reader back to the top every
        // poll while a reply was still being written — the most common state in
        // a voice loop, and the one where you most want to read. Only a change
        // of WHOSE reply this is starts you at the top again.
        let identityChanged = context.coordinator.previousContentID != contentID
        context.coordinator.previousContentID = contentID
        guard textChanged || targetChanged else { return }

        DispatchQueue.main.async { [weak scrollView, weak textView] in
            guard let scrollView, let textView else { return }
            scroll(textView, in: scrollView, to: scrollTarget, reset: identityChanged)
        }
    }

    private func scroll(
        _ textView: NSTextView,
        in scrollView: NSScrollView,
        to target: ConversationScrollTarget,
        reset: Bool
    ) {
        switch target {
        case .none:
            if reset {
                scrollView.contentView.scroll(to: .zero)
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }
        case .end:
            textView.scrollRangeToVisible(
                NSRange(location: textView.string.utf16.count, length: 0)
            )
        case let .character(location):
            centerCharacter(location, in: textView, scrollView: scrollView)
        }
    }

    private func centerCharacter(
        _ location: Int,
        in textView: NSTextView,
        scrollView: NSScrollView
    ) {
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer,
              textView.string.utf16.count > 0 else {
            return
        }

        layoutManager.ensureLayout(for: textContainer)
        let characterLocation = min(max(0, location), textView.string.utf16.count - 1)
        let glyphRange = layoutManager.glyphRange(
            forCharacterRange: NSRange(location: characterLocation, length: 1),
            actualCharacterRange: nil
        )
        var glyphRect = layoutManager.boundingRect(
            forGlyphRange: glyphRange,
            in: textContainer
        )
        glyphRect.origin.x += textView.textContainerOrigin.x
        glyphRect.origin.y += textView.textContainerOrigin.y

        let maximumY = max(
            0,
            textView.bounds.height - scrollView.contentView.bounds.height
        )
        let centeredY = min(
            maximumY,
            max(0, glyphRect.midY - scrollView.contentView.bounds.height / 2)
        )
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: centeredY))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}

private struct DaemonLogDrawer: View {
    let lines: [String]

    var body: some View {
        DaemonLogTextView(text: lines.joined(separator: "\n"))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(ConchPalette.raised.opacity(0.42))
    }
}

private struct DaemonLogTextView: NSViewRepresentable {
    let text: String

    final class Coordinator {
        var previousText = ""
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.borderType = .noBorder

        let textView = NSTextView()
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = false
        textView.usesFindBar = false
        textView.focusRingType = .none
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textColor = NSColor(ConchPalette.textDim)
        textView.textContainerInset = NSSize(width: 12, height: 10)
        textView.minSize = .zero
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.setAccessibilityLabel("Conch daemon log")
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard context.coordinator.previousText != text,
              let textView = scrollView.documentView as? NSTextView else {
            return
        }
        let previousString = textView.string as NSString
        let selectedStrings = textView.selectedRanges.compactMap { value -> String? in
            let range = value.rangeValue
            guard range.length > 0,
                  NSMaxRange(range) <= previousString.length else {
                return nil
            }
            return previousString.substring(with: range)
        }

        context.coordinator.previousText = text
        textView.string = text
        let updatedString = textView.string as NSString
        let restoredRanges = selectedStrings.compactMap { selection -> NSValue? in
            let range = updatedString.range(of: selection)
            guard range.location != NSNotFound else { return nil }
            return NSValue(range: range)
        }
        if !restoredRanges.isEmpty {
            textView.selectedRanges = restoredRanges
        }

        guard restoredRanges.isEmpty else { return }
        DispatchQueue.main.async { [weak textView] in
            guard let textView else { return }
            textView.scrollRangeToVisible(
                NSRange(location: textView.string.utf16.count, length: 0)
            )
        }
    }
}

private struct KeybarActionButton: View {
    let label: String
    var isProminent = false
    var isSelected = false
    /// A control with nothing to act on should say so rather than accept a click.
    var isDisabled = false
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(ConchTypography.font(size: 11.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(
                    isHovered || isProminent || isSelected
                        ? ConchPalette.textPrimary
                        : ConchPalette.textDim
                )
                .padding(.horizontal, 14)
                .frame(minHeight: 40)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(
                            isProminent
                                ? ConchPalette.accent.opacity(isHovered ? 0.20 : 0.13)
                                : isHovered || isSelected ? ConchPalette.hover : .clear
                        )
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(KeybarPressButtonStyle())
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
        .onHover { hovering in
            isHovered = hovering
        }
        .animation(.easeOut(duration: 0.14), value: isHovered)
        .accessibilityLabel(label)
    }
}

private struct KeybarPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.12),
                value: configuration.isPressed
            )
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

private func splitAtUTF16Offset(
    _ text: String,
    _ requestedOffset: Int
) -> (prefix: String, remainder: String) {
    let utf16 = text.utf16
    let clampedOffset = min(max(0, requestedOffset), utf16.count)
    var utf16Index = utf16.index(utf16.startIndex, offsetBy: clampedOffset)
    var stringIndex = String.Index(utf16Index, within: text)

    while stringIndex == nil && utf16Index > utf16.startIndex {
        utf16.formIndex(before: &utf16Index)
        stringIndex = String.Index(utf16Index, within: text)
    }

    let boundary = stringIndex ?? text.startIndex
    return (String(text[..<boundary]), String(text[boundary...]))
}

/// "All sessions" — selected when nothing else is, and the way back when
/// something is.
private struct AllSessionsRow: View {
    let isSelected: Bool
    let count: Int
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "square.stack")
                    .font(.system(size: 10.5))
                    .frame(width: 14)
                Text("All sessions")
                    .font(ConchTypography.font(size: 12.5, weight: .medium))
                Spacer(minLength: 8)
                Text("\(count)")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textFaint)
            }
            .foregroundStyle(isSelected ? ConchPalette.textPrimary : ConchPalette.textDim)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(isSelected ? ConchPalette.raised : (isHovered ? ConchPalette.hover : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help("Act on every session — pause, mute and talk apply to all")
        .accessibilityLabel("All sessions")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

/// Auto ⇄ manual. Named for what conch is doing, not for what the button does.
private struct ModeToggle: View {
    let isManual: Bool
    var isMuted = false
    let scope: String
    let action: () -> Void

    @State private var isHovered = false

    private var help: String {
        if isMuted {
            return "Muted — finished turns are being FORGOTTEN, not held. Unmute."
        }
        return isManual
            ? "Manual — conch stays quiet and waits. Switch \(scope) to auto."
            : "Auto — finished turns read aloud and the mic opens itself. Switch \(scope) to manual."
    }

    private var symbol: String {
        if isMuted { return "speaker.slash.fill" }
        return isManual ? "hand.raised.fill" : "waveform.circle.fill"
    }

    private var tint: Color {
        if isMuted { return ConchPalette.statusNeeds }
        return isManual ? ConchPalette.textDim : ConchPalette.brandCyan
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                Text(isMuted ? "Muted" : (isManual ? "Manual" : "Auto"))
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
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}
