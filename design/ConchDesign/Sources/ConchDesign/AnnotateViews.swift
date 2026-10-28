import SwiftUI

// What annotate draws in the deliverables pane (docs/annotate.md): a note's pin, what it is pinned to, the field it is
// written in, and the tray that counts the notes and sends them. In Tyler's ink, the canvas's orange, with the canvas's
// own pin, so a note looks the same here, on his canvas and in the picture the agent reads; on the pane's own surfaces,
// light and dark, since it is drawn inside conch rather than over another app.

/// A note's pin: the canvas's badge (`CanvasInk.pin`), rounded but for the corner on what it marks, its number on it.
/// Placed by its spot, the badge's bottom left (`AnnotationGeometry.pinSpot`).
public struct AnnotationPin: View {
    let number: Int
    /// Being written or edited: a ring of the surface round it, so it stands off the outline it sits on.
    let lifted: Bool
    let side: CGFloat

    public init(number: Int, lifted: Bool = false, side: CGFloat = CanvasInk.pinSide) {
        self.number = number
        self.lifted = lifted
        self.side = side
    }

    public var body: some View {
        PinShape()
            .fill(CanvasInk.you.color)
            .overlay(
                Text("\(number)")
                    .font(.system(size: side * 0.5, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(CanvasInk.onYou.color)
            )
            .overlay(PinShape().stroke(ConchColor.surface, lineWidth: lifted ? 2 : 1.25))
            .frame(width: side, height: side)
            .conchElevation(.raised)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Note \(number)")
    }

    /// `CanvasInk.pin`, in a square: the spot is its bottom left.
    struct PinShape: Shape {
        func path(in rect: CGRect) -> Path {
            Path(CanvasInk.pin(at: CGPoint(x: rect.minX, y: rect.maxY), side: rect.width))
        }
    }
}

/// What a note is pinned to, outlined: an element or a region boxed, words washed in the highlighter's way, the element
/// under the pointer while annotating outlined lighter, with its name.
public struct AnnotationOutline: View {
    public enum Kind: Equatable, Sendable {
        /// An element or a region of a picture.
        case box
        /// Words.
        case words
        /// What a click would pin to, named.
        case hover(String)
        /// A box being dragged on a picture.
        case dragging
    }

    let kind: Kind

    public init(_ kind: Kind) {
        self.kind = kind
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: kind == .words ? 3 : 6, style: .continuous)
        switch kind {
        case .box:
            shape.fill(CanvasInk.you.color.opacity(CanvasInk.washOpacity))
                .overlay(shape.strokeBorder(CanvasInk.you.color, lineWidth: 2))
        case .words:
            shape.fill(CanvasInk.you.color.opacity(0.22))
        case .dragging:
            shape.fill(CanvasInk.you.color.opacity(0.1))
                .overlay(shape.strokeBorder(CanvasInk.you.color, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3])))
        case let .hover(name):
            shape.fill(CanvasInk.you.color.opacity(0.08))
                .overlay(shape.strokeBorder(CanvasInk.you.color.opacity(0.9), lineWidth: 1.5))
                .overlay(alignment: .topLeading) {
                    Text(name)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .lineLimit(1)
                        .foregroundStyle(CanvasInk.onYou.color)
                        .padding(.horizontal, 6)
                        .frame(height: 18)
                        .background(Capsule().fill(CanvasInk.you.color))
                        // Above the outline's top edge, where it doesn't cover what it names.
                        .alignmentGuide(.top) { $0[.bottom] + 3 }
                        .fixedSize()
                }
        }
    }
}

/// Where a note is written: what it is pinned to, a field for what should change, Save. Return saves, Esc puts it
/// back as it was (a new note with no words is let go), and an existing note can be deleted.
public struct AnnotationEditor: View {
    let number: Int
    let name: String
    @Binding var text: String
    let isNew: Bool
    let width: CGFloat
    let onSave: () -> Void
    let onCancel: () -> Void
    let onDelete: () -> Void
    @FocusState private var focused: Bool

    public static let width: CGFloat = 288
    /// As narrow as it goes, in a narrow column (a file beside a folder's tree): its words still fit on one line.
    public static let narrowest: CGFloat = 232

    /// As wide as `room` allows, from `narrowest` to `width`.
    public static func width(in room: CGFloat) -> CGFloat {
        min(width, max(narrowest, room - 20))
    }

    public init(number: Int, name: String, text: Binding<String>, isNew: Bool, width: CGFloat = AnnotationEditor.width, onSave: @escaping () -> Void, onCancel: @escaping () -> Void, onDelete: @escaping () -> Void) {
        self.number = number
        self.name = name
        _text = text
        self.isNew = isNew
        self.width = width
        self.onSave = onSave
        self.onCancel = onCancel
        self.onDelete = onDelete
    }

    private var hasWords: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public var body: some View {
        VStack(alignment: .leading, spacing: ConchSpace.x2) {
            HStack(spacing: 6) {
                AnnotationPin(number: number, side: 16)
                Text(name)
                    .font(ConchType.meta)
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            TextField("What should change?", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(ConchType.uiBody)
                .foregroundStyle(ConchColor.textPrimary)
                .lineLimit(1...6)
                .focused($focused)
                .onSubmit { hasWords ? onSave() : onCancel() }
                #if os(macOS)
                .onExitCommand(perform: onCancel)
                #endif
                .accessibilityLabel("Note \(number)")
            HStack(spacing: ConchSpace.x2) {
                if !isNew {
                    Button(action: onDelete) {
                        Image(systemName: "trash")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(ConchColor.textSecondary)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete this note")
                    .accessibilityLabel("Delete note \(number)")
                }
                Spacer(minLength: 0)
                Text(isNew ? "Esc to drop it" : "Esc to keep it as it was")
                    .font(ConchType.meta)
                    .foregroundStyle(ConchColor.textTertiary)
                Button(action: onSave) {
                    Text("Save")
                        .font(ConchType.uiEmphasis)
                        .foregroundStyle(CanvasInk.onYou.color)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(Capsule().fill(CanvasInk.you.color))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!hasWords)
                .opacity(hasWords ? 1 : 0.45)
                .help("Save the note (Return)")
            }
        }
        .padding(ConchSpace.x3)
        .frame(width: width, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).fill(ConchColor.surfaceRaised))
        .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
        .conchElevation(.floating)
        .onAppear { focused = true }
        .accessibilityElement(children: .contain)
    }
}

/// The tray along the pane's foot while annotating or while notes wait: how many, the list of them, Clear, Done and Send
/// to the session that published the deliverable; and above it, what became of a Send.
public struct AnnotationTray: View {
    /// A note as the list shows it.
    public struct Row: Identifiable, Equatable, Sendable {
        public let id: String
        public let number: Int
        public let name: String
        public let words: String
        /// Not where conch last looked for it: it is still sent, and the list says so.
        public let missing: Bool

        public init(id: String, number: Int, name: String, words: String, missing: Bool = false) {
            self.id = id
            self.number = number
            self.name = name
            self.words = words
            self.missing = missing
        }

        public init(_ note: AnnotationNote, number: Int) {
            self.init(id: note.id, number: number, name: note.anchor.name, words: note.words, missing: !note.found)
        }
    }

    /// What the tray says above itself, until the next thing happens.
    public struct Notice: Equatable, Sendable {
        public enum Tone: Equatable, Sendable { case done, problem }
        public enum Action: String, Equatable, Sendable {
            case copy, discard
            public var title: String {
                switch self {
                case .copy: "Copy notes"
                case .discard: "Discard"
                }
            }
        }

        public let text: String
        public let tone: Tone
        public let actions: [Action]

        public init(_ text: String, tone: Tone = .problem, actions: [Action] = []) {
            self.text = text
            self.tone = tone
            self.actions = actions
        }

        public static func sent(to label: String) -> Notice { Notice("Sent to \(label)", tone: .done) }
        /// Send with nowhere to go: the session gone, or listed with no way in (`AnnotationRoute.unavailable`).
        public static func ended(_ route: AnnotationRoute) -> Notice {
            guard let reason = route.unavailable else {
                return Notice("\(route.label) has ended, so there is nowhere to send these. Your notes are kept here.", actions: [.copy])
            }
            return Notice("Can't send to \(route.label): \(reason.trimmingCharacters(in: CharacterSet(charactersIn: ". "))). Your notes are kept here.", actions: [.copy])
        }
        /// A session that ended with notes waiting on its deliverable, which went from conch's list with it: said on
        /// whatever the pane shows next, so the words aren't lost without a word.
        public static func orphaned(_ label: String, notes: Int) -> Notice {
            Notice("\(label) ended with \(notes == 1 ? "a note" : "\(notes) notes") you hadn't sent.", actions: [.copy, .discard])
        }
        public static func notSent(to label: String, because reason: String?) -> Notice {
            Notice("Couldn't send to \(label)\(reason.map { ": \($0)" } ?? "."). Your notes are kept here.", actions: [.copy])
        }
        /// How long "Sent to …" stays.
        public static let sentFor: Duration = .seconds(4)
    }

    let rows: [Row]
    let annotating: Bool
    /// What pointing does here, while annotating with no notes yet.
    let hint: String
    let route: AnnotationRoute?
    let sending: Bool
    let notice: Notice?
    @Binding var listOpen: Bool
    let onSend: () -> Void
    let onClear: () -> Void
    let onDone: () -> Void
    let onEdit: (String) -> Void
    let onRemove: (String) -> Void
    let onNotice: (Notice.Action) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        rows: [Row], annotating: Bool, hint: String, route: AnnotationRoute?, sending: Bool = false, notice: Notice? = nil,
        listOpen: Binding<Bool>, onSend: @escaping () -> Void, onClear: @escaping () -> Void, onDone: @escaping () -> Void,
        onEdit: @escaping (String) -> Void = { _ in }, onRemove: @escaping (String) -> Void = { _ in },
        onNotice: @escaping (Notice.Action) -> Void = { _ in }
    ) {
        self.rows = rows
        self.annotating = annotating
        self.hint = hint
        self.route = route
        self.sending = sending
        self.notice = notice
        _listOpen = listOpen
        self.onSend = onSend
        self.onClear = onClear
        self.onDone = onDone
        self.onEdit = onEdit
        self.onRemove = onRemove
        self.onNotice = onNotice
    }

    public static let height: CGFloat = 32
    public static let listWidth: CGFloat = 340

    private var canSend: Bool { !rows.isEmpty && route?.ended == false && !sending }
    private var missing: Int { rows.filter(\.missing).count }

    public var body: some View {
        VStack(spacing: ConchSpace.x2) {
            if let notice { say(notice) }
            if listOpen, !rows.isEmpty { list }
            if annotating || !rows.isEmpty { bar }
        }
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: notice)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: listOpen)
        .animation(ConchMotion.pop.animation(reduceMotion: reduceMotion), value: rows)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Notes")
    }

    private var bar: some View {
        HStack(spacing: 2) {
            if rows.isEmpty {
                Text(hint)
                    .font(ConchType.secondary)
                    .foregroundStyle(ConchColor.textSecondary)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .frame(height: Self.height)
            } else {
                Button { listOpen.toggle() } label: {
                    HStack(spacing: 6) {
                        Circle().fill(CanvasInk.you.color).frame(width: 8, height: 8)
                        Text(rows.count == 1 ? "1 note" : "\(rows.count) notes")
                            .font(ConchType.uiEmphasis)
                            .foregroundStyle(ConchColor.textPrimary)
                        if missing > 0 {
                            Text("· \(missing) not on the page")
                                .font(ConchType.secondary)
                                .foregroundStyle(ConchColor.attention)
                        }
                        Image(systemName: listOpen ? "chevron.down" : "chevron.up")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(ConchColor.textSecondary)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: Self.height)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(listOpen ? "Hide the notes" : "Show the notes")
                .accessibilityLabel(rows.count == 1 ? "1 note" : "\(rows.count) notes")
                separator
                iconButton("xmark", help: "Clear the notes (nothing is sent)", label: "Clear the notes", action: onClear)
                    .disabled(sending)
            }
            if annotating {
                Button(action: onDone) {
                    Text("Done")
                        .font(ConchType.uiEmphasis)
                        .foregroundStyle(ConchColor.textPrimary)
                        .padding(.horizontal, 10)
                        .frame(height: Self.height)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Stop annotating (Esc): your notes stay")
            }
            if !rows.isEmpty { send }
        }
        .padding(4)
        .background(glass(RoundedRectangle(cornerRadius: 12, style: .continuous)))
        .fixedSize()
    }

    private var separator: some View {
        Rectangle().fill(ConchColor.hairlineStrong).frame(width: 0.5, height: 18).padding(.horizontal, 3)
    }

    private func iconButton(_ symbol: String, help: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(ConchColor.textSecondary)
                .frame(width: Self.height, height: Self.height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(label)
    }

    /// Send, in Tyler's ink, naming the session it goes to: the deliverable's own, never a guess.
    private var send: some View {
        Button(action: onSend) {
            HStack(spacing: 6) {
                if sending {
                    ProgressView().controlSize(.small).tint(CanvasInk.onYou.color)
                } else {
                    Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold))
                }
                Text(route.map { "Send to \($0.label)" } ?? "Send")
                    .font(ConchType.uiEmphasis)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 220, alignment: .leading)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .foregroundStyle(CanvasInk.onYou.color)
            .padding(.horizontal, 12)
            .frame(height: Self.height)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(CanvasInk.you.color))
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .opacity(canSend || sending ? 1 : 0.45)
        .keyboardShortcut(.return, modifiers: .command)
        .help(route?.ended == true ? route?.unavailable ?? "\(route!.label) has ended" : route.map { "Send these notes to \($0.label) (⌘Return)" } ?? "Send (⌘Return)")
        .accessibilityLabel(route.map { "Send notes to \($0.label)" } ?? "Send notes")
    }

    /// The notes, one a row: as tall as they are, scrolling only past 260 points.
    private var list: some View {
        ViewThatFits(in: .vertical) {
            listRows
            ScrollView { listRows }
        }
        .frame(width: Self.listWidth)
        .frame(maxHeight: 260)
        .fixedSize(horizontal: false, vertical: true)
        .background(glass(RoundedRectangle(cornerRadius: 12, style: .continuous)))
        .transition(reduceMotion ? .opacity : .scale(scale: 0.94, anchor: .bottom).combined(with: .opacity))
    }

    private var listRows: some View {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    HStack(alignment: .top, spacing: ConchSpace.x2) {
                        Button { onEdit(row.id) } label: {
                            HStack(alignment: .top, spacing: ConchSpace.x2) {
                                AnnotationPin(number: row.number, side: 18)
                                    .padding(.top, 1)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.words)
                                        .font(ConchType.uiBody)
                                        .foregroundStyle(ConchColor.textPrimary)
                                        .lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                    HStack(spacing: 4) {
                                        Text(row.name)
                                            .font(ConchType.meta)
                                            .foregroundStyle(ConchColor.textSecondary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        if row.missing {
                                            Text("· not on the page now")
                                                .font(ConchType.meta)
                                                .foregroundStyle(ConchColor.attention)
                                                .lineLimit(1)
                                                .fixedSize()
                                        }
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(row.missing ? "Not on the page now. It is still sent, with the picture taken when you pinned it." : "Edit this note")
                        Button { onRemove(row.id) } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(ConchColor.textTertiary)
                                .frame(width: 20, height: 20)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("Remove this note")
                        .accessibilityLabel("Remove note \(row.number)")
                    }
                    .padding(.horizontal, ConchSpace.x2)
                    .padding(.vertical, 7)
                    if row.id != rows.last?.id {
                        Rectangle().fill(ConchColor.hairline).frame(height: 0.5).padding(.leading, 34)
                    }
                }
            }
            .padding(4)
    }

    private func say(_ notice: Notice) -> some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: notice.tone == .done ? "checkmark" : "exclamationmark.triangle.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(notice.tone == .done ? ConchColor.textPrimary : ConchColor.attention)
                Text(notice.text)
                    .font(ConchType.secondary)
                    .foregroundStyle(ConchColor.textPrimary)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: 320, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !notice.actions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(notice.actions, id: \.self) { action in
                        Button { onNotice(action) } label: {
                            Text(action.title)
                                .font(ConchType.secondary.weight(.semibold))
                                .foregroundStyle(action == .copy ? ConchColor.onAccent : ConchColor.textPrimary)
                                .padding(.horizontal, 10)
                                .frame(height: 24)
                                .background(Capsule().fill(action == .copy ? AnyShapeStyle(ConchColor.accent) : AnyShapeStyle(ConchColor.fill)))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, ConchSpace.x3)
        .padding(.vertical, 8)
        .fixedSize()
        .background(glass(RoundedRectangle(cornerRadius: 12, style: .continuous)))
        .transition(reduceMotion ? .opacity : .scale(scale: 0.9, anchor: .bottom).combined(with: .opacity))
    }

    private func glass<S: InsettableShape>(_ shape: S) -> some View {
        ZStack {
            shape.fill(.regularMaterial)
            shape.fill(ConchColor.surfaceRaised.opacity(0.82))
            shape.strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5)
        }
        .conchElevation(.floating)
    }
}
