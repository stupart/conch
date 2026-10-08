import AppKit
import SwiftUI
import WebKit

enum DashboardKey: Equatable {
    case talkOrStop
    case pauseOrResume
    /// Esc while conch is reading aloud, wherever the keyboard is, the message box included. Unclaimed when nothing is
    /// being read, so Esc stays the text field's, or releases the selection.
    case stopSpeaking
    case showKeyboardShortcuts
    case moveUp
    case moveDown
    case releaseSelection
    /// Return, with nothing typeable or web in front: on the lagoon the selected session's conversation, and on the
    /// review pane, while it has the keyboard, Approve (`ReviewApproval.returnKey`). Unclaimed anywhere else, so it
    /// passes on.
    case returnKey(reviewPaneFocused: Bool)
    /// ⌘Z, outside a text field: an approval made here in the last ten seconds, taken back (`ReviewApprovals.undoLast`).
    /// Unclaimed when there is none, so it passes on to whatever else undoes.
    case undoApproval
}

struct DashboardInputMonitor: NSViewRepresentable {
    let isEnabled: Bool
    let onKey: (DashboardKey) -> Bool

    final class Coordinator {
        var isEnabled: Bool
        var onKey: (DashboardKey) -> Bool
        weak var view: DashboardPassThroughView?
        var keyMonitor: Any?
        var clickMonitor: Any?
        /// The last click in this window landed in the review pane (`ReviewPaneProbe`): it has the keyboard's attention,
        /// for Return to approve. A click anywhere else in the window takes it away.
        var reviewPaneFocused = false

        init(isEnabled: Bool, onKey: @escaping (DashboardKey) -> Bool) {
            self.isEnabled = isEnabled
            self.onKey = onKey
        }

        deinit {
            removeMonitor()
        }

        func installMonitor(for view: DashboardPassThroughView) {
            self.view = view
            // Only watched, never taken: the click goes where it was going.
            clickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, belongsToMonitoredWindow(event) else { return event }
                // AppKit hands local monitors their events on the main thread.
                reviewPaneFocused = MainActor.assumeIsolated { ReviewPaneProbe.contains(event.locationInWindow, in: event.window) }
                return event
            }
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
                [weak self] event in
                // ⌘Z in the ten seconds after an approval made here takes it back (2026-10-05). Never a text field's own
                // undo: the composer keeps its own undo stack, and that comes first.
                if let self, isEnabled, belongsToMonitoredWindow(event), Self.isUndo(event), !firstResponderIsEditableText() {
                    return onKey(.undoApproval) ? nil : event
                }
                // Esc stops a reading from anywhere, the message box included: it usually has the keyboard, so the
                // space the hint offered never reached here and the reading went on (2026-10-08, Tyler: "it also says
                // space to cut in but that doesn't work"). Only while conch is reading; otherwise Esc goes on as before.
                if let self, isEnabled, belongsToMonitoredWindow(event), event.keyCode == 53,
                   event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty,
                   onKey(.stopSpeaking) {
                    return nil
                }
                guard let self,
                      isEnabled,
                      belongsToMonitoredWindow(event),
                      let key = Self.dashboardKey(for: event, reviewPaneFocused: reviewPaneFocused) else {
                    return event
                }

                // Inline editing owns the full text-input contract, including spaces
                // and Escape. Web content owns ordinary navigation and typing keys,
                // while the dashboard's safety controls remain global there: Escape
                // releases selection and Space cuts into a read.
                if firstResponderIsEditableText() {
                    return event
                }
                if firstResponderIsWebContent(), !key.isGlobalDashboardControl {
                    return event
                }

                // Return is the lagoon's, or the review pane's to approve, held or not: anywhere else it passes on untouched.
                if case let .returnKey(reviewPaneFocused) = key {
                    return onKey(.returnKey(reviewPaneFocused: reviewPaneFocused)) ? nil : event
                }
                if event.isARepeat && key != .moveUp && key != .moveDown {
                    return nil
                }
                return onKey(key) ? nil : event
            }
        }

        func removeMonitor() {
            if let keyMonitor {
                NSEvent.removeMonitor(keyMonitor)
                self.keyMonitor = nil
            }
            if let clickMonitor {
                NSEvent.removeMonitor(clickMonitor)
                self.clickMonitor = nil
            }
        }

        private func belongsToMonitoredWindow(_ event: NSEvent) -> Bool {
            guard let window = view?.window else { return false }
            if let eventWindow = event.window {
                return eventWindow === window
            }
            return NSApp.keyWindow === window
        }

        private func firstResponderIsEditableText() -> Bool {
            guard let responder = view?.window?.firstResponder else { return false }
            if let textView = responder as? NSTextView, textView.isEditable {
                return true
            }

            var candidate = (responder as? NSView)?.superview
            while let view = candidate {
                if let textView = view as? NSTextView, textView.isEditable {
                    return true
                }
                candidate = view.superview
            }
            return false
        }

        private func firstResponderIsWebContent() -> Bool {
            guard let responder = view?.window?.firstResponder else { return false }
            if responder is WKWebView {
                return true
            }

            var candidate = (responder as? NSView)?.superview
            while let view = candidate {
                if view is WKWebView {
                    return true
                }
                candidate = view.superview
            }
            return false
        }

        /// ⌘Z and nothing else: ⇧⌘Z is redo, and ⌥ or ⌃ are someone else's.
        private static func isUndo(_ event: NSEvent) -> Bool {
            event.modifierFlags.intersection([.command, .control, .option, .shift]) == .command
                && event.charactersIgnoringModifiers?.lowercased() == "z"
        }

        private static func dashboardKey(for event: NSEvent, reviewPaneFocused: Bool) -> DashboardKey? {
            let commandModifiers = event.modifierFlags.intersection([
                .command,
                .control,
                .option,
            ])
            guard commandModifiers.isEmpty else { return nil }

            if event.characters == "?" {
                return .showKeyboardShortcuts
            }

            guard !event.modifierFlags.contains(.shift) else { return nil }

            switch event.keyCode {
            case 53:
                return .releaseSelection
            case 126:
                return .moveUp
            case 125:
                return .moveDown
            case 36, 76:
                return .returnKey(reviewPaneFocused: reviewPaneFocused)
            default:
                break
            }

            switch event.characters {
            case " ":
                return .talkOrStop
            case "p":
                return .pauseOrResume
            // No bare "r": it read the selected session aloud whenever a stray r landed outside a text field, the same
            // trap the bare space that opened the mic was (2026-10-08). Recite is in the command palette.
            default:
                return nil
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(isEnabled: isEnabled, onKey: onKey)
    }

    func makeNSView(context: Context) -> NSView {
        let view = DashboardPassThroughView()
        context.coordinator.installMonitor(for: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.isEnabled = isEnabled
        context.coordinator.onKey = onKey
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.removeMonitor()
    }
}

private extension DashboardKey {
    var isGlobalDashboardControl: Bool {
        switch self {
        case .talkOrStop, .releaseSelection, .stopSpeaking:
            return true
        case .pauseOrResume, .showKeyboardShortcuts,
             .moveUp, .moveDown, .returnKey, .undoApproval:
            return false
        }
    }
}

final class DashboardPassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}

/// Where the review pane is in its window, for the input monitor to tell whether a click gave it the keyboard (Return
/// approves only then: `ReviewApproval.returnKey`). Drawn behind the pane, taking no clicks of its own.
struct ReviewPaneProbe: NSViewRepresentable {
    /// Every probe on screen, weakly: one per window showing a review pane.
    @MainActor private static let probes = NSHashTable<NSView>.weakObjects()

    /// Whether a point in `window`'s coordinates is inside a review pane there.
    @MainActor static func contains(_ point: NSPoint, in window: NSWindow?) -> Bool {
        guard let window else { return false }
        return probes.allObjects.contains { probe in
            probe.window === window && probe.convert(probe.bounds, to: nil).contains(point)
        }
    }

    func makeNSView(context: Context) -> NSView {
        let view = DashboardPassThroughView()
        Self.probes.add(view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    static func dismantleNSView(_ nsView: NSView, coordinator: ()) {
        probes.remove(nsView)
    }
}
