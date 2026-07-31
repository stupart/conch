import AppKit
import SwiftUI

enum ConchPalette {
    static let bg = Color(
        red: 0.043,
        green: 0.051,
        blue: 0.047
    )
    static let raised = Color(
        red: 0.082,
        green: 0.093,
        blue: 0.088
    )
    static let hover = Color(
        red: 0.11,
        green: 0.123,
        blue: 0.117
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
    static let statusWorking = Color(
        red: 0.44,
        green: 0.75,
        blue: 0.37
    )
    static let statusWaiting = Color(
        red: 0.42,
        green: 0.46,
        blue: 0.44
    )
    static let statusNeeds = Color(
        red: 0.95,
        green: 0.69,
        blue: 0.20
    )
    static let statusReview = Color(
        red: 0.96,
        green: 0.77,
        blue: 0.19
    )

    static let textFaint = textDim.opacity(0.62)
    static let divider = Color.white.opacity(0.075)
}

enum ConchTypography {
    private static let family = "Helvetica Neue"

    static func font(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard NSFont(name: family, size: size) != nil else {
            return .system(size: size, weight: weight)
        }
        return .custom(family, size: size).weight(weight)
    }

    static func nsFont(size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        guard let base = NSFont(name: family, size: size) else {
            return .systemFont(ofSize: size, weight: weight)
        }
        guard weight >= .medium else { return base }
        return NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask)
    }
}

struct DashboardActions {
    let onSelectSession: (SessionRow) -> Void
    let onOpenReview: (SessionRow) -> Void
    let onTalkOrStop: () -> Void
    let onPauseOrResume: () -> Void
    let onMuteOrUnmute: () -> Void
    let onRecite: () -> Void
    let onMoveUp: () -> Void
    let onMoveDown: () -> Void
    let onReleaseSelection: () -> Void
    let onWakeNumber: (Int) -> Void
    let onQuit: () -> Void
}

struct DashboardView: View {
    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let daemonMessage: String?
    let actions: DashboardActions

    var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                DashboardHeader(state: state)

                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)

                HStack(spacing: 0) {
                    SessionLedger(
                        state: state,
                        selectedSessionID: selectedSessionID,
                        actions: actions
                    )
                    .frame(width: ledgerWidth(for: proxy.size.width))

                    Rectangle()
                        .fill(ConchPalette.divider)
                        .frame(width: 1)

                    ConversationPane(
                        state: state,
                        selectedSessionID: selectedSessionID
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)

                DashboardKeybar(
                    state: state,
                    selectedSessionID: selectedSessionID,
                    daemonMessage: daemonMessage,
                    actions: actions
                )
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

private struct DashboardHeader: View {
    let state: PublishedState?

    private var doingText: String? {
        guard let state else { return nil }
        if state.live.state != "idle" {
            return state.live.label.isEmpty
                ? state.live.state
                : "\(state.live.state) ‹\(state.live.label)›"
        }
        if state.mode.muted {
            return "muted"
        }
        if state.mode.paused {
            return state.mode.holding > 0
                ? "paused · holding \(state.mode.holding)"
                : "paused"
        }
        return nil
    }

    var body: some View {
        HStack(spacing: 12) {
            Text("CONCH")
                .font(ConchTypography.font(size: 11, weight: .medium))
                .tracking(1.6)
                .foregroundStyle(ConchPalette.textDim)

            if let state {
                HeaderStatusCount(
                    status: .needs,
                    count: state.rows.count { $0.status == .needs },
                    label: "need you"
                )
                HeaderStatusCount(
                    status: .review,
                    count: state.rows.count { $0.status == .review },
                    label: "review"
                )
                HeaderStatusCount(
                    status: .waiting,
                    count: state.rows.count { $0.status == .waiting },
                    label: "waiting"
                )
                HeaderStatusCount(
                    status: .working,
                    count: state.rows.count { $0.status == .working },
                    label: "working"
                )
            }

            Spacer(minLength: 12)

            if let doingText {
                Text(doingText)
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.textDim)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .contentTransition(.opacity)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 16)
        .frame(height: 42)
        .background(ConchPalette.bg)
    }
}

private struct HeaderStatusCount: View {
    let status: RowStatus
    let count: Int
    let label: String

    var body: some View {
        if count > 0 {
            HStack(spacing: 5) {
                Image(systemName: LedgerVisual(status: status).symbol)
                    .font(.system(size: 7.5, weight: .semibold))
                    .foregroundStyle(LedgerVisual(status: status).color)

                Text("\(count) \(label)")
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.textDim)
                    .monospacedDigit()
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private struct SessionLedger: View {
    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let actions: DashboardActions

    private var focusID: SessionRow.ID? {
        guard let state else { return selectedSessionID }
        return selectedSessionID
            ?? state.rows.first(where: \.active)?.id
            ?? state.reply.flatMap { reply in
                state.rows.first(where: { $0.id == reply.sessionId })?.id
            }
            ?? state.rows.first(where: {
                !$0.label.isEmpty && $0.label == state.live.label
            })?.id
    }

    private var rowOrder: [SessionRow.ID] {
        state?.rows.map(\.id) ?? []
    }

    var body: some View {
        Group {
            if let state, !state.rows.isEmpty {
                ScrollViewReader { proxy in
                    TimelineView(.periodic(from: .now, by: 30)) { timeline in
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                ForEach(
                                    Array(state.rows.enumerated()),
                                    id: \.element.id
                                ) { index, row in
                                    DashboardRow(
                                        row: row,
                                        visiblePosition: index + 1,
                                        now: timeline.date,
                                        isSelected: selectedSessionID == row.id,
                                        onSelect: { actions.onSelectSession(row) },
                                        onWakeNumber: index < 9
                                            ? { actions.onWakeNumber(index + 1) }
                                            : nil,
                                        onOpenReview: { actions.onOpenReview(row) }
                                    )
                                    .id(row.id)
                                }
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 8)
                        }
                        .scrollIndicators(.visible)
                        .onAppear {
                            scrollToFocus(proxy, animated: false)
                        }
                        .onChange(of: focusID) { _, _ in
                            scrollToFocus(proxy, animated: true)
                        }
                        .onChange(of: rowOrder) { _, _ in
                            scrollToFocus(proxy, animated: true)
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
        if animated {
            withAnimation(.easeOut(duration: 0.18)) {
                proxy.scrollTo(focusID, anchor: .center)
            }
        } else {
            proxy.scrollTo(focusID, anchor: .center)
        }
    }
}

private struct DashboardRow: View {
    let row: SessionRow
    let visiblePosition: Int
    let now: Date
    let isSelected: Bool
    let onSelect: () -> Void
    let onWakeNumber: (() -> Void)?
    let onOpenReview: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovered = false
    @State private var reviewPulseOpacity = 0.0
    @State private var pulseTask: Task<Void, Never>?

    private var canOpenReview: Bool {
        ReviewItem(row: row) != nil
    }

    private var isDimmed: Bool {
        row.paused || row.muted
    }

    private var isLiveSession: Bool {
        row.active || !(row.live?.isEmpty ?? true)
    }

    private var inlineDetail: String {
        if row.status == .review {
            return row.review?.summary ?? row.detail ?? ""
        }
        if row.status == .needs {
            return row.detail ?? ""
        }
        return ""
    }

    private var age: String? {
        let timestamp = row.at ?? (row.status == .review ? row.review?.at : nil)
        return timestamp.flatMap { relativeAge(epochMilliseconds: $0, now: now) }
    }

    var body: some View {
        HStack(spacing: 0) {
            if let onWakeNumber {
                Button(action: onWakeNumber) {
                    Text(String(visiblePosition))
                        .font(ConchTypography.font(size: 10.5))
                        .foregroundStyle(ConchPalette.textFaint)
                        .monospacedDigit()
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Wake session \(visiblePosition)")
            } else {
                Color.clear
                    .frame(width: 40, height: 40)
            }

            Button(action: onSelect) {
                HStack(spacing: 8) {
                    Text("›")
                        .font(ConchTypography.font(size: 14, weight: .medium))
                        .foregroundStyle(ConchPalette.accent)
                        .opacity(isSelected ? 1 : 0)
                        .frame(width: 8)

                    Text(row.label)
                        .font(ConchTypography.font(size: 13.5, weight: .medium))
                        .foregroundStyle(ConchPalette.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .contentTransition(.opacity)
                        .frame(minWidth: 54, idealWidth: 104, maxWidth: 126, alignment: .leading)
                        .layoutPriority(2)

                    DashboardStatusGlyph(visual: LedgerVisual(row: row))
                        .frame(width: 18)

                    if !inlineDetail.isEmpty {
                        Text(inlineDetail)
                            .font(ConchTypography.font(size: 11.5))
                            .foregroundStyle(ConchPalette.textDim)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .contentTransition(.opacity)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Spacer(minLength: 0)
                    }

                    if let age {
                        Text(age)
                            .font(ConchTypography.font(size: 10.5))
                            .foregroundStyle(ConchPalette.textFaint)
                            .monospacedDigit()
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
                .padding(.trailing, canOpenReview ? 2 : 10)
                .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                .contentShape(Rectangle())
                .opacity(isDimmed ? 0.58 : 1)
            }
            .buttonStyle(.plain)
            .help("Select \(row.label)")

            if canOpenReview {
                Button(action: onOpenReview) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(
                            isHovered ? ConchPalette.textDim : ConchPalette.textFaint
                        )
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open review")
                .accessibilityLabel("Open review for \(row.label)")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 42)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(
                        isSelected || isLiveSession
                            ? ConchPalette.raised
                            : isHovered ? ConchPalette.hover : .clear
                    )

                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(ConchPalette.raised)
                    .opacity(reviewPulseOpacity)
            }
        }
        .overlay(alignment: .leading) {
            if isLiveSession {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(ConchPalette.accent)
                    .frame(width: 2)
                    .padding(.vertical, 7)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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
        .onChange(of: row.status) { previousStatus, currentStatus in
            guard previousStatus != .review, currentStatus == .review else {
                return
            }
            pulseForReview()
        }
        .onDisappear {
            pulseTask?.cancel()
        }
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
        if row.muted {
            self = .muted
            return
        }
        if row.paused {
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
        case .working, .listening:
            return "circle.fill"
        case .waiting:
            return "circle"
        case .needs:
            return "exclamationmark"
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
        case .idle, .working, .waiting, .listening:
            return 8
        }
    }

    var color: Color {
        switch self {
        case .working, .listening:
            return ConchPalette.statusWorking
        case .waiting:
            return ConchPalette.statusWaiting
        case .needs:
            return ConchPalette.statusNeeds
        case .review, .speaking:
            return ConchPalette.statusReview
        case .recording:
            return ConchPalette.accent
        case .transcribing:
            return ConchPalette.statusWorking.opacity(0.78)
        case .idle, .muted, .paused:
            return ConchPalette.textFaint
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

    private var document: ConversationDocument {
        ConversationDocument(state: state, selectedSessionID: selectedSessionID)
    }

    private var note: String? {
        guard let live = state?.live else { return nil }
        let instruction: String
        switch live.state {
        case "speaking":
            instruction = "space to cut in · the mic opens when it finishes"
        case "listening", "recording":
            instruction = "pause to send · space to stop · say send to submit now"
        case "transcribing":
            instruction = "transcribing…"
        default:
            return nil
        }
        return live.label.isEmpty ? instruction : "‹\(live.label)› · \(instruction)"
    }

    var body: some View {
        VStack(spacing: 0) {
            ConversationTextView(
                attributedText: document.text,
                scrollTarget: document.scrollTarget
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let note {
                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(height: 1)

                Text(note)
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.textFaint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .frame(height: 32)
                    .accessibilityLabel(note)
            }
        }
        .background(ConchPalette.bg)
    }
}

private struct ConversationDocument {
    let text: NSAttributedString
    let scrollTarget: ConversationScrollTarget

    init(state: PublishedState?, selectedSessionID: SessionRow.ID?) {
        guard let state else {
            text = NSAttributedString(string: "")
            scrollTarget = .none
            return
        }

        let live = state.live
        let isDictating = live.isCapturing || live.state == "transcribing"
        let activeSessionID = state.rows.first(where: \.active)?.id
            ?? state.reply.flatMap { reply in
                reply.sessionId.isEmpty ? nil : reply.sessionId
            }
            ?? state.rows.first(where: {
                !$0.label.isEmpty && $0.label == live.label
            })?.id

        var replyText = ""
        var spokenChars = 0
        var isQuotedReply = false
        var showsReadingProgress = false

        if isDictating {
            if let reading = live.reading, !reading.text.isEmpty {
                replyText = reading.text
                spokenChars = reading.spokenChars
            } else if let reply = state.reply, !reply.text.isEmpty {
                replyText = reply.text
                spokenChars = reply.spokenChars
            }
            isQuotedReply = true
        } else if let selectedSessionID,
                  selectedSessionID != activeSessionID,
                  let preview = state.preview,
                  preview.sessionId == selectedSessionID,
                  !preview.text.isEmpty {
            replyText = preview.text
            spokenChars = preview.spokenChars
        } else if let reading = live.reading, !reading.text.isEmpty {
            replyText = reading.text
            spokenChars = reading.spokenChars
            showsReadingProgress = true
        } else if let reply = state.reply, !reply.text.isEmpty {
            replyText = reply.text
            spokenChars = reply.spokenChars
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
        let accent = ConversationDocument.attributes(color: NSColor(ConchPalette.accent))
        var spokenLocation: Int?

        if !replyText.isEmpty {
            if isDictating {
                output.append(NSAttributedString(string: "↪ replying to · ", attributes: dim))
            }

            if isQuotedReply {
                output.append(NSAttributedString(string: replyText, attributes: dim))
            } else if live.state == "speaking", showsReadingProgress {
                let parts = splitAtUTF16Offset(replyText, spokenChars)
                output.append(NSAttributedString(string: parts.prefix, attributes: body))
                spokenLocation = output.length
                output.append(NSAttributedString(string: parts.remainder, attributes: dim))
            } else {
                output.append(NSAttributedString(string: replyText, attributes: body))
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

        text = output
        if isDictating {
            scrollTarget = .end
        } else if live.state == "speaking", let spokenLocation {
            scrollTarget = .character(spokenLocation)
        } else {
            scrollTarget = .none
        }
    }

    private static func attributes(color: NSColor) -> [NSAttributedString.Key: Any] {
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
}

private enum ConversationScrollTarget: Equatable {
    case none
    case character(Int)
    case end
}

private struct ConversationTextView: NSViewRepresentable {
    let attributedText: NSAttributedString
    let scrollTarget: ConversationScrollTarget

    final class Coordinator {
        var previousText = NSAttributedString(string: "")
        var previousScrollTarget = ConversationScrollTarget.none
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
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        )
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
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
        guard textChanged || targetChanged else { return }

        DispatchQueue.main.async { [weak scrollView, weak textView] in
            guard let scrollView, let textView else { return }
            scroll(textView, in: scrollView, to: scrollTarget, reset: textChanged)
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

private struct DashboardKeybar: View {
    let state: PublishedState?
    let selectedSessionID: SessionRow.ID?
    let daemonMessage: String?
    let actions: DashboardActions

    private var selectedRow: SessionRow? {
        guard let selectedSessionID else { return nil }
        return state?.rows.first { $0.id == selectedSessionID }
    }

    private var activeRow: SessionRow? {
        guard let state else { return nil }
        if let active = state.rows.first(where: \.active) {
            return active
        }
        if let replyID = state.reply?.sessionId,
           !replyID.isEmpty,
           let replied = state.rows.first(where: { $0.id == replyID }) {
            return replied
        }
        return state.rows.first { $0.label == state.live.label && !state.live.label.isEmpty }
    }

    private var targetRow: SessionRow? {
        selectedRow ?? activeRow
    }

    private var talkLabel: String {
        state?.live.isExchangeActive == true ? "stop" : "talk"
    }

    private var pauseLabel: String {
        let paused = selectedRow?.paused ?? state?.mode.paused ?? false
        return paused ? "resume" : "pause"
    }

    private var muteLabel: String {
        let muted = selectedRow?.muted ?? state?.mode.muted ?? false
        return muted ? "unmute" : "mute"
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 5) {
                KeybarActionButton(
                    key: "space",
                    label: talkLabel,
                    isProminent: true,
                    action: actions.onTalkOrStop
                )
                KeybarActionButton(
                    key: "p",
                    label: pauseLabel,
                    action: actions.onPauseOrResume
                )
                KeybarActionButton(
                    key: "m",
                    label: muteLabel,
                    action: actions.onMuteOrUnmute
                )
                KeybarActionButton(
                    key: "r",
                    label: "recite",
                    isEnabled: targetRow != nil,
                    action: actions.onRecite
                )

                Rectangle()
                    .fill(ConchPalette.divider)
                    .frame(width: 1, height: 18)
                    .padding(.horizontal, 3)

                KeybarActionButton(
                    key: "↑",
                    label: "park",
                    action: actions.onMoveUp
                )
                KeybarActionButton(
                    key: "↓",
                    label: "park",
                    action: actions.onMoveDown
                )
                KeybarActionButton(
                    key: "esc",
                    label: "release",
                    isEnabled: selectedSessionID != nil,
                    action: actions.onReleaseSelection
                )
                KeybarHint(key: "1–9", label: "wake")
                KeybarActionButton(key: "q", label: "quit", action: actions.onQuit)

                if let selectedRow {
                    Text("‹\(selectedRow.label)›")
                        .font(ConchTypography.font(size: 10.5))
                        .foregroundStyle(ConchPalette.textFaint)
                        .lineLimit(1)
                        .padding(.leading, 4)
                } else if state?.mode.paused == true, let holding = state?.mode.holding {
                    Text("holding \(holding)")
                        .font(ConchTypography.font(size: 10.5))
                        .foregroundStyle(ConchPalette.textFaint)
                        .monospacedDigit()
                        .padding(.leading, 4)
                }

                if let daemonMessage {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.circle")
                            .font(.system(size: 10, weight: .medium))
                        Text(daemonMessage)
                            .font(ConchTypography.font(size: 10.5))
                    }
                    .foregroundStyle(ConchPalette.statusNeeds.opacity(0.86))
                    .lineLimit(1)
                    .padding(.leading, 6)
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.horizontal, 10)
            .frame(minWidth: 0, minHeight: 47, alignment: .leading)
        }
        .scrollIndicators(.hidden)
        .frame(height: 47)
        .background(ConchPalette.bg)
    }
}

private struct KeybarActionButton: View {
    let key: String
    let label: String
    var isProminent = false
    var isEnabled = true
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            KeybarLabel(key: key, label: label)
                .foregroundStyle(
                    isEnabled
                        ? isHovered || isProminent
                            ? ConchPalette.textPrimary
                            : ConchPalette.textDim
                        : ConchPalette.textFaint.opacity(0.58)
                )
                .padding(.horizontal, 8)
                .frame(minHeight: 40)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(
                            isProminent
                                ? ConchPalette.accent.opacity(isHovered ? 0.20 : 0.13)
                                : isHovered ? ConchPalette.hover : .clear
                        )
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(KeybarPressButtonStyle())
        .disabled(!isEnabled)
        .onHover { hovering in
            isHovered = hovering
        }
        .animation(.easeOut(duration: 0.14), value: isHovered)
        .accessibilityLabel("\(label), \(key)")
    }
}

private struct KeybarHint: View {
    let key: String
    let label: String

    var body: some View {
        KeybarLabel(key: key, label: label)
            .foregroundStyle(ConchPalette.textDim)
            .padding(.horizontal, 8)
            .frame(minHeight: 40)
            .accessibilityElement(children: .combine)
    }
}

private struct KeybarLabel: View {
    let key: String
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Text(key)
                .font(ConchTypography.font(size: 10.5, weight: .medium))
                .monospacedDigit()
                .padding(.horizontal, 5)
                .frame(minHeight: 20)
                .background(
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(Color.white.opacity(0.055))
                )

            Text(label)
                .font(ConchTypography.font(size: 10.5))
                .lineLimit(1)
        }
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
        VStack(spacing: 8) {
            Image(systemName: hasSnapshot ? "circle" : "ellipsis")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.statusWaiting)

            Text(hasSnapshot ? "No sessions" : "Waiting for Conch")
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textDim)
        }
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
