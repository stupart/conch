import AppKit
import ConchDesign
import SwiftUI
import WebKit

// Settings › Skills and Benchmarks, the Mac app's own views compiled from its sources, in an offscreen window against a
// sandboxed daemon, drawn to PNGs. scripts/shoot-skills-library.ts builds the sandbox, compiles this with the app's
// sources and runs it. Nothing is shown and nothing comes forward: the app is `.prohibited`, the window is parked
// 20,000 points off every screen and can't be clicked.
//
//   shoot-skills-library <out-dir> <scene>…    scene: <name>:<section>:<tab>:<width>x<height>:<light|dark>
//
// A section is any Settings section by its raw value (skills, benchmarks, logins, …); a tab, installed or discover
// (Skills only). A scene named `add-…` or `try-…` draws
// that sheet on its own, for the first skill Discover lists.

let arguments = CommandLine.arguments
let outDir = URL(fileURLWithPath: arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func say(_ line: String) { FileHandle.standardOutput.write(Data((line + "\n").utf8)) }

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

DispatchQueue.main.asyncAfter(deadline: .now() + 240) {
    FileHandle.standardError.write(Data("the harness ran out of time\n".utf8))
    exit(3)
}

@MainActor
func webViews(in view: NSView) -> [WKWebView] {
    if let web = view as? WKWebView { return [web] }
    return view.subviews.flatMap(webViews(in:))
}

/// The window as the window server would draw it: the view tree cached, and each web view's own snapshot laid over its
/// frame (WebKit draws out of process, so a cache of the tree leaves it blank).
@MainActor
func capture(_ window: NSWindow) async -> NSBitmapImageRep? {
    guard let frameView = window.contentView?.superview ?? window.contentView,
          let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) else { return nil }
    frameView.cacheDisplay(in: frameView.bounds, to: rep)
    for web in webViews(in: frameView) {
        guard let image = try? await web.takeSnapshot(configuration: nil) else { continue }
        let frame = web.convert(web.bounds, to: frameView)
        let y = frameView.isFlipped ? frameView.bounds.height - frame.maxY : frame.minY
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: frame.minX, y: y, width: frame.width, height: frame.height))
        NSGraphicsContext.restoreGraphicsState()
    }
    return rep
}

/// A window as conch's is, its title bar hidden over the content; a sheet's is borderless, the sheet alone.
@MainActor
func window(width: CGFloat, height: CGFloat, dark: Bool, content: some View, sheet: Bool = false) -> NSWindow {
    let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: width, height: height),
                          styleMask: sheet ? [.borderless] : [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
    window.ignoresMouseEvents = true
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    let host = NSHostingView(rootView: content.frame(width: width, height: sheet ? nil : height, alignment: .top))
    window.contentView = host
    // A sheet is as tall as it lays out; the page, the size asked for.
    let tall = sheet ? max(host.fittingSize.height, 120) : height
    window.setFrame(NSRect(x: -20_000, y: -20_000, width: width, height: tall), display: true)
    window.orderFrontRegardless()
    return window
}

@MainActor
func spin(_ seconds: Double) async {
    try? await Task.sleep(for: .seconds(seconds))
}

/// The first skill Discover lists, as the sheets are drawn for.
@MainActor
func firstDiscovered() async -> DiscoverSkillInfo? {
    guard case let .reply(data) = await ConchSocketClient().request(SkillsLibraryRequest.discover(index: "anthropic-skills"), timeout: 30),
          let page = try? JSONDecoder().decode(SkillsDiscoverPage.self, from: data) else { return nil }
    return page.entries.first { $0.installed != true } ?? page.entries.first
}

@MainActor
func accounts() async -> [LibraryAccountInfo] {
    guard case let .reply(data) = await ConchSocketClient().request(SkillsLibraryRequest.installed(), timeout: 30),
          let page = try? JSONDecoder().decode(SkillsInstalledPage.self, from: data) else { return [] }
    return page.accounts
}

Task { @MainActor in
    let defaults = UserDefaults(suiteName: "conch.skills-library.shot")!
    let stateStore = StateStore()
    for scene in arguments.dropFirst(2) {
        let parts = scene.split(separator: ":").map(String.init)
        guard parts.count == 5 else { say("skipping \(scene)"); continue }
        let (name, section, tab, size, appearance) = (parts[0], parts[1], parts[2], parts[3], parts[4])
        let dims = size.split(separator: "x").compactMap { Double($0) }
        let dark = appearance == "dark"
        UserDefaults.standard.set(tab, forKey: "conch.skills.tab")
        UserDefaults.standard.removeObject(forKey: PaneSplit.library.key)
        let root: AnyView
        var settle = 7.0
        if name.hasPrefix("add-") || name.hasPrefix("try-") {
            guard let entry = await firstDiscovered() else { say("\(name): Discover listed nothing"); continue }
            let store = SkillsLibraryStore()
            let list = await accounts()
            root = name.hasPrefix("add-")
                ? AnyView(SkillAddSheet(entry: entry, accounts: list, store: store) {}.environmentObject(stateStore))
                : AnyView(SkillTrySheet(target: .discovered(entry), accounts: list, store: store) {}.environmentObject(stateStore))
            settle = 5
        } else {
            let router = SettingsRouter(defaults: defaults)
            // Any section, by its raw value: Skills and Benchmarks, or another for a picture to hold them against.
            router.select(SettingsSection(rawValue: section) ?? .skills)
            root = AnyView(ConchSettingsPage(router: router).environmentObject(stateStore))
            if section == "benchmarks" { settle = 10 }
        }
        let shown = window(width: dims[0], height: dims[1], dark: dark, content: root, sheet: name.hasPrefix("add-") || name.hasPrefix("try-"))
        await spin(settle)
        guard let rep = await capture(shown), let png = rep.representation(using: .png, properties: [:]) else {
            say("\(name): nothing drawn")
            continue
        }
        let file = outDir.appendingPathComponent("\(name).png")
        try? png.write(to: file)
        say(file.path)
        shown.orderOut(nil)
    }
    exit(0)
}

app.run()
