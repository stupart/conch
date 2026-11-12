import CoreGraphics
import Foundation

/// An agent's click and typing in conch's browser, as real input (2026-11-11). Tyler: "make browser in the app not get
/// flagged by everything thinking its a robot." A click was `element.click()` and a few `dispatchEvent`s, and typing was
/// the field's value set in steps with an `input` event each: every one of those events says `isTrusted: false` to the
/// page, no key was ever pressed (no `keydown`, `keypress` or `keyup`), and no pointer moved before a click. Anti-bot
/// scripts look for exactly that. Measured in a WKWebView set up as a tab's (a harness, a page logging every event): the
/// script's click came as five untrusted events and its typing as 18 untrusted `input`s with no key at all.
///
/// Now the Mac app hands the tab's web view mouse and key events of its own making (`WorkbenchPage`'s native input), as
/// macOS would hand it Tyler's, so WebKit gives the page what a person gives it: the pointer moving to the spot, a press
/// and a release, then for each character a key down, a key press, `beforeinput`, `input` and a key up, every event
/// trusted. They go to the view itself, never through the window, the keyboard focus or the pointer on screen: the
/// keyboard stays where Tyler left it, and nothing moves his pointer. This file is what that input is: which key types
/// which character, how fast, the path the pointer takes, and when Tyler's own hand in the page comes first.
public enum WorkbenchInput {
    /// One step of an agent's typing.
    public enum Stroke: Equatable, Sendable {
        /// A key on a US keyboard: the character it types, the key's own character without Shift, its virtual key code
        /// (what the page reads as `code`), and whether Shift is held for it.
        case key(character: String, unshifted: String, keyCode: UInt16, shift: Bool)
        /// Text no one key types (an accented letter, an emoji, a tab, a line break in a text area), put in as an input
        /// method or dictation puts it in: `beforeinput` and `input`, trusted, with no key.
        case text(String)
    }

    /// Return's key code, for a type that submits: the page's own Return, so a form submits as it would for Tyler.
    public static let returnKeyCode: UInt16 = 36
    /// The left Shift key's, held round a capital or a symbol.
    public static let shiftKeyCode: UInt16 = 56

    /// The US layout's keys (`kVK_ANSI_*`), by the character each types without Shift.
    static let keyCodes: [Character: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
        "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
        "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, " ": 49, "`": 50,
    ]

    /// What Shift turns a key's character into, backwards: the character typed, to the key's own.
    static let shiftedFrom: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=",
        "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]

    /// The strokes that type `text`: a key for each character a US keyboard has, Shift held for a capital or a symbol;
    /// anything else as text. A line break in a one-line field is left out, as the field drops it from a value anyway;
    /// in a text area it goes in as text, never as Return, which a chat box would take for "send".
    public static func strokes(for text: String, singleLine: Bool) -> [Stroke] {
        var strokes: [Stroke] = []
        for character in text {
            if character == "\r\n" || character == "\n" || character == "\r" {
                if !singleLine { strokes.append(.text("\n")) }
                continue
            }
            let lower = Character(character.lowercased())
            if let own = shiftedFrom[character], let code = keyCodes[own] {
                strokes.append(.key(character: String(character), unshifted: String(own), keyCode: code, shift: true))
            } else if character.isASCII, let code = keyCodes[lower] {
                strokes.append(.key(character: String(character), unshifted: String(lower), keyCode: code, shift: character != lower))
            } else {
                strokes.append(.text(String(character)))
            }
        }
        return strokes
    }

    /// Keys pressed one by one at most, about two and a half seconds of typing (`keyGap`): a type has 12 s in all
    /// (src/browser-workbench.ts `BROWSER_OP_MS`), and its mark and the page's settling need some of it.
    public static let keyedMax = 200

    /// `strokes`, at most `max` of them pressed; the text of the rest after them, in one go, as a paste would.
    public static func budgeted(_ strokes: [Stroke], max: Int = keyedMax) -> [Stroke] {
        guard strokes.count > max else { return strokes }
        let rest = strokes[max...].map { stroke -> String in
            switch stroke {
            case let .key(character, _, _, _): character
            case let .text(text): text
            }
        }.joined()
        return Array(strokes[..<max]) + [.text(rest)]
    }

    /// The time between two keys for a text of `count` of them: a quick typist's for a short one, faster for a long one so
    /// the whole stays near `typingTime`, never faster than `fastestGap`. A key is held a third of it.
    public static func keyGap(count: Int) -> TimeInterval {
        guard count > 0 else { return slowestGap }
        return min(slowestGap, max(fastestGap, typingTime / Double(count)))
    }

    public static let slowestGap: TimeInterval = 0.07
    public static let fastestGap: TimeInterval = 0.012
    public static let typingTime: TimeInterval = 2.4

    /// A little unevenness, as a person's keys and steps never come at one beat: `value` times 0.7 to 1.3, by `unit`
    /// (0 to 1, from the caller's random numbers, so a test can pin it).
    public static func jittered(_ value: TimeInterval, unit: Double) -> TimeInterval {
        value * (0.7 + 0.6 * min(1, max(0, unit)))
    }

    // MARK: The pointer

    /// Where the pointer is taken to be before an agent's first move in a page: a little below and to the left of where it
    /// is going, inside the page, as if it came from the middle of the page towards it.
    public static func pointerStart(towards end: CGPoint, last: CGPoint?, in size: CGSize) -> CGPoint {
        if let last, last.x >= 0, last.y >= 0, last.x <= size.width, last.y <= size.height { return last }
        let middle = CGPoint(x: size.width / 2, y: size.height / 2)
        let dx = middle.x - end.x, dy = middle.y - end.y
        let length = max(1, (dx * dx + dy * dy).squareRoot())
        let reach = min(220, max(80, length))
        return CGPoint(x: min(max(0, end.x + dx / length * reach), size.width), y: min(max(0, end.y + dy / length * reach), size.height))
    }

    /// The pointer's way from `start` to `end`, in `steps` moves: eased in and out, bowed a little to one side, as a hand
    /// moves; the last is `end` exactly. None for no distance.
    public static func path(from start: CGPoint, to end: CGPoint, steps: Int) -> [CGPoint] {
        let dx = end.x - start.x, dy = end.y - start.y
        let length = (dx * dx + dy * dy).squareRoot()
        guard length >= 1, steps > 0 else { return [] }
        // The bow: a tenth of the way, at most 24 points, square to the line.
        let bow = min(24, length / 10)
        let normal = CGPoint(x: -dy / length * bow, y: dx / length * bow)
        return (1...steps).map { step in
            let t = Double(step) / Double(steps)
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            let arc = sin(Double.pi * t)
            return step == steps ? end : CGPoint(x: start.x + dx * eased + normal.x * arc, y: start.y + dy * eased + normal.y * arc)
        }
    }

    /// The moves on the way: about one for every 30 points, between 6 and 18.
    public static func pathSteps(from start: CGPoint, to end: CGPoint) -> Int {
        let length = ((end.x - start.x) * (end.x - start.x) + (end.y - start.y) * (end.y - start.y)).squareRoot()
        return min(18, max(6, Int(length / 30)))
    }

    /// A spot the page measured (CSS pixels from the view's top left) in the view's points, at the page's zoom; nil for a
    /// spot that isn't one, or outside the view.
    public static func viewPoint(css: [Double], scale: Double, in size: CGSize) -> CGPoint? {
        guard css.count == 2, css.allSatisfy(\.isFinite), scale.isFinite, scale > 0 else { return nil }
        let point = CGPoint(x: css[0] * scale, y: css[1] * scale)
        guard point.x >= 0, point.y >= 0, point.x < size.width, point.y < size.height else { return nil }
        return point
    }

    // MARK: Tyler's hand comes first

    /// Tyler's hand in a page an agent is about to click or type in: within this of his last click, key or scroll there,
    /// the agent waits (`handWaitMax` at most), so the two never press in the same page at once.
    public static let handQuiet: TimeInterval = 1.0
    public static let handWaitMax: TimeInterval = 4

    public static func handIsIn(lastTouch: Date?, now: Date) -> Bool {
        guard let lastTouch else { return false }
        return now.timeIntervalSince(lastTouch) < handQuiet
    }

    // MARK: The window a page says it is in

    /// What a page is told of the window it is in (`window.outerWidth`, `outerHeight`, `screenX`, `screenY`), which WebKit
    /// asks the app for and an app that doesn't answer leaves at 0 × 0 at the screen's corner: a page reading 0 × 0 takes
    /// it for a headless browser, the oldest test there is (bot.sannysoft.com's `PHANTOM_WINDOW_HEIGHT` read it so).
    ///
    /// Shown, the page is in conch's window, and that is the window it is told. Parked off screen (`parked`, a tab nobody
    /// is looking at, or a capture), it is conch's window again, where it would be shown, else a laptop's browser window in
    /// the middle of the screen: never the parking window, which is off every screen. Never smaller than the page itself,
    /// with room for a window's title bar, as no browser's window is.
    public static func reportedWindowFrame(page: CGSize, hosting: CGRect?, parked: Bool, dashboard: CGRect?, screen: CGRect?) -> CGRect {
        var frame: CGRect
        if !parked, let hosting {
            frame = hosting
        } else if let dashboard, dashboard.width > 0, dashboard.height > 0 {
            frame = dashboard
        } else {
            let size = CGSize(width: max(page.width, defaultWindow.width), height: max(page.height + titleBar, defaultWindow.height))
            let room = screen ?? CGRect(origin: .zero, size: size)
            frame = CGRect(x: room.midX - size.width / 2, y: room.midY - size.height / 2, width: size.width, height: size.height)
        }
        frame.size.width = max(frame.width, page.width)
        frame.size.height = max(frame.height, page.height + (parked ? titleBar : 0))
        return frame.integral
    }

    static let defaultWindow = CGSize(width: 1280, height: 860 + titleBar)
    static let titleBar: CGFloat = 52
}

#if os(macOS)
import AppKit

extension WorkbenchInput {
    /// A mouse event at a spot in `view` (its points from the top left), in its window's coordinates: what the app hands
    /// the web view for a move, a press or a release.
    @MainActor
    public static func mouseEvent(_ type: NSEvent.EventType, at point: CGPoint, in view: NSView, window: NSWindow) -> NSEvent? {
        let local = view.isFlipped ? point : CGPoint(x: point.x, y: view.bounds.height - point.y)
        let pressed = type == .leftMouseDown || type == .leftMouseUp
        return NSEvent.mouseEvent(with: type, location: view.convert(local, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                                  clickCount: pressed ? 1 : 0, pressure: type == .leftMouseDown ? 1 : 0)
    }

    /// A key going down or up, as a US keyboard sends it: the character, the key's own, its code, Shift or not.
    public static func keyEvent(_ type: NSEvent.EventType, character: String, unshifted: String, keyCode: UInt16, shift: Bool, window: NSWindow) -> NSEvent? {
        NSEvent.keyEvent(with: type, location: .zero, modifierFlags: shift ? [.shift] : [], timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: window.windowNumber, context: nil, characters: character, charactersIgnoringModifiers: unshifted,
                         isARepeat: false, keyCode: keyCode)
    }

    /// Shift going down or up, which the page hears as its own `keydown` and `keyup` of "Shift".
    public static func shiftEvent(down: Bool, window: NSWindow) -> NSEvent? {
        NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: down ? [.shift] : [], timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "",
                         isARepeat: false, keyCode: shiftKeyCode)
    }
}
#endif
