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
/// folder on the way to one has it quieter; the header says how many are left to look at. Opened in the viewer, a file's
/// rule goes grey (`ConchFocusMark`), until the agent points at it again in a newer filing or it changes on the disk
/// (`ConchFileFocus.seen`). Not a wash and a ✦ on every row, as it was until
/// 2026-10-29 (Tyler: "i think we can do better than the purple pointed at star thing"): with most of a folder pointed out
/// the washed rows read as a selection beside the real one, and the stars as noise. A mark in the margin is how an
/// editor marks a page, it never touches the row's own fill, and a column of them still reads as one quiet line.
public struct ConchFileTreeRail: View {
    let rows: [ConchFileRow]
    let selected: String?
    let expanded: Set<String>
    let changed: ConchFileChanges
    let focus: ConchFileFocus?
    /// What of `focus` Tyler has seen, by path (`ConchFileFocus.seen`).
    let seen: Set<String>
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
        seen: Set<String> = [],
        title: String? = nil,
        font: @escaping (CGFloat, Font.Weight) -> Font = { .system(size: $0, weight: $1) },
        onPick: @escaping (ConchFileEntry) -> Void
    ) {
        self.rows = rows
        self.selected = selected
        self.expanded = expanded
        self.changed = changed
        self.focus = focus
        self.seen = seen
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
                        // The folder's name before the count: the count has shorter ways to say it.
                        .layoutPriority(1)
                    Spacer(minLength: 4)
                    if let focus, !focus.isEmpty {
                        // What the rule in the margin means, once, where the tree starts, in plain words and beside
                        // the rule itself: how many are left to look at, and how many are seen.
                        let left = focus.paths.filter { !seen.contains($0) }.count
                        ConchFocusMark(kind: left > 0 ? .unseen : .seen)
                            // Centred on the words' capitals, as it is on a row's name: its middle half their height
                            // above the baseline.
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + Self.countCapHeight / 2 }
                            .accessibilityHidden(true)
                        // As much of the count as fits beside the name: "4 to look at · 2 seen", "4 to look at", "4".
                        ViewThatFits(in: .horizontal) {
                            ForEach(Self.toLookAt(left: left, seen: focus.paths.count - left), id: \.self) { words in
                                Text(words)
                                    .font(font(10.5, .regular))
                                    .foregroundStyle(ConchColor.textTertiary)
                                    .lineLimit(1)
                                    .fixedSize()
                            }
                        }
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
                    // A pointed-at row: it is seen. A folder on the way: everything under it is.
                    isSeen: focus.map { focus in
                        focus.isFocused(row.entry) ? seen.contains(row.entry.path) : !focus.leadsToUnseen(row.entry, seen: seen)
                    } ?? false,
                    font: font,
                    action: { onPick(row.entry) }
                )
            }
        }
        .padding(.vertical, ConchSpace.x1)
    }

    /// The header's words for the marks: how many the agent pointed out are left to look at, and how many are seen;
    /// longest first, each shorter one what a narrower rail says instead.
    static func toLookAt(left: Int, seen: Int) -> [String] {
        if seen == 0 { return ["\(left) to look at", "\(left)"] }
        if left == 0 { return seen == 1 ? ["Seen"] : ["All \(seen) seen", "\(seen) seen"] }
        return ["\(left) to look at · \(seen) seen", "\(left) to look at", "\(left)"]
    }

    /// The count's capital height at 10.5 points, about 0.72 of its size, rounded so the rule lands on whole points.
    static let countCapHeight: CGFloat = 8
}

/// The agent's mark in the tree's margin: a short rule, 2 by 12 points, on whole points so it is crisp at 1x. In the
/// agent's violet until Tyler has opened what it marks; then grey, as conch greys a deliverable once it is looked at
/// (`viewedAt`). The step is from a colour to none, not from strong to faint, so it reads whatever the ink's colour is and
/// is never the faint violet of a folder on the way (`route`).
struct ConchFocusMark: View {
    static let size = CGSize(width: 2, height: 12)
    /// How much of the grey a seen mark keeps: there, for the record that the agent pointed at it, but stepped back.
    static let seenOpacity = 0.55
    /// How much of the violet a folder on the way keeps.
    static let routeOpacity = 0.55

    enum Kind: Equatable {
        /// Pointed out and not seen yet: the agent's ink.
        case unseen
        /// Pointed out and seen.
        case seen
        /// A folder on the way to something pointed out and not seen yet: the route to it, in the agent's violet at half
        /// strength, so it stays a colour beside a seen grey rule. Once all under it is seen there is nothing to lead to,
        /// and it draws nothing.
        case route
    }

    var kind: Kind = .unseen

    var body: some View {
        Capsule()
            .fill(kind == .seen ? ConchColor.textTertiary : CanvasInk.agentText)
            .opacity(kind == .seen ? Self.seenOpacity : kind == .route ? Self.routeOpacity : 1)
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
    /// Pointed at and seen; for a folder on the way to what was, everything under it seen (`ConchFileFocus.seen`).
    var isSeen = false
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
                if isFocused || (leadsToFocus && !isSeen) {
                    ConchFocusMark(kind: isFocused ? (isSeen ? .seen : .unseen) : .route)
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

    /// A name the agent pointed out reads strongly until it is seen, then steps back as any other does, a changed one
    /// too (its weight, icon and dot still say it changed). The picked row reads strongly whatever it is.
    private var nameStyle: AnyShapeStyle {
        let strong = isSelected || (isFocused ? !isSeen : isChanged)
        return strong ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textSecondary)
    }

    /// The path, and for a row the agent pointed out, that it did, where it came in its list and whether it is seen.
    var help: String {
        guard let focus else { return row.entry.path }
        return row.entry.path + "\n" + Self.pointedOut(focus, seen: isSeen)
    }

    static func pointedOut(_ place: ConchFileFocus.Place, seen: Bool) -> String {
        (place.of > 1 ? "Pointed out by the agent, \(place.index) of \(place.of)" : "Pointed out by the agent")
            + (seen ? ", seen" : ", not seen yet")
    }

    var accessibilityLabel: String {
        var said = row.entry.name
        if row.entry.isDirectory { said += isOpen ? ", open folder" : ", folder" }
        if let focus { said += ", " + Self.pointedOut(focus, seen: isSeen).lowercased() }
        else if leadsToFocus { said += ", holds what the agent pointed out" + (isSeen ? ", all seen" : ", not seen yet") }
        if isChanged { said += ", changed by this session" }
        else if holdsChanges { said += ", holds changed files" }
        return said
    }
}
