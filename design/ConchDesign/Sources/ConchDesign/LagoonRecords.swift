import Foundation

/// A session's conversation for the lagoon, from the same two places the app's own conversation pane reads it (2026-10-13).
///
/// The daemon publishes a live conversation window for the eight most recently active sessions and four agents
/// (`sessionsToPublish`, src/daemon.ts); the app draws every other session from conch's record store (`ConversationSource`,
/// `HistoryStore`). The lagoon was sent the published windows only, so a session outside the eight came to its panel
/// with no conversation at all: "Nothing said yet" over a session with four results and a draft PR in it (Tyler, from his
/// live app). And the page reads your replies in that conversation to tell whether a result still waits on you (its
/// v4.12h), so every such session's results waited forever.
///
/// So the lagoon's snapshot takes a session's published window when there is one, and its record's newest page when there
/// isn't, read as the app reads it. Nothing about the snapshot's shape changes: the items are the same `user`,
/// `assistant` and `tool` items, cut by `LagoonSnapshot` to the same last 12 messages and two steps.
///
/// This is the bookkeeping: which sessions to read, what a recorded page becomes, and when a session is read again (its
/// row changed: a status, a result). The socket is the app's (`LagoonModel`).
public struct LagoonRecords: Equatable, Sendable {
    /// A page of the record, at the API's largest. Its 28 KiB budget holds about twenty items (2026-10-13, Tyler's
    /// record: 19 to 23 a page), most of them a turn's steps and context, so a page is one to four messages.
    public static let pageLimit = 100
    /// Read back until a session has this many messages, as the daemon's live window always carries (`live.js`: "at
    /// least its last 6 messages"), or until `pagesAtMost` pages, or the start of the record.
    public static let messagesWanted = 6
    public static let pagesAtMost = 4

    /// Whether to read the page before these (`items` oldest first): fewer than `messagesWanted` messages in them, and
    /// fewer than `pagesAtMost` pages read.
    public static func wantsOlder(_ items: [HistoryItem], pagesRead: Int) -> Bool {
        pagesRead < pagesAtMost && Self.items(items).filter { $0.kind != "tool" }.count < messagesWanted
    }
    /// A read that failed (the record busy, or the daemon not answering) is tried again after this, if nothing about the
    /// session changed meanwhile.
    public static let retryAfter: TimeInterval = 30
    /// A session whose row keeps changing (an agent at work outside the daemon's budget) is read at most this often.
    public static let refreshAfter: TimeInterval = 15

    private struct Read: Equatable, Sendable {
        var mark: String
        var items: [LagoonSnapshot.Source.Item]
        var at: Date
        /// Whether it failed; what was read before it is kept.
        var failed: Bool
    }

    private var reads: [String: Read] = [:]

    public init() {}

    /// Each session's recorded conversation, for every session read and not empty.
    public var conversations: [String: [LagoonSnapshot.Source.Item]] {
        reads.compactMapValues { $0.items.isEmpty ? nil : $0.items }
    }

    /// What a session's record was read for: its row as it stood. A new status, a new time on the row or a new result
    /// means it said or was told something since, and it is read again.
    public static func mark(_ row: LagoonSnapshot.Source.Row) -> String {
        let newest = row.reviews.compactMap(\.at).max()
        return [row.status ?? "-", row.at.map { String($0) } ?? "-", String(row.reviews.count), newest.map { String($0) } ?? "-"]
            .joined(separator: "|")
    }

    /// The sessions to read from the record, in order: `first` (the one the window views) ahead of the rest, in the rows'
    /// order. A session is read when the daemon published no conversation for it, and it was never read, or its row has
    /// changed since (no sooner than `refreshAfter` after the last read), or that read failed `retryAfter` ago.
    public func wanted(rows: [LagoonSnapshot.Source.Row], published: [String: [LagoonSnapshot.Source.Item]], first: String?, now: Date) -> [String] {
        let ordered = rows.filter { $0.id == first } + rows.filter { $0.id != first }
        var seen = Set<String>()
        return ordered.compactMap { row in
            guard seen.insert(row.id).inserted, published[row.id]?.isEmpty ?? true else { return nil }
            guard let read = reads[row.id] else { return row.id }
            let since = now.timeIntervalSince(read.at)
            if read.failed { return since >= Self.retryAfter ? row.id : nil }
            return read.mark != Self.mark(row) && since >= Self.refreshAfter ? row.id : nil
        }
    }

    /// A page read for `session` at `now`, while its row's mark was `mark`. Whether what the lagoon is sent changed.
    @discardableResult
    public mutating func store(_ session: String, mark: String, page: [HistoryItem], at now: Date) -> Bool {
        let items = Self.items(page)
        let changed = (reads[session]?.items ?? []) != items
        reads[session] = Read(mark: mark, items: items, at: now, failed: false)
        return changed
    }

    /// The read failed: what was read before is kept, and it is tried again after `retryAfter`.
    public mutating func failed(_ session: String, mark: String, at now: Date) {
        reads[session] = Read(mark: mark, items: reads[session]?.items ?? [], at: now, failed: true)
    }

    /// Sessions that are gone from the rows are let go.
    public mutating func forget(missing ids: Set<String>) {
        reads = reads.filter { ids.contains($0.key) }
    }

    /// The conversations the lagoon reads: each session's published window, else what its record holds.
    public static func merged(published: [String: [LagoonSnapshot.Source.Item]], recorded: [String: [LagoonSnapshot.Source.Item]]) -> [String: [LagoonSnapshot.Source.Item]] {
        var out = recorded.filter { !$0.value.isEmpty }
        for (session, items) in published where !items.isEmpty || out[session] == nil {
            out[session] = items
        }
        return out
    }

    // MARK: A recorded page, as the live window's items

    /// What the live window would have made of these recorded items, in their order: your messages and its answers, and
    /// one step per tool call. Not tool results (the live window's step carries its call's result), thinking, material or
    /// context, which the lagoon is never sent, nor the machine-written text the agent's transcript files under your name.
    /// A message says its preview (at most 240 characters), marked as cut where there is more.
    public static func items(_ page: [HistoryItem]) -> [LagoonSnapshot.Source.Item] {
        page.compactMap { item in
            switch item.kind {
            case "message":
                guard let role = item.role, role == "user" || role == "assistant" else { return nil }
                let text = unwrapPasted(item.preview).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, role == "assistant" || !isMachineWritten(text) else { return nil }
                // The provider's own id, which is what the live window keys a message by: the same message is one id
                // whichever place it came from.
                return .init(id: item.nativeId ?? item.id, kind: role, text: item.hasFullBody ? text + "…" : text, at: item.at)
            case "tool_call":
                return .init(id: toolId(item.id), kind: "tool", text: toolSummary(item), at: item.at)
            default:
                return nil
            }
        }
    }

    /// The live window's id for a step, `tool:<call id>`, from the record's (`["<session>","tool_call","<call id>"]`); the
    /// record's own id when it isn't one of those.
    static func toolId(_ recordId: String) -> String {
        guard let parts = try? JSONSerialization.jsonObject(with: Data(recordId.utf8)) as? [Any], parts.count == 3,
              parts[1] as? String == "tool_call", let call = parts[2] as? String, !call.isEmpty else { return recordId }
        return "tool:" + call
    }

    /// The daemon's `classifyInjectedUserText` (src/conversation.ts): what Claude Code files under `type: "user"` and no
    /// person typed. The live window makes these materials, which the lagoon never gets; as "you" they would read as a
    /// reply to a result, and answer it.
    public static func isMachineWritten(_ text: String) -> Bool {
        let head = text.drop { $0.isWhitespace }
        if head.hasPrefix("<task-notification>") || head.hasPrefix("[Request interrupted by user") || head.hasPrefix("[Image: ") { return true }
        return ["system-reminder", "local-command-stdout", "local-command-stderr", "command-name", "command-message"]
            .contains { head.hasPrefix("<\($0)>") }
    }

    /// The daemon's `unwrapPastedContent`: a long message conch pasted, without its tags. A preview cut before the closing
    /// tag loses the opening one too.
    static func unwrapPasted(_ text: String) -> String {
        guard text.contains("<pasted_content ") || text.contains("</pasted_content") else { return text }
        return text.replacingOccurrences(of: #"</?pasted_content(?: id="[^"]*")?>"#, with: "", options: .regularExpression)
    }

    /// The step's line, as the daemon's `summariseToolInput` makes it from the call's arguments (the record's preview is
    /// their JSON, cut at 240 characters): the argument a person would recognise, else the tool's name.
    static func toolSummary(_ item: HistoryItem) -> String {
        let keys = ["description", "cmd", "command", "file_path", "path", "pattern", "query", "url"]
        let line = { (value: String) in value.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? value }
        if let data = item.preview.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in keys {
                if let value = object[key] as? String, !value.trimmingCharacters(in: .whitespaces).isEmpty { return line(value) }
            }
        } else {
            // Cut mid-JSON: the first of those keys whose value is there in full.
            for key in keys {
                let pattern = "\"\(key)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\""
                guard let range = item.preview.range(of: pattern, options: .regularExpression) else { continue }
                let match = String(item.preview[range])
                guard let open = match.range(of: ":") else { continue }
                let quoted = match[open.upperBound...].trimmingCharacters(in: .whitespaces)
                if let value = try? JSONSerialization.jsonObject(with: Data(quoted.utf8), options: .fragmentsAllowed) as? String,
                   !value.trimmingCharacters(in: .whitespaces).isEmpty {
                    return line(value)
                }
            }
        }
        return item.toolName ?? "tool"
    }
}
