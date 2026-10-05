import AppKit
import ConchDesign
import Foundation

// sidebar-settle.test.ts compiles the Mac app's own sources without two of them, and these stand in for them.
//
// ConchMacApp.swift is the @main app and its delegate: it starts the daemon, registers a login item, asks for
// notifications and installs the menu bar item. None of that may happen in a test, so what the rest of the app reads
// from it, ReviewNotifications, never notifies, activates or raises anything.
//
// DebugSnapshot.swift reads and DELETES the running app's request files in /tmp (`conch shot`, `conch parity`): run
// here, it would eat requests meant for the real conch. Its stand-in answers nothing and touches no file.

final class ReviewNotifications {
    static let shared = ReviewNotifications()
    var isQuiet: () -> Bool = { false }
    private(set) weak var reviewWindow: NSWindow?
    private init() {}
    func readAuthorizationAtLaunch() {}
    func requestNow(_ done: @escaping (Bool) -> Void) { done(false) }
    func authorization(_ done: @escaping (ConchPermissionStatus) -> Void) { done(.notAsked) }
    func register(window: NSWindow) {}
    func postOnce(for item: ReviewItem) {}
}

enum DebugSnapshot {
    @MainActor static var viewing: String?
    @MainActor static func pendingSelection() -> String? { nil }
    @MainActor static func pendingInspection() -> String? { nil }
    @MainActor static func serviceRequest() {}
}
