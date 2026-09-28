import Foundation
import XCTest
@testable import ConchDesign

/// The Mac's poll of the daemon's published state decodes it only after a publish (`ConchStampedRead`).
///
/// Measured 28 Sep: the file was 277 KB and was read and decoded four times a second, while the daemon rewrote it
/// about once every seven seconds.
final class FileStampTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("conch-stamp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// As the daemon publishes: a new file beside it, renamed over it (`publishSessionsFile`).
    private func publish(_ text: String, to url: URL) throws {
        let temp = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        try Data(text.utf8).write(to: temp)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temp)
    }

    func testAStampNamesTheFileAsItIsNow() throws {
        let url = directory.appendingPathComponent("state.json")
        XCTAssertNil(ConchFileStamp(path: url.path), "nothing there")
        XCTAssertNil(ConchFileStamp(path: directory.path), "a folder is not a file")
        try publish(#"{"ts":1}"#, to: url)
        let first = try XCTUnwrap(ConchFileStamp(path: url.path))
        XCTAssertEqual(ConchFileStamp(path: url.path), first, "untouched: the same stamp")
        // The same size, published again: a new file under the name.
        try publish(#"{"ts":2}"#, to: url)
        XCTAssertNotEqual(ConchFileStamp(path: url.path), first, "a publish of the same size is still a new stamp")
    }

    /// Polled over and over, the file is read once per publish, and each read's value is what the poll gets.
    func testTheFileIsReadOnlyWhenItWasPublishedAgain() throws {
        let url = directory.appendingPathComponent("state.json")
        try publish("one", to: url)
        var poll = ConchStampedRead<String>()
        let read = { try? String(contentsOf: url, encoding: .utf8) }
        for _ in 0..<8 { XCTAssertEqual(poll.value(at: url.path, read: read), "one") }
        XCTAssertEqual(poll.reads, 1, "eight polls, one publish: one read")
        try publish("two", to: url)
        for _ in 0..<8 { XCTAssertEqual(poll.value(at: url.path, read: read), "two") }
        XCTAssertEqual(poll.reads, 2)
    }

    /// A read that made nothing — a file this build can't decode, or none at all — is tried again at the next poll,
    /// never remembered as the answer.
    func testAFailedReadIsTriedAgain() throws {
        let url = directory.appendingPathComponent("state.json")
        var poll = ConchStampedRead<Int>()
        XCTAssertNil(poll.value(at: url.path) { nil })
        try publish("x", to: url)
        var attempts = 0
        for _ in 0..<3 { XCTAssertNil(poll.value(at: url.path) { attempts += 1; return nil }) }
        XCTAssertEqual(attempts, 3, "every poll tries a file that would not decode")
        XCTAssertEqual(poll.value(at: url.path) { 7 }, 7)
        XCTAssertEqual(poll.value(at: url.path) { XCTFail("decoded already"); return 8 }, 7)
        try FileManager.default.removeItem(at: url)
        XCTAssertNil(poll.value(at: url.path) { nil }, "gone: nothing, not the old value")
    }
}
