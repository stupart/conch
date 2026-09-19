import Cocoa

// A known ground to judge a translucent surface against.
//
//   swift tools/backdrop.swift [RRGGBB]     covers every screen; ^C or SIGTERM to remove
//
// The conversation overlay is mostly blur: what it looks like is a function of
// whatever happens to be behind it. A session went into judging its tint against
// an ever-changing pile of the user's own windows, which is not a measurement —
// the variable being compared was never held still. This holds it still.
//
// Two runs over two different colours also make the panel's own alpha solvable:
// a pixel is `alpha * panel + (1 - alpha) * backdrop`, so measuring the same
// pixel over black and over white gives both unknowns.
//
// It sits ABOVE ordinary windows (so it covers the desk, which is also the
// polite thing to do with someone's private work) and BELOW conch's floating
// panels, which live at `.floating`. It never takes focus and never takes a
// click: the app under test keeps whatever focus it had, because a panel that
// lost its keyboard focus to the test rig draws no caret, and a missing caret
// reads as a bug that isn't there.
let hex = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "808080"
guard let value = UInt32(hex, radix: 16), hex.count == 6 else {
    FileHandle.standardError.write(Data("backdrop: colour must be six hex digits, like 808080\n".utf8))
    exit(2)
}
let app = NSApplication.shared
// .accessory: no Dock tile, no menu bar, and it never becomes the active app.
app.setActivationPolicy(.accessory)
let colour = NSColor(
    srgbRed: CGFloat((value >> 16) & 255) / 255,
    green: CGFloat((value >> 8) & 255) / 255,
    blue: CGFloat(value & 255) / 255,
    alpha: 1
)
// Every screen, not just the main one. The overlay docks in a corner and can be
// dragged to another display; a backdrop covering one screen would leave it
// judged against the desk on the other, which looks like a working rig.
var windows: [NSWindow] = []
for screen in NSScreen.screens {
    let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.setFrame(screen.frame, display: true)
    window.backgroundColor = colour
    window.level = NSWindow.Level(Int(CGWindowLevelForKey(.normalWindow)) + 1)
    window.ignoresMouseEvents = true
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    window.isExcludedFromWindowsMenu = true
    window.orderFrontRegardless()
    windows.append(window)
}
// Printed only once the windows are actually up, so a script can wait for this
// line instead of guessing at a sleep and photographing the desk it meant to cover.
print("backdrop #\(hex) on \(windows.count) screen\(windows.count == 1 ? "" : "s") — ready")
fflush(stdout)
app.run()
