import Combine
import Foundation

struct SessionStaticContent: Equatable {
    let rowID: SessionRow.ID?
    let text: String
    let isPlaceholder: Bool

    static func fallback(for row: SessionRow?) -> SessionStaticContent {
        guard let row else {
            return SessionStaticContent(
                rowID: nil,
                text: "Select a session to see its latest reply.",
                isPlaceholder: true
            )
        }

        let snippet = row.snippet?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !snippet.isEmpty {
            return SessionStaticContent(
                rowID: row.id,
                text: snippet,
                isPlaceholder: false
            )
        }

        let name = row.label.isEmpty ? row.id : row.label
        return SessionStaticContent(
            rowID: row.id,
            text: "No reply yet from ‹\(name)›.",
            isPlaceholder: true
        )
    }
}

struct TranscriptWatchID: Hashable {
    let rowID: SessionRow.ID?
    let label: String?
    let path: String?
    let snippet: String?

    init(row: SessionRow?) {
        rowID = row?.id
        label = row?.label
        path = row?.transcriptPath
        snippet = row?.snippet
    }
}

@MainActor
final class TranscriptContentModel: ObservableObject {
    @Published private(set) var content = SessionStaticContent.fallback(for: nil)

    private var currentWatchID = TranscriptWatchID(row: nil)

    func content(for row: SessionRow?) -> SessionStaticContent {
        let watchID = TranscriptWatchID(row: row)
        return watchID == currentWatchID
            ? content
            : SessionStaticContent.fallback(for: row)
    }

    func monitor(row: SessionRow?) async {
        let watchID = TranscriptWatchID(row: row)
        if currentWatchID != watchID {
            currentWatchID = watchID
            content = SessionStaticContent.fallback(for: row)
        }

        guard let row else { return }
        let rawPath = row.transcriptPath?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !rawPath.isEmpty else { return }

        while !Task.isCancelled {
            let result = await TranscriptReplyCache.shared.reply(at: rawPath)
            guard !Task.isCancelled, currentWatchID == watchID else { return }

            switch result {
            case let .loaded(reply):
                let next = if let reply, !reply.isEmpty {
                    SessionStaticContent(
                        rowID: row.id,
                        text: reply,
                        isPlaceholder: false
                    )
                } else {
                    SessionStaticContent.fallback(for: row)
                }
                if next != content {
                    content = next
                }
            case .unavailable:
                // Keep an already-displayed reply through a transient stat/read
                // failure. A newly selected row already has an immediate fallback.
                break
            }

            do {
                try await Task.sleep(nanoseconds: 250_000_000)
            } catch {
                return
            }
        }
    }
}

private enum TranscriptLoadResult: Sendable {
    case loaded(String?)
    case unavailable
}

private struct TranscriptFileVersion: Hashable, Sendable {
    let size: Int64
    let modificationTime: TimeInterval
}

private struct TranscriptCacheEntry: Sendable {
    let version: TranscriptFileVersion
    let reply: String?
}

private enum TranscriptTailRead: Sendable {
    case success(String?)
    case failure
}

private actor TranscriptReplyCache {
    static let shared = TranscriptReplyCache()

    private let capacity = 64
    private var entries: [String: TranscriptCacheEntry] = [:]
    private var recency: [String] = []
    private var latestVersion: [String: TranscriptFileVersion] = [:]

    func reply(at rawPath: String) async -> TranscriptLoadResult {
        let path = TranscriptTailReader.resolvedPath(rawPath)
        let version = await Task.detached(priority: .utility) {
            TranscriptTailReader.fileVersion(at: path)
        }.value

        guard let version else {
            return .unavailable
        }
        guard !Task.isCancelled else { return .unavailable }

        if let cached = entries[path], cached.version == version {
            touch(path)
            return .loaded(cached.reply)
        }

        latestVersion[path] = version
        let task: Task<TranscriptTailRead, Never> = Task.detached(priority: .utility) {
            do {
                return TranscriptTailRead.success(
                    try TranscriptTailReader.lastAssistantReply(
                        at: path,
                        fileSize: version.size
                    )
                )
            } catch {
                return TranscriptTailRead.failure
            }
        }

        let result = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        guard !Task.isCancelled else { return .unavailable }

        switch result {
        case let .success(reply):
            if latestVersion[path] == version {
                remember(
                    TranscriptCacheEntry(version: version, reply: reply),
                    for: path
                )
            }
            return .loaded(reply)
        case .failure:
            return .unavailable
        }
    }

    private func remember(_ entry: TranscriptCacheEntry, for path: String) {
        entries[path] = entry
        touch(path)
        while recency.count > capacity {
            let evicted = recency.removeFirst()
            entries[evicted] = nil
            latestVersion[evicted] = nil
        }
    }

    private func touch(_ path: String) {
        recency.removeAll { $0 == path }
        recency.append(path)
    }
}

private enum TranscriptTailReader {
    private static let chunkSize = 64 * 1_024

    static func resolvedPath(_ rawPath: String) -> String {
        if let url = URL(string: rawPath), url.isFileURL {
            return url.standardizedFileURL.path
        }
        return NSString(string: rawPath).expandingTildeInPath
    }

    static func fileVersion(at path: String) -> TranscriptFileVersion? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = (attributes[.size] as? NSNumber)?.int64Value,
              size >= 0,
              let modified = attributes[.modificationDate] as? Date else {
            return nil
        }
        return TranscriptFileVersion(
            size: size,
            modificationTime: modified.timeIntervalSinceReferenceDate
        )
    }

    static func lastAssistantReply(at path: String, fileSize: Int64) throws -> String? {
        guard fileSize > 0 else { return nil }
        let filename = URL(fileURLWithPath: path).lastPathComponent
        if filename.hasPrefix("rollout-"), filename.hasSuffix(".jsonl") {
            return try lastCodexReply(at: path, fileSize: fileSize)
        }
        return try lastClaudeReply(at: path, fileSize: fileSize)
    }

    private static func lastClaudeReply(at path: String, fileSize: Int64) throws -> String? {
        var newestFirst: [String] = []
        _ = try scanLinesBackward(at: path, fileSize: fileSize) { line in
            guard let entry = jsonObject(from: line) else { return false }
            let type = entry["type"] as? String
            let role = entry["role"] as? String

            if type == "user" || role == "user" {
                return true
            }
            guard type == "assistant" || role == "assistant" else {
                return false
            }

            let content: Any?
            if let message = entry["message"] as? [String: Any] {
                content = message["content"]
            } else {
                content = entry["content"]
            }

            if let parts = content as? [Any] {
                let objects = parts.compactMap { $0 as? [String: Any] }
                if objects.contains(where: { ($0["type"] as? String) == "tool_use" }) {
                    return true
                }
                let texts = objects.compactMap { part -> String? in
                    guard let partType = part["type"] as? String,
                          partType == "text" || partType == "output_text" else {
                        return nil
                    }
                    return part["text"] as? String
                }
                let joined = texts.joined(separator: "\n")
                if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    newestFirst.append(joined)
                }
            } else if let text = content as? String,
                      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                newestFirst.append(text)
            }
            return false
        }

        let reply = newestFirst.reversed()
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return reply.isEmpty ? nil : reply
    }

    private static func lastCodexReply(at path: String, fileSize: Int64) throws -> String? {
        var fallback: String?
        var authoritative: String?

        _ = try scanLinesBackward(at: path, fileSize: fileSize) { line in
            guard let entry = jsonObject(from: line) else { return false }

            if entry["type"] as? String == "event_msg",
               let payload = entry["payload"] as? [String: Any] {
                switch payload["type"] as? String {
                case "task_complete":
                    if let message = payload["last_agent_message"] as? String {
                        authoritative = message
                        return true
                    }
                case "agent_message":
                    if fallback == nil,
                       payload["phase"] as? String != "commentary",
                       let message = payload["message"] as? String {
                        fallback = message
                    }
                case "user_message":
                    return true
                default:
                    break
                }
            } else if fallback == nil,
                      entry["type"] as? String == "response_item",
                      let payload = entry["payload"] as? [String: Any],
                      payload["role"] as? String == "assistant",
                      let content = payload["content"] as? [Any] {
                let texts = content.compactMap { value -> String? in
                    guard let part = value as? [String: Any],
                          let type = part["type"] as? String,
                          type == "text" || type == "output_text" else {
                        return nil
                    }
                    return part["text"] as? String
                }
                let joined = texts.joined(separator: "\n")
                if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fallback = joined
                }
            }
            return false
        }

        let reply = (authoritative ?? fallback)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let reply, !reply.isEmpty else {
            return nil
        }
        return reply
    }

    @discardableResult
    private static func scanLinesBackward(
        at path: String,
        fileSize: Int64,
        visit: ([UInt8]) -> Bool
    ) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        defer { try? handle.close() }

        var position = fileSize
        var carry: [UInt8] = []
        var nextLength = chunkSize

        while position > 0 {
            try Task.checkCancellation()
            let length = Int(min(Int64(nextLength), position))
            position -= Int64(length)
            try handle.seek(toOffset: UInt64(position))
            guard let data = try handle.read(upToCount: length), data.count == length else {
                throw CocoaError(.fileReadUnknown)
            }

            var window = [UInt8](data)
            window.append(contentsOf: carry)
            var segmentEnd = window.count
            var foundNewline = false

            if !window.isEmpty {
                for index in stride(from: window.count - 1, through: 0, by: -1) {
                    guard window[index] == 0x0A else { continue }
                    foundNewline = true
                    if index + 1 < segmentEnd,
                       visit(Array(window[(index + 1)..<segmentEnd])) {
                        return true
                    }
                    segmentEnd = index
                }
            }

            carry = Array(window[..<segmentEnd])
            if foundNewline {
                nextLength = chunkSize
            } else if nextLength <= Int.max / 2 {
                nextLength *= 2
            }
        }

        try Task.checkCancellation()
        if !carry.isEmpty, visit(carry) {
            return true
        }
        return false
    }

    private static func jsonObject(from bytes: [UInt8]) -> [String: Any]? {
        guard !bytes.isEmpty,
              let value = try? JSONSerialization.jsonObject(with: Data(bytes)),
              let object = value as? [String: Any] else {
            return nil
        }
        return object
    }
}
