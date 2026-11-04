import SwiftUI

/// The slash typeahead, drawn (`SlashTypeahead`): the matching commands as a section of the composer's own card, above
/// the field, with a hairline between. Not a popup of its own: the card that holds the words grows to hold the list, the
/// way it holds attachments, so it reads as part of the message box. Each row is the line as typed, what it does, and on
/// the right the argument it takes. A command that opens a picker says "in the terminal" in its words; the row keeps
/// them whole at the composer's width (`SlashTypeaheadRenderTests`).
///
/// On the Mac, rows are set as ⌘K's are (12.5 and 11), their text on the field's own column, the highlighted one in the
/// selection's fill with corners concentric to the card's, and the keys it answers to at its foot. On the phone, the
/// Commands sheet's rows: the line in mono, its words under it, each row a thumb's height, chosen by a tap.
public struct SlashTypeaheadList: View {
    /// What the list sits in, for the highlight's corners: the window's card (`ConchRadius.large`), or the floating
    /// input's glass (`ConchRadius.panel`), whose wider corner would all but touch a row drawn as the card's are.
    public enum Surface: Sendable {
        case card, glass

        /// Further in than the 6 the composer pads by, on the sides and above.
        var extraInset: CGFloat { self == .glass ? 3 : 0 }
        /// Concentric with the surface's corner at the row's inset: 18 less 6 on the card. The glass's 30 would ask for a
        /// pill, so it takes the nearest that reads as the card's: measured, it clears the glass by 6.1 at the corner.
        var rowRadius: CGFloat { self == .glass ? 14 : ConchRadius.medium }
    }

    public let matches: [AgentCommand]
    /// The highlighted row; nil draws none (the phone, which has no keys to move one).
    public let selected: Int?
    public var surface: Surface
    public var onChoose: (AgentCommand) -> Void

    public init(matches: [AgentCommand], selected: Int?, surface: Surface = .card, onChoose: @escaping (AgentCommand) -> Void) {
        self.matches = matches
        self.selected = selected
        self.surface = surface
        self.onChoose = onChoose
    }

    /// The rows' text inset, less what the surface already took: the line stays on the field's column either way.
    private var textInset: CGFloat { Self.rowInsetX - surface.extraInset }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            rows
            #if os(macOS)
            HStack(spacing: 8) {
                Text("↑↓ select · ⇥ or ⏎ choose · esc close")
                Spacer(minLength: 8)
                count
            }
            .font(.system(size: Self.footerSize))
            .foregroundStyle(ConchColor.textTertiary)
            .lineLimit(1)
            .padding(.horizontal, textInset)
            .padding(.top, 5)
            // 13 from the keys' baseline to the hairline, as the field's / sits 12 to 13 under it: the rule halfway
            // between, not stuck to the line above (design pass, 2026-11-04).
            .padding(.bottom, 10)
            .accessibilityHidden(true)
            #else
            // Four rows and a bit fill the room above the keyboard, and the fifth can sit exactly under the edge: the
            // count says the list goes on.
            if matches.count > Self.phoneRowsBeforeCount {
                HStack {
                    Spacer()
                    count
                }
                .font(.footnote)
                .foregroundStyle(ConchColor.textTertiary)
                .padding(.top, 4)
                .accessibilityHidden(true)
            }
            #endif
            Rectangle()
                .fill(ConchColor.hairline)
                .frame(height: 0.5)
                .padding(.horizontal, textInset)
                #if os(iOS)
                // Halfway between the last row's words and the field's.
                .padding(.top, 3)
                #endif
        }
        .padding(.horizontal, surface.extraInset)
        .padding(.top, surface.extraInset)
        #if os(iOS)
        // The card's own 12 above the first command, as above the field when the list is shut: the row's tap height
        // would otherwise drop the first line 6 lower than the card's edge asks.
        .padding(.top, -6)
        #endif
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Commands")
    }

    /// How many there are, when more than the rows show: `/` lists a whole agent's.
    @ViewBuilder
    private var count: some View {
        #if os(macOS)
        let more = CGFloat(matches.count) > Self.visibleRows
        #else
        let more = matches.count > Self.phoneRowsBeforeCount
        #endif
        if more {
            Text("\(matches.count) \(matches.allSatisfy(\.isMention) ? "skills" : "commands")")
        }
    }

    @ViewBuilder
    private var rows: some View {
        #if os(macOS)
        let list = ForEach(Array(matches.enumerated()), id: \.element.line) { index, command in
            SlashTypeaheadRow(command: command, isSelected: index == selected, inset: textInset, radius: surface.rowRadius)
                .id(command.line)
                .contentShape(Rectangle())
                .onTapGesture { onChoose(command) }
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { onChoose(command) }
        }
        // Fixed rows, so the list is exactly as tall as what it shows, up to seven whole ones; ↓ scrolls the rest into
        // view, and the foot says how many there are. A half row peeking under the seventh read as a row cut in two.
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(spacing: 0) { list }
            }
            .scrollIndicators(.never)
            .frame(height: Self.rowHeight * min(CGFloat(matches.count), Self.visibleRows))
            .onChange(of: selected) { _, selected in
                guard let selected, matches.indices.contains(selected) else { return }
                proxy.scrollTo(matches[selected].line)
            }
        }
        #else
        // Rows as tall as their words at the reader's text size, a few before it scrolls, above the keyboard. The
        // scroller shows itself once on opening, and the count under the rows says how many.
        ScrollView(.vertical) {
            VStack(spacing: 0) {
                ForEach(matches, id: \.line) { command in
                    Button { onChoose(command) } label: {
                        SlashTypeaheadRow(command: command, isSelected: false)
                    }
                    .buttonStyle(SlashTypeaheadPress())
                }
            }
        }
        .scrollIndicatorsFlash(onAppear: true)
        .frame(maxHeight: Self.phoneMaxHeight)
        .fixedSize(horizontal: false, vertical: true)
        #endif
    }

    #if os(macOS)
    /// ⌘K's row: 12.5 type and 6 above and below, 28 in all.
    public static let rowHeight: CGFloat = 28
    public static let visibleRows: CGFloat = 7
    /// With the card's own 6, the row's text starts where the field's does (`ComposerView.fieldInsetX`).
    public static let rowInsetX: CGFloat = 10
    static let titleSize: CGFloat = 12.5
    static let detailSize: CGFloat = 11
    static let footerSize: CGFloat = 10.5
    #else
    public static let rowInsetX: CGFloat = 0
    static let phoneMaxHeight: CGFloat = 236
    static let phoneRowsBeforeCount = 4
    #endif
}

private struct SlashTypeaheadRow: View {
    let command: AgentCommand
    let isSelected: Bool
    #if os(macOS)
    var inset: CGFloat = SlashTypeaheadList.rowInsetX
    var radius: CGFloat = ConchRadius.medium
    @State private var isHovering = false
    #endif

    var body: some View {
        #if os(macOS)
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text(command.line)
                .font(.system(size: SlashTypeaheadList.titleSize))
                .foregroundStyle(ConchColor.textPrimary)
                .lineLimit(1)
                .layoutPriority(2)
            // A step darker on the highlight, where the tertiary ink fell under 4.5:1 (the Skills library's rule).
            Text(command.detail)
                .font(.system(size: SlashTypeaheadList.detailSize))
                .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if let hint = command.argumentPlaceholder {
                Text(hint)
                    .font(.system(size: SlashTypeaheadList.footerSize))
                    .foregroundStyle(LibraryRowText.quiet(selected: isSelected))
                    .lineLimit(1)
                    .layoutPriority(1)
            }
        }
        .padding(.horizontal, inset)
        .frame(height: SlashTypeaheadList.rowHeight)
        // ⌘K's ladder: the selection outranks hover.
        .background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(isSelected ? AnyShapeStyle(ConchColor.rowSelected) : isHovering ? AnyShapeStyle(ConchColor.rowHover) : AnyShapeStyle(.clear))
        )
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        #else
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(command.line)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(ConchColor.textPrimary)
                    .lineLimit(1)
                if let hint = command.argumentPlaceholder {
                    Text(hint).font(.footnote).foregroundStyle(ConchColor.textTertiary).lineLimit(1)
                }
            }
            Text(command.detail)
                .font(.footnote)
                .foregroundStyle(ConchColor.textSecondary)
                .lineLimit(2)
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        #endif
    }
}

#if os(iOS)
/// A row under the thumb: the selection's fill while pressed, reaching 8 past the words on each side, 6 in from the
/// composer's edge, its corners concentric with the composer's 26 there.
private struct SlashTypeaheadPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(configuration.isPressed ? AnyShapeStyle(ConchColor.rowSelected) : AnyShapeStyle(.clear))
                    .padding(.horizontal, -8)
            )
    }
}
#endif
