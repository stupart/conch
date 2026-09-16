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

    /// §3's collapsed line, or nil when there is nothing certain to say.
    public static func summary(header: String, chosen: [String]) -> String? {
        guard !chosen.isEmpty else { return nil }
        let picked = chosen.joined(separator: ", ")
        let name = header.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "you chose \(picked)" : "\(name) · you chose \(picked)"
    }
}
