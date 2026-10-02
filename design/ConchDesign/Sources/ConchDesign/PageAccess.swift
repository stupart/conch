import Foundation

/// A live page's login wall, as both apps say it (src/page-access.ts is the daemon's half).
///
/// Tyler (2026-10-03, feedback item 3): an agent published a URL behind a login, he tapped it on his phone and got a
/// sign-in page. When a `url` deliverable is published, the daemon now has conch's Mac app draw it with the review pane's
/// sign-ins (`mac`) and looks at it itself with none (`anonymous`, what the phone would be shown). When the Mac drew the
/// page, its picture is filed on the deliverable as its `snapshot`:
///
/// - the phone shows that picture first, labelled as conch's view on the Mac at that time, with the live page a tap away,
///   and says when the live page needs a sign-in the phone doesn't have (DeliverableSheet.swift);
/// - the Mac says, over the live page, that the page asked conch to sign in, and that signing in there once is what lets
///   conch see it (ReviewView.swift).
///
/// The words and the decisions are here, once, so the two apps can't say it differently.
public enum PageAccess {
    /// What one look found: the page, a sign-in page, or nothing either way (not drawn, not reached).
    public enum State: String, Codable, Equatable, Sendable {
        case page
        case signIn = "sign-in"
        case unchecked
    }

    /// The two looks, as a deliverable carries them (`access`). A state this build doesn't know reads as unchecked.
    public struct Found: Equatable, Sendable, Decodable {
        public var mac: State
        public var anonymous: State

        public init(mac: State, anonymous: State) {
            self.mac = mac
            self.anonymous = anonymous
        }

        private enum CodingKeys: String, CodingKey { case mac, anonymous }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            mac = (try? container.decode(State.self, forKey: .mac)) ?? .unchecked
            anonymous = (try? container.decode(State.self, forKey: .anonymous)) ?? .unchecked
        }
    }

    /// The phone's line under the Mac's picture: whose view it is, and when it was drawn. The time alone today, the day
    /// too before then, in the reader's own clock and calendar.
    public static func snapshotCaption(capturedAt: Date, now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        if calendar.isDate(capturedAt, inSameDayAs: now) {
            formatter.dateStyle = .none
            formatter.timeStyle = .short
            return "conch's view on your Mac at \(formatter.string(from: capturedAt))"
        }
        formatter.setLocalizedDateFormatFromTemplate("MMMd jj:mm")
        return "conch's view on your Mac, \(formatter.string(from: capturedAt))"
    }

    /// Said on the phone beside the Mac's picture when the live page asked a device without the Mac's sign-ins to sign in:
    /// opening it here would show a sign-in page, not this.
    public static let phoneSignInNote = "The live page needs a sign-in this phone doesn't have, so it may open on a sign-in page."

    /// Said on the phone, after the picture, as the way to the live page.
    public static let openLiveTitle = "Open live page"

    /// The phone's note, when there is one: only when the look without cookies was shown a sign-in page.
    public static func phoneNote(_ found: Found?) -> String? {
        found?.anonymous == .signIn ? phoneSignInNote : nil
    }

    /// Said on the Mac over the live page when conch's own look at it was shown a sign-in page: the review pane's sign-ins
    /// are conch's, so signing in here once is what lets conch draw it, for the phone and for the agent.
    public static let macSignInBanner = "This page asked conch to sign in when it was published. Sign in here once, and conch sees it from then on."

    /// The Mac's banner, when there is one: only when the Mac's own look was shown a sign-in page.
    public static func macBanner(_ found: Found?) -> String? {
        found?.mac == .signIn ? macSignInBanner : nil
    }
}
