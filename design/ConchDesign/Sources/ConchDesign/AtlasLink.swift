import Foundation

/// A link between Atlas pages: `[[projects/index|Projects]]`, or `[[projects/index]]`, in the page's own Markdown.
///
/// Tyler, 2026-10-28: "looks like the '← Back to [[projects/index|Projects]]' button doesn't work." Atlas, the user's
/// wiki, links its pages the way wikis do, by path from the wiki's root in double brackets, and `atlas_show` hands conch
/// a page's Markdown exactly as it is stored (src/atlas-copies.ts). CommonMark has no wiki links, so every renderer showed
/// the brackets as literal text that only looked like something to click.
///
/// Each one is rewritten into an ordinary Markdown link before the inline parse (`linkingWikiLinks`), to `atlas:<path>`,
/// with its label (or its path, when it has none) as the words. What a click on one does is the app's: on the Mac it
/// opens conch's saved copy of the page in place, or says it isn't saved and offers to ask the session that showed it
/// (ReviewView.swift). conch never reads Atlas itself: it holds no Atlas credential of its own, and the ones on the Mac
/// belong to the Claude Code and Codex hosts.
public enum AtlasLink {
    public static let scheme = "atlas"

    /// The folder `atlas_show` saves pages to, as `atlasCopiesFolder` in src/atlas-copies.ts has it: `CONCH_ATLAS_COPIES`
    /// moves it, as it moves the daemon's (tests and harnesses).
    public static var copiesFolder: URL {
        if let moved = ProcessInfo.processInfo.environment["CONCH_ATLAS_COPIES"], !moved.isEmpty {
            return URL(fileURLWithPath: moved, isDirectory: true)
        }
        return URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent("conch-notes", isDirectory: true)
            .appendingPathComponent("atlas", isDirectory: true)
    }

    /// One page a link points at: its Atlas path (`projects/index`, as written, `.md` or not) and the heading it names,
    /// if it names one (`[[projects/index#status]]`).
    public struct Page: Equatable, Sendable {
        public let path: String
        public let heading: String?

        public init(path: String, heading: String? = nil) {
            self.path = path
            self.heading = heading
        }

        /// The link's address: `atlas:projects/index`, `#heading` after it when there is one.
        public var address: String { "\(AtlasLink.scheme):\(path)" + (heading.map { "#\($0)" } ?? "") }

        /// Where conch keeps its copy of this page under `folder`: its path, with `.md` added when the path has no
        /// Markdown extension of its own, as `atlasPagePath`'s `file` names it, so `projects/index` and
        /// `projects/index.md` are the same copy.
        public func copy(in folder: URL = AtlasLink.copiesFolder) -> URL {
            folder.appendingPathComponent(AtlasLink.isMarkdownName(path) ? path : "\(path).md", isDirectory: false)
        }

        /// The path without `.md`, which is how the wiki writes it and how it reads in a sentence.
        public var name: String {
            path.replacingOccurrences(of: #"\.(md|markdown)$"#, with: "", options: [.regularExpression, .caseInsensitive])
        }
    }

    /// The page a clicked link points at, when it is an Atlas link (`atlas:<path>`, `#heading` after it optional). Nil
    /// for anything else, and for a path conch would never have saved a copy under: the daemon's own rule (parts of
    /// letters, digits, `.`, `_` or `-`, none starting with a dot), so no link can reach outside the copies folder.
    public static func page(of link: String) -> Page? {
        let prefix = "\(scheme):"
        guard link.lowercased().hasPrefix(prefix) else { return nil }
        let rest = (String(link.dropFirst(prefix.count)).removingPercentEncoding ?? String(link.dropFirst(prefix.count)))
        let parts = rest.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        guard let path = normalized(String(parts[0])) else { return nil }
        let heading = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
        return Page(path: path, heading: heading.isEmpty ? nil : heading)
    }

    /// The Atlas path of a file inside `folder`, the copies folder: the page a saved copy is of. Nil outside it.
    public static func path(ofCopy file: URL, in folder: URL = copiesFolder) -> String? {
        let root = folder.standardizedFileURL.path.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        let path = file.standardizedFileURL.path
        guard path.hasPrefix(root + "/") else { return nil }
        return normalized(String(path.dropFirst(root.count + 1)))
    }

    /// An Atlas path as conch keeps it (src/atlas-copies.ts `atlasPagePath`): slashes either end dropped, every part
    /// letters, digits, `.`, `_` or `-` and never starting with a dot, at most 16 parts and 300 characters. Nil otherwise.
    static func normalized(_ value: String) -> String? {
        let path = value.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^/+|/+$"#, with: "", options: .regularExpression)
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, path.count <= 300, parts.count <= 16,
              parts.allSatisfy({ $0.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil })
        else { return nil }
        return path
    }

    /// A page's title as a reader sees it: its first top-level heading (`# AI Benchmarks and Evals`), emphasis and links
    /// taken out. Nil for a page with none.
    public static func title(of markdown: String) -> String? {
        for block in MarkdownDocument.blocks(markdown) {
            guard case let .heading(1, text) = block else { continue }
            let words = String(MarkdownDocument.inline(text).characters).trimmingCharacters(in: .whitespaces)
            return words.isEmpty ? nil : words
        }
        return nil
    }

    static func isMarkdownName(_ path: String) -> Bool {
        path.range(of: #"\.(md|markdown)$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static let wikiLink = try! NSRegularExpression(pattern: #"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\]\]"#)
    /// A code span: a run of backticks, and the same run again (CommonMark).
    private static let codeSpan = try! NSRegularExpression(pattern: #"(`+)[\s\S]*?(?<!`)\1(?!`)"#)

    /// `text` with each wiki link written as a Markdown link to its page: `[[projects/index|Projects]]` becomes
    /// `[Projects](atlas:projects/index)`, and `[[projects/index]]` `[projects/index](atlas:projects/index)`. Inside a
    /// code span a wiki link is code and stays as written, and so does one whose target is no Atlas path (`[[a b]]`),
    /// which no copy could be saved under.
    public static func linkingWikiLinks(_ text: String) -> String {
        guard text.contains("[[") else { return text }
        let whole = NSRange(text.startIndex..., in: text)
        let code = codeSpan.matches(in: text, range: whole).map(\.range)
        var output = ""
        var cursor = text.startIndex
        for match in wikiLink.matches(in: text, range: whole) {
            guard !code.contains(where: { NSIntersectionRange($0, match.range).length > 0 }),
                  let range = Range(match.range, in: text),
                  let targetRange = Range(match.range(at: 1), in: text)
            else { continue }
            let target = String(text[targetRange]).split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
            guard let path = normalized(String(target[0])) else { continue }
            let heading = target.count > 1 ? MarkdownAnchor.slug(String(target[1])) : ""
            let page = Page(path: path, heading: heading.isEmpty ? nil : heading)
            let label = Range(match.range(at: 2), in: text).map { String(text[$0]).trimmingCharacters(in: .whitespaces) }
            let words = (label?.isEmpty == false ? label! : String(text[targetRange]).trimmingCharacters(in: .whitespaces))
            output += text[cursor..<range.lowerBound]
            output += "[\(words)](\(page.address))"
            cursor = range.upperBound
        }
        output += text[cursor...]
        return output
    }
}

/// Where a heading can be linked to inside its document: `[Status](#status)`. GitHub's rule, which is what agents and the
/// wiki write: lower case, everything but letters, digits, spaces, `-` and `_` dropped, spaces as `-`; a second heading
/// with the same words takes `-1`, a third `-2` (`MarkdownTypesetter` numbers them).
public enum MarkdownAnchor {
    public static func slug(_ heading: String) -> String {
        let words = heading.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let kept = words.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " || $0 == "-" || $0 == "_" }
        return String(String.UnicodeScalarView(kept)).replacingOccurrences(of: " ", with: "-")
    }

    /// The heading a clicked link names inside its own document: `#status`, the whole link. Nil for any other link.
    public static func target(of link: Any) -> String? {
        let text: String
        if let url = link as? URL {
            guard url.scheme == nil, url.path.isEmpty, url.host == nil, let fragment = url.fragment else { return nil }
            text = fragment
        } else if let string = link as? String, string.hasPrefix("#") {
            text = String(string.dropFirst())
        } else {
            return nil
        }
        let decoded = (text.removingPercentEncoding ?? text).trimmingCharacters(in: .whitespaces)
        return decoded.isEmpty ? nil : decoded
    }
}
