import XCTest
@testable import ConchDesign

/// What a `conch-lagoon://` request may read (LagoonFiles.swift), and the page's address and navigation rules (Lagoon.swift):
/// nothing leaves its folder by `..`, an encoded one, or a symlink; a review is served only while the current state holds
/// it; ranges are what WebKit's video loader asks for. The app's scheme handler (LagoonWeb.swift) only does the reading;
/// test/lagoon-page.test.ts drives it through a real web view.
final class LagoonFilesTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("lagoon-files-\(UUID().uuidString)", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("bundle/js/world"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("work/site/img"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("secret"), withIntermediateDirectories: true)
        try "<!doctype html>".write(to: root.appendingPathComponent("bundle/index.html"), atomically: true, encoding: .utf8)
        try "export {}".write(to: root.appendingPathComponent("bundle/js/world/place.js"), atomically: true, encoding: .utf8)
        try "page".write(to: root.appendingPathComponent("work/site/page.html"), atomically: true, encoding: .utf8)
        try "png".write(to: root.appendingPathComponent("work/site/img/a.png"), atomically: true, encoding: .utf8)
        try "index".write(to: root.appendingPathComponent("work/site/index.html"), atomically: true, encoding: .utf8)
        try "keys".write(to: root.appendingPathComponent("secret/keys.txt"), atomically: true, encoding: .utf8)
        // A symlink inside the deliverable's folder that points out of it, and one that stays in.
        try fm.createSymbolicLink(at: root.appendingPathComponent("work/site/out"), withDestinationURL: root.appendingPathComponent("secret"))
        try fm.createSymbolicLink(at: root.appendingPathComponent("work/site/out.txt"), withDestinationURL: root.appendingPathComponent("secret/keys.txt"))
        try fm.createSymbolicLink(at: root.appendingPathComponent("work/site/alias.png"), withDestinationURL: root.appendingPathComponent("work/site/img/a.png"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func url(_ text: String) -> URL { URL(string: text)! }

    // MARK: Routes

    func testTheBundleAndItsIndex() {
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://lagoon/index.html?app=1&readonly=1")), .bundle(["index.html"]))
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://lagoon/")), .bundle(["index.html"]))
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://lagoon")), .bundle(["index.html"]))
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://lagoon/js/world/place.js")), .bundle(["js", "world", "place.js"]))
        // Encoded once, decoded once.
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://lagoon/sprites/og/walk%201.webp")), .bundle(["sprites", "og", "walk 1.webp"]))
    }

    func testOnlyTheLagoonsOwnAddress() {
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://elsewhere/index.html")), .refused("not a lagoon address"))
        XCTAssertEqual(LagoonFiles.route(url("https://lagoon/index.html")), .refused("not a lagoon address"))
        XCTAssertEqual(LagoonFiles.route(url("CONCH-LAGOON://LAGOON/index.html")), .bundle(["index.html"]))
    }

    func testEverySpellingOfAParentFolderIsRefused() {
        for text in [
            "conch-lagoon://lagoon/review/s/r/..%2F..%2Fsecret%2Fkeys.txt",
            "conch-lagoon://lagoon/review/s/r/%2e%2e/keys.txt",
            "conch-lagoon://lagoon/review/s/r/%2E%2E",
            "conch-lagoon://lagoon/js/%2F..%2Fx",
            "conch-lagoon://lagoon/js/a%5C..%5Cb",
            "conch-lagoon://lagoon/js//double",
            "conch-lagoon://lagoon/js/./x.js",
            "conch-lagoon://lagoon/js/x%00.js",
            "conch-lagoon://lagoon/js/%FF%FE.js",
        ] {
            guard case .refused = LagoonFiles.route(url(text)) else { return XCTFail("served \(text)") }
        }
    }

    func testAReviewRoute() {
        XCTAssertEqual(LagoonFiles.route(url("conch-lagoon://lagoon/review/abc-1/rev%201")), .review(sessionId: "abc-1", reviewId: "rev 1", rest: []))
        XCTAssertEqual(
            LagoonFiles.route(url("conch-lagoon://lagoon/review/abc-1/r1/img/a%20b.png")),
            .review(sessionId: "abc-1", reviewId: "r1", rest: ["img", "a b.png"])
        )
        // Ids are names to look up, not paths: a per-window row's `#`, or a `/`, arrives encoded and comes out whole.
        XCTAssertEqual(LagoonFiles.route(url(Lagoon.reviewURL(sessionId: "s#12", reviewKey: "r/1"))), .review(sessionId: "s#12", reviewId: "r/1", rest: []))
        guard case .refused = LagoonFiles.route(url("conch-lagoon://lagoon/review/s/r/%2e%2e")) else { return XCTFail("a parent after the ids") }
        guard case .refused = LagoonFiles.route(url("conch-lagoon://lagoon/review/abc-1")) else { return XCTFail("half a review") }
    }

    // MARK: Files in a folder

    func testAFileInTheBundle() {
        let bundle = root.appendingPathComponent("bundle")
        XCTAssertEqual(LagoonFiles.file(in: bundle, ["js", "world", "place.js"])?.lastPathComponent, "place.js")
        XCTAssertNil(LagoonFiles.file(in: bundle, ["js", "world"]), "a folder is not a file")
        XCTAssertNil(LagoonFiles.file(in: bundle, ["missing.js"]))
        XCTAssertNil(LagoonFiles.file(in: bundle, ["..", "secret", "keys.txt"]))
        XCTAssertNil(LagoonFiles.file(in: bundle, ["js", "../../secret/keys.txt"]))
        XCTAssertNil(LagoonFiles.file(in: bundle, []))
    }

    func testASymlinkThatLeadsOutIsRefusedAndOneThatStaysInIsServed() {
        let site = root.appendingPathComponent("work/site")
        XCTAssertNil(LagoonFiles.file(in: site, ["out", "keys.txt"]))
        XCTAssertNil(LagoonFiles.file(in: site, ["out.txt"]))
        XCTAssertEqual(LagoonFiles.file(in: site, ["alias.png"])?.lastPathComponent, "a.png")
    }

    func testContainmentIsByComponentNotByPrefix() {
        XCTAssertTrue(LagoonFiles.contains(URL(fileURLWithPath: "/a/b"), URL(fileURLWithPath: "/a/b/c.txt")))
        XCTAssertTrue(LagoonFiles.contains(URL(fileURLWithPath: "/a/b"), URL(fileURLWithPath: "/a/b")))
        XCTAssertFalse(LagoonFiles.contains(URL(fileURLWithPath: "/a/b"), URL(fileURLWithPath: "/a/bc/d.txt")))
        XCTAssertFalse(LagoonFiles.contains(URL(fileURLWithPath: "/a/b"), URL(fileURLWithPath: "/a/b/../c.txt")))
    }

    // MARK: Deliverables

    func testTheBareReviewRedirectsToItsFileSoRelativeLinksResolveBesideIt() {
        let page = root.appendingPathComponent("work/site/page.html")
        XCTAssertEqual(LagoonFiles.review(target: page, rest: []), .redirect("page.html"))
        XCTAssertEqual(
            LagoonFiles.redirectURL(sessionId: "s 1", reviewId: "r1", to: "my page.html"),
            "conch-lagoon://lagoon/review/s%201/r1/my%20page.html"
        )
        // Its folder and below, nothing above.
        guard case let .file(image) = LagoonFiles.review(target: page, rest: ["img", "a.png"]) else { return XCTFail("its image") }
        XCTAssertEqual(image.lastPathComponent, "a.png")
        XCTAssertEqual(LagoonFiles.review(target: page, rest: ["..", "..", "secret", "keys.txt"]), .refused("not in the deliverable's folder"))
        XCTAssertEqual(LagoonFiles.review(target: page, rest: ["out", "keys.txt"]), .refused("not in the deliverable's folder"))
    }

    func testAFolderDeliverableStartsAtItsIndex() {
        let folder = root.appendingPathComponent("work/site")
        XCTAssertEqual(LagoonFiles.review(target: folder, rest: []), .redirect("index.html"))
        guard case .file = LagoonFiles.review(target: folder, rest: ["index.html"]) else { return XCTFail("its index") }
    }

    func testAWebLinkOrAMissingFileIsNotServed() {
        XCTAssertEqual(LagoonFiles.review(target: url("https://example.com/x"), rest: []), .refused("a web link isn't served here"))
        XCTAssertEqual(LagoonFiles.review(target: root.appendingPathComponent("work/gone.html"), rest: []), .refused("not there"))
    }

    func testOnlyAReviewInTheCurrentStateIsServedAndAStaleIdIsNothing() {
        func source(_ reviews: [LagoonSnapshot.Source.Review]) -> LagoonSnapshot.Source {
            LagoonSnapshot.Source(ts: 1, paused: false, holding: 0, liveState: nil, rows: [
                .init(id: "s1", cwd: "/work", reviews: reviews),
            ], conversations: [:], dismissed: [])
        }
        let before = source([
            .init(id: "r-old", summary: "old", link: "site/old.html"),
            .init(id: "r-new", summary: "new", link: "site/page.html"),
        ])
        XCTAssertEqual(LagoonFiles.heldLink(sessionId: "s1", reviewId: "r-old", in: before)?.link, "site/old.html")
        XCTAssertEqual(LagoonFiles.heldLink(sessionId: "s1", reviewId: "r-new", in: before)?.cwd, "/work")
        // The session let r-old go: its id is stale now, and serves nothing.
        let after = source([.init(id: "r-new", summary: "new", link: "site/page.html")])
        XCTAssertNil(LagoonFiles.heldLink(sessionId: "s1", reviewId: "r-old", in: after))
        XCTAssertNotNil(LagoonFiles.heldLink(sessionId: "s1", reviewId: "r-new", in: after))
        // A session that's gone, and one that never was.
        XCTAssertNil(LagoonFiles.heldLink(sessionId: "s2", reviewId: "r-new", in: after))
        // A web link is the page's to open itself, and a review without a link has nothing to serve.
        let web = source([.init(id: "w", link: "https://example.com"), .init(id: "none")])
        XCTAssertNil(LagoonFiles.heldLink(sessionId: "s1", reviewId: "w", in: web))
        XCTAssertNil(LagoonFiles.heldLink(sessionId: "s1", reviewId: "none", in: web))
        // Keyed as the snapshot keys it: id, else artifact, else its place.
        let older = source([.init(artifact: "art-1", link: "a.html"), .init(link: "b.html")])
        XCTAssertEqual(LagoonFiles.heldLink(sessionId: "s1", reviewId: "art-1", in: older)?.link, "a.html")
        XCTAssertEqual(LagoonFiles.heldLink(sessionId: "s1", reviewId: "1", in: older)?.link, "b.html")
    }

    // MARK: Ranges

    func testByteRanges() {
        typealias R = LagoonFiles.ByteRange
        XCTAssertEqual(LagoonFiles.byteRange(nil, length: 100), R.whole)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=0-1", length: 100), R.part(0...1))   // WebKit's first ask for a video
        XCTAssertEqual(LagoonFiles.byteRange("bytes=10-", length: 100), R.part(10...99))
        XCTAssertEqual(LagoonFiles.byteRange("bytes=90-500", length: 100), R.part(90...99))
        XCTAssertEqual(LagoonFiles.byteRange("bytes=-10", length: 100), R.part(90...99))
        XCTAssertEqual(LagoonFiles.byteRange("bytes=-500", length: 100), R.part(0...99))
        XCTAssertEqual(LagoonFiles.byteRange("Bytes=2-5", length: 100), R.part(2...5))
        XCTAssertEqual(LagoonFiles.byteRange("bytes=100-", length: 100), R.unsatisfiable)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=-0", length: 100), R.unsatisfiable)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=0-", length: 0), R.unsatisfiable)
        // Not one it takes: the whole file.
        XCTAssertEqual(LagoonFiles.byteRange("bytes=0-1,5-6", length: 100), R.whole)
        XCTAssertEqual(LagoonFiles.byteRange("items=0-1", length: 100), R.whole)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=5-2", length: 100), R.whole)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=a-b", length: 100), R.whole)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=-", length: 100), R.whole)
        XCTAssertEqual(LagoonFiles.byteRange("bytes=99999999999999999999999-", length: 100), R.unsatisfiable)
    }

    // MARK: The page

    func testThePagesAddressAndItsTypes() {
        XCTAssertEqual(Lagoon.pageURL(readOnly: true).absoluteString, "conch-lagoon://lagoon/index.html?app=1&readonly=1")
        XCTAssertEqual(Lagoon.pageURL(readOnly: false).absoluteString, "conch-lagoon://lagoon/index.html?app=1")
        XCTAssertEqual(Lagoon.mimeType(forPathExtension: "js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(Lagoon.mimeType(forPathExtension: "WEBP"), "image/webp")
        XCTAssertEqual(Lagoon.mimeType(forPathExtension: "hdr"), "application/octet-stream")
        XCTAssertEqual(Lagoon.mimeType(forPathExtension: "html"), "text/html; charset=utf-8")
        XCTAssertEqual(Lagoon.mimeType(forPathExtension: "mp4"), "video/mp4")
        // encodeURIComponent, exactly.
        XCTAssertEqual(Lagoon.encodeComponent("a b/c?d#e&f=g'(h)*~!.-_"), "a%20b%2Fc%3Fd%23e%26f%3Dg'(h)*~!.-_")
        XCTAssertEqual(Lagoon.encodeComponent("é"), "%C3%A9")
    }

    func testWhereThePageMayGo() {
        let allow = Lagoon.Navigation.allow
        // The page itself: only ever the lagoon.
        XCTAssertEqual(Lagoon.navigation(to: url("conch-lagoon://lagoon/index.html?app=1"), mainFrame: true, newWindow: false), allow)
        for text in ["https://example.com", "http://example.com", "file:///etc/passwd", "about:blank", "data:text/html,x", "conch-lagoon://other/x"] {
            XCTAssertNotEqual(Lagoon.navigation(to: url(text), mainFrame: true, newWindow: false), allow, text)
        }
        // A deliverable on the glass: the lagoon, the web, blank frames, and the page's own bytes.
        for text in ["conch-lagoon://lagoon/review/s/r/page.html", "https://example.com", "http://example.com", "about:blank", "about:srcdoc",
                     "blob:conch-lagoon://lagoon/1234", "data:text/html,x"] {
            XCTAssertEqual(Lagoon.navigation(to: url(text), mainFrame: false, newWindow: false), allow, text)
        }
        for text in ["file:///etc/passwd", "about:config", "javascript:alert(1)", "ftp://example.com", "figma://file/1"] {
            XCTAssertNotEqual(Lagoon.navigation(to: url(text), mainFrame: false, newWindow: false), allow, text)
        }
        // Never a new window.
        XCTAssertEqual(Lagoon.navigation(to: url("conch-lagoon://lagoon/index.html"), mainFrame: true, newWindow: true),
                       .refuse("the lagoon never opens a window"))
        XCTAssertNotEqual(Lagoon.navigation(to: nil, mainFrame: false, newWindow: false), allow)
    }
}
