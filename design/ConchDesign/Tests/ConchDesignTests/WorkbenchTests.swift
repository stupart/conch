import ConchDesign
import XCTest

/// The Workbench's rules (ConchDesign `Workbench`): which store a profile's pages use, which tab a session shows, which
/// new tab comes to the front, and what the address field takes.
final class WorkbenchTests: XCTestCase {
    private func tab(_ id: String, session: String = "s1", openedAt: Double = 1_000, title: String? = nil, url: String = "https://acme.dev/") -> Workbench.Tab {
        Workbench.Tab(id: id, sessionId: session, url: url, title: title, openedAt: openedAt)
    }

    /// The built-in profile shares the review pane's and conch_capture's store, so their sign-ins carry over; any other
    /// is WebKit's store for its UUID; anything else opens nothing.
    func testAProfileIsTheDefaultStoreOrItsOwn() {
        XCTAssertEqual(Workbench.dataStore(forProfile: "default"), .default)
        let id = "7d4e1c2a-9b3f-4a5e-8c6d-0f1e2d3c4b5a"
        XCTAssertEqual(Workbench.dataStore(forProfile: id), .identified(UUID(uuidString: id)!))
        XCTAssertEqual(Workbench.dataStore(forProfile: id.uppercased()), .identified(UUID(uuidString: id)!))
        for bad in ["", "Default", "work", "7d4e1c2a9b3f4a5e8c6d0f1e2d3c4b5a", "../7d4e1c2a-9b3f-4a5e-8c6d-0f1e2d3c4b5a"] {
            XCTAssertNil(Workbench.dataStore(forProfile: bad), bad)
        }
    }

    func testTheShownTabIsThePickWhileItIsOpenElseTheNewest() {
        let tabs = [tab("a", openedAt: 1), tab("b", openedAt: 3), tab("c", openedAt: 2)]
        XCTAssertEqual(Workbench.shown(in: tabs, picked: "c")?.id, "c")
        XCTAssertEqual(Workbench.shown(in: tabs, picked: nil)?.id, "b")
        XCTAssertEqual(Workbench.shown(in: tabs, picked: "closed")?.id, "b", "a closed pick is no pick")
        XCTAssertNil(Workbench.shown(in: [], picked: "a"))
    }

    /// A tab opened while you look at its session comes to the front; one opened for another session, or long enough
    /// ago that the app wasn't looking (a relaunch), arrives quietly.
    func testOnlyANewTabOfTheSessionInViewComesToTheFront() {
        let now = Date(timeIntervalSince1970: 10_000)
        let ms = now.timeIntervalSince1970 * 1000
        let tabs = [
            tab("old", session: "s1", openedAt: ms - 60_000),
            tab("known", session: "s1", openedAt: ms - 1_000),
            tab("new", session: "s1", openedAt: ms - 2_000),
            tab("newer", session: "s1", openedAt: ms - 500),
            tab("theirs", session: "s2", openedAt: ms - 100),
        ]
        let arrived = Workbench.arrivals(tabs, known: ["known"], now: now)
        XCTAssertEqual(arrived.map(\.id), ["new", "newer", "theirs"])
        XCTAssertEqual(Workbench.front(of: arrived, viewing: "s1")?.id, "newer")
        XCTAssertEqual(Workbench.front(of: arrived, viewing: "s2")?.id, "theirs")
        XCTAssertNil(Workbench.front(of: arrived, viewing: "s3"))
        XCTAssertNil(Workbench.front(of: arrived, viewing: nil))
    }

    func testATabIsNamedByItsTitleElseItsHost() {
        XCTAssertEqual(Workbench.label(title: "  Pricing · Acme ", url: "https://acme.dev/pricing"), "Pricing · Acme")
        XCTAssertEqual(Workbench.label(title: "", url: "https://www.acme.dev/pricing"), "acme.dev")
        XCTAssertEqual(Workbench.label(title: nil, url: "http://localhost:3000/"), "localhost")
        XCTAssertEqual(Workbench.label(title: nil, url: ""), "New tab")
    }

    func testTheAddressFieldTakesAnAddressAHostOrASearchAndNothingElse() {
        XCTAssertEqual(Workbench.address(typed: " https://acme.dev/a?b=c ")?.absoluteString, "https://acme.dev/a?b=c")
        XCTAssertEqual(Workbench.address(typed: "acme.dev/pricing")?.absoluteString, "https://acme.dev/pricing")
        XCTAssertEqual(Workbench.address(typed: "localhost:3000")?.absoluteString, "http://localhost:3000")
        XCTAssertEqual(Workbench.address(typed: "127.0.0.1:8080/x")?.absoluteString, "http://127.0.0.1:8080/x")
        XCTAssertEqual(Workbench.address(typed: "mac-mini.local")?.absoluteString, "http://mac-mini.local")
        XCTAssertEqual(Workbench.address(typed: "conch voice loop")?.host, "www.google.com")
        XCTAssertEqual(Workbench.address(typed: "conch")?.host, "www.google.com")
        XCTAssertNil(Workbench.address(typed: "   "))
        XCTAssertNil(Workbench.address(typed: "file:///etc/passwd"))
        XCTAssertNil(Workbench.address(typed: "javascript:alert(1)"))
        XCTAssertNil(Workbench.address(typed: "ftp://acme.dev/"))
    }

    func testOnlyAWebAddressOpensInATab() {
        XCTAssertTrue(Workbench.isWeb(URL(string: "https://acme.dev")))
        XCTAssertTrue(Workbench.isWeb(URL(string: "http://localhost:3000")))
        XCTAssertFalse(Workbench.isWeb(URL(string: "file:///tmp/a.html")))
        XCTAssertFalse(Workbench.isWeb(URL(string: "about:blank")))
        XCTAssertFalse(Workbench.isWeb(nil))
    }

    /// The script is one string the app runs as it is, in a world of conch's own, saying the refusal word for word.
    func testTheScriptRunsInConchsOwnWorldAndRefusesPasswordsInTheAgreedWords() {
        XCTAssertEqual(WorkbenchScript.contentWorld, "conch-workbench")
        XCTAssertEqual(WorkbenchScript.passwordRefusal, "agents don't type passwords; sign in yourself in the tab")
        XCTAssertTrue(WorkbenchScript.page.contains("const PASSWORD_REFUSAL = \"\(WorkbenchScript.passwordRefusal)\";"))
        XCTAssertTrue(WorkbenchScript.page.contains("if (isPassword(el)) fail(PASSWORD_REFUSAL);"))
        XCTAssertTrue(WorkbenchScript.page.contains("text: \(WorkbenchScript.textMax), links: \(WorkbenchScript.linksMax), buttons: \(WorkbenchScript.buttonsMax), fields: \(WorkbenchScript.fieldsMax)"))
    }

    /// A tab is a second axis value like the files: picking one keeps the stage, and is remembered per session.
    @MainActor
    func testPickingABrowserTabPutsItInTheWorkHalfAndKeepsTheStage() {
        let model = WorkspaceModel()
        model.show(stage: .sideBySide, for: "a")
        model.show(browserTab: "tab-1", for: "a")
        XCTAssertEqual(model.presentation(for: "a").work, .browser)
        XCTAssertEqual(model.presentation(for: "a").selectedBrowserTab, "tab-1")
        XCTAssertEqual(model.presentation(for: "a").stage, .sideBySide)
        XCTAssertNil(model.presentation(for: "b").selectedBrowserTab)
        // Remembered across a relaunch, and a memory from before tabs still reads.
        let memory = WorkspaceMemory.decode(model.memory.encoded())
        XCTAssertEqual(memory?.presentations["a"]?.selectedBrowserTab, "tab-1")
        let older = #"{"presentations":{"a":{"stage":"sideBySide","work":"files","expandedToolIDs":[]}}}"#
        XCTAssertEqual(WorkspaceMemory.decode(Data(older.utf8))?.presentations["a"]?.work, .files)
    }
}
