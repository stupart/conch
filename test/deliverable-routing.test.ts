import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/// Two routers decide how a deliverable is shown — one in the Mac app, one on
/// the phone — and nothing kept them in step. They drifted: a local .html
/// rendered as a PAGE on the Mac and as raw markup on the phone, and anything
/// unrecognised became `.text` there, which for a video or a zip means pages
/// of bytes. The same deliverable looked finished on one surface and broken on
/// the other, which is worse than either being wrong consistently.
const mac = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ReviewView.swift"), "utf8");
const phone = readFileSync(
  join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", "DeliverableSheet.swift"), "utf8");

describe("both apps route deliverables the same way", () => {
  test("every image type the Mac knows, the phone knows", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "svg"]) {
      expect(mac).toContain(`"${ext}"`);
      expect(phone).toContain(`"${ext}"`);
    }
  });

  test("video is a player on both, not a lucky web preview", () => {
    // WebKit plays some codecs and refuses others, so falling through to a web
    // view was luck rather than support — and on the phone it was not even
    // that: video hit the text renderer.
    for (const ext of ["mp4", "mov", "m4v", "webm"]) {
      expect(mac).toContain(`"${ext}"`);
      expect(phone).toContain(`"${ext}"`);
    }
    expect(mac).toMatch(/case video\(URL\)/);
    expect(phone).toMatch(/case image, video, pdf, markdown, page, text, unsupported/);
  });

  test("a local HTML file is a page on both", () => {
    expect(phone).toMatch(/case "html", "htm"/);
    // The Mac reaches it by falling through to .web, which is why its comment
    // has to keep saying so — that default IS the contract.
    expect(mac).toMatch(/falls through to the web view/);
  });

  test("an unpreviewable file says so instead of printing bytes", () => {
    expect(phone).toContain("unsupported");
    expect(phone).toMatch(/can't preview a/);
    expect(mac).toMatch(/case missing\(URL\)/);
  });
});
