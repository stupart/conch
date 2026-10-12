import CommonCrypto
import CryptoKit
import SQLite3
import XCTest
@testable import ConchDesign

/// Reading Chrome's sign-ins for conch's browser (ChromeCookies.swift), against fixture Chrome folders built here: cookie
/// databases in Chrome's schema, with values encrypted under a made-up Safe Storage password. Nothing here reads the real
/// Chrome folder or the Keychain.
///
/// The fixtures are encrypted by this file's own code (CryptoKit's SHA-256, CommonCrypto called directly), and the known
/// answers below were made with Python's hashlib and openssl, so the reader is checked against more than itself.
final class ChromeCookiesTests: XCTestCase {
    private var root: URL!
    private var chrome: URL { root.appendingPathComponent("Chrome", isDirectory: true) }
    private var scratch: URL { root.appendingPathComponent("scratch", isDirectory: true) }

    private static let password = Data("conch-fixture-password".utf8)
    private let now = Date(timeIntervalSince1970: 1_791_763_200) // 2026-10-12

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("chrome-cookies-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: chrome, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: Known answers

    /// hashlib.pbkdf2_hmac('sha1', b'conch-fixture-password', b'saltysalt', 1003, 16), and `openssl enc -aes-128-cbc` with
    /// an IV of sixteen 0x20 bytes over "fixture-session-id", bare and after sha256(b'.example.com').
    func testKnownAnswersMadeOutsideSwift() {
        let key = ChromeCookies.deriveKey(password: Self.password)
        XCTAssertEqual(hex(key), "d268d2362992a382de29689ef69dc7c8")
        // Chromium's own constant for the empty password's key (encryptor.cc, kEmptyKey).
        XCTAssertEqual(hex(ChromeCookies.emptyPasswordKey), "d0d0ec9c7d77d43ac54187fa4818d17f")

        let bare = data(hex: "763130089ef4ff9a70a4b398c6a7d880f0c315f4a74a75eb54dbfe4d333f39ccbc6e04")
        XCTAssertEqual(ChromeCookies.decrypt(bare, key: key, hostKey: ".example.com", hashPrefixed: false), "fixture-session-id")
        let hashed = data(hex: "763130822d973c0c03425625659cf43519944af40bd73891207d8b220e4ead013540d20c778673e2ecb7fda819ff6bef3a62649ec2b2e9e1780d303e85b7caab7ea5de")
        XCTAssertEqual(ChromeCookies.decrypt(hashed, key: key, hostKey: ".example.com", hashPrefixed: true), "fixture-session-id")
        XCTAssertNil(ChromeCookies.decrypt(hashed, key: key, hostKey: ".other.com", hashPrefixed: true), "another host's hash")
        XCTAssertNil(ChromeCookies.decrypt(bare, key: key, hostKey: ".example.com", hashPrefixed: true), "no hash where one is due")
    }

    // MARK: Decrypting

    func testVersion23ValuesAreTheValueAlone() throws {
        try makeDatabase(profile: "Default", version: 23, rows: [
            Row(host: ".example.com", name: "sid", encrypted: encrypt("v23-value", host: ".example.com", hashPrefixed: false)),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.value), ["v23-value"])
        XCTAssertEqual(read.failed, 0)
    }

    func testVersion24ValuesStartWithTheirHostsHash() throws {
        try makeDatabase(profile: "Default", version: 24, rows: [
            Row(host: ".example.com", name: "sid", encrypted: encrypt("v24-value", host: ".example.com", hashPrefixed: true)),
            Row(host: "app.example.com", name: "host-only", encrypted: encrypt("app-value", host: "app.example.com", hashPrefixed: true)),
            // Encrypted for another host: Chrome drops it (kHashFailed), and so does this.
            Row(host: ".victim.com", name: "moved", encrypted: encrypt("moved-value", host: ".example.com", hashPrefixed: true)),
            // No hash at all in a version-24 database.
            Row(host: ".example.com", name: "bare", encrypted: encrypt("bare-value", host: ".example.com", hashPrefixed: false)),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.name), ["sid", "host-only"])
        XCTAssertEqual(read.cookies.map(\.value), ["v24-value", "app-value"])
        XCTAssertEqual(read.failed, 2)
    }

    func testAnEmptyEncryptedValueIsTheValueColumn() throws {
        try makeDatabase(profile: "Default", rows: [
            Row(host: "plain.example.com", name: "plain", value: "in-the-clear"),
            Row(host: "plain.example.com", name: "empty", value: ""),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.value), ["in-the-clear", ""])
        XCTAssertEqual(read.failed, 0)
    }

    func testAValueEncryptedUnderTheEmptyPasswordIsReadAsChromeDoes() throws {
        try makeDatabase(profile: "Default", rows: [
            Row(host: ".example.com", name: "fallback",
                encrypted: encrypt("fallback-value", host: ".example.com", hashPrefixed: true, key: ChromeCookies.emptyPasswordKey)),
        ])
        XCTAssertEqual(try readDefault().cookies.map(\.value), ["fallback-value"])
    }

    func testCorruptValuesAreSkippedAndCounted() throws {
        var truncated = encrypt("cut-short", host: ".example.com", hashPrefixed: true)
        truncated.removeLast(5)
        var flipped = encrypt("flipped-value", host: ".example.com", hashPrefixed: true)
        flipped[flipped.count - 20] ^= 0xFF
        try makeDatabase(profile: "Default", rows: [
            Row(host: ".example.com", name: "good", encrypted: encrypt("good-value", host: ".example.com", hashPrefixed: true)),
            Row(host: ".example.com", name: "garbage", encrypted: Data("v10".utf8) + Data(repeating: 0xAB, count: 32)),
            Row(host: ".example.com", name: "truncated", encrypted: truncated),
            Row(host: ".example.com", name: "flipped", encrypted: flipped),
            Row(host: ".example.com", name: "linux", encrypted: Data("v11".utf8) + Data(repeating: 1, count: 16)),
            Row(host: ".example.com", name: "tag-only", encrypted: Data("v10".utf8)),
            Row(host: ".example.com", name: "wrong-password",
                encrypted: encrypt("other", host: ".example.com", hashPrefixed: true, key: ChromeCookies.deriveKey(password: Data("not-it".utf8)))),
            Row(host: ".example.com", name: "not-text", encrypted: encrypt(bytes: Data(SHA256.hash(data: Data(".example.com".utf8))) + Data([0xFF, 0xFE, 0xC0]))),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.name), ["good"])
        XCTAssertEqual(read.failed, 7)
        XCTAssertEqual(read.skipped, 0)
    }

    // MARK: Expiry and SameSite

    func testExpiryIsMicrosecondsSince1601AndZeroIsASession() throws {
        let expiry = Date(timeIntervalSince1970: 1_893_456_000) // 2030-01-01
        try makeDatabase(profile: "Default", rows: [
            Row(host: ".example.com", name: "lasting", value: "a", expires: chromeTime(expiry)),
            Row(host: ".example.com", name: "zero", value: "b", expires: 0),
            Row(host: ".example.com", name: "not-persistent", value: "c", expires: chromeTime(expiry), persistent: false),
            Row(host: ".example.com", name: "expired", value: "d", expires: chromeTime(now.addingTimeInterval(-60))),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.name), ["lasting", "zero", "not-persistent"])
        XCTAssertEqual(read.cookies[0].expires, expiry)
        XCTAssertNil(read.cookies[1].expires, "0 is a session cookie")
        XCTAssertNil(read.cookies[2].expires, "kept for the session, as Chrome would")
        XCTAssertEqual(read.skipped, 1, "the expired one")

        // 13,350,009,600 seconds after 1601-01-01: 2024-01-18 00:00:00 UTC.
        XCTAssertEqual(ChromeCookies.date(chromeTime: 13_350_009_600_000_000), Date(timeIntervalSince1970: 1_705_536_000))
        XCTAssertNil(ChromeCookies.date(chromeTime: 0))
        XCTAssertNil(ChromeCookies.date(chromeTime: -1))

        // Foundation holds an HTTPCookie to 400 days from today, as Chrome does, so this one is a month out.
        let soon = Date(timeIntervalSince1970: (Date().timeIntervalSince1970 + 30 * 86_400).rounded())
        let lasting = try XCTUnwrap(ChromeCookies.httpCookie(ChromeCookie(
            hostKey: ".example.com", name: "lasting", value: "a", path: "/", expires: soon,
            isSecure: false, isHTTPOnly: false, sameSite: .unspecified)))
        XCTAssertEqual(lasting.expiresDate, soon)
        XCTAssertFalse(lasting.isSessionOnly)
        let session = try XCTUnwrap(ChromeCookies.httpCookie(read.cookies[1]))
        XCTAssertNil(session.expiresDate)
        XCTAssertTrue(session.isSessionOnly)
    }

    func testSameSiteCarriesOverWhereItWasSaid() throws {
        try makeDatabase(profile: "Default", rows: [
            Row(host: ".example.com", name: "unspecified", value: "a", sameSite: -1),
            Row(host: ".example.com", name: "none", value: "b", secure: true, sameSite: 0),
            Row(host: ".example.com", name: "lax", value: "c", sameSite: 1),
            Row(host: ".example.com", name: "strict", value: "d", sameSite: 2),
            Row(host: ".example.com", name: "future", value: "e", sameSite: 7),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.sameSite), [.unspecified, .none, .lax, .strict, .unspecified])
        let policies = try read.cookies.map { try XCTUnwrap(ChromeCookies.httpCookie($0)).sameSitePolicy }
        XCTAssertEqual(policies, [nil, nil, .sameSiteLax, .sameSiteStrict, nil])
    }

    // MARK: Into WebKit

    func testHTTPCookiesKeepDomainPathAndFlags() throws {
        let domain = try XCTUnwrap(ChromeCookies.httpCookie(ChromeCookie(
            hostKey: ".example.com", name: "sid", value: "domain-value", path: "/account", expires: nil,
            isSecure: true, isHTTPOnly: true, sameSite: .lax)))
        XCTAssertEqual(domain.domain, ".example.com", "a leading dot: every host under it")
        XCTAssertEqual(domain.path, "/account")
        XCTAssertEqual(domain.name, "sid")
        XCTAssertEqual(domain.value, "domain-value")
        XCTAssertTrue(domain.isSecure)
        XCTAssertTrue(domain.isHTTPOnly)

        let host = try XCTUnwrap(ChromeCookies.httpCookie(ChromeCookie(
            hostKey: "app.example.com", name: "__Host-id", value: "host-value", path: "", expires: nil,
            isSecure: false, isHTTPOnly: false, sameSite: .unspecified)))
        XCTAssertEqual(host.domain, "app.example.com", "no dot: that host alone")
        XCTAssertEqual(host.path, "/", "an empty path is the root")
        XCTAssertFalse(host.isSecure)
        XCTAssertFalse(host.isHTTPOnly)
        XCTAssertTrue(host.isSessionOnly)
    }

    func testACookiePrintsWithoutItsValue() {
        let cookie = ChromeCookie(hostKey: ".example.com", name: "sid", value: "do-not-print-me", path: "/", expires: nil,
                                  isSecure: true, isHTTPOnly: true, sameSite: .lax)
        XCTAssertFalse(String(describing: cookie).contains("do-not-print-me"))
        XCTAssertFalse(String(reflecting: cookie).contains("do-not-print-me"))
        var dumped = ""
        dump(cookie, to: &dumped)
        XCTAssertFalse(dumped.contains("do-not-print-me"))
        XCTAssertTrue(dumped.contains(".example.com"))
    }

    // MARK: Partitioned cookies

    func testPartitionedCookiesAreSkipped() throws {
        try makeDatabase(profile: "Default", rows: [
            Row(host: ".widget.com", name: "chips", value: "a", partition: "https://site.com"),
            Row(host: ".widget.com", name: "plain", value: "b"),
        ])
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.name), ["plain"])
        XCTAssertEqual(read.skipped, 1)
    }

    // MARK: Profiles

    func testProfilesAreLocalStatesNamesForFoldersWithCookies() throws {
        try makeDatabase(profile: "Default", rows: [])
        try makeDatabase(profile: "Profile 1", rows: [])
        try makeDatabase(profile: "Profile 10", rows: [])
        try makeDatabase(profile: "Profile 2", at: "Network/Cookies", rows: [])
        try makeDatabase(profile: "Guest Profile", rows: [])
        try FileManager.default.createDirectory(at: chrome.appendingPathComponent("Profile 3"), withIntermediateDirectories: true)
        try writeLocalState([
            "Default": ["name": "Tyler"],
            "Profile 1": ["name": "Work"],
            "Profile 2": ["name": "  Side  "],
            "Profile 10": ["name": ""],
            "Profile 3": ["name": "Never browsed"],
            "Profile 4": ["name": "Deleted"],
            "../Default": ["name": "Out of the folder"],
        ])
        XCTAssertEqual(ChromeCookies.profiles(in: chrome), [
            ChromeProfile(directory: "Default", name: "Tyler"),
            ChromeProfile(directory: "Profile 1", name: "Work"),
            ChromeProfile(directory: "Profile 2", name: "Side"),
            ChromeProfile(directory: "Profile 10", name: "Profile 10"),
        ])
    }

    func testWithoutLocalStateTheFoldersAreTheProfiles() throws {
        try makeDatabase(profile: "Profile 2", rows: [])
        try makeDatabase(profile: "Default", rows: [])
        try makeDatabase(profile: "System Profile", rows: [])
        XCTAssertEqual(ChromeCookies.profiles(in: chrome).map(\.directory), ["Default", "Profile 2"])
        XCTAssertEqual(ChromeCookies.profiles(in: chrome).map(\.name), ["Default", "Profile 2"])
    }

    func testNoChromeIsNoProfiles() {
        XCTAssertEqual(ChromeCookies.profiles(in: root.appendingPathComponent("Nothing here")), [])
        XCTAssertEqual(ChromeCookies.profiles(in: chrome), [], "Chrome's folder, empty")
    }

    func testTheDefaultFolderIsChromesUnderApplicationSupport() {
        XCTAssertTrue(ChromeCookies.chromeFolder.path.hasSuffix("/Library/Application Support/Google/Chrome"))
    }

    func testEachOtherProfileGetsAConchProfileOfItsOwn() {
        let names = ChromeCookies.conchProfileNames(for: [
            ChromeProfile(directory: "Default", name: "Tyler"),
            ChromeProfile(directory: "Profile 1", name: "Work"),
            ChromeProfile(directory: "Profile 2", name: "Person 1"),
            ChromeProfile(directory: "Profile 3", name: "person 1"),
            ChromeProfile(directory: "Profile 4", name: "Default"),
        ])
        XCTAssertEqual(names, [
            "Profile 1": "Work",
            "Profile 2": "Person 1 (Profile 2)",
            "Profile 3": "person 1 (Profile 3)",
            "Profile 4": "Default (Profile 4)",
        ], "Default is conch's own; a shared name would put two Chrome profiles in one")
    }

    /// The daemon keeps a profile's name to one printable line of at most 60 (src/browser-profiles.ts).
    func testConchProfileNamesAreWhatTheDaemonKeeps() {
        let long = String(repeating: "Work account ", count: 8) // 104 characters
        let names = ChromeCookies.conchProfileNames(for: [
            ChromeProfile(directory: "Profile 1", name: long),
            ChromeProfile(directory: "Profile 2", name: long + "two"),
            ChromeProfile(directory: "Profile 3", name: "Side\nproject\u{7}"),
            ChromeProfile(directory: "Profile 4", name: "\u{2028}"),
        ])
        for name in names.values {
            XCTAssertLessThanOrEqual(name.unicodeScalars.count, ChromeCookies.conchProfileNameLimit, name)
            XCTAssertFalse(name.unicodeScalars.contains { $0.properties.generalCategory == .control }, name)
            XCTAssertEqual(name, name.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        // Cut to the same 60, the two would be one profile: each keeps its folder.
        XCTAssertEqual(names["Profile 1"], String(long.prefix(48)).trimmingCharacters(in: .whitespaces) + " (Profile 1)")
        XCTAssertEqual(names["Profile 2"], String(long.prefix(48)).trimmingCharacters(in: .whitespaces) + " (Profile 2)")
        XCTAssertEqual(names["Profile 3"], "Side project")
        XCTAssertEqual(names["Profile 4"], "Profile 4", "nothing printable: its folder")
    }

    // MARK: Where the database is

    func testBothCookiePathsAreRead() throws {
        try makeDatabase(profile: "Profile 1", at: "Cookies", rows: [Row(host: ".old.com", name: "a", value: "old-path")])
        try makeDatabase(profile: "Profile 2", at: "Network/Cookies", rows: [Row(host: ".new.com", name: "b", value: "new-path")])
        XCTAssertEqual(try read("Profile 1").cookies.map(\.value), ["old-path"])
        XCTAssertEqual(try read("Profile 2").cookies.map(\.value), ["new-path"])

        // Both: the one written last.
        let stale = try makeDatabase(profile: "Profile 3", at: "Cookies", rows: [Row(host: ".a.com", name: "a", value: "stale")])
        let current = try makeDatabase(profile: "Profile 3", at: "Network/Cookies", rows: [Row(host: ".a.com", name: "a", value: "current")])
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-86_400)], ofItemAtPath: stale.path)
        try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: current.path)
        XCTAssertEqual(try read("Profile 3").cookies.map(\.value), ["current"])
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(86_400)], ofItemAtPath: stale.path)
        XCTAssertEqual(try read("Profile 3").cookies.map(\.value), ["stale"])
    }

    func testAProfileWithoutCookiesOrWithAnotherLayoutSaysSo() throws {
        XCTAssertThrowsError(try read("Profile 9")) { error in
            XCTAssertEqual(error as? ChromeCookiesError, .noCookies(profile: "Profile 9"))
        }
        let folder = chrome.appendingPathComponent("Profile 8", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try sqlite(folder.appendingPathComponent("Cookies")) { db in
            try exec(db, "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)")
            try exec(db, "INSERT INTO meta VALUES('version', '24')")
            try exec(db, "CREATE TABLE cookies(host_key TEXT, name TEXT)")
        }
        XCTAssertThrowsError(try read("Profile 8")) { error in
            XCTAssertEqual(error as? ChromeCookiesError, .unknownLayout)
        }
        try Data("not a database".utf8).write(to: chrome.appendingPathComponent("Profile 7/Cookies"), options: [], createFolder: true)
        XCTAssertThrowsError(try read("Profile 7")) { error in
            guard case .unreadable = error as? ChromeCookiesError else { return XCTFail("\(error)") }
        }
        XCTAssertEqual(try scratchContents(), [], "the copies are gone, failed reads too")
    }

    // MARK: Copy, then read

    /// Chrome holds its database open, locked, with what it wrote last in the `-wal` beside it. The reader copies both and
    /// reads the copy; the original, its folder and its lock are left as they were, and the copy is gone afterwards.
    func testItReadsACopyAndLeavesTheOriginalAsItWas() throws {
        let folder = chrome.appendingPathComponent("Default", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let original = folder.appendingPathComponent("Cookies")

        // As Chrome runs: one connection, exclusive, in WAL mode, nothing checkpointed into the database yet.
        var handle: OpaquePointer?
        XCTAssertEqual(sqlite3_open(original.path, &handle), SQLITE_OK)
        let chromeRunning = try XCTUnwrap(handle)
        defer { sqlite3_close(chromeRunning) }
        try exec(chromeRunning, "PRAGMA locking_mode = EXCLUSIVE")
        try exec(chromeRunning, "PRAGMA journal_mode = WAL")
        try exec(chromeRunning, "PRAGMA wal_autocheckpoint = 0")
        try createSchema(chromeRunning, version: 24)
        try insert(chromeRunning, Row(host: ".example.com", name: "in-wal",
                                      encrypted: encrypt("wal-value", host: ".example.com", hashPrefixed: true)))
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.path + "-wal"))

        let before = try snapshot(folder)
        let read = try readDefault()
        XCTAssertEqual(read.cookies.map(\.value), ["wal-value"], "what's only in the -wal is read too")
        XCTAssertEqual(try snapshot(folder), before, "the original folder: the same files, bytes and dates")
        XCTAssertEqual(try scratchContents(), [], "the copy is deleted")

        // Chrome's connection still has its lock and its data.
        try insert(chromeRunning, Row(host: ".example.com", name: "after", value: "x"))
    }

    func testTheCopyGoesInAFolderOnlyThisUserCanOpen() throws {
        let folder = try ChromeCookies.privateFolder(in: scratch)
        let mode = try FileManager.default.attributesOfItem(atPath: folder.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o700)
        XCTAssertEqual(folder.deletingLastPathComponent().standardizedFileURL, scratch.standardizedFileURL)
        XCTAssertNotEqual(try ChromeCookies.privateFolder(in: scratch), folder, "a new one for each read")
    }

    // MARK: Fixtures

    private struct Row {
        var host: String
        var name: String
        var value = ""
        var encrypted = Data()
        var path = "/"
        var expires: Int64 = 0
        var secure = false
        var httpOnly = false
        var sameSite = -1
        var persistent = true
        var partition = ""
    }

    private func readDefault() throws -> ChromeCookieRead { try read("Default") }

    private func read(_ profile: String) throws -> ChromeCookieRead {
        try ChromeCookies.readCookies(profile: profile, in: chrome, password: Self.password, now: now, scratch: scratch)
    }

    @discardableResult
    private func makeDatabase(profile: String, at relative: String = "Cookies", version: Int = 24, rows: [Row]) throws -> URL {
        let url = chrome.appendingPathComponent(profile, isDirectory: true).appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try sqlite(url) { db in
            try createSchema(db, version: version)
            for row in rows { try insert(db, row) }
        }
        return url
    }

    private func sqlite(_ url: URL, _ body: (OpaquePointer) throws -> Void) throws {
        var handle: OpaquePointer?
        guard sqlite3_open(url.path, &handle) == SQLITE_OK, let db = handle else { throw FixtureError("open \(url.path)") }
        defer { sqlite3_close(db) }
        try body(db)
    }

    /// Chromium's schema at version 24 (sqlite_persistent_cookie_store.cc), and its `meta`.
    private func createSchema(_ db: OpaquePointer, version: Int) throws {
        try exec(db, "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)")
        try exec(db, "INSERT INTO meta VALUES('version', '\(version)'), ('last_compatible_version', '\(version)')")
        try exec(db, """
            CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,\
            name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,\
            is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,\
            is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,\
            source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,\
            has_cross_site_ancestor INTEGER NOT NULL)
            """)
    }

    private var created: Int64 = 13_300_000_000_000_000

    private func insert(_ db: OpaquePointer, _ row: Row) throws {
        let sql = """
            INSERT INTO cookies VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, 2, 443, 0, 0, 0)
            """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let insert = statement else { throw FixtureError("prepare") }
        defer { sqlite3_finalize(insert) }
        created += 1
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_int64(insert, 1, created)
        sqlite3_bind_text(insert, 2, row.host, -1, transient)
        sqlite3_bind_text(insert, 3, row.partition, -1, transient)
        sqlite3_bind_text(insert, 4, row.name, -1, transient)
        sqlite3_bind_text(insert, 5, row.value, -1, transient)
        if row.encrypted.isEmpty {
            sqlite3_bind_zeroblob(insert, 6, 0)
        } else {
            _ = row.encrypted.withUnsafeBytes { bytes in
                sqlite3_bind_blob(insert, 6, bytes.baseAddress, Int32(row.encrypted.count), transient)
            }
        }
        sqlite3_bind_text(insert, 7, row.path, -1, transient)
        sqlite3_bind_int64(insert, 8, row.expires)
        sqlite3_bind_int(insert, 9, row.secure ? 1 : 0)
        sqlite3_bind_int(insert, 10, row.httpOnly ? 1 : 0)
        sqlite3_bind_int(insert, 11, row.expires != 0 ? 1 : 0)
        sqlite3_bind_int(insert, 12, row.persistent ? 1 : 0)
        sqlite3_bind_int(insert, 13, Int32(row.sameSite))
        guard sqlite3_step(insert) == SQLITE_DONE else { throw FixtureError("insert: \(String(cString: sqlite3_errmsg(db)))") }
    }

    private func exec(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw FixtureError("\(sql): \(String(cString: sqlite3_errmsg(db)))") }
    }

    private func writeLocalState(_ cache: [String: [String: String]]) throws {
        let state: [String: Any] = ["profile": ["info_cache": cache, "last_used": "Default"], "browser": ["enabled_labs_experiments": []]]
        try JSONSerialization.data(withJSONObject: state).write(to: chrome.appendingPathComponent("Local State"))
    }

    /// Encrypted as Chrome does, by this file's own hand: CryptoKit's SHA-256, then CommonCrypto's AES.
    private func encrypt(_ plain: String, host: String, hashPrefixed: Bool, key: Data? = nil) -> Data {
        let prefix = hashPrefixed ? Data(SHA256.hash(data: Data(host.utf8))) : Data()
        return encrypt(bytes: prefix + Data(plain.utf8), key: key)
    }

    private func encrypt(bytes: Data, key: Data? = nil) -> Data {
        let key = key ?? pbkdf2(Self.password)
        let iv = [UInt8](repeating: 0x20, count: 16)
        var out = [UInt8](repeating: 0, count: bytes.count + 16)
        var moved = 0
        let input = [UInt8](bytes)
        let keyBytes = [UInt8](key)
        let status = CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                             keyBytes, keyBytes.count, iv, input, input.count, &out, out.count, &moved)
        XCTAssertEqual(status, CCCryptorStatus(kCCSuccess))
        return Data("v10".utf8) + Data(out.prefix(moved))
    }

    private func pbkdf2(_ password: Data) -> Data {
        var key = [UInt8](repeating: 0, count: 16)
        let secret = [CChar](password.map { CChar(bitPattern: $0) })
        let salt = [UInt8]("saltysalt".utf8)
        let status = CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), secret, secret.count, salt, salt.count,
                                          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, &key, key.count)
        XCTAssertEqual(status, Int32(kCCSuccess))
        return Data(key)
    }

    private func chromeTime(_ date: Date) -> Int64 {
        Int64(((date.timeIntervalSince1970 + 11_644_473_600) * 1_000_000).rounded())
    }

    private func scratchContents() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: scratch.path)
    }

    private struct FileState: Equatable {
        let bytes: Data
        let modified: Date?
    }

    private func snapshot(_ folder: URL) throws -> [String: FileState] {
        var files: [String: FileState] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: folder.path) {
            let url = folder.appendingPathComponent(name)
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            files[name] = FileState(bytes: try Data(contentsOf: url), modified: attributes[.modificationDate] as? Date)
        }
        return files
    }

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private func data(hex: String) -> Data {
        var bytes = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return bytes
    }

    private struct FixtureError: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}

private extension Data {
    func write(to url: URL, options: Data.WritingOptions, createFolder: Bool) throws {
        if createFolder {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        }
        try write(to: url, options: options)
    }
}
