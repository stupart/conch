import SwiftUI
import AppKit

@main
struct ConchMacApp: App {
    @StateObject private var store = StateStore()

    var body: some Scene {
        WindowGroup("conch") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 640, minHeight: 400)
                .preferredColorScheme(.dark)
                .background(WindowBackgroundConfigurator())
        }
        .defaultSize(width: 1_040, height: 720)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

/// Paints the host NSWindow's background dark so it never flashes white for a
/// frame before SwiftUI's dark content draws on cold launch.
private struct WindowBackgroundConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in
            guard let window = view?.window else { return }
            window.backgroundColor = NSColor(ConchPalette.bg)
            window.isOpaque = true
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}
