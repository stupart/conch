import Foundation

/// The lagoon and the sidebar, one selection (2026-10-13). Tyler: "If I'm looking at the work for one session it should
/// show I'm in that session on the main sidebar."
///
/// Two ways in, and neither may echo back:
/// - the page says `focusSession` (its panel opened on a session or moved to another, or a crab was clicked): the
///   sidebar selects that session (`workspace.viewing`) and the window stays on the lagoon. The page already has that
///   crab in front of it, so the camera isn't sent there again: a `conchWorld.focus` back would pull it off the panel's
///   framing onto the crab, every time the panel moved.
/// - the sidebar picks a session (a click, the arrow keys, the menu bar) while the lagoon shows: `conchWorld.focus(id)`
///   and the camera goes to it. The page posts nothing back for that, and if it did, the selection wouldn't move.
///
/// Both come through the one place the window's selection changes (`selectionChanged`), so this remembers which session
/// the page itself picked last, and that one isn't sent back. Any other selection, nil included, forgets it.
public struct LagoonFocus: Equatable, Sendable {
    /// The session the page last focused, while the window's selection is still that one.
    public private(set) var pagePicked: String?

    public init() {}

    /// The page focused `id` while the window views `viewing`: whether the window's selection must move to it. Either way
    /// the session is the page's own pick, so the selection landing on it isn't sent back.
    public mutating func pageFocused(_ id: String, viewing: String?) -> Bool {
        pagePicked = id
        return viewing != id
    }

    /// The window's selection is now `id`: whether to send the lagoon's camera to it. Not to the session the page picked
    /// (it is already there), nor to no session; any other selection is the sidebar's, and the page's pick is forgotten.
    public mutating func selectionChanged(to id: String?) -> Bool {
        guard let id else {
            pagePicked = nil
            return false
        }
        if id == pagePicked { return false }
        pagePicked = nil
        return true
    }
}
