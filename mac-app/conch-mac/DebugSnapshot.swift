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
/// Deliberately a file-sentinel rather than a socket command: the Mac app is a
/// socket CLIENT and cannot be pushed to, but it already re-reads state four
/// times a second, so a request file costs one `stat` per poll and no protocol.
enum DebugSnapshot {
    /// Written by `conch shot <path>`; contains the destination path.
    static let requestPath = "/tmp/conch-shot.request"

    /// Honour a pending request, if there is one. Cheap enough to call per poll.
    @MainActor
    static func serviceRequest() {
        let manager = FileManager.default
        guard manager.fileExists(atPath: requestPath) else { return }

        // Read and remove FIRST. A capture that throws must not leave a request
        // behind that retries four times a second forever.
        let destination = (try? String(contentsOfFile: requestPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        try? manager.removeItem(atPath: requestPath)
        guard !destination.isEmpty else { return }
        // Only somewhere obviously scratch. A request file is world-writable by
        // nature, so refuse to be turned into a "write a PNG anywhere" tool.
        guard destination.hasPrefix("/tmp/"), destination.hasSuffix(".png") else { return }

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

        let candidates = NSApp.windows.filter { $0.isVisible && !$0.isMiniaturized }
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
        let key = candidates.first { $0.isKeyWindow }
        guard let window = key ?? candidates.max(by: { lhs, rhs in
            lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
        }) else {
            return fail("no visible window (of \(NSApp.windows.count) total)")
        }
        guard let view = window.contentView else { return fail("window has no contentView") }
        guard view.bounds.width > 1, view.bounds.height > 1 else {
            return fail("contentView is \(view.bounds.size)")
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return fail("bitmapImageRepForCachingDisplay returned nil")
        }
        view.cacheDisplay(in: view.bounds, to: rep)
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
