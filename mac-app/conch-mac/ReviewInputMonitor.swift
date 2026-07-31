import AppKit
import SwiftUI

struct ReviewInputMonitor: NSViewRepresentable {
    let presentationID: UUID
    let onDismiss: () -> Void
    let onUserActivity: () -> Void

    final class Coordinator {
        var presentationID: UUID
        var onDismiss: () -> Void
        var onUserActivity: () -> Void
        weak var view: PassThroughView?
        var mouseMovementLeaseID: ObjectIdentifier?
        var keyMonitor: Any?
        var swipeMonitor: Any?
        var mouseMonitor: Any?
        var lastMouseActivityTimestamp: TimeInterval = 0
        var didTrigger = false

        init(
            presentationID: UUID,
            onDismiss: @escaping () -> Void,
            onUserActivity: @escaping () -> Void
        ) {
            self.presentationID = presentationID
            self.onDismiss = onDismiss
            self.onUserActivity = onUserActivity
        }

        deinit {
            removeMonitors()
        }

        func installMonitors(for view: PassThroughView) {
            self.view = view
            view.onWindowChange = { [weak self] window in
                self?.configureMouseEvents(for: window)
            }

            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
                [weak self] event in
                guard let self, self.belongsToMonitoredWindow(event) else {
                    return event
                }
                self.onUserActivity()
                guard event.keyCode == 53 else {
                    return event
                }

                self.dismissOnce()
                return nil
            }

            swipeMonitor = NSEvent.addLocalMonitorForEvents(
                matching: .swipe
            ) { [weak self] event in
                guard let self, self.belongsToMonitoredWindow(event) else {
                    return event
                }

                guard self.isAtTopEdge(event) else {
                    return event
                }

                guard event.deltaY > 0 else {
                    return event
                }

                self.dismissOnce()
                return event
            }

            mouseMonitor = NSEvent.addLocalMonitorForEvents(
                matching: [
                    .mouseMoved,
                    .leftMouseDragged,
                    .rightMouseDragged,
                    .otherMouseDragged,
                ]
            ) { [weak self] event in
                guard let self, self.belongsToMonitoredWindow(event) else {
                    return event
                }

                if event.timestamp - self.lastMouseActivityTimestamp >= 0.08 {
                    self.lastMouseActivityTimestamp = event.timestamp
                    self.onUserActivity()
                }
                return event
            }

            configureMouseEvents(for: view.window)
        }

        func removeMonitors() {
            if let keyMonitor {
                NSEvent.removeMonitor(keyMonitor)
                self.keyMonitor = nil
            }
            if let swipeMonitor {
                NSEvent.removeMonitor(swipeMonitor)
                self.swipeMonitor = nil
            }
            if let mouseMonitor {
                NSEvent.removeMonitor(mouseMonitor)
                self.mouseMonitor = nil
            }

            view?.onWindowChange = nil
            restoreConfiguredWindow()
        }

        private func configureMouseEvents(for window: NSWindow?) {
            let windowID = window.map(ObjectIdentifier.init)
            guard mouseMovementLeaseID != windowID else { return }
            restoreConfiguredWindow()
            guard let window else { return }

            mouseMovementLeaseID = WindowMouseMovementLease.acquire(window)
        }

        private func restoreConfiguredWindow() {
            if let mouseMovementLeaseID {
                WindowMouseMovementLease.release(mouseMovementLeaseID)
            }
            mouseMovementLeaseID = nil
        }

        private func belongsToMonitoredWindow(_ event: NSEvent) -> Bool {
            guard let window = view?.window else { return false }
            if let eventWindow = event.window {
                return eventWindow === window
            }
            return NSApp.keyWindow === window
        }

        private func isAtTopEdge(_ event: NSEvent) -> Bool {
            guard let view else { return false }
            let location = view.convert(event.locationInWindow, from: nil)
            let distanceFromTop = view.isFlipped
                ? location.y - view.bounds.minY
                : view.bounds.maxY - location.y
            return distanceFromTop >= 0 && distanceFromTop <= 52
        }

        private func dismissOnce() {
            guard !didTrigger else { return }
            didTrigger = true
            onDismiss()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            presentationID: presentationID,
            onDismiss: onDismiss,
            onUserActivity: onUserActivity
        )
    }

    func makeNSView(context: Context) -> NSView {
        let view = PassThroughView()
        context.coordinator.installMonitors(for: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        if context.coordinator.presentationID != presentationID {
            context.coordinator.presentationID = presentationID
            context.coordinator.didTrigger = false
            context.coordinator.lastMouseActivityTimestamp = 0
        }
        context.coordinator.onDismiss = onDismiss
        context.coordinator.onUserActivity = onUserActivity
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.removeMonitors()
    }
}

final class PassThroughView: NSView {
    var onWindowChange: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(window)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}

private enum WindowMouseMovementLease {
    private final class Entry {
        weak var window: NSWindow?
        let originallyAcceptedMouseMovedEvents: Bool
        var leaseCount: Int

        init(window: NSWindow) {
            self.window = window
            originallyAcceptedMouseMovedEvents = window.acceptsMouseMovedEvents
            leaseCount = 1
        }
    }

    private static var entries: [ObjectIdentifier: Entry] = [:]

    static func acquire(_ window: NSWindow) -> ObjectIdentifier {
        let id = ObjectIdentifier(window)
        if let entry = entries[id], entry.window === window {
            entry.leaseCount += 1
        } else {
            entries[id] = Entry(window: window)
        }
        window.acceptsMouseMovedEvents = true
        return id
    }

    static func release(_ id: ObjectIdentifier) {
        guard let entry = entries[id] else { return }
        entry.leaseCount -= 1
        guard entry.leaseCount == 0 else { return }

        entry.window?.acceptsMouseMovedEvents =
            entry.originallyAcceptedMouseMovedEvents
        entries[id] = nil
    }
}
