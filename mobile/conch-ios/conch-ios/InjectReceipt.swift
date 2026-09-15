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
    }

    static func decode(status: Int, body: Data) -> InjectReceipt {
        guard status == 200 else { return .failed("The Mac returned HTTP \(status).") }
        guard let reply = try? JSONDecoder().decode(Wire.self, from: body) else {
            return .failed("The Mac did not return a valid delivery receipt. Your draft is kept.")
        }
        if let error = reply.error { return .failed(error) }
        if reply.kind == "inject-accepted", reply.delivered == nil, reply.staged == nil { return .accepted }
        if reply.kind == "inject-done" {
            if reply.staged == true, reply.delivered == false { return .staged }
            if reply.staged != true, let delivered = reply.delivered {
                return delivered ? .delivered : .failed("It didn't land in the session.")
            }
        }
        return .failed("The Mac did not confirm this message. Your draft is kept.")
    }

    /// A delayed receipt must preserve edits and additional dictation made while waiting.
    func remainingDraft(_ draft: String, sent: String) -> String {
        guard reachedMac else { return draft }
        let held = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard held.hasPrefix(sent) else { return draft }
        return String(held.dropFirst(sent.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
