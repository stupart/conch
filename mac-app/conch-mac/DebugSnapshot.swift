import AppKit
import Foundation

/// Let the app photograph ITSELF, so nobody has to photograph the screen.
///
/// This exists because of a specific mistake: verifying UI work by running
/// `screencapture` over a region of Tyler's display, which caught an unrelated
/// window full of his private work instead of conch. The screen is his; the
/// app's own window is the only thing conch has any business capturing, and it
/// is the only thing that was ever wanted.
///
/// A whole-screen shot is a perfectly respectable way to look at conch — it is
/// `conch shot --screen`, it carries the context that makes a wrong crop
/// obvious, and it lives in the CLI because the Terminal already holds the
/// screen-recording permission. This file is the other half: photographing ONE
/// window, which is what you want when the window is occluded or offscreen, or
/// when you would rather not pull the rest of Tyler's desk into an agent's
/// context.
///
/// Deliberately a file-sentinel rather than a socket command: the Mac app is a
/// socket CLIENT and cannot be pushed to, but it already re-reads state four
/// times a second, so a request file costs one `stat` per poll and no protocol.
enum DebugSnapshot {
    /// Written by `conch shot <path>`; the first line is the destination path,
    /// and an optional second line names the window (`Target`). One line alone
    /// is what every caller wrote before named windows existed, and still means
    /// exactly what it meant then.
    static let requestPath = "/tmp/conch-shot.request"

    /// Ask the app to OPEN something before it is photographed.
    ///
    /// A picture of the window only proves what was already on screen, so the
    /// views that most need checking — sheets, reached by a menu on a row —
    /// could not be verified without reaching for the user's mouse. This lets
    /// the capture ask first. The value is a session id, or empty for the
    /// selected row; anything it names is read-only either way.
    static let inspectRequestPath = "/tmp/conch-inspect.request"

    /// Which window to photograph.
    ///
    /// `key` is what a one-line request has always meant and stays the default.
    /// The floating panels were unreachable until now: the candidate list
    /// deliberately excluded them, which left the conversation overlay — the
    /// surface under the heaviest iteration — impossible for the app to
    /// photograph at all.
    enum Target: String {
        case key, overlay, controlbar, dashboard, geometry
    }

    /// Read and clear a pending request to open the capability inspector.
    @MainActor
    static func pendingInspection() -> String? {
        let manager = FileManager.default
        guard manager.fileExists(atPath: inspectRequestPath) else { return nil }
        let wanted = (try? String(contentsOfFile: inspectRequestPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        try? manager.removeItem(atPath: inspectRequestPath)
        return wanted ?? ""
    }

    /// The conversation overlay, identified by the one thing true of it in EVERY state.
    ///
    /// Not by its frame autosave name: `FloatingPanels` blanks that while the fog is
    /// collapsed or full screen (so neither is ever saved as the restore frame), which
    /// are exactly two of the states worth photographing. A name-matching lookup would
    /// find the overlay in the easy states and silently miss it in the interesting ones.
    /// `takesKeys` is set once, at construction, on the fog and on nothing else.
    @MainActor
    private static func isOverlay(_ panel: FloatingPanel) -> Bool { panel.takesKeys }

    /// Everything conch has on screen, whichever window is being photographed.
    ///
    /// The caller gets this even for a whole-screen capture, and that is the point: a
    /// crop computed from live geometry cannot aim at where the window used to be.
    /// Three measurements were invalidated in one session by cropping to a region that
    /// was stale after a resize, or that turned out to belong to another app.
    @MainActor
    private static func describe(_ window: NSWindow) -> [String: Any] {
        let frame = window.frame
        let screen = window.screen ?? NSScreen.main
        let scale = screen?.backingScaleFactor ?? 2
        var described: [String: Any] = [
            "name": name(of: window),
            // `screencapture -l <number>` photographs exactly this window as the window
            // server composites it — which, unlike the offscreen draw below, includes the
            // behind-window blur that a translucent panel is mostly made of.
            "windowNumber": window.windowNumber,
            "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
            "isVisible": window.isVisible,
            "isKeyWindow": window.isKeyWindow,
            // A caret only exists where the keyboard focus is. A whole session went into
            // scanning for one in a field that had none, reading every correct "nothing
            // here" as a broken measurement.
            "firstResponder": window.firstResponder.map { String(describing: type(of: $0)) } ?? "none",
            "appearance": window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "dark" : "light",
            "backingScaleFactor": scale,
        ]
        if let screen {
            let bounds = screen.frame
            described["screenFrame"] = ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]
            // What the menu bar and the Dock leave over. Worth reporting because AppKit
            // CONSTRAINS a window to it: a fog asked to dock flush to the top of the
            // screen comes up flush to the top of this instead, 33 points short, and
            // without both rectangles that looks like the dock request being ignored.
            let usable = screen.visibleFrame
            described["visibleFrame"] = ["x": usable.minX, "y": usable.minY, "width": usable.width, "height": usable.height]
            // Where this window lands inside a full-display screenshot: pixels, y from the
            // TOP, which is how every image tool measures and how Cocoa does not.
            described["imageRect"] = [
                "x": (frame.minX - bounds.minX) * scale,
                "y": (bounds.maxY - frame.maxY) * scale,
                "width": frame.width * scale,
                "height": frame.height * scale,
            ]
            described["isOnMainDisplay"] = screen == NSScreen.screens.first
        }
        return described
    }

    @MainActor
    private static func name(of window: NSWindow) -> String {
        guard let panel = window as? FloatingPanel else {
            // Not every non-panel window is the dashboard — the menu bar's own status
            // window is one too. Calling that "dashboard" in the very artifact that
            // exists to say which window is which would be its own small lie, so
            // anything without a title answers with its class instead.
            return window.title.isEmpty ? String(describing: type(of: window)) : "dashboard"
        }
        return isOverlay(panel) ? "overlay" : "controlbar"
    }

    /// Honour a pending request, if there is one. Cheap enough to call per poll.
    @MainActor
    static func serviceRequest() {
        let manager = FileManager.default
        guard manager.fileExists(atPath: requestPath) else { return }

        // Read and remove FIRST. A capture that throws must not leave a request
        // behind that retries four times a second forever.
        let request = (try? String(contentsOfFile: requestPath, encoding: .utf8)) ?? ""
        try? manager.removeItem(atPath: requestPath)
        let lines = request.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let destination = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !destination.isEmpty else { return }
        // Only somewhere obviously scratch. A request file is world-writable by
        // nature, so refuse to be turned into a "write a PNG anywhere" tool.
        guard destination.hasPrefix("/tmp/"), destination.hasSuffix(".png") else { return }
        let wanted = lines.count > 1 ? lines[1] : ""
        let target = wanted.isEmpty ? Target.key : Target(rawValue: wanted) ?? Target.key

        // A silent failure here is worse than useless: the caller waits five
        // seconds and learns nothing. Say which step failed, in a file beside
        // the one that was asked for.
        func fail(_ reason: String) {
            try? reason.write(
                toFile: destination + ".error",
                atomically: true,
                encoding: .utf8
            )
        }

        let onScreen = NSApp.windows.filter { $0.isVisible && !$0.isMiniaturized }
        // Not the floating panels (M3): this photographs the conch window.
        let candidates = onScreen.filter { !($0 is FloatingPanel) }
        let panels = onScreen.compactMap { $0 as? FloatingPanel }
        // Whatever is in FRONT is what someone wants a picture of.
        //
        // This used to take the largest visible window on the reasoning that
        // the biggest one is the app rather than a panel or a tooltip. True,
        // and it meant sheets and the Settings window could never be
        // photographed at all — they are smaller than the window they sit on,
        // so they always lost. That is precisely the UI that most needs
        // looking at: Settings crashed the app today, and the resume picker is
        // a sheet.
        //
        // A sheet or a settings window takes key status when it appears, so
        // preferring the key window shows what is actually on screen. Size
        // remains the fallback for when nothing is key.
        let largest = candidates.max { lhs, rhs in
            lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
        }
        let key = candidates.first { $0.isKeyWindow }
        let window: NSWindow?
        switch target {
        case .key: window = key ?? largest
        case .dashboard: window = largest
        case .overlay: window = panels.first(where: isOverlay)
        case .controlbar: window = panels.first { !isOverlay($0) }
        case .geometry: window = nil
        }

        // Written before the picture is taken and beside it, for every target. The
        // geometry is read live, here, at the moment of capture: a rect remembered
        // from earlier in a run is the single most reliable way to measure the wrong
        // thing.
        let described = onScreen.map(describe)
        let sidecar: [String: Any] = [
            "captured": window.map(name(of:)) ?? NSNull(),
            "target": target.rawValue,
            "windows": described,
            // The overlay paints its own light or dark from this, independently of the
            // system appearance — an hour went into comparing a light-mode reference
            // against a dark-mode app without noticing.
            "overlayAppearance": UserDefaults.standard.string(forKey: FloatingPanels.Look.appearanceKey) ?? "auto",
            "appIsActive": NSApp.isActive,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let json = try? JSONSerialization.data(withJSONObject: sidecar, options: [.prettyPrinted, .sortedKeys]) {
            try? json.write(to: URL(fileURLWithPath: destination + ".json"))
        }
        // Geometry alone: the caller is taking the picture itself (`--screen`, or
        // `screencapture -l` for the composited window) and only needs to know where
        // everything is and which window is which.
        if target == .geometry { return }

        guard let window else {
            if target == .overlay, !UserDefaults.standard.bool(forKey: ConchStatusItem.showConversationKey) {
                return fail("the conversation overlay is switched off (conch.showConversation is false), so there is no window to photograph")
            }
            return fail("no \(target.rawValue) window (of \(NSApp.windows.count) total)")
        }
        guard let view = window.contentView else { return fail("window has no contentView") }
        guard view.bounds.width > 1, view.bounds.height > 1 else {
            return fail("contentView is \(view.bounds.size)")
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return fail("bitmapImageRepForCachingDisplay returned nil")
        }
        // Draw in the WINDOW'S appearance, not whatever the drawing context happens to be.
        //
        // The palette is dynamic colours — `NSColor(name: nil) { appearance in … }` — which
        // resolve against the CURRENT DRAWING appearance. An offscreen `cacheDisplay` does not
        // inherit the window's, so on a light system every snapshot came back DARK: a whole
        // night of "verified by eye" was judged in a theme the user never sees. A screenshot
        // tool that lies is worse than no screenshot tool, because it is believed.
        window.effectiveAppearance.performAsCurrentDrawingAppearance {
            view.cacheDisplay(in: view.bounds, to: rep)
        }
        guard let png = rep.representation(using: .png, properties: [:]) else {
            return fail("png representation returned nil")
        }
        do {
            try png.write(to: URL(fileURLWithPath: destination))
        } catch {
            fail("write failed: \(error.localizedDescription)")
        }
    }
}
