import CoreGraphics
import Foundation
import SwiftUI

// Comparing two versions of one artifact: a before and an after.
//
// Feedback, 2026-10-03: an agent that edited a photo hand-stitched a before/after composite with
// PIL so the change could be seen at all. It did not need to: publishing again under the same
// `key` (or link) already files the artifact's next version, and the daemon keeps an artifact's
// newest two through its cap (`capReviews`, src/panel.ts). What was missing was a way to LOOK at
// two versions together. These are the rules both apps compare by: which two versions, which
// ways two of a kind can be compared, the slider's arithmetic and the words on each side. The
// views are in VersionCompareViews.swift; the Mac's deliverable tab and the phone's review sheet
// each drive them.

/// A before and an after: two filings of one artifact, the OLDER always the before.
public struct VersionPair: Equatable, Hashable, Sendable {
    public let before: String
    public let after: String

    public init(before: String, after: String) {
        self.before = before
        self.after = after
    }
}

/// How two versions are put in front of you.
public enum CompareMode: String, CaseIterable, Equatable, Hashable, Sendable, Identifiable {
    /// One picture over the other, a divider you drag to reveal the before on its left.
    case slider
    /// Both at once, each whole.
    case sideBySide
    /// The lines that changed, for text.
    case diff
    /// One at a time, a tap apart: where there is no room for two (a page on a phone).
    case flip

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .slider: "Slider"
        case .sideBySide: "Side by side"
        case .diff: "Changes"
        case .flip: "Flip"
        }
    }

    public var symbol: String {
        switch self {
        case .slider: "slider.horizontal.below.rectangle"
        case .sideBySide: "rectangle.split.2x1"
        case .diff: "plus.forwardslash.minus"
        case .flip: "rectangle.2.swap"
        }
    }
}

/// What two versions are, as far as comparing them goes: pixels, lines, or anything else the viewers draw.
public enum CompareContent: String, Equatable, Sendable {
    case image
    case text
    case other

    /// Picture extensions the slider can draw, the viewers' own list (ReviewView.swift `DeliverableSource`).
    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff"]

    /// Decided as the viewers route a link, by its name: a web address is a page whatever it ends in, a local picture is
    /// pixels, markdown and anything `DeliverableText` calls text is lines. The daemon's `kind` decides only what the
    /// name can't (a text file with no extension the agent called `text`).
    public static func of(kind: String?, link: String?) -> CompareContent {
        guard let link = link?.trimmingCharacters(in: .whitespacesAndNewlines), !link.isEmpty else { return .other }
        if let scheme = URL(string: link)?.scheme?.lowercased(), scheme == "http" || scheme == "https" { return .other }
        let path = URL(string: link).flatMap { $0.isFileURL ? $0.path : nil } ?? link
        let ext = (path as NSString).pathExtension.lowercased()
        if imageExtensions.contains(ext) { return .image }
        if ext == "md" || ext == "markdown" || DeliverableText.byName(path) == true { return .text }
        if DeliverableText.byName(path) == nil, kind == "text" || kind == "markdown" { return .text }
        return .other
    }

    /// Two versions compare as what they BOTH are: a picture republished as a page is two different things, side by side.
    public static func shared(_ before: CompareContent, _ after: CompareContent) -> CompareContent {
        before == after ? before : .other
    }
}

public enum VersionCompare {
    /// Whether an artifact has anything to compare: a second version held.
    public static func canCompare(_ versions: [String]) -> Bool {
        Set(versions).count > 1
    }

    /// The pair to open on, from `versions` NEWEST FIRST (as `DeliverableGroup.versions`): the version `shown` (the
    /// newest when nil, or one no longer held) and the one filed just before it. The oldest, shown, is compared with the
    /// one just after it instead, so the before is still the older. Nil with fewer than two versions.
    public static func defaultPair(in versions: [String], from shown: String? = nil) -> VersionPair? {
        guard versions.count > 1 else { return nil }
        let index = shown.flatMap { versions.firstIndex(of: $0) } ?? 0
        if index + 1 < versions.count {
            return VersionPair(before: versions[index + 1], after: versions[index])
        }
        return VersionPair(before: versions[index], after: versions[index - 1])
    }

    /// Two versions as a pair, the older the before, whichever order they were picked in. Nil when they are the same
    /// version or either is not one of `versions` (newest first).
    public static func pair(_ one: String, _ other: String, in versions: [String]) -> VersionPair? {
        guard one != other, let first = versions.firstIndex(of: one), let second = versions.firstIndex(of: other) else {
            return nil
        }
        return first > second ? VersionPair(before: one, after: other) : VersionPair(before: other, after: one)
    }

    /// The pair as it stands now: itself while both versions are still held, else nothing. A version taken off (Remove)
    /// or dropped past the cap ends the comparison, rather than comparing something with nothing.
    public static func resolve(_ pair: VersionPair?, in versions: [String]) -> VersionPair? {
        guard let pair, versions.contains(pair.before), versions.contains(pair.after), pair.before != pair.after else {
            return nil
        }
        return Self.pair(pair.before, pair.after, in: versions)
    }

    /// What `version` can be compared with, for a "Compare with…" menu: every other version, the one it opens on
    /// by default (`defaultPair`) first, then the rest newest first.
    public static func partners(of version: String, in versions: [String]) -> [String] {
        let others = versions.filter { $0 != version }
        guard let pair = defaultPair(in: versions, from: version) else { return others }
        let preferred = pair.before == version ? pair.after : pair.before
        return [preferred] + others.filter { $0 != preferred }
    }

    /// The ways two versions of this content can be compared, the first the one to open on. `wide` is a Mac pane (room
    /// for two pages); a phone is not, and flips between them instead.
    public static func modes(for content: CompareContent, wide: Bool) -> [CompareMode] {
        switch content {
        case .image: [.slider, .sideBySide]
        case .text: wide ? [.diff, .sideBySide] : [.diff, .flip]
        case .other: wide ? [.sideBySide] : [.flip]
        }
    }

    /// The mode to show: the one picked while it is still offered, else the first.
    public static func mode(_ picked: CompareMode?, for content: CompareContent, wide: Bool) -> CompareMode {
        let offered = modes(for: content, wide: wide)
        if let picked, offered.contains(picked) { return picked }
        return offered[0]
    }

    /// Whether two versions are one file, or one page: conch keeps a LINK to each version, not a copy, so both show
    /// what is there now and a compare would show the newest twice. An agent that edits a picture in place and publishes
    /// it again has made a version with nothing behind it to compare; this says so rather than showing two of one.
    public static func sharesLink(_ before: String?, _ after: String?) -> Bool {
        guard let before = normalized(before), let after = normalized(after) else { return false }
        return before == after
    }

    private static func normalized(_ link: String?) -> String? {
        guard let link = link?.trimmingCharacters(in: .whitespacesAndNewlines), !link.isEmpty else { return nil }
        if var parts = URLComponents(string: link), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            parts.fragment = nil
            return parts.string ?? link
        }
        let path = URL(string: link).flatMap { $0.isFileURL ? $0.path : nil } ?? link
        return (path as NSString).standardizingPath
    }
}

// MARK: - The slider

/// The before/after slider's arithmetic: where the divider is, as a fraction of the picture's width from its left.
/// The before shows left of the divider, the after right of it.
public enum CompareSlider {
    /// Where a comparison opens: halfway.
    public static let start: Double = 0.5
    /// An arrow key's move, and a shift-arrow's.
    public static let step: Double = 0.05
    public static let largeStep: Double = 0.25

    public static func clamp(_ fraction: Double) -> Double {
        guard fraction.isFinite else { return start }
        return min(max(fraction, 0), 1)
    }

    /// The divider under a pointer at `x`, in a picture `width` wide: where you press is where it goes.
    public static func fraction(atX x: CGFloat, width: CGFloat) -> Double {
        guard width > 0 else { return start }
        return clamp(Double(x / width))
    }

    /// Moved by whole steps (negative is left), from the keys or VoiceOver's adjust. Landing on the nearest step, so
    /// arrows from a dragged 0.437 go to 0.45 and 0.40 rather than 0.487 and 0.387.
    public static func moved(_ fraction: Double, by steps: Int, large: Bool = false) -> Double {
        let size = large ? largeStep : step
        let here = clamp(fraction) / size
        // The step the move starts from: the one at or behind it in the direction of travel. A hair of slack, so a
        // fraction that is a step but not exactly (0.45 as 8.999…) counts as on it.
        let from = steps >= 0 ? (here + 0.000_1).rounded(.down) : (here - 0.000_1).rounded(.up)
        let target = steps == 0 ? clamp(fraction) : (from + Double(steps)) * size
        return clamp((target * 10_000).rounded() / 10_000)
    }

    /// Where the divider is drawn, in a picture `width` wide.
    public static func dividerX(_ fraction: Double, width: CGFloat) -> CGFloat {
        CGFloat(clamp(fraction)) * width
    }

    /// A picture `size` fitted whole into `container`, centred: the rect both versions are drawn in.
    public static func fit(_ size: CGSize, in container: CGSize) -> CGRect {
        guard size.width > 0, size.height > 0, container.width > 0, container.height > 0 else { return .zero }
        let scale = min(container.width / size.width, container.height / size.height)
        let fitted = CGSize(width: size.width * scale, height: size.height * scale)
        return CGRect(
            x: (container.width - fitted.width) / 2,
            y: (container.height - fitted.height) / 2,
            width: fitted.width,
            height: fitted.height
        )
    }

    /// What VoiceOver says the slider is at: how much of each side shows.
    public static func accessibilityValue(_ fraction: Double, before: String, after: String) -> String {
        let shown = Int((clamp(fraction) * 100).rounded())
        return "\(shown) percent \(before), \(100 - shown) percent \(after)"
    }

    /// Each side's name chip sits in its own corner; once the divider is nearly over it, that side is mostly hidden and
    /// the chip would sit on the OTHER version, naming it wrongly. So it goes.
    public static let labelMargin: Double = 0.15

    public static func showsBeforeLabel(_ fraction: Double) -> Bool { clamp(fraction) >= labelMargin }
    public static func showsAfterLabel(_ fraction: Double) -> Bool { clamp(fraction) <= 1 - labelMargin }
}

// MARK: - Side by side

public enum CompareLayout {
    /// Two pictures beside each other or one above the other, whichever draws them BIGGER in `container`: two landscape
    /// shots on a phone held upright stack, two portrait ones in a Mac pane sit side by side. Beside each other on a tie.
    public static func axis(before: CGSize, after: CGSize, in container: CGSize, gap: CGFloat = 12) -> Axis {
        func area(_ size: CGSize, in box: CGSize) -> CGFloat {
            let rect = CompareSlider.fit(size, in: box)
            return rect.width * rect.height
        }
        let beside = CGSize(width: max(0, (container.width - gap) / 2), height: container.height)
        let stacked = CGSize(width: container.width, height: max(0, (container.height - gap) / 2))
        let besideArea = area(before, in: beside) + area(after, in: beside)
        let stackedArea = area(before, in: stacked) + area(after, in: stacked)
        return stackedArea > besideArea ? .vertical : .horizontal
    }
}

// MARK: - What each side is called

public enum VersionLabel {
    /// "v3": the daemon's number, else the version's place among those held (an older daemon numbers none).
    public static func number(_ version: Int?, place: Int) -> String {
        "v\(version ?? place)"
    }

    /// How long ago, in the ledger's own vocabulary with "ago": "just now", "12m ago", "3h ago", "2d ago".
    public static func age(epochMilliseconds: Double?, now: Date) -> String? {
        guard let epochMilliseconds, epochMilliseconds.isFinite, epochMilliseconds > 0 else { return nil }
        let elapsed = max(0, now.timeIntervalSince1970 - epochMilliseconds / 1_000)
        if elapsed < 60 { return "just now" }
        if elapsed < 3_600 { return "\(Int(elapsed / 60))m ago" }
        if elapsed < 86_400 { return "\(Int(elapsed / 3_600))h ago" }
        return "\(Int(elapsed / 86_400))d ago"
    }

    /// One side's line: "v1 · 2h ago — Warmer grade, lifted shadows". The summary is what tells one version from the
    /// next, so it is kept, cut at `maxSummary` characters so a menu or a caption does not run the width of the screen.
    public static func line(version: Int?, place: Int, filedAt: Double?, summary: String, now: Date, maxSummary: Int = 60) -> String {
        var head = number(version, place: place)
        if let age = age(epochMilliseconds: filedAt, now: now) { head += " · \(age)" }
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return head }
        let cut = trimmed.count > maxSummary ? String(trimmed.prefix(max(1, maxSummary - 1))) + "…" : trimmed
        return "\(head) — \(cut)"
    }
}

// MARK: - Text

/// The lines that changed between two versions of a text, as a unified diff reads: kept, removed, added.
public struct TextDiff: Equatable, Sendable {
    public enum Change: Equatable, Sendable {
        case same
        case removed
        case added
    }

    public struct Line: Equatable, Sendable {
        public let change: Change
        public let text: String
        /// Its line number in the before (kept and removed lines) and in the after (kept and added lines), from 1.
        public let before: Int?
        public let after: Int?
    }

    /// What a diff view draws: a line, or a run of unchanged lines folded away.
    public enum Row: Equatable, Sendable, Identifiable {
        case line(Line)
        /// `count` unchanged lines folded into one row; `id` is stable for the same diff (`rows(expanded:)` takes it).
        case fold(id: Int, count: Int)

        public var id: String {
            switch self {
            case let .line(line): "l\(line.before ?? 0):\(line.after ?? 0)"
            case let .fold(id, _): "f\(id)"
            }
        }
    }

    public let lines: [Line]

    public var added: Int { lines.lazy.filter { $0.change == .added }.count }
    public var removed: Int { lines.lazy.filter { $0.change == .removed }.count }
    public var isIdentical: Bool { lines.allSatisfy { $0.change == .same } }

    /// The most lines on either side, and the most changes, a diff is worked out for. Past them it is nil and the apps
    /// show the two versions side by side (or one at a time) instead: a deliverable is something to read, and a diff of
    /// thousands of changes is not one. The edit bound also bounds the work: Myers' search keeps one row per change.
    public static let maxLines = 20_000
    public static let maxChanges = 1_000

    /// The diff of `before` and `after`, line by line (Myers' shortest edit), or nil past `maxLines` or `maxChanges`.
    public static func between(_ before: String, _ after: String, maxLines: Int = maxLines, maxChanges: Int = maxChanges) -> TextDiff? {
        let a = split(before)
        let b = split(after)
        guard a.count <= maxLines, b.count <= maxLines else { return nil }
        // What both start and end with is kept as it is, so the search runs only over the middle that changed.
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let middleA = Array(a[prefix ..< a.count - suffix])
        let middleB = Array(b[prefix ..< b.count - suffix])
        guard let edits = shortestEdit(middleA, middleB, maxChanges: maxChanges) else { return nil }

        var lines: [Line] = []
        lines.reserveCapacity(a.count + b.count)
        for index in 0 ..< prefix {
            lines.append(Line(change: .same, text: a[index], before: index + 1, after: index + 1))
        }
        for edit in edits {
            switch edit {
            case let .same(x, y):
                lines.append(Line(change: .same, text: middleA[x], before: prefix + x + 1, after: prefix + y + 1))
            case let .removed(x):
                lines.append(Line(change: .removed, text: middleA[x], before: prefix + x + 1, after: nil))
            case let .added(y):
                lines.append(Line(change: .added, text: middleB[y], before: nil, after: prefix + y + 1))
            }
        }
        for offset in 0 ..< suffix {
            let x = a.count - suffix + offset
            let y = b.count - suffix + offset
            lines.append(Line(change: .same, text: a[x], before: x + 1, after: y + 1))
        }
        return TextDiff(lines: lines)
    }

    /// The rows to draw: every change, `context` unchanged lines either side of it, and each longer unchanged run
    /// folded to one row. A fold in `expanded` (by its id) is drawn whole.
    public func rows(context: Int = 3, expanded: Set<Int> = []) -> [Row] {
        guard !lines.isEmpty else { return [] }
        var keep = [Bool](repeating: false, count: lines.count)
        for (index, line) in lines.enumerated() where line.change != .same {
            for near in max(0, index - context) ... min(lines.count - 1, index + context) { keep[near] = true }
        }
        var rows: [Row] = []
        var index = 0
        while index < lines.count {
            if keep[index] {
                rows.append(.line(lines[index]))
                index += 1
                continue
            }
            var end = index
            while end < lines.count, !keep[end] { end += 1 }
            let id = index
            // A fold of one line hides nothing worth a row of its own.
            if end - index == 1 || expanded.contains(id) {
                rows.append(contentsOf: lines[index ..< end].map(Row.line))
            } else {
                rows.append(.fold(id: id, count: end - index))
            }
            index = end
        }
        return rows
    }

    /// Lines as a person counts them: a final newline ends the last line rather than starting an empty one, and a
    /// Windows line end is the same line as a Unix one.
    static func split(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        // By Character: "\r\n" is ONE Character in Swift, so splitting on "\n" alone would leave it whole.
        var lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        if text.last?.isNewline == true { lines.removeLast() }
        return lines
    }

    enum Edit: Equatable {
        case same(Int, Int)
        case removed(Int)
        case added(Int)
    }

    /// Myers' O((N+M)D) shortest edit script, in order, or nil past `maxChanges`. Each round keeps only the
    /// diagonals it can reach (2d+3 of them), so the trace is O(D²) however long the texts are.
    static func shortestEdit(_ a: [String], _ b: [String], maxChanges: Int) -> [Edit]? {
        let n = a.count
        let m = b.count
        if n == 0 { return (0 ..< m).map(Edit.added) }
        if m == 0 { return (0 ..< n).map(Edit.removed) }
        let limit = min(n + m, maxChanges)
        let offset = limit + 1
        var v = [Int](repeating: 0, count: 2 * limit + 3)
        // trace[d] is v as round d found it: the diagonals -(d+1)...(d+1).
        var trace: [[Int]] = []
        var found = false
        rounds: for d in 0 ... limit {
            trace.append(Array(v[(offset - d - 1) ... (offset + d + 1)]))
            for k in stride(from: -d, through: d, by: 2) {
                var x: Int
                if k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) {
                    x = v[offset + k + 1]
                } else {
                    x = v[offset + k - 1] + 1
                }
                var y = x - k
                while x < n, y < m, a[x] == b[y] {
                    x += 1
                    y += 1
                }
                v[offset + k] = x
                if x >= n, y >= m {
                    found = true
                    break rounds
                }
            }
        }
        guard found else { return nil }

        var edits: [Edit] = []
        var x = n
        var y = m
        for d in stride(from: trace.count - 1, through: 0, by: -1) {
            let row = trace[d]
            // `row` starts at diagonal -(d+1).
            func at(_ k: Int) -> Int { row[k + d + 1] }
            let k = x - y
            let previous = (k == -d || (k != d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1
            let previousX = d == 0 ? 0 : at(previous)
            let previousY = d == 0 ? 0 : previousX - previous
            while x > previousX, y > previousY {
                x -= 1
                y -= 1
                edits.append(.same(x, y))
            }
            if d > 0 {
                if x == previousX {
                    edits.append(.added(previousY))
                } else {
                    edits.append(.removed(previousX))
                }
            }
            x = previousX
            y = previousY
        }
        return edits.reversed()
    }
}
