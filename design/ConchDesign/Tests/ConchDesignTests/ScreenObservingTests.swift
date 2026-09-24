import XCTest
@testable import ConchDesign

/// The Mac's front-window observer, in its pure parts: what an app is, and what gets said.
final class ScreenObservingTests: XCTestCase {
    func testAppsAreKnownByTheirBundleIds() {
        XCTAssertEqual(ScreenAppKind(bundleId: "com.apple.Terminal"), .terminal)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.googlecode.iterm2"), .terminal)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.apple.iphonesimulator"), .simulator)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.figma.Desktop"), .design)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.apple.Safari"), .pageAddressBrowser)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.google.Chrome"), .addressFieldBrowser)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.brave.Browser"), .addressFieldBrowser)
        // Preview, QuickTime, an editor: their document is read, not their name.
        XCTAssertEqual(ScreenAppKind(bundleId: "com.apple.Preview"), .app)
        XCTAssertEqual(ScreenAppKind(bundleId: "com.apple.QuickTimePlayerX"), .app)
    }

    func testAnAddressFieldGetsItsSchemeBack() {
        // Chrome shows a local server without its scheme; they speak http.
        XCTAssertEqual(ScreenAppKind.addressFieldURL("localhost:5173/review")?.absoluteString, "http://localhost:5173/review")
        XCTAssertEqual(ScreenAppKind.addressFieldURL("127.0.0.1:8080")?.absoluteString, "http://127.0.0.1:8080")
        XCTAssertEqual(ScreenAppKind.addressFieldURL("[::1]:3000/")?.absoluteString, "http://[::1]:3000/")
        // Anywhere else is https.
        XCTAssertEqual(ScreenAppKind.addressFieldURL("example.com/docs")?.absoluteString, "https://example.com/docs")
        // "Always show full URLs" keeps what it says.
        XCTAssertEqual(ScreenAppKind.addressFieldURL("http://example.com/x")?.absoluteString, "http://example.com/x")
        XCTAssertEqual(ScreenAppKind.addressFieldURL(" https://localhost:5173/ ")?.absoluteString, "https://localhost:5173/")
    }

    func testASearchBeingTypedIsNoAddress() {
        for text in ["", "   ", "how to center a div", "local", "http://", "localhost:5173/a b"] {
            XCTAssertNil(ScreenAppKind.addressFieldURL(text), text)
        }
    }

    private let start = Date(timeIntervalSince1970: 1_790_000_000)
    private func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }

    func testARepeatIsNotSaidTwice() {
        var gate = ScreenReportGate<String>()
        XCTAssertTrue(gate.noticed("chrome:a", in: "com.google.Chrome", at: at(0)))
        XCTAssertFalse(gate.noticed("chrome:a", in: "com.google.Chrome", at: at(3)))
        XCTAssertTrue(gate.noticed("preview:x", in: "com.apple.Preview", at: at(6)))
        // Back again is news: it is not what was said last.
        XCTAssertTrue(gate.noticed("chrome:a", in: "com.google.Chrome", at: at(9)))
    }

    /// The pill opens a page in Chrome: Chrome still shows the old tab for a moment, then the page
    /// conch staged. Neither undoes the staged report, which knows whose it is.
    func testTheAppConchStagedIntoIsHeldForTheGrace() {
        var gate = ScreenReportGate<String>()
        gate.staged("url:review", in: "com.google.Chrome", at: at(0))
        XCTAssertFalse(gate.noticed("url:old-tab", in: "com.google.Chrome", at: at(0.5)))
        XCTAssertFalse(gate.noticed("url:review", in: "com.google.Chrome", at: at(2)))
        // Once there, the same page is a repeat of the staged report, however long it stays.
        XCTAssertFalse(gate.noticed("url:review", in: "com.google.Chrome", at: at(60)))
        // A new tab after the grace is Tyler's doing.
        XCTAssertTrue(gate.noticed("url:other", in: "com.google.Chrome", at: at(61)))
    }

    func testAnotherAppDuringTheGraceIsSaid() {
        var gate = ScreenReportGate<String>()
        gate.staged("url:review", in: "com.google.Chrome", at: at(0))
        XCTAssertTrue(gate.noticed("slack", in: "com.tinyspeck.slackmacgap", at: at(1)))
    }

    /// Held is not said: after the grace the same reading is said, not dropped as a repeat.
    func testAHeldReportIsNotRememberedAsSaid() {
        var gate = ScreenReportGate<String>()
        gate.staged("url:review", in: "com.google.Chrome", at: at(0))
        XCTAssertFalse(gate.noticed("url:old-tab", in: "com.google.Chrome", at: at(1)))
        XCTAssertTrue(gate.noticed("url:old-tab", in: "com.google.Chrome", at: at(ScreenReportGate<String>.grace)))
    }

    /// conch's own window has no app: a pick there right after staging is Tyler's, and is said.
    func testConchsOwnWindowIsNeverHeld() {
        var gate = ScreenReportGate<String>()
        gate.staged("conch:a", in: nil, at: at(0))
        XCTAssertFalse(gate.noticed("conch:a", in: nil, at: at(0.1)))
        XCTAssertTrue(gate.noticed("conch:b", in: nil, at: at(0.5)))
        // And staging into conch's window ends an earlier app's grace.
        gate.staged("url:review", in: "com.google.Chrome", at: at(1))
        gate.staged("conch:a", in: nil, at: at(1.5))
        XCTAssertTrue(gate.noticed("url:old-tab", in: "com.google.Chrome", at: at(2)))
    }

    /// The panel shows A full screen; Chrome, behind it, still shows B's page, and the poll reads it
    /// every 3 s. That reading used to be said, and B at 0.9 took the canvas's Send from A.
    func testNothingIsSaidWhileThePanelCoversTheScreen() {
        var gate = ScreenReportGate<String>()
        XCTAssertTrue(gate.noticed("url:b", in: "com.google.Chrome", at: at(0)))
        gate.staged("conch:a:panel", in: nil, at: at(5))
        gate.covered = true
        XCTAssertFalse(gate.noticed("url:b", in: "com.google.Chrome", at: at(8)))
        XCTAssertFalse(gate.noticed("url:b", in: "com.google.Chrome", at: at(60)))
        // Not remembered as said: docked again, the page in front is news.
        gate.covered = false
        XCTAssertTrue(gate.noticed("url:b", in: "com.google.Chrome", at: at(61)))
    }

    /// A daemon that restarts forgets `showing`; the poll's unchanged reading was dropped as a repeat
    /// until Tyler switched app or tab.
    func testAForgottenGateSaysTheSameReadingAgain() {
        var gate = ScreenReportGate<String>()
        XCTAssertTrue(gate.noticed("url:b", in: "com.google.Chrome", at: at(0)))
        XCTAssertFalse(gate.noticed("url:b", in: "com.google.Chrome", at: at(3)))
        gate.forget()
        XCTAssertTrue(gate.noticed("url:b", in: "com.google.Chrome", at: at(6)))
        XCTAssertFalse(gate.noticed("url:b", in: "com.google.Chrome", at: at(9)))
    }

    /// A report the daemon never acked is said again at the next reading, but never over a newer one.
    func testAnUnackedReportIsUnsaid() {
        var gate = ScreenReportGate<String>()
        XCTAssertTrue(gate.noticed("url:b", in: "com.google.Chrome", at: at(0)))
        gate.unsaid("url:b")
        XCTAssertTrue(gate.noticed("url:b", in: "com.google.Chrome", at: at(3)))
        XCTAssertTrue(gate.noticed("url:c", in: "com.google.Chrome", at: at(6)))
        // The late failure of b's report is no reason to say c again.
        gate.unsaid("url:b")
        XCTAssertFalse(gate.noticed("url:c", in: "com.google.Chrome", at: at(9)))
    }
}
