import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Chrome's sign-ins, copied into conch's browser from Settings › Browser (2026-10-11; Tyler: "Everything, once"). Reading
 * and decrypting Chrome's cookies is ConchDesign's ChromeCookies, tested by XCTest on fixture databases (ChromeCookiesTests).
 * The Mac app has no XCTest target, so these pin what its half must never stop doing: the Keychain is asked only from the
 * button, cookie values go into WebKit's cookie stores and nowhere else, and the daemon is only ever asked about profiles.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (source: string): string => source.replace(/\/\/.*$/gm, "");

const importer = code(read("mac-app/conch-mac/ChromeImport.swift"));
const view = code(read("mac-app/conch-mac/BrowserSettingsView.swift"));
const cookies = code(read("design/ConchDesign/Sources/ConchDesign/ChromeCookies.swift"));
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
const count = (source: string, needle: string): number => source.split(needle).length - 1;

describe("the Keychain is asked once, from the button", () => {
  test("Chrome Safe Storage's generic password, read with the Security framework", () => {
    expect(importer).toContain("kSecClass as String: kSecClassGenericPassword,");
    expect(importer).toContain('kSecAttrService as String: "Chrome Safe Storage",');
    expect(importer).toContain('kSecAttrAccount as String: "Chrome",');
    expect(count(importer, "SecItemCopyMatching(")).toBe(1);
    // ConchDesign's half never touches the Keychain: the password is a parameter.
    expect(cookies).not.toContain("SecItem");
    expect(cookies).toContain("password: Data,");
  });

  test("only the import asks, off the main thread, and only the button starts an import", () => {
    // Asked for on a queue of its own, since it blocks for as long as the prompt is up, and from the import alone.
    expect(importer).toContain("DispatchQueue.global(qos: .userInitiated).async { answer.resume(returning: password()) }");
    expect(count(importer, "password()")).toBe(2);
    expect(count(importer, "ChromeSafeStorage.ask()")).toBe(1);
    const run = importer.slice(importer.indexOf("func importFromChrome() async {"), importer.indexOf("static let needsUpdate"));
    expect(run).toContain("switch await ChromeSafeStorage.ask() {");
    // Looking at Chrome's profiles on appear reads names, never the Keychain.
    const refresh = importer.slice(importer.indexOf("func refresh() async {"), importer.indexOf("private func listProfiles()"));
    expect(refresh).not.toContain("ChromeSafeStorage");
    expect(refresh).not.toContain("readCookies");
    expect(count(view, "importFromChrome()")).toBe(1);
    expect(view).toMatch(/Button\(store\.reports\.isEmpty \? "Import logins from Chrome" : "Import again"\) \{\s*Task \{ await store\.importFromChrome\(\) \}/);
  });

  test("a refusal says so, and the button stays to try again", () => {
    expect(importer).toContain("case .failure(.denied): importState = .denied; return");
    expect(view).toContain("conch wasn't allowed to read Chrome Safe Storage, so nothing was copied.");
    // Disabled only while an import runs, which a refusal has ended.
    expect(view).toContain(".disabled(store.isImporting)");
    expect(importer).toContain("case .askingKeychain, .importing: true");
  });
});

describe("cookie values go into WebKit's cookie stores and nowhere else", () => {
  test("nothing logs or prints", () => {
    for (const [name, source] of [["ChromeImport.swift", importer], ["BrowserSettingsView.swift", view], ["ChromeCookies.swift", cookies]]) {
      for (const sink of ["print(", "NSLog(", "os_log(", "Logger(", "debugPrint(", "dump(", "FileHandle.standardError"]) {
        expect(source, `${name}: ${sink}`).not.toContain(sink);
      }
    }
  });

  test("the daemon is asked about profiles, by name, and never sent a cookie", () => {
    const request = importer.slice(importer.indexOf("struct Request: Encodable {"), importer.indexOf("struct Reply: Decodable {"));
    expect(request.replace(/\s+/g, " ").trim()).toBe(
      'struct Request: Encodable { let kind = "browser-profiles" let action: String let name: String? }',
    );
    expect(count(importer, "ConchSocketClient()")).toBe(1);
    expect(importer).toContain('ChromeImport.profiles("list")');
    expect(importer).toContain('ChromeImport.profiles("add", name: name)');
    expect(view).not.toContain("ConchSocketClient");
  });

  test("Default goes into WebKit's default store, every other profile into the store its id names", () => {
    const store = importer.slice(importer.indexOf("static func dataStore(for profileId: String)"), importer.indexOf("struct Report:"));
    expect(store).toContain("if profileId == Profile.defaultId { return .default() }");
    expect(store).toContain("guard let identifier = UUID(uuidString: profileId) else { return nil }");
    expect(store).toContain("return WKWebsiteDataStore(forIdentifier: identifier)");
    expect(importer).toContain('static let defaultId = "default"');
    expect(importer).toContain("if chrome.isDefault {\n            target = ChromeImport.Profile.builtIn");
    expect(importer).toContain("cookieStore.setCookie(cookie)");
  });

  test("what is kept is counts", () => {
    expect(importer).toContain('static let countsKey = "conch.browser.chromeImportCounts"');
    expect(importer).toContain("defaults.set(importedCounts, forKey: Self.countsKey)");
    expect(count(importer, "defaults.set(")).toBe(1);
    // The report's fields are counts and names.
    const report = importer.slice(importer.indexOf("struct Report: Identifiable"), importer.indexOf("var id: String { chrome.directory }"));
    expect(report).not.toMatch(/\bvalue\b|HTTPCookie|ChromeCookie\b/);
  });

  test("the copy of Chrome's database is read in a private folder and deleted", () => {
    expect(cookies).toContain("attributes: [.posixPermissions: 0o700]");
    expect(cookies).toContain("defer { try? files.removeItem(at: folder) }");
    // The original is only ever copied, never opened.
    expect(count(cookies, "sqlite3_open_v2(")).toBe(1);
    expect(cookies).toContain("sqlite3_open_v2(database.path, &handle, SQLITE_OPEN_READWRITE, nil)");
    expect(cookies).toContain("return try read(database: copy, password: password, now: now)");
  });
});

describe("Settings › Browser", () => {
  test("its words", () => {
    expect(view).toContain(
      'static let explanation = "Copies your Chrome sign-ins into conch\'s browser, one conch profile per Chrome profile. macOS will ask you to allow conch to read Chrome Safe Storage."',
    );
    expect(importer).toContain('static let needsUpdate = "Needs an updated conch daemon"');
    expect(view).toContain("Text(ChromeImportStore.needsUpdate)");
    expect(view).toContain('"Chrome isn\'t installed on this Mac, so there\'s nothing to copy."');
    expect(view).toContain('"Chrome has no profiles with sign-ins to copy."');
  });

  test("a daemon from before browser-profiles reads as one that needs updating", () => {
    const reply = importer.slice(importer.indexOf("switch reply.kind {"), importer.indexOf("static func dataStore"));
    expect(reply).toContain('case "browser-profiles":');
    expect(reply).toContain('case "browser-error":');
    expect(reply).toContain("default:\n                return .needsUpdate");
  });

  test("both files are in the app's target", () => {
    for (const name of ["ChromeImport.swift", "BrowserSettingsView.swift"]) {
      expect(project).toContain(`/* ${name} in Sources */ = {isa = PBXBuildFile;`);
      expect(project).toContain(`path = ${name}; sourceTree = "<group>"; };`);
    }
  });
});
