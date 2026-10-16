import Foundation

/// The user agent conch's web views give (2026-10-17): Safari's, at the version of the Safari on this Mac. Google's
/// sign-in turns away browsers it takes for embedded ones, so conch's say Safari, whose engine they are; the version had
/// been a fixed 18.0 while the Mac ran Safari 26, which some sites take for an outdated browser.
public enum SafariUserAgent {
    /// Safari 18's, said when this Mac's Safari can't be read.
    public static let fallbackVersion = "18.0"

    /// The agent for a Safari version as its bundle gives it (`26.6.2`): Safari says its major and minor.
    public static func string(safariVersion: String?) -> String {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(version(safariVersion)) Safari/605.1.15"
    }

    static func version(_ bundleVersion: String?) -> String {
        let parts = (bundleVersion ?? "").split(separator: ".").map(String.init)
        guard let major = parts.first, !major.isEmpty, major.allSatisfy(\.isNumber), major.count <= 3 else { return fallbackVersion }
        let minor = parts.count > 1 && !parts[1].isEmpty && parts[1].allSatisfy(\.isNumber) && parts[1].count <= 3 ? parts[1] : "0"
        return "\(major).\(minor)"
    }

    /// The installed Safari's version, read once.
    public static let current: String = string(
        safariVersion: Bundle(url: URL(fileURLWithPath: "/Applications/Safari.app"))?.infoDictionary?["CFBundleShortVersionString"] as? String
    )
}
