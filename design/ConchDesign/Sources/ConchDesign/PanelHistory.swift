import CoreGraphics
import Foundation

// The conversation panel's recorded history: the main window's rule (`ConversationSource`) for the panel's words.
//
// The panel drew only the live window the daemon published, and the daemon publishes eight sessions' (and four
// agents'), so a session without one was a blank panel over a whole conversation — the main window's bug (#457), in the
// panel. Here, as there, a session with no live window is drawn from its record: the recorded messages above an empty
// live window, the newest first on screen, older pages read in as the reader scrolls back, and the main window's
// sentences while there is nothing to draw yet.

/// What the conversation panel draws for a session.
public enum PanelConversation: Equatable, Sendable {
    /// Its turns: the record's, older than the live window's, then the live window's own.
    case turns
    /// No turns yet, and why, in the main window's words (`ConversationPlaceholder`).
    case placeholder(ConversationPlaceholder.Transcript)
    /// No live window, and the record is off or holds nothing to show (`ConversationSource.neither`): the transcript's own
    /// last reply, or its sentence for why there is none — what the main window's single-reply document says
    /// (`SessionStaticContent`).
    case lastReply

    /// `source` is the main window's rule for this session (`ConversationSource.of`), and decides as the main window's gate
    /// does: `.neither` is the single-reply document's content, anything else the conversation. `turns` is how many of the
    /// conversation's the panel has — it draws what was said, not the tools — and with none, why.
    public static func of(source: ConversationSource, turns: Int, session: String, reader: HistoryPaging) -> PanelConversation {
        switch source {
        case .neither:
            return .lastReply
        case .live, .recorded:
            if turns > 0 { return .turns }
            // Not asked about this session yet: it is about to be.
            guard reader.session == session else { return .placeholder(.unread) }
            switch reader.status {
            case .loading:
                return .placeholder(.unread)
            case .failed:
                return .placeholder(.unreadable)
            case .idle where reader.canLoadOlder:
                // More to read: the newest pages can be all tool steps.
                return .placeholder(.unread)
            case .idle, .off:
                // Read to the start, or not recorded, and what there is holds tool steps and no words: the agent is at
                // work and has not said anything since.
                return .placeholder(.awaitingReply)
            }
        }
    }
}

public enum PanelHistory {
    /// Recorded turns read whole either side of the one in the middle of the panel (`nearby`).
    public static let bodiesAround = 8

    /// The panel's turns for `session`: the record's messages older than the live window, then the live window's.
    ///
    /// The seam is the main window's (`HistorySnapshot.older`): the record holds the whole session and the live window its
    /// newest items, so the record stops where the live window starts — by id, and by time where the provider's ids do not
    /// match (Codex). `liveItems` is every item the live window holds, tools included, since any of them marks the seam;
    /// `live` its turns. A reader still on another session adds nothing: its rows are that session's.
    public static func turns(
        session: String,
        reader: HistoryPaging,
        live: [ConversationTurn],
        liveItems: [String],
        liveStartsAt: Double?,
        whole: (HistoryItem) -> String?
    ) -> [ConversationTurn] {
        guard reader.session == session, !reader.rows.isEmpty else { return live }
        let older = HistorySnapshot.older(
            rows: reader.rows,
            thanSnapshot: Set(liveItems.map(HistorySnapshot.nativeId(forSnapshotItem:))),
            startingAt: liveStartsAt
        )
        return older.compactMap { $0.item.flatMap { turn(recorded: $0, whole: whole($0)) } } + live
    }

    /// A recorded item as a turn, the way the main window's stack makes it a row (`ConversationItem(recorded:)`): a message
    /// is yours when its role is the user's and the agent's otherwise, and says its whole body once that has been read, its
    /// preview until then, marked as cut where there is more. Nil for anything but a message — tools, materials and context
    /// stay in the main window, as the live window's do — and for a message with nothing in it.
    public static func turn(recorded item: HistoryItem, whole: String?) -> ConversationTurn? {
        guard item.kind == "message" else { return nil }
        let text = whole ?? (item.hasFullBody ? item.preview + "…" : item.preview)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return ConversationTurn(id: item.id, fromYou: item.role == "user", text: text)
    }

    /// Whether the panel should read the page before its oldest turn: the transcript's oldest end is within the main
    /// window's prefetch distance of the box (`HistoryPrefetch`) — which a transcript that does not fill its box always
    /// is — and the fog would draw what came (it draws the newest `ConversationFog.turnsShown`). Past that the main window
    /// is where the rest is read.
    public static func wantsOlder(turns: Int, scroll: FogScroll, box: CGFloat) -> Bool {
        guard turns < ConversationFog.turnsShown else { return false }
        // Nothing to show yet is as near the oldest end as it gets, measured or not: the newest pages can be all tool
        // steps, and the placeholder that shows meanwhile lays out no transcript to measure.
        guard turns > 0 else { return true }
        return HistoryPrefetch.shouldLoadOlder(contentAbove: scroll.range - scroll.offset, viewport: box)
    }

    /// The turns about where the reader is, and the one in the middle, for their recorded messages to be read whole.
    ///
    /// The panel's transcript is one flow of text, not rows that can say which of them are on screen, so this goes by
    /// position: how far back from the newest end the middle of the box is, as a share of the whole transcript, picks the
    /// middle turn, and `side` turns either side of it are the rest. The reader's region asks the same of the record for the
    /// main window's rows it lays out (`HistoryStore.showing`), and holds their bodies while they are near.
    ///
    /// Scrolled back, only the middle turn and newer ones: a body grows its turn at the turn's end, and the scroll keeps the
    /// reader's place by the distance from the oldest line (`FogScroll.layout`), so a turn above the middle growing would
    /// move the lines under the reader. Pinned, the newest line holds still whatever grows above it.
    public static func nearby(_ ids: [String], scroll: FogScroll, box: CGFloat, side: Int = bodiesAround) -> (ids: [String], center: String?) {
        guard !ids.isEmpty else { return ([], nil) }
        let whole = scroll.range + box
        let back = whole > 0 ? min(max((scroll.offset + box / 2) / whole, 0), 1) : 0
        let middle = max(0, ids.count - 1 - Int((back * CGFloat(ids.count)).rounded(.down)))
        let window = ids[(scroll.pinned ? max(0, middle - side) : middle)...min(ids.count - 1, middle + side)]
        return (Array(window), ids[middle])
    }
}
