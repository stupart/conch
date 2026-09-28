import SwiftUI

extension EnvironmentValues {
    /// The window this is in can't be seen: ordered out, minimised, on another Space, or wholly covered. A clock that
    /// only moves pixels (`TimelineView(.animation)`) stops while it is (`conchPausesWhenHidden`).
    ///
    /// SwiftUI does not stop one for you: a `TimelineView(.animation)` ticked at its full 30 frames a second in a window
    /// that had been ordered out, and in one never shown at all (measured 28 Sep), re-running its window's view graph
    /// every frame for nobody. The conversation panel is ordered out, not torn down, when it is turned off, so its
    /// "Thinking" went on at 30 frames a second for as long as the session worked.
    @Entry public var conchHidden = false
}

#if canImport(AppKit)
import AppKit

extension View {
    /// Tells everything in this window whether the window can be seen (`conchHidden`), from AppKit's own occlusion
    /// state, so its animation clocks stop when it can't. Put it at the root of each window's content.
    public func conchPausesWhenHidden() -> some View {
        modifier(PausesWhenHidden())
    }
}

struct PausesWhenHidden: ViewModifier {
    @State private var hidden = false

    func body(content: Content) -> some View {
        content
            .environment(\.conchHidden, hidden)
            .background(WindowVisibilityReader { visible in
                if hidden == visible { hidden = !visible }
            })
    }
}

/// Reports whether its window can be seen, now and whenever that changes (`NSWindow.occlusionState`).
struct WindowVisibilityReader: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> WindowVisibilityView {
        let view = WindowVisibilityView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: WindowVisibilityView, context: Context) {
        view.onChange = onChange
    }
}

final class WindowVisibilityView: NSView {
    var onChange: (Bool) -> Void = { _ in }
    /// What was last reported; nil before the first report.
    private(set) var visible: Bool?
    private var observer: NSObjectProtocol?

    /// Visible means some part of the window is on screen and not covered: AppKit's `.visible` occlusion bit. A window
    /// that is ordered out, minimised, off every display or on another Space has it clear.
    static func isVisible(_ window: NSWindow?) -> Bool {
        window?.occlusionState.contains(.visible) ?? false
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observer.map(NotificationCenter.default.removeObserver)
        observer = nil
        if let window {
            observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.check() }
            }
        }
        check()
    }

    deinit {
        observer.map(NotificationCenter.default.removeObserver)
    }

    func check() {
        let now = Self.isVisible(window)
        guard now != visible else { return }
        visible = now
        // After the update that moved the view, never inside it: SwiftUI's state is not to be written mid-update.
        let report = onChange
        DispatchQueue.main.async { report(now) }
    }
}
#endif
