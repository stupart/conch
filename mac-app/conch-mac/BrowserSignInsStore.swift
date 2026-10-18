import ConchDesign
import Foundation
import WebKit

/// Which sites each of conch's browser profiles is signed in to (`BrowserSignIns`), read again whenever a profile's
/// cookies change, and signing out of one. Settings › Browser lists them; the daemon's logins inventory reads the report
/// this writes (`browser-sign-ins.json` in conch's config folder).
///
/// Only cookies' names, domains and expiry are looked at. A value is never read, kept, logged or written: the report is
/// site names and times.
@MainActor
final class BrowserSignInsStore: NSObject, ObservableObject, WKHTTPCookieStoreObserver {
    static let shared = BrowserSignInsStore()

    /// Each profile's sites, by profile id; a profile not read yet isn't here.
    @Published private(set) var sites: [String: [BrowserSignIns.Site]] = [:]
    /// Sites being signed out of, as `key(profile:site:)`.
    @Published private(set) var signingOut: Set<String> = []

    /// A busy page sets cookies all the time: a profile is read again once they have been still this long.
    private static let settle: UInt64 = 2_000_000_000
    /// …or this long after they started changing, however busy the page. A page that never stops (a YouTube player in
    /// the review pane sets cookies every few seconds) put every read off for two days, sign-ins included (2026-10-18).
    private static let longestWait: TimeInterval = 10
    /// And once in a while regardless, so a change WebKit didn't report is caught up with.
    private static let everyWhile: UInt64 = 10 * 60 * 1_000_000_000
    /// The report is written when what it says changes, and at least this often while a profile's cookies do.
    private static let rewriteAfter: TimeInterval = 5 * 60

    private var stores: [String: WKWebsiteDataStore] = [:]
    private var cookieStores: [String: WKHTTPCookieStore] = [:]
    private var reads: [String: Task<Void, Never>] = [:]
    /// When each profile's cookies started changing, while a read waits for them to settle.
    private var waitingSince: [String: Date] = [:]
    private var sweep: Task<Void, Never>?
    private var checkedAt: [String: Date] = [:]
    private var written: (report: BrowserSignIns.Report, at: Date)?
    private let reportURL: URL

    override init() {
        let environment = ProcessInfo.processInfo.environment
        let config = environment["CONCH_CONFIG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/conch", isDirectory: true)
        reportURL = config.appendingPathComponent(BrowserSignIns.reportFileName)
        super.init()
    }

    static func key(profile: String, site: String) -> String { "\(profile)\n\(site)" }

    /// Keeps a profile's sites, from now on: read now, and again as its cookies change. Default is watched from launch;
    /// another profile from when a tab opens on it or Settings › Browser lists it.
    func watch(_ profile: String) {
        guard stores[profile] == nil, let store = ChromeImport.dataStore(for: profile) else { return }
        stores[profile] = store
        let cookies = store.httpCookieStore
        cookieStores[profile] = cookies
        cookies.add(self)
        read(profile, after: 0)
        sweep = sweep ?? Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.everyWhile)
                guard let self else { return }
                for profile in self.cookieStores.keys where self.reads[profile] == nil { self.read(profile, after: 0) }
            }
        }
    }

    /// The daemon's whole list of profiles: each is watched, and one that is gone is dropped from the list and the
    /// report.
    func keep(only profiles: [String]) {
        for profile in profiles { watch(profile) }
        for profile in stores.keys where !profiles.contains(profile) {
            cookieStores[profile]?.remove(self)
            reads[profile]?.cancel()
            stores[profile] = nil
            cookieStores[profile] = nil
            reads[profile] = nil
            waitingSince[profile] = nil
            checkedAt[profile] = nil
            sites[profile] = nil
        }
        writeReport()
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        let changed = ObjectIdentifier(cookieStore)
        Task { @MainActor in
            for (profile, cookies) in self.cookieStores where ObjectIdentifier(cookies) == changed {
                self.read(profile, after: Self.settle)
            }
        }
    }

    private func read(_ profile: String, after delay: UInt64) {
        let now = Date()
        // Waited long enough: the read already set stands, rather than being put off again.
        if let since = waitingSince[profile], now.timeIntervalSince(since) >= Self.longestWait, reads[profile] != nil { return }
        if waitingSince[profile] == nil { waitingSince[profile] = now }
        reads[profile]?.cancel()
        reads[profile] = Task { @MainActor [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            guard let self, !Task.isCancelled, let cookies = self.cookieStores[profile] else { return }
            self.waitingSince[profile] = nil
            self.reads[profile] = nil
            let found = await cookies.allCookies()
            guard !Task.isCancelled, self.cookieStores[profile] != nil else { return }
            let named = found.map { BrowserSignIns.Cookie(name: $0.name, domain: $0.domain, expires: $0.expiresDate) }
            let now = Date()
            let signedIn = BrowserSignIns.sites(from: named, now: now)
            if self.sites[profile] != signedIn { self.sites[profile] = signedIn }
            self.checkedAt[profile] = now
            self.writeReport()
        }
    }

    /// Signs out of a site in one profile: everything WebKit keeps for it there (cookies, storage, caches) is removed,
    /// as Safari's "Remove" in Manage Website Data does. Its tabs stay open and sign in again like any page.
    func signOut(of site: String, in profile: String) async {
        guard let store = stores[profile] ?? ChromeImport.dataStore(for: profile) else { return }
        let key = Self.key(profile: profile, site: site)
        guard signingOut.insert(key).inserted else { return }
        defer { signingOut.remove(key) }
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let records = await store.dataRecords(ofTypes: types)
        await store.removeData(ofTypes: types, for: records.filter { BrowserSignIns.record($0.displayName, belongsTo: site) })
        // A cookie WebKit filed under another record (one set for the site from another of its hosts) goes by its domain.
        let cookies = store.httpCookieStore
        for cookie in await cookies.allCookies() where BrowserSignIns.site(ofCookieDomain: cookie.domain) == site {
            await cookies.deleteCookie(cookie)
        }
        if cookieStores[profile] != nil { read(profile, after: 0) }
    }

    /// The report for the daemon: written when it changes, or when the last one is five minutes old. Owner-only, as
    /// conch's other settings are.
    private func writeReport() {
        var report = BrowserSignIns.Report()
        for (profile, found) in sites {
            let at = (checkedAt[profile] ?? Date()).timeIntervalSince1970 * 1000
            report.profiles[profile] = .init(sites: found, checkedAt: at.rounded())
        }
        let now = Date()
        if let written, sameSites(written.report, report), now.timeIntervalSince(written.at) < Self.rewriteAfter { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(report) else { return }
        do {
            try FileManager.default.createDirectory(at: reportURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: reportURL, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: reportURL.path)
            written = (report, now)
        } catch {
            // Settings › Browser still has the list; the inventory says it doesn't know, as before.
        }
    }

    private func sameSites(_ a: BrowserSignIns.Report, _ b: BrowserSignIns.Report) -> Bool {
        a.profiles.mapValues(\.sites) == b.profiles.mapValues(\.sites)
    }
}
