// Whether conch.app has made its main window: exit 0 when a window named "conch", owned by conch, exists and is drawn
// (not the browser's parking window, which is invisible, nor the menu bar's). Minimised or on another Space counts: it
// is there. build-app.sh asks after a relaunch: a background launch has come back with no window at all more than once
// (2026-10-12, 2026-10-18), and a second `open` didn't always bring one.
import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
let shown = windows.contains { window in
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let name = window[kCGWindowName as String] as? String ?? ""
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return (owner == "conch" || owner == "conch-mac") && name == "conch" && layer == 0 && alpha > 0
        && (bounds["Width"] ?? 0) >= 300 && (bounds["Height"] ?? 0) >= 200
}
exit(shown ? 0 : 1)
