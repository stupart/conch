import Foundation

/// Which deliverable this is — the one question every surface that shows work has to answer
/// the same way.
///
/// Three of them used to answer it separately, each recomputing `session + filing time`: the
/// terminal's seen set, the Mac's `ReviewItem.id`, and the phone's `ReviewQueue.key`. Three
/// chances to disagree, and two deliverables filed inside the same millisecond are one
/// deliverable to all three.
///
/// The daemon now mints an identity when it files a deliverable and publishes it on the row.
/// This prefers that, and keeps the old recipe for the case that still needs it.
public enum ReviewIdentity {
    /// The published identity when there is one, else the key every surface used to compute.
    ///
    /// The fallback is not a nicety: an older daemon sends no identity, and its deliverables
    /// must keep the exact key the apps already use — byte for byte — or every open sheet,
    /// pulse and seen mark on screen would be talking about a different deliverable than the
    /// one it was a moment ago.
    public static func key(published: String?, sessionId: String, filedAt: Double?) -> String {
        if let published, !published.isEmpty { return published }
        let stamp = filedAt.map { String($0.bitPattern) } ?? "undated"
        return [sessionId, stamp].joined(separator: "\u{1F}")
    }
}
