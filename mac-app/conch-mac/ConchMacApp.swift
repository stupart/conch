import SwiftUI

@main
struct ConchMacApp: App {
    @StateObject private var store = StateStore()

    var body: some Scene {
        WindowGroup("conch") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 640, minHeight: 400)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1_040, height: 720)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
