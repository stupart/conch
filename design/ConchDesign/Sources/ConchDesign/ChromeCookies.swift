import CommonCrypto
import Foundation
import SQLite3

/// Chrome's sign-ins, read so conch's own browser can have them (2026-10-11). Tyler chose "Everything, once": every Chrome
/// profile's cookies, copied in one go into a conch browser profile each, after he allows macOS's Keychain prompt for
/// "Chrome Safe Storage".
///
/// This file is the part that can be tested without Chrome or the Keychain: finding Chrome's profiles in a folder, reading
/// and decrypting one profile's cookies given the Safe Storage password, and turning a cookie into `HTTPCookie`'s
/// properties. The password is always a parameter; the Mac app reads it from the Keychain (`ChromeImport.swift`), and only
/// when Settings › Browser's button is pressed.
///
/// A cookie's value is a secret: nothing here logs one, and a `ChromeCookie` prints with its value withheld.
///
/// How Chrome keeps them on macOS, as Chromium's source has it (components/os_crypt/async/browser/keychain_key_provider.mm,
/// components/os_crypt/async/common/encryptor.cc, net/extras/sqlite/sqlite_persistent_cookie_store.cc):
/// - profiles are folders of `~/Library/Application Support/Google/Chrome` (`Default`, `Profile 1`, …), named in
///   `Local State` at `profile.info_cache.<folder>.name`;
/// - cookies are the SQLite table `cookies` in `<profile>/Cookies` (or `<profile>/Network/Cookies`);
/// - a value is `v10` and then AES-128-CBC, PKCS7, a 16-byte IV of spaces, under PBKDF2-HMAC-SHA1(password, "saltysalt",
///   1003 rounds, 16 bytes); one that fails under that key is tried under the empty password's key, as Chrome does;
/// - from the database's version 24, what is encrypted starts with the SHA-256 of the cookie's `host_key`;
/// - `expires_utc` is microseconds since 1601-01-01, and `samesite` is -1 unspecified, 0 none, 1 lax, 2 strict.
public enum ChromeCookies {
    /// Chrome's first profile's folder, the one every Chrome has.
    public static let defaultProfileDirectory = "Default"

    /// Where Chrome keeps its profiles for this user.
    public static var chromeFolder: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
        return support.appendingPathComponent("Google/Chrome", isDirectory: true)
    }

    // MARK: Profiles

    /// Chrome's profiles in `chromeFolder` that have cookies to read: `Default` first, then `Profile 1`, `Profile 2`… in
    /// number order. Their names are the ones Chrome shows (`Local State`); without that file, every `Default` or
    /// `Profile N` folder that has cookies, named by its folder. Empty when Chrome isn't there, or has nothing to read.
    public static func profiles(in chromeFolder: URL) -> [ChromeProfile] {
        var found: [ChromeProfile] = []
        if let cache = infoCache(in: chromeFolder) {
            for (directory, entry) in cache where isProfileDirectoryName(directory) {
                guard cookieDatabase(profile: directory, in: chromeFolder) != nil else { continue }
                let name = ((entry as? [String: Any])?["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                found.append(ChromeProfile(directory: directory, name: name.flatMap { $0.isEmpty ? nil : $0 } ?? directory))
            }
        } else if let names = try? FileManager.default.contentsOfDirectory(atPath: chromeFolder.path) {
            for directory in names where directory == defaultProfileDirectory || directory.hasPrefix("Profile ") {
                guard isProfileDirectoryName(directory), cookieDatabase(profile: directory, in: chromeFolder) != nil else { continue }
                found.append(ChromeProfile(directory: directory, name: directory))
            }
        }
        return found.sorted { a, b in
            if a.isDefault != b.isDefault { return a.isDefault }
            return a.directory.localizedStandardCompare(b.directory) == .orderedAscending
        }
    }

    /// `Local State`'s `profile.info_cache`, or nil when the file is missing or isn't Chrome's JSON.
    private static func infoCache(in chromeFolder: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: chromeFolder.appendingPathComponent("Local State")),
              let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profile = state["profile"] as? [String: Any] else { return nil }
        return profile["info_cache"] as? [String: Any]
    }

    /// A profile's folder is one name inside Chrome's folder, never a path out of it.
    private static func isProfileDirectoryName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.contains("/") && !name.contains("\0")
    }

    /// A profile's cookie database: `<profile>/Network/Cookies` where newer Chrome keeps it, or `<profile>/Cookies`. With
    /// both there, the one written last.
    public static func cookieDatabase(profile directory: String, in chromeFolder: URL) -> URL? {
        guard isProfileDirectoryName(directory) else { return nil }
        let folder = chromeFolder.appendingPathComponent(directory, isDirectory: true)
        let candidates = [
            folder.appendingPathComponent("Network", isDirectory: true).appendingPathComponent("Cookies"),
            folder.appendingPathComponent("Cookies"),
        ]
        let existing: [(url: URL, modified: Date)] = candidates.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey]),
                  values.isRegularFile == true else { return nil }
            return (url, values.contentModificationDate ?? .distantPast)
        }
        // Stable on a tie: the first candidate, Network/Cookies, wins.
        return existing.max { $0.modified < $1.modified }?.url
    }

    /// The longest name the daemon keeps for a conch browser profile, in Unicode scalars (src/browser-profiles.ts).
    public static let conchProfileNameLimit = 60

    /// The conch profile each Chrome profile but `Default` goes into, by name (`browser-profiles add` is idempotent by
    /// name, ignoring case): its Chrome name, or that with its folder after it where two Chrome profiles share a name, or
    /// where it would be taken for conch's own Default. On one printable line, and cut to the daemon's 60. Keyed by Chrome
    /// folder.
    public static func conchProfileNames(for profiles: [ChromeProfile]) -> [String: String] {
        let others = profiles.filter { !$0.isDefault }.map { profile -> (directory: String, base: String) in
            let base = printable(profile.name)
            return (profile.directory, base.isEmpty ? profile.directory : base)
        }
        var counts: [String: Int] = [:]
        for profile in others { counts[fitted(profile.base).lowercased(), default: 0] += 1 }
        var names: [String: String] = [:]
        for profile in others {
            let key = fitted(profile.base).lowercased()
            let clashes = counts[key, default: 0] > 1 || key == defaultProfileDirectory.lowercased()
            names[profile.directory] = clashes ? fitted(profile.base, suffix: " (\(profile.directory))") : fitted(profile.base)
        }
        return names
    }

    /// One line, no control characters: each one a space, then trimmed.
    private static func printable(_ name: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in name.unicodeScalars {
            let unprintable = scalar.properties.generalCategory == .control || scalar == "\u{2028}" || scalar == "\u{2029}"
            scalars.append(unprintable ? " " : scalar)
        }
        return String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `base`, cut so that it and `suffix` fit the daemon's limit.
    private static func fitted(_ base: String, suffix: String = "") -> String {
        let room = max(1, conchProfileNameLimit - suffix.unicodeScalars.count)
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: base.unicodeScalars.prefix(room))
        return String(scalars).trimmingCharacters(in: .whitespaces) + suffix
    }

    // MARK: Reading

    /// One profile's cookies, decrypted with `password` (Chrome Safe Storage's, from the Keychain).
    ///
    /// Chrome keeps its database locked while it runs, so this reads a copy: the database and its `-wal` and `-journal`
    /// beside it, into a folder of its own under `scratch` that only this user can open, deleted before this returns. The
    /// original is never opened.
    ///
    /// Left out and counted: a value that won't decrypt (`failed`); a cookie that has expired, or one partitioned to a
    /// single top-level site, which WebKit's cookie store can't keep the way Chrome does (`skipped`).
    public static func readCookies(
        profile directory: String,
        in chromeFolder: URL,
        password: Data,
        now: Date = Date(),
        scratch: URL = FileManager.default.temporaryDirectory
    ) throws -> ChromeCookieRead {
        guard let source = cookieDatabase(profile: directory, in: chromeFolder) else {
            throw ChromeCookiesError.noCookies(profile: directory)
        }
        let files = FileManager.default
        let folder = try privateFolder(in: scratch)
        defer { try? files.removeItem(at: folder) }

        let copy = folder.appendingPathComponent("Cookies")
        do {
            try files.copyItem(at: source, to: copy)
            // What Chrome hasn't written into the database yet; SQLite reads it from beside the copy.
            for suffix in ["-wal", "-journal"] {
                let side = URL(fileURLWithPath: source.path + suffix)
                guard files.fileExists(atPath: side.path) else { continue }
                try files.copyItem(at: side, to: URL(fileURLWithPath: copy.path + suffix))
            }
        } catch {
            throw ChromeCookiesError.unreadable("couldn't copy Chrome's cookies")
        }
        return try read(database: copy, password: password, now: now)
    }

    /// A new folder under `scratch` that only this user can open, for one read's copy.
    static func privateFolder(in scratch: URL) throws -> URL {
        let folder = scratch.appendingPathComponent("conch-chrome-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            throw ChromeCookiesError.unreadable("couldn't make a private folder to copy Chrome's cookies into")
        }
        return folder
    }

    /// The copy, read. Read-write only so SQLite can finish or undo what the `-wal` or `-journal` copied with it holds.
    private static func read(database: URL, password: Data, now: Date) throws -> ChromeCookieRead {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(database.path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db = handle else {
            sqlite3_close(handle)
            throw ChromeCookiesError.unreadable("couldn't open Chrome's cookies")
        }
        defer { sqlite3_close(db) }

        let version = try queryInt(db, "SELECT value FROM meta WHERE key = 'version'") ?? 0
        let columns = try tableColumns(db, "cookies")
        let required = ["host_key", "name", "value", "encrypted_value", "path", "expires_utc", "is_secure", "is_httponly"]
        guard required.allSatisfy(columns.contains) else { throw ChromeCookiesError.unknownLayout }
        // Older databases lack some: unspecified SameSite, persistence from `has_expires`, no partitions.
        let sameSite = columns.contains("samesite") ? "samesite" : "-1"
        let persistent = columns.contains("is_persistent") ? "is_persistent" : columns.contains("has_expires") ? "has_expires" : "1"
        let partition = columns.contains("top_frame_site_key") ? "top_frame_site_key" : "''"
        let sql = """
            SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, \
            \(sameSite), \(persistent), \(partition) FROM cookies
            """

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let rows = statement else {
            sqlite3_finalize(statement)
            throw ChromeCookiesError.unreadable(errorMessage(db))
        }
        defer { sqlite3_finalize(rows) }

        let key = deriveKey(password: password)
        let hashPrefixed = version >= 24
        var result = ChromeCookieRead()
        while true {
            let step = sqlite3_step(rows)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw ChromeCookiesError.unreadable(errorMessage(db)) }

            if !text(rows, 10).isEmpty { result.skipped += 1; continue }
            let hostKey = text(rows, 0)
            let isPersistent = sqlite3_column_int64(rows, 9) != 0
            let expires = isPersistent ? date(chromeTime: sqlite3_column_int64(rows, 5)) : nil
            if let expires, expires <= now { result.skipped += 1; continue }

            let encrypted = blob(rows, 3)
            let value: String
            if encrypted.isEmpty {
                value = text(rows, 2)
            } else if let decrypted = decrypt(encrypted, key: key, hostKey: hostKey, hashPrefixed: hashPrefixed) {
                value = decrypted
            } else {
                result.failed += 1
                continue
            }
            result.cookies.append(ChromeCookie(
                hostKey: hostKey,
                name: text(rows, 1),
                value: value,
                path: text(rows, 4),
                expires: expires,
                isSecure: sqlite3_column_int64(rows, 6) != 0,
                isHTTPOnly: sqlite3_column_int64(rows, 7) != 0,
                sameSite: ChromeSameSite(rawValue: Int(sqlite3_column_int64(rows, 8))) ?? .unspecified
            ))
        }
        return result
    }

    private static func queryInt(_ db: OpaquePointer, _ sql: String) throws -> Int64? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let row = statement else {
            sqlite3_finalize(statement)
            throw ChromeCookiesError.unreadable(errorMessage(db))
        }
        defer { sqlite3_finalize(row) }
        return sqlite3_step(row) == SQLITE_ROW ? sqlite3_column_int64(row, 0) : nil
    }

    private static func tableColumns(_ db: OpaquePointer, _ table: String) throws -> Set<String> {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &statement, nil) == SQLITE_OK, let rows = statement else {
            sqlite3_finalize(statement)
            throw ChromeCookiesError.unreadable(errorMessage(db))
        }
        defer { sqlite3_finalize(rows) }
        var names: Set<String> = []
        while sqlite3_step(rows) == SQLITE_ROW { names.insert(text(rows, 1)) }
        return names
    }

    /// SQLite's own words for what went wrong: about the file, never a row's contents.
    private static func errorMessage(_ db: OpaquePointer) -> String {
        sqlite3_errmsg(db).map { String(cString: $0) } ?? "couldn't read Chrome's cookies"
    }

    private static func text(_ row: OpaquePointer, _ column: Int32) -> String {
        guard let bytes = sqlite3_column_text(row, column) else { return "" }
        let count = Int(sqlite3_column_bytes(row, column))
        return String(decoding: UnsafeBufferPointer(start: bytes, count: count), as: UTF8.self)
    }

    private static func blob(_ row: OpaquePointer, _ column: Int32) -> Data {
        let count = Int(sqlite3_column_bytes(row, column))
        guard count > 0, let bytes = sqlite3_column_blob(row, column) else { return Data() }
        return Data(bytes: bytes, count: count)
    }

    // MARK: Decrypting

    private static let salt = Data("saltysalt".utf8)
    private static let iterations: UInt32 = 1003
    private static let keyLength = 16
    private static let versionTag = Data("v10".utf8)
    private static let hashLength = Int(CC_SHA256_DIGEST_LENGTH)

    /// PBKDF2-HMAC-SHA1(password, "saltysalt", `rounds`, 16 bytes): Chrome's key from its Safe Storage password.
    static func deriveKey(password: Data, rounds: UInt32 = iterations) -> Data {
        var key = Data(count: keyLength)
        let status = key.withUnsafeMutableBytes { out in
            password.withUnsafeBytes { secret in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        secret.baseAddress?.assumingMemoryBound(to: CChar.self), password.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), rounds,
                        out.baseAddress?.assumingMemoryBound(to: UInt8.self), keyLength
                    )
                }
            }
        }
        return status == kCCSuccess ? key : Data(count: keyLength)
    }

    /// The empty password's key, at one round, which Chrome falls back to when its own key doesn't decrypt a value
    /// (crbug.com/40055416).
    static let emptyPasswordKey = deriveKey(password: Data(), rounds: 1)

    /// One `encrypted_value`, decrypted: nil when it isn't `v10`, won't decrypt, doesn't start with its host's hash where
    /// the database says it should (`hashPrefixed`, version 24 on), or isn't text.
    ///
    /// Under `key` first, then the empty password's. Chrome falls back only when AES itself fails, on the padding, but a
    /// wrong key gets past a padding check often enough (CommonCrypto looks at less of it than one might hope) that this
    /// falls back on any failure: the hash and the text are the better test of the right key.
    static func decrypt(_ encrypted: Data, key: Data, hostKey: String, hashPrefixed: Bool) -> String? {
        guard encrypted.count > versionTag.count, encrypted.prefix(versionTag.count) == versionTag else { return nil }
        let body = Data(encrypted.dropFirst(versionTag.count))
        guard body.count % kCCBlockSizeAES128 == 0 else { return nil }
        for candidate in [key, emptyPasswordKey] {
            guard var plain = aes(CCOperation(kCCDecrypt), body, key: candidate) else { continue }
            if hashPrefixed {
                guard plain.count >= hashLength, plain.prefix(hashLength) == sha256(Data(hostKey.utf8)) else { continue }
                plain = Data(plain.dropFirst(hashLength))
            }
            if let text = String(data: plain, encoding: .utf8) { return text }
        }
        return nil
    }

    /// AES-128-CBC, PKCS7, Chrome's IV of sixteen spaces.
    static func aes(_ operation: CCOperation, _ input: Data, key: Data) -> Data? {
        let iv = Data(repeating: 0x20, count: kCCBlockSizeAES128)
        var output = Data(count: input.count + kCCBlockSizeAES128)
        let capacity = output.count
        var moved = 0
        let status = output.withUnsafeMutableBytes { out in
            input.withUnsafeBytes { inBytes in
                key.withUnsafeBytes { keyBytes in
                    iv.withUnsafeBytes { ivBytes in
                        CCCrypt(
                            operation, CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, key.count, ivBytes.baseAddress,
                            inBytes.baseAddress, input.count,
                            out.baseAddress, capacity, &moved
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else { return nil }
        return output.prefix(moved)
    }

    static func sha256(_ data: Data) -> Data {
        var digest = Data(count: hashLength)
        digest.withUnsafeMutableBytes { out in
            data.withUnsafeBytes { bytes in
                _ = CC_SHA256(bytes.baseAddress, CC_LONG(data.count), out.baseAddress?.assumingMemoryBound(to: UInt8.self))
            }
        }
        return digest
    }

    // MARK: Into WebKit

    /// Seconds from 1601-01-01, Chrome's (Windows') epoch, to 1970-01-01.
    static let epochOffset: TimeInterval = 11_644_473_600

    /// `expires_utc` as a date: nil for 0, a session cookie.
    public static func date(chromeTime: Int64) -> Date? {
        guard chromeTime > 0 else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(chromeTime) / 1_000_000 - epochOffset)
    }

    /// `HTTPCookie`'s properties for a Chrome cookie, for `WKHTTPCookieStore.setCookie`. `host_key` is the domain as Chrome
    /// keeps it: with a leading dot it is sent to every host under it, without one only to that host. SameSite carries
    /// over where it was said; unspecified, and none, are left to WebKit, which sends either cross-site.
    public static func properties(for cookie: ChromeCookie) -> [HTTPCookiePropertyKey: Any] {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: cookie.hostKey,
            .path: cookie.path.isEmpty ? "/" : cookie.path,
            .name: cookie.name,
            .value: cookie.value,
        ]
        if let expires = cookie.expires {
            properties[.expires] = expires
        } else {
            properties[.discard] = "TRUE"
        }
        if cookie.isSecure { properties[.secure] = "TRUE" }
        // HTTPCookie reads it back as `isHTTPOnly`, but Foundation names no key for it.
        if cookie.isHTTPOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        switch cookie.sameSite {
        case .lax: properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax.rawValue
        case .strict: properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict.rawValue
        case .none, .unspecified: break
        }
        return properties
    }

    /// The cookie for WebKit, or nil where Foundation won't make one of it (no name, say).
    public static func httpCookie(_ cookie: ChromeCookie) -> HTTPCookie? {
        HTTPCookie(properties: properties(for: cookie))
    }
}

/// A Chrome profile: its folder (`Default`, `Profile 1`) and the name Chrome shows for it.
public struct ChromeProfile: Equatable, Hashable, Identifiable, Sendable {
    public let directory: String
    public let name: String

    public init(directory: String, name: String) {
        self.directory = directory
        self.name = name
    }

    public var id: String { directory }
    /// Chrome's first profile, whose cookies go into conch's own Default.
    public var isDefault: Bool { directory == ChromeCookies.defaultProfileDirectory }
}

/// Chrome's `samesite` column.
public enum ChromeSameSite: Int, Sendable {
    case unspecified = -1, none = 0, lax = 1, strict = 2
}

/// One cookie, decrypted. Its value is a secret: it prints, dumps and mirrors withheld.
public struct ChromeCookie: Equatable, Sendable {
    /// Chrome's `host_key`: `.example.com` for the domain and every host under it, `example.com` for that host alone.
    public var hostKey: String
    public var name: String
    public var value: String
    public var path: String
    /// Nil for a session cookie.
    public var expires: Date?
    public var isSecure: Bool
    public var isHTTPOnly: Bool
    public var sameSite: ChromeSameSite

    public init(hostKey: String, name: String, value: String, path: String, expires: Date?,
                isSecure: Bool, isHTTPOnly: Bool, sameSite: ChromeSameSite) {
        self.hostKey = hostKey
        self.name = name
        self.value = value
        self.path = path
        self.expires = expires
        self.isSecure = isSecure
        self.isHTTPOnly = isHTTPOnly
        self.sameSite = sameSite
    }
}

extension ChromeCookie: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "ChromeCookie(\(hostKey) \(path) \(name), value withheld, \(expires.map { "expires \($0)" } ?? "session"))"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(self, children: ["hostKey": hostKey, "name": name, "path": path, "expires": expires as Any,
                                "isSecure": isSecure, "isHTTPOnly": isHTTPOnly, "sameSite": sameSite])
    }
}

/// A profile's cookies, and what was left out of them, counted.
public struct ChromeCookieRead: Equatable, Sendable {
    public var cookies: [ChromeCookie] = []
    /// Values that wouldn't decrypt.
    public var failed = 0
    /// Expired, or partitioned to one top-level site.
    public var skipped = 0

    public init(cookies: [ChromeCookie] = [], failed: Int = 0, skipped: Int = 0) {
        self.cookies = cookies
        self.failed = failed
        self.skipped = skipped
    }
}

public enum ChromeCookiesError: Error, Equatable, Sendable {
    /// The profile has no cookie database.
    case noCookies(profile: String)
    /// The copy couldn't be made or read; the words are about the file, never its contents.
    case unreadable(String)
    /// A `cookies` table without the columns every Chrome since 2013 has.
    case unknownLayout
}
