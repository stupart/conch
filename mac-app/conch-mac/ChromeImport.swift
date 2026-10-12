import ConchDesign
import Foundation
import Security
import WebKit

/// Chrome's sign-ins, copied into conch's browser in one go (Settings › Browser, 2026-10-11). Tyler chose "Everything,
/// once": each Chrome profile's cookies go into a conch browser profile of its own, after he allows macOS's Keychain prompt
/// for "Chrome Safe Storage". Reading and decrypting is ConchDesign's (`ChromeCookies`, tested on fixtures); this is the
/// Keychain, the daemon's profiles, and WebKit's cookie stores.
///
/// Cookie values are secrets. They go from Chrome's database into a `WKWebsiteDataStore`'s cookie store and nowhere else:
/// never logged, never written anywhere else, never sent to the daemon. What is kept and shown is counts.
enum ChromeImport {
    /// A conch browser profile, as the daemon keeps them (`browser-profiles`).
    struct Profile: Decodable, Equatable, Identifiable, Sendable {
        let id: String
        let name: String

        /// conch's own profile, `WKWebsiteDataStore.default()`, where Chrome's `Default` goes.
        static let defaultId = "default"
        static let builtIn = Profile(id: defaultId, name: "Default")
        var isDefault: Bool { id == Self.defaultId }
    }

    /// The daemon's answer to a `browser-profiles` request.
    enum ProfilesReply: Equatable {
        case profiles([Profile], created: Profile?)
        /// `browser-error`, in the daemon's words.
        case refused(String)
        /// A daemon from before `browser-profiles`: it answers with some other kind.
        case needsUpdate
        case unreachable
    }

    /// `{ kind: "browser-profiles", action: "list" | "add", name? }`. `add` is idempotent by name.
    static func profiles(_ action: String, name: String? = nil) async -> ProfilesReply {
        struct Request: Encodable {
            let kind = "browser-profiles"
            let action: String
            let name: String?
        }
        struct Reply: Decodable {
            let kind: String?
            let profiles: [Profile]?
            let created: Profile?
            let error: String?
        }
        switch await ConchSocketClient().request(Request(action: action, name: name), timeout: 10) {
        case .connectFailed, .timeout:
            return .unreachable
        case let .reply(data):
            guard let reply = try? JSONDecoder().decode(Reply.self, from: data) else { return .needsUpdate }
            switch reply.kind {
            case "browser-profiles":
                guard let profiles = reply.profiles else { return .refused("conch's browser profiles came back unreadable.") }
                return .profiles(profiles, created: reply.created)
            case "browser-error":
                return .refused(reply.error ?? "The daemon couldn't do that.")
            default:
                return .needsUpdate
            }
        }
    }

    /// A conch profile's website data: Default's is WebKit's default store, every other one's the persistent store named
    /// by its id. Nil for an id that isn't a UUID, which WebKit can't name a store by.
    @MainActor
    static func dataStore(for profileId: String) -> WKWebsiteDataStore? {
        if profileId == Profile.defaultId { return .default() }
        guard let identifier = UUID(uuidString: profileId) else { return nil }
        return WKWebsiteDataStore(forIdentifier: identifier)
    }

    /// One Chrome profile's import, counted. No values.
    struct Report: Identifiable, Equatable, Sendable {
        let chrome: ChromeProfile
        /// The conch profile it went into, by name; nil when it didn't get as far as one.
        var conchProfile: String?
        var imported = 0
        /// Expired, kept for one site only, or not a cookie Foundation will make.
        var skipped = 0
        /// Values that wouldn't decrypt.
        var failed = 0
        /// Why nothing of it was imported.
        var problem: String?

        var id: String { chrome.directory }
    }
}

/// Chrome Safe Storage's password, from the login Keychain: the generic password Chrome keeps under service "Chrome Safe
/// Storage", account "Chrome". Reading it is what makes macOS ask whether conch may.
enum ChromeSafeStorage {
    enum Failure: Error, Equatable {
        /// The prompt was answered Deny, or closed.
        case denied
        /// No such item: Chrome has never run as this user.
        case missing
        case failed(OSStatus)
    }

    /// The password, asked for on a queue of its own: `password()` blocks for as long as macOS's prompt is up.
    static func ask() async -> Result<Data, Failure> {
        await withCheckedContinuation { answer in
            DispatchQueue.global(qos: .userInitiated).async { answer.resume(returning: password()) }
        }
    }

    /// Blocks while macOS asks, so never on the main thread, nor on Swift's own threads (`ask()`).
    static func password() -> Result<Data, Failure> {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Chrome Safe Storage",
            kSecAttrAccount as String: "Chrome",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, !data.isEmpty else { return .failure(.missing) }
            return .success(data)
        case errSecItemNotFound:
            return .failure(.missing)
        case errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed, errSecNoAccessForItem:
            return .failure(.denied)
        default:
            return .failure(.failed(status))
        }
    }
}

/// Settings › Browser's state: conch's profiles, and the Chrome import's progress and counts.
@MainActor
final class ChromeImportStore: ObservableObject {
    static let shared = ChromeImportStore()

    enum ProfilesState: Equatable {
        case loading
        case loaded([ChromeImport.Profile])
        case needsUpdate
        case unreachable
        case failed(String)
    }

    enum ImportState: Equatable {
        case idle
        case noChrome
        case noProfiles
        case askingKeychain
        case importing(profile: String, index: Int, total: Int, cookiesDone: Int, cookies: Int)
        case denied
        case keyMissing
        case failed(String)
        case finished
    }

    @Published private(set) var profiles: ProfilesState = .loading
    @Published private(set) var importState: ImportState = .idle
    @Published private(set) var reports: [ChromeImport.Report] = []
    /// Chrome's profiles as last looked at: what an import would copy. Names only; nil until looked.
    @Published private(set) var chromeProfiles: [ChromeProfile]?
    /// Whether this user has a Chrome folder at all.
    @Published private(set) var chromeInstalled = true
    /// Cookies the last import put in each conch profile, by profile id. Counts only, kept so the list can say so later.
    @Published private(set) var importedCounts: [String: Int]

    static let countsKey = "conch.browser.chromeImportCounts"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        importedCounts = defaults.dictionary(forKey: Self.countsKey) as? [String: Int] ?? [:]
    }

    var isImporting: Bool {
        switch importState {
        case .askingKeychain, .importing: true
        default: false
        }
    }

    /// conch's profiles from the daemon, and which Chrome profiles there are. Neither touches the Keychain or a cookie.
    func refresh() async {
        await lookInChrome()
        await listProfiles()
    }

    @discardableResult
    private func lookInChrome() async -> [ChromeProfile] {
        let folder = ChromeCookies.chromeFolder
        let (installed, found) = await Task.detached(priority: .userInitiated) {
            (FileManager.default.fileExists(atPath: folder.path), ChromeCookies.profiles(in: folder))
        }.value
        chromeInstalled = installed
        chromeProfiles = found
        return found
    }

    private func listProfiles() async {
        if case .loaded = profiles {} else { profiles = .loading }
        switch await ChromeImport.profiles("list") {
        case let .profiles(list, _):
            // Default is conch's own and always there, whether or not the daemon lists it.
            profiles = .loaded(list.contains(where: \.isDefault) ? list : [ChromeImport.Profile.builtIn] + list)
        case .needsUpdate: profiles = .needsUpdate
        case .unreachable: profiles = .unreachable
        case let .refused(error): profiles = .failed(error)
        }
    }

    /// The button: every Chrome profile's cookies into its conch profile. Chrome's Default goes into conch's Default; each
    /// other one into a conch profile named after it, made if it isn't there.
    func importFromChrome() async {
        guard !isImporting else { return }
        reports = []
        let found = await lookInChrome()
        guard chromeInstalled else { importState = .noChrome; return }
        guard !found.isEmpty else { importState = .noProfiles; return }

        // Somewhere to put them before the Keychain is asked: every profile but Default needs the daemon's.
        var daemonProblem: String?
        if found.contains(where: { !$0.isDefault }) {
            switch await ChromeImport.profiles("list") {
            case .profiles: break
            case .needsUpdate: daemonProblem = Self.needsUpdate
            case .unreachable: daemonProblem = Self.unreachable
            case let .refused(error): daemonProblem = error
            }
        }
        if let daemonProblem, !found.contains(where: \.isDefault) {
            importState = .failed(daemonProblem)
            return
        }

        importState = .askingKeychain
        let password: Data
        switch await ChromeSafeStorage.ask() {
        case let .success(secret): password = secret
        case .failure(.denied): importState = .denied; return
        case .failure(.missing): importState = .keyMissing; return
        case let .failure(.failed(status)): importState = .failed("The Keychain wouldn't give conch Chrome's key (error \(status))."); return
        }

        let names = ChromeCookies.conchProfileNames(for: found)
        for (index, chrome) in found.enumerated() {
            importState = .importing(profile: chrome.name, index: index, total: found.count, cookiesDone: 0, cookies: 0)
            let report = await importProfile(chrome, as: names[chrome.directory], index: index, of: found.count,
                                             password: password, daemonProblem: daemonProblem)
            reports.append(report)
        }
        importState = .finished
        defaults.set(importedCounts, forKey: Self.countsKey)
        await listProfiles()
    }

    static let needsUpdate = "Needs an updated conch daemon"
    static let unreachable = "conch's daemon isn't running. Turn it on in General, then try again."

    private func importProfile(_ chrome: ChromeProfile, as conchName: String?, index: Int, of total: Int,
                               password: Data, daemonProblem: String?) async -> ChromeImport.Report {
        var report = ChromeImport.Report(chrome: chrome)

        // Where it goes.
        let target: ChromeImport.Profile
        if chrome.isDefault {
            target = ChromeImport.Profile.builtIn
        } else {
            if let daemonProblem { report.problem = daemonProblem; return report }
            let name = conchName ?? chrome.name
            switch await ChromeImport.profiles("add", name: name) {
            case let .profiles(list, created):
                guard let profile = created ?? list.first(where: { $0.name == name })
                    ?? list.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
                    report.problem = "The daemon didn't make a profile for it."
                    return report
                }
                target = profile
            case .needsUpdate: report.problem = Self.needsUpdate; return report
            case .unreachable: report.problem = Self.unreachable; return report
            case let .refused(error): report.problem = error; return report
            }
        }
        report.conchProfile = target.name
        guard let store = ChromeImport.dataStore(for: target.id) else {
            report.problem = "conch's profile has an id WebKit can't open."
            return report
        }

        // Read and decrypt off the main thread; a copy of the database, never the one Chrome has open.
        let folder = ChromeCookies.chromeFolder
        let read: ChromeCookieRead
        do {
            read = try await Task.detached(priority: .userInitiated) {
                try ChromeCookies.readCookies(profile: chrome.directory, in: folder, password: password)
            }.value
        } catch ChromeCookiesError.noCookies {
            return report
        } catch {
            report.problem = "Couldn't read its cookies. Quit Chrome and try again."
            return report
        }
        report.skipped = read.skipped
        report.failed = read.failed

        let cookies = read.cookies.compactMap(ChromeCookies.httpCookie)
        report.skipped += read.cookies.count - cookies.count
        let cookieStore = store.httpCookieStore
        // In batches, each one's cookies set together, so thousands don't take a round trip to WebKit's network process each.
        var done = 0
        for start in stride(from: 0, to: cookies.count, by: 100) {
            let batch = Array(cookies[start..<min(start + 100, cookies.count)])
            await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
                var remaining = batch.count
                for cookie in batch {
                    cookieStore.setCookie(cookie) {
                        remaining -= 1
                        if remaining == 0 { finished.resume() }
                    }
                }
            }
            done += batch.count
            importState = .importing(profile: chrome.name, index: index, total: total, cookiesDone: done, cookies: cookies.count)
        }
        report.imported = done
        importedCounts[target.id] = done
        return report
    }
}
