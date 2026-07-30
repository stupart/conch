import AppKit
import SwiftUI

struct ReviewInputMonitor: NSViewRepresentable {
    let onReveal: () -> Void

    final class Coordinator {
        var onReveal: () -> Void
        weak var view: NSView?
        var keyMonitor: Any?
        var gestureMonitor: Any?
        var scrollDistance: CGFloat = 0
        var lastScrollTimestamp: TimeInterval = 0
        var didTrigger = false

        init(onReveal: @escaping () -> Void) {
            self.onReveal = onReveal
        }

        deinit {
            removeMonitors()
        }

        func installMonitors(for view: NSView) {
            self.view = view

            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
                [weak self] event in
                guard let self, self.belongsToMonitoredWindow(event) else {
                    return event
                }
                guard event.keyCode == 53 else {
                    return event
                }

                self.revealOnce()
                return nil
            }

            gestureMonitor = NSEvent.addLocalMonitorForEvents(
                matching: [.scrollWheel, .swipe]
            ) { [weak self] event in
                guard let self, self.belongsToMonitoredWindow(event) else {
                    return event
                }

                guard self.isAtTopEdge(event) else {
                    self.resetScroll()
                    return event
                }

                let delta = event.scrollingDeltaY != 0
                    ? event.scrollingDeltaY
                    : event.deltaY
                guard delta > 0 else {
                    self.resetScroll()
                    return event
                }

                if event.type == .swipe {
                    self.revealOnce()
                    return event
                }

                if event.phase.contains(.began)
                    || event.timestamp - self.lastScrollTimestamp > 0.3 {
                    self.scrollDistance = 0
                }
                self.lastScrollTimestamp = event.timestamp
                self.scrollDistance += event.hasPreciseScrollingDeltas ? delta : delta * 12

                if self.scrollDistance > 42 {
                    self.revealOnce()
                }

                if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
                    self.resetScroll()
                }
                return event
            }
        }

        func removeMonitors() {
            if let keyMonitor {
                NSEvent.removeMonitor(keyMonitor)
                self.keyMonitor = nil
            }
            if let gestureMonitor {
                NSEvent.removeMonitor(gestureMonitor)
                self.gestureMonitor = nil
            }
        }

        private func belongsToMonitoredWindow(_ event: NSEvent) -> Bool {
            guard let window = view?.window else { return false }
            return event.window === window || NSApp.keyWindow === window
        }

        private func isAtTopEdge(_ event: NSEvent) -> Bool {
            guard let view else { return false }
            let location = view.convert(event.locationInWindow, from: nil)
            let distanceFromTop = view.isFlipped
                ? location.y - view.bounds.minY
                : view.bounds.maxY - location.y
            return distanceFromTop >= 0 && distanceFromTop <= 52
        }

        private func resetScroll() {
            scrollDistance = 0
            lastScrollTimestamp = 0
        }

        private func revealOnce() {
            guard !didTrigger else { return }
            didTrigger = true
            onReveal()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onReveal: onReveal)
    }

    func makeNSView(context: Context) -> NSView {
        let view = PassThroughView()
        context.coordinator.installMonitors(for: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onReveal = onReveal
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.removeMonitors()
    }
}

private final class PassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}
