/// The conversation panel's keys. It has them only while it is full screen, while its switcher is open, or while you type
/// in its reply line; otherwise the app in front keeps them, and none of these reach it.
public enum PanelKeys {
    public enum Action: Equatable, Sendable {
        /// ⌘↩: full screen, or back to its corner.
        case fullScreen
        /// Esc, full screen: back to its corner.
        case exitFullScreen
        /// ⌥⌘← and ⌥⌘→: back and on through what is ready, as the panel's Previous and Next.
        case previous, next
        /// ⌘.: folded to its handle.
        case collapse
        /// Esc with the switcher open.
        case closeSwitcher
        /// ↑ and ↓ with the switcher open: the row picked out, by one.
        case move(Int)
        /// Return with the switcher open: the session picked out.
        case pick
        /// Esc with nothing left to leave: the keys go back to the app in front.
        case giveBack
    }

    /// The keys this reads, by their virtual key code (Carbon's `kVK_`).
    public enum Key {
        public static let returnKey: UInt16 = 36
        public static let period: UInt16 = 47
        public static let escape: UInt16 = 53
        public static let enter: UInt16 = 76
        public static let left: UInt16 = 123
        public static let right: UInt16 = 124
        public static let down: UInt16 = 125
        public static let up: UInt16 = 126
    }

    /// Each key as a tooltip names it (`IconButton`'s `shortcut`).
    public enum Shortcut {
        public static let fullScreen = "⌘↩"
        public static let exitFullScreen = "Esc"
        public static let previous = "⌥⌘←"
        public static let next = "⌥⌘→"
        public static let collapse = "⌘."
        /// The canvas's own hotkey, from anywhere (`CanvasHotKey`).
        public static let pen = "⌃⌥⌘P"
    }

    /// What a key pressed on the panel does, or nil to leave it to whatever has the keys: the reply line's own Return, Esc
    /// and arrows while you type. The switcher, open, takes the arrows, Return and Esc first, typing or not.
    public static func action(key: UInt16, command: Bool, option: Bool, control: Bool, shift: Bool, switching: Bool, fullScreen: Bool, typing: Bool) -> Action? {
        let returns = key == Key.returnKey || key == Key.enter
        if control { return nil }
        if command, option, !shift {
            if key == Key.left { return .previous }
            if key == Key.right { return .next }
            return nil
        }
        if command, !option, !shift {
            if returns { return .fullScreen }
            if key == Key.period { return .collapse }
            return nil
        }
        guard !command, !option else { return nil }
        if switching, !shift {
            switch key {
            case Key.escape: return .closeSwitcher
            case Key.up: return .move(-1)
            case Key.down: return .move(1)
            case Key.returnKey, Key.enter: return .pick
            default: break
            }
        }
        guard key == Key.escape, !shift, !typing else { return nil }
        return fullScreen ? .exitFullScreen : .giveBack
    }
}
