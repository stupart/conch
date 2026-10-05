import Foundation

/// The overlays: everything conch puts on screens outside its own window. The control bar and its Ready pill, the floating
/// conversation panel, the canvas's glass on every display (⌃⌥⌘P, its pill, Show, and the agent's marks drawn on it), the
/// input leaving the window as the reply line and its swoop, and the tour's card and the tip by the pill.
///
/// Tyler, 2026-10-05: "not really there UX-wise and kinda annoying atm. We'll come back to them." So they sit behind one
/// switch, off by default, rather than being deleted or kept on a branch: the code stays, and they come back with the
/// switch (Debug ▸ Overlays (experimental)). While it is off nothing of them installs, registers a key or puts a window
/// on screen, and what would have opened in the panel opens in conch's window instead (`destination`).
public enum ConchOverlays {
    /// The switch: a UserDefaults bool. Never set is off.
    public static let key = "conch.overlays"
    /// Off until someone turns it on.
    public static let byDefault = false

    /// Whether the overlays are on, from what UserDefaults holds under `key` (nil: never set).
    public static func enabled(stored: Any?) -> Bool {
        (stored as? Bool) ?? byDefault
    }

    /// Where an open from the menu bar, the Ready pill or the panel goes (`ConchStatusItem.open`).
    public enum Destination: Equatable, Sendable {
        /// The conversation panel, full screen.
        case panel
        /// conch's own window on the session, its deliverable pane on that version: what the panel would have shown,
        /// with the overlays off.
        case window
        /// Its own app (`ConchStatusItem.stage`): a browser, Terminal, or conch's window on the session.
        case stage
    }

    /// The one opening rule. With the overlays on, as it always was: anything the panel draws (`panelDraws`) opens in it
    /// while it is on, or from anywhere when only conch can show it (`conchOnly`: marks, a folder); a pick in the panel
    /// with nothing to open shows the session's words there (`words`); the rest is staged in its own app. With them off
    /// there is no panel, so whatever it would have drawn opens in conch's window instead, and the rest is staged as before.
    public static func destination(overlays: Bool, panelDraws: Bool, panelOn: Bool, conchOnly: Bool, words: Bool) -> Destination {
        if overlays { return (panelDraws && (panelOn || conchOnly)) || words ? .panel : .stage }
        return panelDraws || conchOnly || words ? .window : .stage
    }
}
