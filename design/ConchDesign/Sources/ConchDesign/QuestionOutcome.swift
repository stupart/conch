import Foundation

// What a question's answer was — workspace-v1 §3.
//
// "Once answered it collapses to 'Legacy keys · you chose Keep them under legacy'." Today an
// answered question keeps drawing its whole block: the header, the question, and a list of
// options nobody can press any more. That is the largest thing in a finished transcript that
// says the least.
//
// The wire never says "the user chose X". An answered AskUserQuestion is simply a completed
// tool call, and what it carries is the call's RESULT text. So the choice is recovered by
// looking for the options' own labels in that text — and when none of them is there, nothing
// is claimed and the row keeps the shape it has today. Guessing at a person's decision is
// worse than not summarising it.

public enum QuestionOutcome {
    /// Which of `options` the answer names, in the order the question listed them.
    ///
    /// A label that sits INSIDE a longer matched label is not a second choice: with options
    /// "Keep" and "Keep them under legacy", an answer naming the latter names one thing, and
    /// reporting both would invent a decision.
    public static func chosen(from options: [String], in result: String?) -> [String] {
        guard let result, !result.isEmpty else { return [] }
        let haystack = result.lowercased()

        var taken: [Range<String.Index>] = []
        var accepted: Set<Int> = []
        // Longest first, so the specific option claims its span before a shorter one can.
        for (index, label) in options.enumerated()
            .sorted(by: { $0.element.count > $1.element.count }) {
            let needle = label.lowercased()
            guard !needle.isEmpty, let range = haystack.range(of: needle) else { continue }
            if taken.contains(where: { $0.overlaps(range) }) { continue }
            taken.append(range)
            accepted.insert(index)
        }
        return options.enumerated().filter { accepted.contains($0.offset) }.map(\.element)
    }

    /// Each question's answer, read from Claude Code's result — `"<question>"="<answer>"`
    /// for every question — or nil unless every one is there. Read per question rather than
    /// by searching for option labels: with several questions in one result, a label from
    /// one would match another's answer.
    public static func answers(to questions: [String], in result: String?) -> [String]? {
        guard let result else { return nil }
        var found: [String] = []
        for question in questions {
            let key = "\"\(question)\"=\""
            guard let start = result.range(of: key) else { return nil }
            // Words with a comma on a multi-select question are quoted again inside the quotes,
            // so the comma can't read as a second option: `"Pick gamma?"=""a, b""` (2.1.280,
            // measured in the lab, 2026-09-28).
            if result[start.upperBound...].hasPrefix("\""),
               let close = result.range(of: "\"\"", range: result.index(after: start.upperBound)..<result.endIndex) {
                found.append(String(result[result.index(after: start.upperBound)..<close.lowerBound]))
                continue
            }
            guard let end = result.range(of: "\"", range: start.upperBound..<result.endIndex) else { return nil }
            found.append(String(result[start.upperBound..<end.lowerBound]))
        }
        return found
    }

    /// §3's collapsed line, or nil when there is nothing certain to say.
    public static func summary(header: String, chosen: [String]) -> String? {
        guard !chosen.isEmpty else { return nil }
        let picked = chosen.joined(separator: ", ")
        let name = header.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "you chose \(picked)" : "\(name) · you chose \(picked)"
    }

    /// A lone question's collapsed line. Claude Code records the answer as
    /// `"<question>"="<answer>"` (2.1.280); when that answer is exactly the options it names it
    /// reads "you chose …", and when it carries words of your own — alone, or beside ticked
    /// options ("G1, G3, plus my words") — it is quoted as recorded. A lone question answered in
    /// words used to stay drawn in full, every option still looking pressable (Tyler's "Ship
    /// tonight", answered in the terminal, 2026-09-28). A result with no recorded answer falls
    /// back to the options named anywhere in it; nothing recognisable says nothing.
    public static func summary(header: String, question: String, options: [String], result: String?) -> String? {
        guard let recorded = answers(to: [question], in: result)?.first else {
            return summary(header: header, chosen: chosen(from: options, in: result))
        }
        let picked = chosen(from: options, in: recorded)
        if !picked.isEmpty, picked.joined(separator: ", ") == recorded { return summary(header: header, chosen: picked) }
        let said = recorded.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return nil }
        let name = header.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "you answered “\(said)”" : "\(name) · you answered “\(said)”"
    }

    /// Which options each question's recorded answer names, for a finished card still drawn in
    /// full: those stay marked, the rest dim. Per question, in order; empty where nothing is certain.
    public static func chosenPerQuestion(questions: [String], options: [[String]], result: String?) -> [[String]] {
        guard questions.count == options.count, !questions.isEmpty else { return options.map { _ in [] } }
        if let recorded = answers(to: questions, in: result) {
            return zip(options, recorded).map { chosen(from: $0, in: $1) }
        }
        return questions.count == 1 ? [chosen(from: options[0], in: result)] : options.map { _ in [] }
    }

    /// The one question row a session can still be answering: the newest running question with
    /// nothing Tyler said after it. The daemon's own rule (`pendingQuestion`, src/conversation.ts):
    /// a question he has talked past is still "running" on disk, and a card that stayed pressable
    /// for it offered an answer the daemon then refused. Nil when none is.
    public static func liveQuestionID<Item>(
        in items: [Item],
        id: (Item) -> String,
        isUser: (Item) -> Bool,
        isRunningQuestion: (Item) -> Bool
    ) -> String? {
        for item in items.reversed() {
            if isUser(item) { return nil }
            if isRunningQuestion(item) { return id(item) }
        }
        return nil
    }
}
