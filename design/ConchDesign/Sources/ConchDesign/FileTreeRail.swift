import SwiftUI

/// The file tree as it is drawn: the rows of a working folder, or of a folder a session published, one line each.
///
/// One tree, wherever conch shows one: the main window's Files tab and a folder deliverable (in that window, and full
/// screen in the conversation panel) draw this, over listings the host loaded and keeps (`ConchFileTree.rows`). Here in
/// ConchDesign so the gallery can draw the real rows, not a picture of them.
///
/// Two kinds of mark, at the two ends of a row, and they say different things. A dot in the ready colour, after the name,
/// is a file this session CHANGED, at full strength, and a folder holding one, quieter (`ConchFileChanges`). A short rule
/// in the agent's violet, in the margin before the row, is what it POINTED OUT for you to look at (`ConchFileFocus`), and a
/// folder on the way to one has it quieter; the header says how many. Not a wash and a ✦ on every row, as it was until
/// 2026-10-29 (Tyler: "i think we can do better than the purple pointed at star thing"): with most of a folder pointed out
/// the washed rows read as a selection beside the real one, and the stars as noise. A mark in the margin is how an
/// editor marks a page, it never touches the row's own fill, and a column of them still reads as one quiet line.
public struct ConchFileTreeRail: View {
    let rows: [ConchFileRow]
    let selected: String?
    let expanded: Set<String>
    let changed: ConchFileChanges
    let focus: ConchFileFocus?
    /// The folder's name above the rows, for a folder deliverable; nil draws none (the Files tab, whose folder is the
    /// session's own and named by the header above it).
    let title: String?
    /// The host's type: the Mac app passes its own, so the tree reads like the window it sits in.
    let font: (CGFloat, Font.Weight) -> Font
    let onPick: (ConchFileEntry) -> Void
    @Environment(\.conchRendersStatically) private var rendersStatically

    public init(
        rows: [ConchFileRow],
        selected: String?,
        expanded: Set<String>,
        changed: ConchFileChanges,
        focus: ConchFileFocus? = nil,
        title: String? = nil,
        font: @escaping (CGFloat, Font.Weight) -> Font = { .system(size: $0, weight: $1) },
        onPick: @escaping (ConchFileEntry) -> Void
    ) {
        self.rows = rows
        self.selected = selected
        self.expanded = expanded
        self.changed = changed
        self.focus = focus
        self.title = title
        self.font = font
        self.onPick = onPick
    }

    public var body: some View {
        if rendersStatically {
            // A picture (the gallery): one layout pass, no scroll view, which ImageRenderer can't draw.
            lines
        } else {
            ScrollView { lines }
        }
    }

    private var lines: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if let title {
                // On one baseline: the folder's name and the count are two sizes.
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "folder")
                        .font(.system(size: 10, weight: .medium))
                    Text(title)
                        .font(font(11.5, .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let focus, !focus.isEmpty {
                        // What the rule in the margin means, once, where the tree starts, in plain words and beside
                        // the rule itself.
                        ConchFocusMark()
                            // Centred on the words' capitals, as it is on a row's name: its middle half their height
                            // above the baseline.
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + Self.countCapHeight / 2 }
                            .accessibilityHidden(true)
                        Text(Self.toLookAt(focus.paths.count))
                            .font(font(10.5, .regular))
                            .foregroundStyle(ConchColor.textTertiary)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
                .foregroundStyle(ConchColor.textPrimary)
                // The rows' own inset, so the folder's icon sits over their first column and the count ends over their
                // dots.
                .padding(.horizontal, ConchFileRowView.contentInset)
                .frame(height: 26)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            ForEach(rows) { row in
                ConchFileRowView(
                    row: row,
                    isSelected: selected == row.entry.path,
                    isOpen: expanded.contains(row.entry.path),
                    isChanged: changed.changed(row.entry),
                    holdsChanges: changed.contains(row.entry),
                    focus: focus.flatMap { $0.place(of: row.entry) },
                    leadsToFocus: focus?.leadsTo(row.entry) ?? false,
                    font: font,
                    action: { onPick(row.entry) }
                )
            }
        }
        .padding(.vertical, ConchSpace.x1)
    }

    /// The header's words for the marks: how many the agent pointed out.
    static func toLookAt(_ count: Int) -> String { "\(count) to look at" }

    /// The count's capital height at 10.5 points, about 0.72 of its size, rounded so the rule lands on whole points.
    static let countCapHeight: CGFloat = 8
}

/// The agent's mark in the tree's margin: a short rule in its violet, 2 by 12 points, on whole points so it is crisp at 1x.
struct ConchFocusMark: View {
    static let size = CGSize(width: 2, height: 12)
    /// A folder on the way to what was pointed out is the route to it, and says so more quietly, as a folder holding a
    /// change does.
    var route = false

    var body: some View {
        Capsule()
            .fill(CanvasInk.agentText)
            .opacity(route ? 0.35 : 1)
            .frame(width: Self.size.width, height: Self.size.height)
    }
}

/// One line of the tree.
struct ConchFileRowView: View {
    let row: ConchFileRow
    let isSelected: Bool
    let isOpen: Bool
    let isChanged: Bool
    let holdsChanges: Bool
    /// Where this row is among what the agent pointed out, when it is one of them (`ConchFileFocus.place(of:)`).
    let focus: ConchFileFocus.Place?
    let leadsToFocus: Bool
    let font: (CGFloat, Font.Weight) -> Font
    let action: () -> Void

    @State private var isHovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The row's fill (selection, hover), in from both edges of the rail; and what the row holds, in from those.
    static let fillInset: CGFloat = 6
    static let contentInset: CGFloat = 10
    /// The margin mark's left edge: two points in from the rail's own, clear of a border its host draws there, and two
    /// short of the row's fill, so it never touches the selection and never reads as part of it.
    static let markInset: CGFloat = 2

    var isFocused: Bool { focus != nil }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                // The chevron turns rather than swapping glyph: one control that moves is
                // easier to follow than two that replace each other. `pop` because the tokens
                // say small things bounce more.
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(ConchColor.textTertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                    .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: isOpen)
                    .frame(width: 10)
                    .opacity(row.entry.isDirectory ? 1 : 0)

                Image(systemName: row.entry.isDirectory ? "folder" : "doc")
                    .font(.system(size: 10))
                    .foregroundStyle(iconStyle)
                    .frame(width: 13)

                Text(row.entry.name)
                    .font(font(11.5, isChanged ? .medium : .regular))
                    .foregroundStyle(nameStyle)
                    .lineLimit(1)
                    .truncationMode(.middle)

                // A gap before the dot only where there is one: the name has the room to the row's edge otherwise.
                Spacer(minLength: isChanged || holdsChanges ? 4 : 0)

                // Two strengths, on purpose. A file the session edited is the claim; a folder
                // merely CONTAINING one is the route to it, and must not shout as loudly or
                // every folder from the root down reads as edited.
                if isChanged || holdsChanges {
                    Circle()
                        .fill(ConchColor.ready)
                        .opacity(isChanged ? 1 : 0.35)
                        .frame(width: 5, height: 5)
                        .accessibilityHidden(true)
                }
            }
            .padding(.leading, Self.contentInset + CGFloat(row.depth) * ConchSpace.x3)
            .padding(.trailing, Self.contentInset)
            .frame(height: 22)
            .background(
                RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous)
                    .fill(background)
                    .padding(.horizontal, Self.fillInset)
            )
            .overlay(alignment: .leading) {
                if isFocused || leadsToFocus {
                    ConchFocusMark(route: !isFocused)
                        .offset(x: Self.markInset)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(accessibilityLabel)
    }

    private var background: AnyShapeStyle {
        if isSelected { return AnyShapeStyle(ConchColor.rowSelected) }
        return isHovered ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear)
    }

    private var iconStyle: AnyShapeStyle {
        isChanged ? AnyShapeStyle(ConchColor.ready) : AnyShapeStyle(ConchColor.textTertiary)
    }

    private var nameStyle: AnyShapeStyle {
        isChanged || isSelected || isFocused ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textSecondary)
    }

    /// The path, and for a row the agent pointed out, that it did and where it came in its list.
    var help: String {
        guard let focus else { return row.entry.path }
        return row.entry.path + "\n" + Self.pointedOut(focus)
    }

    static func pointedOut(_ place: ConchFileFocus.Place) -> String {
        place.of > 1 ? "Pointed out by the agent, \(place.index) of \(place.of)" : "Pointed out by the agent"
    }

    var accessibilityLabel: String {
        var said = row.entry.name
        if row.entry.isDirectory { said += isOpen ? ", open folder" : ", folder" }
        if let focus { said += ", " + Self.pointedOut(focus).lowercased() }
        else if leadsToFocus { said += ", holds what the agent pointed out" }
        if isChanged { said += ", changed by this session" }
        else if holdsChanges { said += ", holds changed files" }
        return said
    }
}
