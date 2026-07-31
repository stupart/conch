import AppKit
import SwiftUI

enum DashboardKey: Equatable {
    case talkOrStop
    case pauseOrResume
    case muteOrUnmute
    case recite
    case moveUp
    case moveDown
    case releaseSelection
    case wakeNumber(Int)
    case quit
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
            case "q":
                return .quit
            case let character?:
                guard character.count == 1,
                      let number = Int(character),
                      (1...9).contains(number) else {
                    return nil
                }
                return .wakeNumber(number)
            case nil:
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

final class DashboardPassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}
