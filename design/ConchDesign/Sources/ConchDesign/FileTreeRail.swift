import SwiftUI

/// The file tree as it is drawn: the rows of a working folder, or of a folder a session published, one line each.
///
/// One tree, wherever conch shows one: the main window's Files tab and a folder deliverable (in that window, and full
/// screen in the conversation panel) draw this, over listings the host loaded and keeps (`ConchFileTree.rows`). Here in
/// ConchDesign so the gallery can draw the real rows, not a picture of them.
///
/// Two kinds of mark, and they say different things. A dot in the ready colour is a file this session CHANGED, at full
/// strength, and a folder holding one, quieter (`ConchFileChanges`). The agent's violet is what it POINTED AT
/// (`ConchFileFocus`): the row washed in its ink with the ✦ its marks carry, and the folders on the way to it tinted, the
/// way agent ink points at one thing on a page.
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
                HStack(spacing: 5) {
                    Image(systemName: "folder")
                        .font(.system(size: 10, weight: .medium))
                    Text(title)
                        .font(font(11.5, .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    if focus?.isEmpty == false {
                        // What the violet means, once, where the tree starts.
                        Text("✦ pointed at")
                            .font(font(10.5, .medium))
                            .foregroundStyle(CanvasInk.agentText)
                            .accessibilityHidden(true)
                    }
                }
                .foregroundStyle(ConchColor.textPrimary)
                .padding(.horizontal, ConchSpace.x3)
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
                    isFocused: focus?.isFocused(row.entry) ?? false,
                    leadsToFocus: focus?.leadsTo(row.entry) ?? false,
                    font: font,
                    action: { onPick(row.entry) }
                )
            }
        }
        .padding(.vertical, ConchSpace.x1)
    }
}

/// One line of the tree.
struct ConchFileRowView: View {
    let row: ConchFileRow
    let isSelected: Bool
    let isOpen: Bool
    let isChanged: Bool
    let holdsChanges: Bool
    let isFocused: Bool
    let leadsToFocus: Bool
    let font: (CGFloat, Font.Weight) -> Font
    let action: () -> Void

    @State private var isHovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The agent's ink as a wash under the row it pointed at: its violet, faint enough that the name stays the thing read.
    static let focusWash = ConchRGBA(CanvasInk.agent.hex, alpha: 0.14)

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
                    .font(font(11.5, isChanged || isFocused ? .medium : .regular))
                    .foregroundStyle(nameStyle)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 4)

                if isFocused {
                    // The mark an agent's ink carries on the canvas, so the two read as one voice.
                    Text("✦")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(CanvasInk.agentText)
                        .accessibilityHidden(true)
                }

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
            .padding(.leading, ConchSpace.x2 + CGFloat(row.depth) * ConchSpace.x3)
            .padding(.trailing, ConchSpace.x2)
            .frame(height: 22)
            .background(
                RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous)
                    .fill(background)
                    .padding(.horizontal, ConchSpace.x1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(row.entry.path)
        .accessibilityLabel(accessibilityLabel)
    }

    private var background: AnyShapeStyle {
        if isSelected { return AnyShapeStyle(ConchColor.rowSelected) }
        if isFocused { return AnyShapeStyle(Self.focusWash.color) }
        return isHovered ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(Color.clear)
    }

    private var iconStyle: AnyShapeStyle {
        if isChanged { return AnyShapeStyle(ConchColor.ready) }
        if isFocused || leadsToFocus { return AnyShapeStyle(CanvasInk.agentText) }
        return AnyShapeStyle(ConchColor.textTertiary)
    }

    private var nameStyle: AnyShapeStyle {
        isChanged || isSelected || isFocused ? AnyShapeStyle(ConchColor.textPrimary) : AnyShapeStyle(ConchColor.textSecondary)
    }

    var accessibilityLabel: String {
        var said = row.entry.name
        if row.entry.isDirectory { said += isOpen ? ", open folder" : ", folder" }
        if isFocused { said += ", pointed at by the agent" }
        else if leadsToFocus { said += ", holds what the agent pointed at" }
        if isChanged { said += ", changed by this session" }
        else if holdsChanges { said += ", holds changed files" }
        return said
    }
}
