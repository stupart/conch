import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Chrome's sign-ins, copied into conch's browser from Settings › Browser. Reading and decrypting the cookies is
 * ConchDesign's ChromeCookies (ChromeCookiesTests); the Mac app has no XCTest target, so this holds what its half must
 * never stop doing with those secrets: cookie values and Chrome's Safe Storage password reach no log, the daemon is
 * only ever asked about profiles, and the copy of Chrome's database is private and deleted.
 */
const root = join(import.meta.dir, "..");
/** Swift with its line comments out, so a rule is about code and not about prose naming it. */
const code = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\/\/.*$/gm, "");

const importer = code("mac-app/conch-mac/ChromeImport.swift");
const view = code("mac-app/conch-mac/BrowserSettingsView.swift");
const cookies = code("design/ConchDesign/Sources/ConchDesign/ChromeCookies.swift");

test("nothing logs or prints, and the daemon is sent a profile's name, never a cookie", () => {
  for (const [name, source] of [["ChromeImport.swift", importer], ["BrowserSettingsView.swift", view], ["ChromeCookies.swift", cookies]]) {
    for (const sink of ["print(", "NSLog(", "os_log(", "Logger(", "debugPrint(", "dump(", "FileHandle.standardError"]) {
      expect(source, `${name}: ${sink}`).not.toContain(sink);
    }
  }
  const request = importer.slice(importer.indexOf("struct Request: Encodable {"), importer.indexOf("struct Reply: Decodable {"));
  expect(request.replace(/\s+/g, " ").trim()).toBe(
    'struct Request: Encodable { let kind = "browser-profiles" let action: String let name: String? }',
  );
  expect(view).not.toContain("ConchSocketClient");
});

test("the copy of Chrome's database is read in a private folder and deleted", () => {
  expect(cookies).toContain("attributes: [.posixPermissions: 0o700]");
  expect(cookies).toContain("defer { try? files.removeItem(at: folder) }");
});
