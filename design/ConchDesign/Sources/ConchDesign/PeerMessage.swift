import Foundation
import SwiftUI

/// A message one agent session sent another, at either end (`PeerMessage` in `src/peer-messages.ts`).
///
/// Tyler, 2026-11-12: "is there a way for agents to effectively message each other now in conch and how does it show
/// in my convo when they do?" It showed as Claude Code's own note, tags and all, or not at all, and a message conch
/// typed in would have been his own bubble. Now the receiver's row says who it is from, the words alone, and opens the
/// sender; the sender's says who it went to and how far it got. Neither is ever drawn as something he said.
public struct ConchPeerMessage: Decodable, Equatable, Sendable {
    public enum Direction: String, Sendable { case received, sent }

    /// How far a sent message got (`PeerDelivery`).
    public enum Delivery: String, Sendable { case sent, unread, queued, held, expired, failed }

    public var direction: Direction
    /// The other session's name as the message gave it.
    public var name: String
    /// conch's own path (`conch message`) rather than Claude Code's SendMessage.
    public var viaConch: Bool
    /// conch's id for the other end, which a click opens when it is a live row.
    public var session: String?
    /// conch's label for it, when the daemon found it live.
    public var label: String?
    public var agentId: String?
    public var pid: Int?
    public var msgId: String?
    public var replyTo: String?
    public var summary: String?
    public var delivery: Delivery?
    public var deliveryNote: String?
    /// Arrived while the session was busy, so it joined the turn under way.
    public var queued: Bool

    public init(
        direction: Direction,
        name: String,
        viaConch: Bool = false,
        session: String? = nil,
        label: String? = nil,
        agentId: String? = nil,
        pid: Int? = nil,
        msgId: String? = nil,
        replyTo: String? = nil,
        summary: String? = nil,
        delivery: Delivery? = nil,
        deliveryNote: String? = nil,
        queued: Bool = false
    ) {
        self.direction = direction
        self.name = name
        self.viaConch = viaConch
        self.session = session
        self.label = label
        self.agentId = agentId
        self.pid = pid
        self.msgId = msgId
        self.replyTo = replyTo
        self.summary = summary
        self.delivery = delivery
        self.deliveryNote = deliveryNote
        self.queued = queued
    }

    private enum CodingKeys: String, CodingKey {
        case direction, name, via, session, label, agentId, pid, msgId, replyTo, summary, delivery, deliveryNote, queued
    }

    /// Tolerant, as every conversation shape is, but never nameless or directionless: such a field throws, the item
    /// decodes without it, and the row is drawn as the material or tool row it also is.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let text = { (key: CodingKeys) in (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0.isEmpty ? nil : $0 } }
        guard let direction = text(.direction).flatMap(Direction.init(rawValue:)), let name = text(.name) else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "a peer message says which way and with whom")
        }
        self.direction = direction
        self.name = name
        viaConch = text(.via) == "conch"
        session = text(.session)
        label = text(.label)
        agentId = text(.agentId)
        pid = try? c.decodeIfPresent(Int.self, forKey: .pid)
        msgId = text(.msgId)
        replyTo = text(.replyTo)
        summary = text(.summary)
        // A delivery word a newer daemon added reads as no word, never as a wrong one.
        delivery = text(.delivery).flatMap(Delivery.init(rawValue:))
        deliveryNote = text(.deliveryNote)
        queued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)) ?? false
    }

    /// The other end as the row names it: the live row's label (the app's own, the freshest), else the label the
    /// daemon published, else the name the message gave. A Claude Code socket address is no name, so it says so.
    public func shownName(live: String? = nil) -> String {
        if let live, !live.isEmpty { return live }
        if let label { return label }
        if name.hasPrefix("uds:") { return "another Claude session" }
        return name
    }

    /// "From harbor", "Sent to harbor".
    public func heading(live: String? = nil) -> String {
        direction == .received ? "From \(shownName(live: live))" : "Sent to \(shownName(live: live))"
    }

    /// How far a sent message got, in a few words; nil for a received one, or before its result came.
    public var deliveryWords: String? {
        guard direction == .sent, let delivery else { return nil }
        switch delivery {
        case .sent: return "Delivered"
        case .unread: return "In its inbox, unread"
        case .queued: return "Queued until it's free"
        case .held: return "Held there, not delivered"
        case .expired: return "Expired, not delivered"
        case .failed: return "Not sent"
        }
    }

    /// The other session never got it: the row says so in the attention colour, with the reason.
    public var notDelivered: Bool {
        direction == .sent && [.held, .expired, .failed].contains(delivery)
    }

    // MARK: - A recorded row read back

    private static let tags = ["cross-session-message", "agent-message"]
    private static let attribute = try! NSRegularExpression(pattern: #"([A-Za-z_][\w-]*)\s*=\s*"([^"]*)""#)
    private static let agentIdPattern = try! NSRegularExpression(pattern: #"^a[0-9a-f]{16}$"#)
    private static let socketPid = try! NSRegularExpression(pattern: #"/(\d+)\.sock$"#)

    /// A recorded `inter_agent` row's text as the peer message it is (`peerRecordText`, the record store's one tag),
    /// or nil for any other text, a Codex team's own traffic included. Read from a 240-character preview too, where
    /// the closing tag hasn't arrived: the words so far are the body.
    public static func recorded(_ text: String) -> (peer: ConchPeerMessage, body: String)? {
        let head = text.drop(while: { $0.isWhitespace })
        for tag in tags where head.hasPrefix("<\(tag)") {
            let afterName = head.dropFirst(tag.count + 1)
            guard let first = afterName.first, first == ">" || first.isWhitespace,
                  let close = afterName.firstIndex(of: ">") else { return nil }
            let attributes = parse(String(afterName[afterName.startIndex..<close]))
            var body = String(afterName[afterName.index(after: close)...])
            if let end = body.range(of: "</\(tag)>", options: .backwards) { body = String(body[..<end.lowerBound]) }
            body = body.trimmingCharacters(in: .whitespacesAndNewlines)
            let from = attributes["from"] ?? ""
            let session = from.hasPrefix("conch:") ? String(from.dropFirst("conch:".count)) : nil
            let agentId = matches(agentIdPattern, from) ? from : nil
            let pid = firstGroup(socketPid, from).flatMap(Int.init)
            let name = attributes["from-name"] ?? agentId ?? session ?? "another session"
            let peer = ConchPeerMessage(
                direction: .received,
                name: name,
                viaConch: attributes["via"] == "conch" || session != nil,
                session: session.flatMap { $0.isEmpty ? nil : $0 },
                agentId: agentId,
                pid: pid,
                msgId: attributes["msg-id"],
                replyTo: attributes["reply-to"]
            )
            return (peer, body)
        }
        return nil
    }

    private static func parse(_ raw: String) -> [String: String] {
        var out: [String: String] = [:]
        let range = NSRange(raw.startIndex..., in: raw)
        for match in attribute.matches(in: raw, range: range) {
            guard let key = Range(match.range(at: 1), in: raw), let value = Range(match.range(at: 2), in: raw) else { continue }
            let decoded = unescape(String(raw[value]))
            if !decoded.isEmpty { out[raw[key].lowercased()] = decoded }
        }
        return out
    }

    private static func unescape(_ value: String) -> String {
        value.replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    private static func matches(_ pattern: NSRegularExpression, _ text: String) -> Bool {
        pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func firstGroup(_ pattern: NSRegularExpression, _ text: String) -> String? {
        guard let match = pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}

/// A message between sessions, as its own row in either app's conversation: left-aligned on the conversation's own
/// ground, outlined, never filled as Tyler's bubble is. A heading says who it is from (or went to) and when; the
/// words under it; a sent one says how far it got. When the other session is a live row, the heading opens it.
public struct PeerMessageRow: View {
    let message: ConchPeerMessage
    let body_: String
    let at: Date?
    let liveLabel: String?
    let readingSize: CGFloat
    let open: (() -> Void)?

    /// `liveLabel` is the other session's row label as the app has it now; `open` is nil when that session isn't a
    /// live row, and nothing then reads as clickable.
    public init(
        message: ConchPeerMessage,
        body: String,
        at: Date?,
        liveLabel: String? = nil,
        readingSize: CGFloat = ConchType.readingBodySize - 1,
        open: (() -> Void)? = nil
    ) {
        self.message = message
        self.body_ = body
        self.at = at
        self.liveLabel = liveLabel
        self.readingSize = readingSize
        self.open = open
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: ConchSpace.x2) {
            heading
            // Whole, always, as every message in the stack is: no "Show all" (Tyler: "those should just smooth infinite
            // scroll").
            if !body_.isEmpty {
                MarkdownView(text: body_, size: readingSize)
                    .foregroundStyle(ConchColor.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let words = message.deliveryWords {
                deliveryLine(words)
            }
        }
        .padding(.horizontal, ConchSpace.x3)
        .padding(.vertical, ConchSpace.x2 + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: ConchRadius.medium)
                .strokeBorder(ConchColor.hairlineStrong, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var heading: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x1 + 2) {
            Image(systemName: message.direction == .received ? "bubble.left.and.bubble.right" : "arrow.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(ConchColor.textSecondary)
            Group {
                if let open {
                    Button(action: open) {
                        HStack(spacing: 3) {
                            Text(message.heading(live: liveLabel))
                            Image(systemName: "arrow.up.forward.square")
                                .font(.system(size: 10, weight: .medium))
                        }
                    }
                    .buttonStyle(.plain)
                    .help("Open \(message.shownName(live: liveLabel))")
                    .accessibilityHint("Opens that session")
                } else {
                    Text(message.heading(live: liveLabel))
                }
            }
            .font(ConchType.uiEmphasis)
            .foregroundStyle(ConchColor.textPrimary)
            .lineLimit(1)
            if message.replyTo != nil {
                Text("reply")
                    .font(ConchType.meta)
                    .foregroundStyle(ConchColor.textTertiary)
            }
            Spacer(minLength: ConchSpace.x2)
            if let at {
                Text(at, format: .dateTime.hour().minute())
                    .font(ConchType.meta)
                    .foregroundStyle(ConchColor.textTertiary)
                    .monospacedDigit()
            }
        }
    }

    private func deliveryLine(_ words: String) -> some View {
        // Why it was never sent is worth reading; "held" and "expired" are their own reason.
        let note = message.delivery == .failed ? message.deliveryNote : nil
        return HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x1) {
            Image(systemName: message.notDelivered ? "exclamationmark.circle" : "checkmark")
                .font(.system(size: 10, weight: .semibold))
            Text(note.map { "\(words): \($0)" } ?? words)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(ConchType.meta)
        .foregroundStyle(message.notDelivered ? ConchColor.attention : ConchColor.textTertiary)
    }

    private var accessibilityText: String {
        let who = message.direction == .received
            ? "Message from \(message.shownName(live: liveLabel)), another session"
            : "Message sent to \(message.shownName(live: liveLabel))"
        return [who, body_, message.deliveryWords].compactMap { $0 }.joined(separator: ". ")
    }
}
