import SwiftUI

enum ConchPalette {
    static let background = Color(
        red: 0.035,
        green: 0.043,
        blue: 0.041
    )
    static let raised = Color(
        red: 0.052,
        green: 0.063,
        blue: 0.059
    )
    static let hover = Color.white.opacity(0.035)
    static let divider = Color.white.opacity(0.075)
    static let primary = Color.white.opacity(0.86)
    static let secondary = Color.white.opacity(0.47)
    static let faint = Color.white.opacity(0.27)
    static let green = Color(red: 0.39, green: 0.73, blue: 0.52)
    static let cyan = Color(red: 0.42, green: 0.72, blue: 0.76)
    static let amber = Color(red: 0.91, green: 0.66, blue: 0.31)
    static let gold = Color(red: 0.95, green: 0.75, blue: 0.32)
}

struct DashboardView: View {
    let state: PublishedState?
    let onOpenReview: (SessionRow) -> Void

    var body: some View {
        VStack(spacing: 0) {
            DashboardHeader(state: state)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            Group {
                if let state, !state.rows.isEmpty {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(state.rows) { row in
                                DashboardRow(
                                    row: row,
                                    onOpenReview: onOpenReview
                                )

                                Rectangle()
                                    .fill(ConchPalette.divider)
                                    .frame(height: 1)
                                    .padding(.leading, 48)
                            }
                        }
                    }
                    .scrollIndicators(.visible)
                } else {
                    DashboardEmptyState(hasSnapshot: state != nil)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(height: 1)

            DashboardFooter(state: state)
        }
        .background(ConchPalette.background)
        .font(.system(size: 12, weight: .regular, design: .monospaced))
    }
}

private struct DashboardHeader: View {
    let state: PublishedState?

    var body: some View {
        HStack(spacing: 10) {
            Text("CONCH")
                .fontWeight(.semibold)
                .tracking(1.4)
                .foregroundStyle(ConchPalette.primary)

            Rectangle()
                .fill(ConchPalette.divider)
                .frame(width: 1, height: 14)

            LiveStateView(live: state?.live)

            Spacer(minLength: 16)

            if let mode = state?.mode {
                if mode.muted {
                    ModeFlag(glyph: "M", label: "muted", color: ConchPalette.amber)
                }
                if mode.paused {
                    ModeFlag(glyph: "Ⅱ", label: "paused", color: ConchPalette.secondary)
                }
                if mode.holding > 0 {
                    ModeFlag(
                        glyph: "↳",
                        label: "holding \(mode.holding)",
                        color: ConchPalette.secondary
                    )
                    .monospacedDigit()
                }
                if !mode.muted && !mode.paused && mode.holding == 0 {
                    Text("ready")
                        .foregroundStyle(ConchPalette.faint)
                }
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 14)
        .frame(height: 38)
        .background(ConchPalette.raised)
    }
}

private struct LiveStateView: View {
    let live: LiveState?

    private var color: Color {
        switch live?.state {
        case "speaking":
            return ConchPalette.amber
        case "listening", "recording":
            return ConchPalette.green
        case "transcribing":
            return ConchPalette.cyan
        case "paused", "muted":
            return ConchPalette.secondary
        default:
            return ConchPalette.faint
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)

            Text(live?.state ?? "offline")
                .foregroundStyle(ConchPalette.secondary)

            if let label = live?.label, !label.isEmpty {
                Text("·")
                    .foregroundStyle(ConchPalette.faint)
                Text(label)
                    .foregroundStyle(ConchPalette.primary)
            }
        }
    }
}

private struct ModeFlag: View {
    let glyph: String
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Text(glyph)
                .foregroundStyle(color)
            Text(label)
                .foregroundStyle(ConchPalette.secondary)
        }
    }
}

private struct DashboardRow: View {
    let row: SessionRow
    let onOpenReview: (SessionRow) -> Void

    @State private var isHovered = false

    private var canOpenReview: Bool {
        ReviewItem(row: row) != nil
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
        .background(isHovered && canOpenReview ? ConchPalette.hover : .clear)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
    }

    private var rowContent: some View {
        HStack(spacing: 10) {
            Text(row.status.dashboardGlyph)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .foregroundStyle(row.status.dashboardColor)
                .frame(width: 22, alignment: .center)
                .accessibilityLabel(row.status.accessibilityLabel)

            Text(row.label)
                .fontWeight(row.active ? .semibold : .medium)
                .foregroundStyle(ConchPalette.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 164, alignment: .leading)

            HStack(spacing: 6) {
                if let live = row.live, !live.isEmpty {
                    Text(live == "speaking" ? "▶" : "●")
                        .foregroundStyle(ConchPalette.cyan)
                        .accessibilityLabel(live)
                }

                Text(row.snippet ?? row.detail ?? "")
                    .foregroundStyle(ConchPalette.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if row.paused {
                Image(systemName: "pause.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ConchPalette.faint)
                    .help("Session paused")
            }

            if row.muted {
                Image(systemName: "speaker.slash.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ConchPalette.faint)
                    .help("Session muted")
            }

            if canOpenReview {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(isHovered ? ConchPalette.secondary : ConchPalette.faint)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 42)
        .opacity(row.paused || row.muted ? 0.55 : 1)
    }
}

private struct DashboardEmptyState: View {
    let hasSnapshot: Bool

    var body: some View {
        VStack(spacing: 9) {
            Text("·")
                .font(.system(size: 18, design: .monospaced))
                .foregroundStyle(ConchPalette.faint)
            Text(hasSnapshot ? "no sessions" : "waiting for conch daemon")
                .foregroundStyle(ConchPalette.secondary)
            if !hasSnapshot {
                Text("/tmp/conch-sessions.json")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(ConchPalette.faint)
            }
        }
    }
}

private struct DashboardFooter: View {
    let state: PublishedState?

    var body: some View {
        HStack(spacing: 8) {
            Text("read only")
                .foregroundStyle(ConchPalette.faint)
            Text("·")
                .foregroundStyle(ConchPalette.faint)
            Text("/tmp/conch-sessions.json")
                .foregroundStyle(ConchPalette.secondary)
            Spacer()
            Text("\(state?.rows.count ?? 0) sessions")
                .foregroundStyle(ConchPalette.faint)
                .monospacedDigit()
        }
        .font(.system(size: 10, weight: .regular, design: .monospaced))
        .padding(.horizontal, 14)
        .frame(height: 26)
        .background(ConchPalette.raised.opacity(0.72))
    }
}

private extension Optional where Wrapped == RowStatus {
    var dashboardGlyph: String {
        switch self {
        case .working:
            return "●"
        case .waiting:
            return "○"
        case .needs:
            return "⚠"
        case .review:
            return "⭐"
        case .none, .unknown:
            return "·"
        }
    }

    var dashboardColor: Color {
        switch self {
        case .working:
            return ConchPalette.green
        case .waiting:
            return ConchPalette.secondary
        case .needs:
            return ConchPalette.amber
        case .review:
            return ConchPalette.gold
        case .none, .unknown:
            return ConchPalette.faint
        }
    }

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
