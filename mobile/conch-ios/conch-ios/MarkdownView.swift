import SwiftUI

/// A compact block-level markdown renderer.
///
/// Foundation's `AttributedString(markdown:)` handles inline emphasis but
/// drops block structure on iOS the same way it does on the Mac — so blocks
/// are split here and inline parsing is applied within each. Headings,
/// lists, quotes, code and tables cover what agents actually write; anything
/// else renders as a paragraph rather than vanishing.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                render(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Block model

    private enum Block {
        case heading(Int, String)
        case bullet(Int, String)     // depth, text
        case ordered(Int, String)    // ordinal, text
        case quote(String)
        case code(String)
        case table([[String]])
        case paragraph(String)
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var code: [String] = []
        var table: [[String]] = []
        var inCode = false

        func flushParagraph() {
            if !paragraph.isEmpty {
                result.append(.paragraph(paragraph.joined(separator: " ")))
                paragraph = []
            }
        }
        func flushTable() {
            if !table.isEmpty {
                result.append(.table(table))
                table = []
            }
        }

        for rawLine in text.components(separatedBy: "\n") {
            let line = String(rawLine)
            if line.hasPrefix("```") {
                flushParagraph(); flushTable()
                if inCode {
                    result.append(.code(code.joined(separator: "\n")))
                    code = []
                }
                inCode.toggle()
                continue
            }
            if inCode { code.append(line); continue }

            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flushParagraph(); flushTable(); continue }

            if trimmed.hasPrefix("|") {
                flushParagraph()
                let cells = trimmed
                    .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
                    .components(separatedBy: "|")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                // Skip the |---|---| separator row.
                if !cells.allSatisfy({ $0.allSatisfy { "-: ".contains($0) } }) {
                    table.append(cells)
                }
                continue
            }
            flushTable()

            if let heading = trimmed.headingLevel {
                flushParagraph()
                result.append(.heading(heading.level, heading.text))
            } else if let bullet = line.bulletItem {
                flushParagraph()
                result.append(.bullet(bullet.depth, bullet.text))
            } else if let ordered = trimmed.orderedItem {
                flushParagraph()
                result.append(.ordered(ordered.ordinal, ordered.text))
            } else if trimmed.hasPrefix(">") {
                flushParagraph()
                result.append(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
            } else {
                paragraph.append(trimmed)
            }
        }
        if inCode, !code.isEmpty { result.append(.code(code.joined(separator: "\n"))) }
        flushParagraph()
        flushTable()
        return result
    }

    // MARK: - Rendering

    @ViewBuilder
    private func render(_ block: Block) -> some View {
        switch block {
        case let .heading(level, text):
            inline(text)
                .font(.system(
                    size: level <= 1 ? 24 : level == 2 ? 20 : 17,
                    weight: .bold
                ))
                .padding(.top, 4)
        case let .bullet(depth, text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(depth > 0 ? "◦" : "•")
                    .font(Type.body)
                    .foregroundStyle(Palette.textDim)
                inline(text).font(Type.body)
            }
            .padding(.leading, CGFloat(16 + depth * 18))
        case let .ordered(ordinal, text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(ordinal).")
                    .font(Type.body.monospacedDigit())
                    .foregroundStyle(Palette.textDim)
                    .frame(minWidth: 26, alignment: .trailing)
                inline(text).font(Type.body)
            }
            .padding(.leading, 16)
        case let .quote(text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Palette.textDim)
                    .frame(width: 2)
                inline(text).font(Type.body)
            }
            .padding(.leading, 8)
        case let .code(text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(Type.mono)
                    .foregroundStyle(Palette.textPrimary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        case let .table(rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(cell)
                                    .font(Type.mono)
                                    .fontWeight(index == 0 ? .semibold : .regular)
                            }
                        }
                        if index == 0 {
                            Divider().overlay(Palette.divider)
                        }
                    }
                }
            }
        case let .paragraph(text):
            inline(text).font(Type.body)
        }
    }

    /// Inline emphasis via Foundation; falls back to the literal string so a
    /// malformed span can never blank a block.
    private func inline(_ text: String) -> Text {
        if let parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return Text(parsed)
        }
        return Text(text)
    }
}

private extension String {
    var headingLevel: (level: Int, text: String)? {
        guard hasPrefix("#") else { return nil }
        let level = prefix(while: { $0 == "#" }).count
        guard level <= 6 else { return nil }
        let text = dropFirst(level).trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return (level, text)
    }

    var bulletItem: (depth: Int, text: String)? {
        let leading = prefix(while: { $0 == " " }).count
        let trimmed = trimmingCharacters(in: .whitespaces)
        for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
            return (leading >= 2 ? 1 : 0, String(trimmed.dropFirst(marker.count)))
        }
        return nil
    }

    var orderedItem: (ordinal: Int, text: String)? {
        guard let dot = firstIndex(of: "."),
              let ordinal = Int(self[..<dot]),
              ordinal > 0, ordinal < 1000 else { return nil }
        let rest = self[index(after: dot)...]
        guard rest.hasPrefix(" ") else { return nil }
        return (ordinal, rest.trimmingCharacters(in: .whitespaces))
    }
}
