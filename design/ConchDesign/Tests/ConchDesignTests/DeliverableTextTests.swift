import XCTest
@testable import ConchDesign

/// Which deliverable files the viewers show as text (`DeliverableText`). Tyler clicked `starter-prompts.ts` in a published
/// folder's tree and got "Couldn't load deliverable — Frame load interrupted": WebKit took `.ts` for an MPEG transport
/// stream. The decision is the file's name, and where that says nothing, its bytes; never WebKit's MIME guess.
final class DeliverableTextTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("deliverable-text-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    @discardableResult
    private func write(_ name: String, _ data: Data) throws -> String {
        let url = folder.appendingPathComponent(name)
        try data.write(to: url)
        return url.path
    }

    func testSourceConfigAndDataAreTextByName() {
        for name in [
            "starter-prompts.tsx", "app.py", "build.sh", "ci.yml", "compose.yaml", "Cargo.toml", "package.json", "notes.txt",
            "View.swift", "main.go", "lib.rs", "query.sql", "style.css", "index.js", "module.mjs", "setup.cfg", "run.log",
            "APP.PY",
        ] {
            XCTAssertEqual(DeliverableText.byName("/w/\(name)"), true, name)
        }
    }

    func testExtensionlessFilesPeopleReadAreTextByName() {
        for name in ["LICENSE", "license", "Makefile", "Dockerfile", "CODEOWNERS", ".gitignore", ".env.example", "Procfile"] {
            XCTAssertEqual(DeliverableText.byName("/w/\(name)"), true, name)
        }
    }

    func testPagesStayPagesAndUnknownNamesAreLeftToTheBytes() {
        for name in ["index.html", "page.HTM", "doc.xhtml"] {
            XCTAssertEqual(DeliverableText.byName("/w/\(name)"), false, name)
        }
        // A .ts is TypeScript or an MPEG transport stream, and an unknown or missing extension says nothing either.
        for name in ["starter-prompts.ts", "clip.mts", "notes", "data.weird", "song.mp3"] {
            XCTAssertNil(DeliverableText.byName("/w/\(name)"), name)
        }
    }

    func testTheBytesDecideWhereTheNameCannot() throws {
        // The file from the report: TypeScript in a .ts, which WebKit called video.
        let prompts = try write("starter-prompts.ts", Data("export const prompts = [\n  \"Plan the week\",\n];\n".utf8))
        XCTAssertTrue(DeliverableText.isText(path: prompts))
        // An MPEG transport stream really named .ts: sync bytes and binary payload.
        var stream = Data()
        for _ in 0..<40 { stream.append(contentsOf: [0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00]) }
        XCTAssertFalse(DeliverableText.isText(path: try write("clip.ts", stream)))
        // Extensionless and unknown text, UTF-8 beyond ASCII, an empty file.
        XCTAssertTrue(DeliverableText.isText(path: try write("NOTES", Data("Café — naïve résumé\n".utf8))))
        XCTAssertTrue(DeliverableText.isText(path: try write("data.weird", Data("key = value\n".utf8))))
        XCTAssertTrue(DeliverableText.isText(path: try write("empty", Data())))
        // Binary under a name that says nothing: a PNG's header, and a zip.
        XCTAssertFalse(DeliverableText.isText(path: try write("picture", Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]))))
        XCTAssertFalse(DeliverableText.isText(path: try write("bundle.weird", Data([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]))))
        // Missing: nothing to show as text.
        XCTAssertFalse(DeliverableText.isText(path: folder.appendingPathComponent("gone").path))
        // A page is never read at all.
        XCTAssertFalse(DeliverableText.isText(path: "/w/index.html", read: { _ in XCTFail("read a page"); return nil }))
    }

    func testTextCutMidCharacterAtTheSniffsEdgeIsStillText() {
        var text = Data(repeating: 0x61, count: DeliverableText.sniffBytes - 1)
        text.append(contentsOf: Array("é".utf8))
        XCTAssertTrue(DeliverableText.looksLikeText(text.prefix(DeliverableText.sniffBytes)))
        // Invalid UTF-8 in the middle, and control characters, are not.
        XCTAssertFalse(DeliverableText.looksLikeText(Data([0x61, 0xFF, 0xFE, 0x61, 0x62, 0x63])))
        XCTAssertFalse(DeliverableText.looksLikeText(Data(repeating: 0x01, count: 64)))
        XCTAssertTrue(DeliverableText.looksLikeText(Data("tabs\tand\r\nlines\n".utf8)))
    }
}
