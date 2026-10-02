import CoreGraphics
import XCTest
@testable import ConchDesign

/// `conch_capture`'s rules (PageCapture.swift): when a page has settled, where its target goes, what is captured, where
/// the target is in the picture, and what counts as a sign-in screen. The Mac app's web view runs these as it draws;
/// test/page-capture-render.test.ts draws real pages with it.
final class PageCaptureTests: XCTestCase {
    private func sample(
        _ elapsed: TimeInterval,
        target: CGRect? = CGRect(x: 10, y: 300, width: 200, height: 100),
        ready: String = "complete",
        fonts: Bool = true,
        images: Int = 0,
        height: CGFloat = 4000
    ) -> PageCapture.Sample {
        PageCapture.Sample(readyState: ready, fontsLoaded: fonts, pendingImages: images, target: target, scrollHeight: height, elapsed: elapsed)
    }

    // MARK: Settling

    /// Frames alone, as most tests here count them; `quiet` is its own test.
    private let frames = PageCapture.SettleRules(quiet: 0)

    func testSettlesAfterFourLooksWithNothingMoved() {
        var settle = PageCapture.Settle(rules: frames)
        XCTAssertEqual(settle.observe(sample(0.00)), .wait)
        XCTAssertEqual(settle.observe(sample(0.02)), .wait)
        XCTAssertEqual(settle.observe(sample(0.03)), .wait)
        XCTAssertEqual(settle.observe(sample(0.05)), .settled)
    }

    func testAndAQuietMomentSinceAnythingMoved() {
        var settle = PageCapture.Settle()
        XCTAssertEqual(settle.observe(sample(0.00)), .wait)
        for at in [0.02, 0.03, 0.05, 0.2, 0.29] { XCTAssertEqual(settle.observe(sample(at)), .wait, "\(at)") }
        XCTAssertEqual(settle.observe(sample(0.30)), .settled)
        // A script moves the target again a moment after an image lands: the quiet starts over from the move.
        var chained = PageCapture.Settle()
        _ = chained.observe(sample(0.00))
        let moved = CGRect(x: 10, y: 480, width: 200, height: 100)
        XCTAssertEqual(chained.observe(sample(0.10, target: moved)), .wait)
        for at in [0.12, 0.14, 0.16, 0.3, 0.39] { XCTAssertEqual(chained.observe(sample(at, target: moved)), .wait, "\(at)") }
        XCTAssertEqual(chained.observe(sample(0.40, target: moved)), .settled)
    }

    func testALayoutShiftStartsTheCountAgain() {
        var settle = PageCapture.Settle(rules: frames)
        _ = settle.observe(sample(0.00))
        _ = settle.observe(sample(0.02))
        _ = settle.observe(sample(0.03))
        // An image above loads in and pushes the target down 120 px.
        XCTAssertEqual(settle.observe(sample(0.05, target: CGRect(x: 10, y: 420, width: 200, height: 100))), .wait)
        let moved = CGRect(x: 10, y: 420, width: 200, height: 100)
        XCTAssertEqual(settle.observe(sample(0.07, target: moved)), .wait)
        XCTAssertEqual(settle.observe(sample(0.08, target: moved)), .wait)
        XCTAssertEqual(settle.observe(sample(0.10, target: moved)), .settled)
    }

    func testSubpixelJitterIsStillAndAGrowingPageIsNot() {
        var jitter = PageCapture.Settle(rules: frames)
        for (index, y) in [300.0, 300.2, 299.9, 300.3].enumerated() {
            let verdict = jitter.observe(sample(Double(index) / 60, target: CGRect(x: 10, y: y, width: 200, height: 100)))
            XCTAssertEqual(verdict, index == 3 ? .settled : .wait)
        }
        var growing = PageCapture.Settle()
        for (index, height) in [4000.0, 4200, 4400, 4600, 4800].enumerated() {
            XCTAssertEqual(growing.observe(sample(Double(index) / 60, height: height)), .wait)
        }
    }

    func testWaitsForLoadFontsAndImagesThenGivesImagesUp() {
        var settle = PageCapture.Settle()
        for at in [0.0, 0.1, 0.2, 0.3, 0.4] { XCTAssertEqual(settle.observe(sample(at, ready: "interactive")), .wait) }
        var fonts = PageCapture.Settle()
        for at in [0.0, 0.1, 0.2, 0.3, 0.4] { XCTAssertEqual(fonts.observe(sample(at, fonts: false)), .wait) }
        var images = PageCapture.Settle(rules: frames)
        for at in [0.0, 0.1, 0.2, 0.3, 5.9] { XCTAssertEqual(images.observe(sample(at, images: 2)), .wait) }
        // An image whose server never answers doesn't hold the capture past `imageWait`.
        XCTAssertEqual(images.observe(sample(6.0, images: 2)), .settled)
    }

    func testGivesUpAtTheCapSayingWhatWasStillMoving() {
        var loading = PageCapture.Settle()
        XCTAssertEqual(loading.observe(sample(10, ready: "loading")), .gaveUp("the page was still loading"))
        var moving = PageCapture.Settle()
        _ = moving.observe(sample(9.9, target: CGRect(x: 0, y: 0, width: 10, height: 10)))
        XCTAssertEqual(moving.observe(sample(10, target: CGRect(x: 0, y: 50, width: 10, height: 10))), .gaveUp("the layout was still moving"))
        var images = PageCapture.Settle(rules: PageCapture.SettleRules(imageWait: 20, cap: 10))
        // (`quiet` met: the cap is the only thing that ends it.)
        XCTAssertEqual(images.observe(sample(10, images: 3)), .gaveUp("3 images were still loading"))
        var found = PageCapture.Settle(rules: frames)
        // A target that appears is a change, as one that moves is.
        _ = found.observe(sample(0, target: nil))
        XCTAssertEqual(found.observe(sample(0.02)), .wait)
    }

    // MARK: Placing

    func testATargetThatFitsIsCentredAndOneThatDoesntIsTopAligned() {
        let view = CGSize(width: 1440, height: 900)
        XCTAssertEqual(PageCapture.alignment(target: CGSize(width: 300, height: 852), viewport: view), .center)
        XCTAssertEqual(PageCapture.alignment(target: CGSize(width: 300, height: 853), viewport: view), .start)
        XCTAssertTrue(PageCapture.isPlaced(CGRect(x: 100, y: 400, width: 300, height: 100), viewport: view))
        // Pushed down past a quarter of the view by a late layout shift: scrolled again.
        XCTAssertFalse(PageCapture.isPlaced(CGRect(x: 100, y: 650, width: 300, height: 100), viewport: view))
        XCTAssertFalse(PageCapture.isPlaced(CGRect(x: 100, y: 850, width: 300, height: 100), viewport: view))
        XCTAssertFalse(PageCapture.isPlaced(CGRect(x: -40, y: 400, width: 300, height: 100), viewport: view))
        // Wider than the view: across doesn't count against it.
        XCTAssertTrue(PageCapture.isPlaced(CGRect(x: -40, y: 400, width: 1600, height: 100), viewport: view))
        // Too tall to fit: its top near the top of the view.
        XCTAssertTrue(PageCapture.isPlaced(CGRect(x: 0, y: 24, width: 300, height: 2000), viewport: view))
        XCTAssertFalse(PageCapture.isPlaced(CGRect(x: 0, y: 400, width: 300, height: 2000), viewport: view))
        XCTAssertFalse(PageCapture.isPlaced(CGRect(x: 0, y: -100, width: 300, height: 2000), viewport: view))
    }

    // MARK: The picture

    func testTheCropIsTheTargetWithItsMarginInsideTheView() {
        let view = CGSize(width: 1440, height: 900)
        XCTAssertEqual(PageCapture.crop(target: nil, viewport: view), PageCapture.Crop(rect: CGRect(x: 0, y: 0, width: 1440, height: 900), clipped: false))
        XCTAssertEqual(
            PageCapture.crop(target: CGRect(x: 100.4, y: 400.6, width: 300, height: 100), viewport: view),
            PageCapture.Crop(rect: CGRect(x: 76, y: 376, width: 349, height: 149), clipped: false)
        )
        // Near the edge, the margin is cut, the target isn't.
        XCTAssertEqual(
            PageCapture.crop(target: CGRect(x: 10, y: 10, width: 300, height: 100), viewport: view),
            PageCapture.Crop(rect: CGRect(x: 0, y: 0, width: 334, height: 134), clipped: false)
        )
        // Taller than the view: what the view holds, said so.
        XCTAssertEqual(
            PageCapture.crop(target: CGRect(x: 0, y: 24, width: 1440, height: 3000), viewport: view),
            PageCapture.Crop(rect: CGRect(x: 0, y: 0, width: 1440, height: 900), clipped: true)
        )
        XCTAssertNil(PageCapture.crop(target: CGRect(x: 0, y: 1200, width: 300, height: 100), viewport: view))
    }

    func testTheBoxIsTheTargetInThePicturesPixels() {
        let crop = CGRect(x: 76, y: 376, width: 349, height: 150)
        XCTAssertEqual(PageCapture.box(target: CGRect(x: 100, y: 400, width: 300, height: 100), crop: crop, scale: 2),
                       CGRect(x: 48, y: 48, width: 600, height: 200))
        XCTAssertEqual(PageCapture.box(target: CGRect(x: 100, y: 400, width: 300, height: 100), crop: crop, scale: 1),
                       CGRect(x: 24, y: 24, width: 300, height: 100))
        // Only the part inside the crop.
        XCTAssertEqual(PageCapture.box(target: CGRect(x: 0, y: 24, width: 1440, height: 3000), crop: CGRect(x: 0, y: 0, width: 1440, height: 900), scale: 2),
                       CGRect(x: 0, y: 48, width: 2880, height: 1752))
        XCTAssertNil(PageCapture.box(target: CGRect(x: 0, y: 1000, width: 10, height: 10), crop: crop, scale: 2))
    }

    func testABigPictureIsAskedForSmaller() {
        XCTAssertNil(PageCapture.snapshotWidth(for: CGSize(width: 1440, height: 900), scale: 2))
        let width = PageCapture.snapshotWidth(for: CGSize(width: 1440, height: 10_000), scale: 2)!
        XCTAssertLessThan(width, 1440)
        let pixels = Double(width * 2) * Double(width * 2 * 10_000 / 1440)
        XCTAssertLessThanOrEqual(pixels, PageCapture.maxPixels)
        XCTAssertGreaterThan(pixels, PageCapture.maxPixels * 0.99)
        XCTAssertEqual(PageCapture.fullPageHeight(scrollHeight: 4321.2, viewport: CGSize(width: 1440, height: 900)), 4322)
        XCTAssertEqual(PageCapture.fullPageHeight(scrollHeight: 300, viewport: CGSize(width: 1440, height: 900)), 900)
        XCTAssertEqual(PageCapture.fullPageHeight(scrollHeight: 90_000, viewport: CGSize(width: 1440, height: 900)), PageCapture.fullPageMax)
    }

    // MARK: Sign-in screens

    private func page(_ url: String, title: String = "", passwords: Int = 0, words: Bool = false) -> PageCapture.PageSignals {
        PageCapture.PageSignals(url: URL(string: url), title: title, passwordFields: passwords, signInWords: words)
    }

    func testIdentityProvidersAndSignInPathsAreSignInScreens() {
        for url in [
            "https://accounts.google.com/v3/signin/identifier?continue=x",
            "https://vercel.com/login?next=%2Fteam",
            "https://vercel.com/sso-api?url=https%3A%2F%2Fapp-git-x.vercel.app",
            "https://github.com/login?return_to=%2Forg%2Frepo",
            "https://acme.us.auth0.com/u/login?state=x",
            "https://acme.okta.com/app/x",
            "https://login.microsoftonline.com/common/oauth2/authorize",
            "https://clerk.acme.dev/v1/client",
            "https://app.acme.dev/sign-in?redirect_url=%2Fdashboard",
        ] {
            XCTAssertTrue(PageCapture.loginWall(page(url)), url)
        }
    }

    func testOrdinaryPagesAreNot() {
        for url in [
            "https://acme.dev/pricing",
            "https://vercel.com/acme/app/deployments",
            "https://github.com/acme/app/pull/12",
            "https://app.acme.dev/sessions/123",
            "https://acme.dev/docs/login-flow",
            "http://localhost:3000/",
        ] {
            XCTAssertFalse(PageCapture.loginWall(page(url, title: "Acme", words: true)), url)
        }
        XCTAssertFalse(PageCapture.loginWall(page("file:///tmp/login/index.html")))
    }

    func testAPasswordFieldNeedsSignInWordsAndATitleNeedsOneOrTheOther() {
        XCTAssertTrue(PageCapture.loginWall(page("https://acme.dev/", title: "Acme", passwords: 1, words: true)))
        // A settings page that changes a password, and a header's Log in button, are not.
        XCTAssertFalse(PageCapture.loginWall(page("https://acme.dev/settings", title: "Settings", passwords: 2)))
        XCTAssertFalse(PageCapture.loginWall(page("https://acme.dev/", title: "Acme", words: true)))
        XCTAssertTrue(PageCapture.loginWall(page("https://acme.dev/", title: "Log in to Vercel", words: true)))
        XCTAssertTrue(PageCapture.loginWall(page("https://acme.dev/", title: "Acme | Sign in", passwords: 1)))
        XCTAssertTrue(PageCapture.loginWall(page("https://acme.dev/", title: "Sign in to GitHub · GitHub", words: true)))
        XCTAssertFalse(PageCapture.loginWall(page("https://acme.dev/docs", title: "Login – Acme docs")))
    }

    // MARK: The folder

    func testOnlyConchsCaptureFolderIsWrittenTo() {
        let home = "/Users/t"
        XCTAssertEqual(PageCapture.folder("/Users/t/Library/Application Support/conch/captures", home: home),
                       "/Users/t/Library/Application Support/conch/captures")
        XCTAssertEqual(PageCapture.folder("/Users/t/Library/Application Support/conch/x/../captures", home: home),
                       "/Users/t/Library/Application Support/conch/captures")
        XCTAssertNil(PageCapture.folder("/Users/t/Library/Application Support/conch", home: home))
        XCTAssertNil(PageCapture.folder("/tmp/conch-previews", home: home))
        XCTAssertNil(PageCapture.folder("/Users/other/Library/Application Support/conch/captures", home: home))
    }

    func testFilesAreNamedForTheirRequestAlone() {
        XCTAssertEqual(PageCapture.fileName(request: "mfa1b2c3-x9y8z7"), "mfa1b2c3-x9y8z7.png")
        XCTAssertEqual(PageCapture.fileName(request: "mfa1b2c3-x9y8z7", seen: true), "mfa1b2c3-x9y8z7-seen.png")
        for bad in ["", "../x", "a/b", "A", "a.png", String(repeating: "a", count: 65)] {
            XCTAssertNil(PageCapture.fileName(request: bad), bad)
        }
    }
}
