import ConchDesign
import Foundation

/// Only an explicit daemon receipt can authorize clearing the sent draft.
enum InjectReceipt: Equatable {
    case delivered
    case accepted
    case staged
    case failed(String)

    /// Accepted work is still running; staged text has not been submitted.
    var reachedMac: Bool { self == .delivered || self == .accepted }

    private struct Wire: Decodable {
        let kind: String
        let delivered: Bool?
        let staged: Bool?
        let error: String?
        /// What stopped the delivery, in the daemon's own words (`src/inject.ts`).
        let reason: String?
        /// The Mac kept the text on its clipboard, so it is a paste away rather than lost.
        let onClipboard: Bool?
    }

    static func decode(status: Int, body: Data) -> InjectReceipt {
        guard status == 200 else { return .failed("Not delivered — the Mac returned HTTP \(status).") }
        guard let reply = try? JSONDecoder().decode(Wire.self, from: body) else {
            return .failed("Not delivered — the Mac didn't send a valid receipt. Your draft is kept.")
        }
        // A finished delivery is read FIRST, so a failure is described by its reason rather
        // than by the daemon's own `error` wording, which was written for a log.
        if reply.kind == "inject-done" {
            if reply.staged == true, reply.delivered == false { return .staged }
            if reply.staged != true, let delivered = reply.delivered {
                return delivered ? .delivered : .failed(ConchSendFailure.sentence(
                    reason: reply.reason,
                    onClipboard: reply.onClipboard ?? false
                ))
            }
        }
        if reply.kind == "inject-accepted", reply.delivered == nil, reply.staged == nil { return .accepted }
        if let error = reply.error { return .failed("Not delivered — \(error)") }
        return .failed("Not delivered — the Mac didn't confirm this message. Your draft is kept.")
    }

    /// A delayed receipt must preserve edits and additional dictation made while waiting.
    func remainingDraft(_ draft: String, sent: String) -> String {
        guard reachedMac else { return draft }
        let held = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard held.hasPrefix(sent) else { return draft }
        return String(held.dropFirst(sent.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
