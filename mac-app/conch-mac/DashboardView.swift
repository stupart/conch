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
}

enum ConchTypography {
    private static let family = "Helvetica Neue"

    static func font(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard NSFont(name: family, size: size) != nil else {
            return .system(size: size, weight: weight)
        }
        return .custom(family, size: size).weight(weight)
    }
}

struct DashboardView: View {
    let state: PublishedState?
    let onOpenReview: (SessionRow) -> Void

    var body: some View {
        VStack(spacing: 0) {
            DashboardHeader(mode: state?.mode)

            Group {
                if let state, !state.rows.isEmpty {
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(state.rows) { row in
                                DashboardRow(
                                    row: row,
                                    onOpenReview: onOpenReview
                                )
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 8)
                    }
                    .scrollIndicators(.visible)
                } else {
                    DashboardEmptyState(hasSnapshot: state != nil)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ConchPalette.bg)
        .font(ConchTypography.font(size: 12.5))
        .tracking(-0.3)
    }
}

private struct DashboardHeader: View {
    let mode: ModeState?

    var body: some View {
        HStack(spacing: 12) {
            Text("CONCH")
                .font(ConchTypography.font(size: 11, weight: .medium))
                .tracking(1.6)
                .foregroundStyle(ConchPalette.textDim)

            Spacer(minLength: 16)

            if mode?.muted == true {
                ModeFlag(symbol: "speaker.slash.fill", label: "muted")
            }

            if mode?.paused == true {
                ModeFlag(symbol: "pause.fill", label: "paused")
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 16)
        .frame(height: 42)
        .background(ConchPalette.bg)
    }
}

private struct ModeFlag: View {
    let symbol: String
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: 8.5, weight: .medium))

            Text(label)
                .font(ConchTypography.font(size: 10.5))
                .tracking(-0.3)
        }
        .foregroundStyle(ConchPalette.textDim)
        .accessibilityElement(children: .combine)
    }
}

private struct DashboardRow: View {
    let row: SessionRow
    let onOpenReview: (SessionRow) -> Void

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

    var body: some View {
        Group {
            if canOpenReview {
                Button {
                    onOpenReview(row)
                } label: {
                    rowContent
                }
                .buttonStyle(.plain)
                .help("Open review")
            } else {
                rowContent
            }
        }
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isHovered ? ConchPalette.hover : .clear)

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
                    .padding(.vertical, 8)
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

    private var rowContent: some View {
        HStack(spacing: 10) {
            DashboardStatusGlyph(status: row.status)
                .frame(width: 22)

            Text(row.label)
                .font(ConchTypography.font(size: 15, weight: .medium))
                .tracking(-0.3)
                .foregroundStyle(ConchPalette.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .contentTransition(.opacity)
                .frame(width: 174, alignment: .leading)

            HStack(spacing: 7) {
                if let live = row.live, !live.isEmpty {
                    Image(systemName: live == "speaking" ? "waveform" : "circle.fill")
                        .font(.system(size: live == "speaking" ? 10 : 6, weight: .medium))
                        .foregroundStyle(ConchPalette.statusWorking)
                        .accessibilityLabel(live)
                }

                Text(row.snippet ?? row.detail ?? "")
                    .font(ConchTypography.font(size: 12.5))
                    .tracking(-0.3)
                    .foregroundStyle(ConchPalette.textDim)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if row.paused {
                Image(systemName: "pause.fill")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(ConchPalette.textDim)
                    .help("Session paused")
            }

            if row.muted {
                Image(systemName: "speaker.slash.fill")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(ConchPalette.textDim)
                    .help("Session muted")
            }

            if canOpenReview {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(
                        isHovered ? ConchPalette.textDim : ConchPalette.textFaint
                    )
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(isDimmed ? 0.58 : 1)
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.25),
            value: row.status
        )
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
    let status: RowStatus?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            ForEach(DashboardStatusVisual.allCases) { visual in
                Image(systemName: visual.symbol)
                    .font(.system(size: visual.symbolSize, weight: .medium))
                    .foregroundStyle(visual.color)
                    .opacity(visual.matches(status) ? 1 : 0)
            }
        }
        .frame(height: 16)
        .animation(
            reduceMotion ? nil : .easeOut(duration: 0.25),
            value: status
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.accessibilityLabel)
    }
}

private enum DashboardStatusVisual: String, CaseIterable, Identifiable {
    case working
    case waiting
    case needs
    case review
    case unknown

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .working:
            return "circle.fill"
        case .waiting:
            return "circle"
        case .needs:
            return "exclamationmark.triangle.fill"
        case .review:
            return "star.fill"
        case .unknown:
            return "circle.dotted"
        }
    }

    var symbolSize: CGFloat {
        switch self {
        case .needs, .review:
            return 11.5
        case .working, .waiting, .unknown:
            return 9
        }
    }

    var color: Color {
        switch self {
        case .working:
            return ConchPalette.statusWorking
        case .waiting:
            return ConchPalette.statusWaiting
        case .needs:
            return ConchPalette.statusNeeds
        case .review:
            return ConchPalette.statusReview
        case .unknown:
            return ConchPalette.textFaint
        }
    }

    func matches(_ status: RowStatus?) -> Bool {
        switch (self, status) {
        case (.working, .working),
             (.waiting, .waiting),
             (.needs, .needs),
             (.review, .review):
            return true
        case (.unknown, .none),
             (.unknown, .unknown):
            return true
        default:
            return false
        }
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
                .tracking(-0.3)
                .foregroundStyle(ConchPalette.textDim)
        }
    }
}

private extension Optional where Wrapped == RowStatus {
    var accessibilityLabel: String {
        switch self {
        case .working:
            return "Working"
        case .waiting:
            return "Waiting"
        case .needs:
            return "Needs response"
        case .review:
            return "Review ready"
        case .none, .unknown:
            return "No status"
        }
    }
}
