import Foundation

/// The agent's commands, offered in the message box as they are typed, on the Mac and the phone alike (2026-11-04).
/// Tyler: "can u get me access to slash commands on the mobile app and desktop app?" The catalog was only in the
/// palettes (⌘K, the phone's Commands sheet); this puts it where the words go. When it shows, what it lists and what
/// choosing does are decided here, once, so the two composers cannot come to disagree: they draw it and hand it the keys.
///
/// It shows while the draft starts with a sigil one of the session's lines starts with (`/`, and `$` for Codex's
/// skills) and the caret is still in that first word: never mid-sentence, never once the command has words after it.
///
/// It lists what the word starts, or what starts a word inside a line (`/audit` finds `/review-kit:audit`), never a
/// scattered match. Return chooses while it shows, so a command conch does not list (an MCP prompt, one newer than this
/// catalog) must find nothing, close it, and still send.
public struct SlashTypeahead: Equatable, Sendable {
    /// The command word being typed.
    public struct Word: Equatable, Sendable {
        /// What it starts with: `/`, or `$`.
        public let sigil: Character
        /// The whole first word, sigil and all.
        public let text: String
        /// What follows the sigil: what the lines are matched against.
        public var query: String { String(text.dropFirst()) }
    }

    /// What choosing a row makes of the draft.
    public struct Choice: Equatable, Sendable {
        public let draft: String
        /// Where the caret goes, counted as a text view counts it (UTF-16): after the command, or after the space its
        /// argument goes behind.
        public let caret: Int
        /// The draft already was this, so there was nothing to fill: Return sends it rather than choosing it again.
        public let unchanged: Bool
    }

    /// Everything the session's agent can be typed, in the order a tie keeps (`AgentCommands.all`).
    public private(set) var catalog: [AgentCommand]
    /// The command word under the caret, whether or not anything matches it.
    public private(set) var word: Word?
    /// What the list shows, best first. Empty is closed.
    public private(set) var matches: [AgentCommand] = []
    /// The highlighted row, in `matches`.
    public private(set) var selected = 0
    /// The word Esc closed the list on, or a command was just chosen into: it stays shut until that word changes.
    private var closedOn: String?
    /// The draft and caret last seen, for a catalog that arrives after them.
    private var draft = ""
    private var caret: Int?

    public init(catalog: [AgentCommand] = []) {
        self.catalog = catalog
    }

    public var isShowing: Bool { !matches.isEmpty }

    public var selection: AgentCommand? { matches.indices.contains(selected) ? matches[selected] : nil }

    /// What a line may start with for this session: the first characters of its catalog's lines. A Claude session has
    /// only `/`; a Codex one gains `$` once its skills are read. Read off the lines, so nothing here asks whose agent it is.
    public var sigils: Set<Character> { Set(catalog.compactMap(\.line.first)) }

    /// The session's skills and commands arrived (or it is another session's catalog): the list follows, on the row it had.
    public mutating func setCatalog(_ catalog: [AgentCommand]) {
        guard catalog != self.catalog else { return }
        let kept = selection?.line
        self.catalog = catalog
        // A `$` may mean something now that it did not before the skills were read.
        word = Self.word(in: draft, caret: caret, sigils: sigils)
        if closedOn != nil, word?.text != closedOn { closedOn = nil }
        refresh(keeping: kept)
    }

    /// The draft or its caret moved. `caret` is in UTF-16, as a text view counts it; nil is the end of the draft (the
    /// phone's field does not say where its caret is, and a thumb types at the end).
    public mutating func update(draft: String, caret: Int?) {
        self.draft = draft
        self.caret = caret
        let next = Self.word(in: draft, caret: caret, sigils: sigils)
        let kept = next?.text == word?.text ? selection?.line : nil
        word = next
        if closedOn != nil, next?.text != closedOn { closedOn = nil }
        refresh(keeping: kept)
    }

    /// ↑ and ↓, stopping at the ends as ⌘K's do.
    public mutating func move(_ delta: Int) {
        guard !matches.isEmpty else { return }
        selected = min(max(selected + delta, 0), matches.count - 1)
    }

    /// A row the pointer is on, or was tapped.
    public mutating func highlight(_ command: AgentCommand) {
        if let index = matches.firstIndex(of: command) { selected = index }
    }

    /// Esc: closed, and staying closed while the word is the same. Typing on opens it again.
    public mutating func dismiss() {
        guard let word else { return }
        closedOn = word.text
        refresh(keeping: nil)
    }

    /// Choose `command`, or the highlighted row: what the draft becomes and where the caret goes. Nothing is ever sent
    /// from here; the composer sends only when the draft was already the command (`Choice.unchanged`) and Return asked.
    public mutating func choose(_ command: AgentCommand? = nil, in draft: String) -> Choice? {
        guard isShowing, let command = command ?? selection else { return nil }
        let choice = Self.fill(draft, with: command)
        // Chosen, it stays shut until the word changes: a command that takes nothing is a line ready for Return now.
        closedOn = command.line
        self.draft = choice.draft
        caret = choice.caret
        word = Self.word(in: choice.draft, caret: choice.caret, sigils: sigils)
        refresh(keeping: nil)
        return choice
    }

    private mutating func refresh(keeping line: String?) {
        guard let word, word.text != closedOn else {
            matches = []
            selected = 0
            return
        }
        matches = Self.ranked(word, in: catalog)
        selected = line.flatMap { line in matches.firstIndex { $0.line == line } } ?? 0
    }

    // MARK: The rules, by themselves

    /// Whether a draft begins as any agent's command could (`/`, or `$`): the moment to read the session's skills and
    /// commands, before its own sigils are known.
    public static func mayBeginCommand(_ draft: String) -> Bool {
        draft.first == "/" || draft.first == "$"
    }

    /// The command word the caret is in, or nil: the draft starts with one of `sigils`, the caret is after it and no
    /// further than the first word's end, and the word is shaped like a command. A path's second `/`, a link and
    /// anything else a command is never spelled with leave it closed.
    public static func word(in draft: String, caret: Int?, sigils: Set<Character>) -> Word? {
        guard let sigil = draft.first, sigils.contains(sigil) else { return nil }
        let text = String(draft.prefix { !$0.isWhitespace })
        let at = caret ?? draft.utf16.count
        guard at >= 1, at <= text.utf16.count else { return nil }
        guard text.dropFirst().allSatisfy(isCommandCharacter) else { return nil }
        return Word(sigil: sigil, text: text)
    }

    /// Letters, digits, `-`, `_`, `:` and `.`: what an agent's commands, skills and plugins are named with.
    static func isCommandCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber || "-_:.".contains(character)
    }

    /// The lines spelled with the word's sigil that it starts, or starts a word of, best first (`CommandMatch.score`),
    /// the catalog's order breaking ties. Just the sigil lists them all, in that order.
    public static func ranked(_ word: Word, in catalog: [AgentCommand]) -> [AgentCommand] {
        let query = word.query
        return catalog.enumerated()
            .compactMap { index, command -> (score: Int, index: Int, command: AgentCommand)? in
                guard command.line.first == word.sigil, let score = CommandMatch.score(query, in: command.line) else { return nil }
                // A prefix scores 300 less the length and a word start 200 less it; a scattered subsequence tops out at
                // 100. Lines are far shorter than 100, so above 100 is a start.
                guard query.isEmpty || score > 100 else { return nil }
                return (score, index, command)
            }
            .sorted { $0.score != $1.score ? $0.score > $1.score : $0.index < $1.index }
            .map(\.command)
    }

    /// The draft with its first word replaced by `command`, whatever follows it kept. A command that takes an argument
    /// gets the space it goes behind and the caret after it; one that takes none is the line, the caret at its end.
    public static func fill(_ draft: String, with command: AgentCommand) -> Choice {
        let first = draft.prefix { !$0.isWhitespace }
        let rest = draft[first.endIndex...]
        let length = command.line.utf16.count
        let filled: String
        let caret: Int
        if command.takesArgument {
            filled = command.line + (rest.first == " " ? "" : " ") + rest
            caret = length + 1
        } else {
            filled = command.line + rest
            caret = length
        }
        return Choice(draft: filled, caret: caret, unchanged: filled == draft)
    }

    /// The argument a command is waiting for, while nothing has been typed after it: the draft is the command and one
    /// space, the caret at its end. The composer shows it there, in the placeholder's ink.
    public static func placeholder(for draft: String, caret: Int?, in catalog: [AgentCommand]) -> String? {
        guard draft.hasSuffix(" "), !draft.hasSuffix("  "), caret == nil || caret == draft.utf16.count else { return nil }
        let line = String(draft.dropLast())
        return catalog.first { $0.line == line }?.argumentPlaceholder
    }
}
