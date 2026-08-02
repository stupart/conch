import AppKit
import SwiftUI
import WebKit

enum DashboardKey: Equatable {
    case talkOrStop
    case pauseOrResume
    case muteOrUnmute
    case recite
    case moveUp
    case moveDown
    case releaseSelection
}

struct DashboardInputMonitor: NSViewRepresentable {
    let isEnabled: Bool
    let onKey: (DashboardKey) -> Bool

    final class Coordinator {
        var isEnabled: Bool
        var onKey: (DashboardKey) -> Bool
        weak var view: DashboardPassThroughView?
        var keyMonitor: Any?

        init(isEnabled: Bool, onKey: @escaping (DashboardKey) -> Bool) {
            self.isEnabled = isEnabled
            self.onKey = onKey
        }

        deinit {
            removeMonitor()
        }

        func installMonitor(for view: DashboardPassThroughView) {
            self.view = view
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
                [weak self] event in
                guard let self,
                      isEnabled,
                      belongsToMonitoredWindow(event),
                      let key = Self.dashboardKey(for: event) else {
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

        private static func dashboardKey(for event: NSEvent) -> DashboardKey? {
            let disallowedModifiers = event.modifierFlags.intersection([
                .command,
                .control,
                .option,
                .shift,
            ])
            guard disallowedModifiers.isEmpty else { return nil }

            switch event.keyCode {
            case 53:
                return .releaseSelection
            case 126:
                return .moveUp
            case 125:
                return .moveDown
            default:
                break
            }

            switch event.characters {
            case " ":
                return .talkOrStop
            case "p":
                return .pauseOrResume
            case "m":
                return .muteOrUnmute
            case "r":
                return .recite
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
        case .talkOrStop, .releaseSelection:
            return true
        case .pauseOrResume, .muteOrUnmute, .recite, .moveUp, .moveDown:
            return false
        }
    }
}

final class DashboardPassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}
