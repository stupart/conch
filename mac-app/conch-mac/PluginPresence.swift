import Foundation

/// Whether conch's editor plugin is installed.
///
/// The app and the plugin are two halves of the same product and neither
/// installs the other: `brew install conch` brings the daemon, the CLI and this
/// app, while the plugin is what gives a Claude Code or Codex session the conch
/// tools and skill. Someone who only ever ran the brew install has no idea the
/// other half exists, so the app says so once and then never again.
enum PluginPresence {
    /// Marketplace installs land under `plugins/cache/<marketplace>/conch/<version>/`,
    /// and a local `conch install-plugin` writes into `plugins/conch`. Either
    /// counts; we only need to know whether to nudge, not which route was used.
    static func isInstalled(home: URL = URL(fileURLWithPath: NSHomeDirectory())) -> Bool {
        claudePluginInstalled(home: home) || codexPluginInstalled(home: home)
    }

    private static func claudePluginInstalled(home: URL) -> Bool {
        let plugins = home.appendingPathComponent(".claude/plugins")
        if containsConchDirectory(plugins.appendingPathComponent("cache")) { return true }
        if FileManager.default.fileExists(atPath: plugins.appendingPathComponent("conch").path) {
            return true
        }
        // A settings file can enable a plugin that lives elsewhere entirely.
        let settings = home.appendingPathComponent(".claude/settings.json")
        if let data = try? Data(contentsOf: settings),
           let text = String(data: data, encoding: .utf8) {
            return text.contains("conch@")
        }
        return false
    }

    private static func codexPluginInstalled(home: URL) -> Bool {
        containsConchDirectory(home.appendingPathComponent(".codex/plugins"))
    }

    /// A `conch` directory anywhere in the first two levels below `root`.
    /// Marketplace names are unknown to us, so we look one level wide.
    private static func containsConchDirectory(_ root: URL) -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: root.appendingPathComponent("conch").path) { return true }
        guard let entries = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return false }
        return entries.contains { fm.fileExists(atPath: $0.appendingPathComponent("conch").path) }
    }
}
