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
    // MARK: - 2026-10-16: the user's own tabs, watching agents work, and the Workdesk

    /// A blank tab of the user's, and one paused: what the published tab says, and what pausing changes.
    func testAUserTabIsBlankUntilItGoesSomewhereAndPausingKeepsEverythingElse() {
        let blank = Workbench.Tab(id: "tab-1", sessionId: "s1", url: "", profile: "default", openedAt: 5, openedByUser: true)
        XCTAssertTrue(blank.isBlank)
        XCTAssertEqual(Workbench.label(title: nil, url: blank.url), "New tab")
        let paused = blank.with(paused: true)
        XCTAssertTrue(paused.paused)
        XCTAssertEqual(paused.with(paused: false), blank)
        XCTAssertFalse(tab("tab-2").isBlank)
        XCTAssertFalse(tab("tab-2").openedByUser)
    }

    /// The refusal an agent hears is the daemon's, word for word, starting with the reason the user would give.
    func testThePausedRefusalStartsWithTheUsersReason() {
        let words = Workbench.pausedRefusal(tab: "tab-1a2b3c4d")
        XCTAssertTrue(words.hasPrefix("the user has taken over this tab (tab-1a2b3c4d)"))
        XCTAssertTrue(words.contains("open a tab of your own with browser_open"))
    }

    /// An agent's work brings its tab forward only while the user watches: the session in view, the Workdesk on screen
    /// showing another of its browser tabs or a deliverable, and untouched for a few seconds. Never the files, the shell
    /// or the terminal, never from the conversation alone, never another session's, never a paused tab, never the one
    /// already shown.
    func testAnAgentsWorkTakesTheWorkdeskOnlyFromSomeoneWatching() {
        let now = Date(timeIntervalSince1970: 1_000)
        let working = tab("b", session: "s1")
        XCTAssertTrue(Workbench.follows(working, viewing: "s1", front: .browser("a"), lastTouch: nil, now: now))
        XCTAssertTrue(Workbench.follows(working, viewing: "s1", front: .browser("a"), lastTouch: now.addingTimeInterval(-Workbench.followQuiet), now: now))
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .browser("a"), lastTouch: now.addingTimeInterval(-1), now: now), "touched a second ago")
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .place, lastTouch: nil, now: now), "the files, the shell or the terminal")
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: nil, lastTouch: nil, now: now), "the conversation alone: the stage never moves for it")
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .browser("b"), lastTouch: nil, now: now), "already shown")
        XCTAssertFalse(Workbench.follows(working, viewing: "s2", front: .browser("a"), lastTouch: nil, now: now), "another session's")
        XCTAssertFalse(Workbench.follows(working, viewing: nil, front: .browser("a"), lastTouch: nil, now: now))
        XCTAssertFalse(Workbench.follows(working.with(paused: true), viewing: "s1", front: .browser("a"), lastTouch: nil, now: now))
        XCTAssertEqual(Workbench.followQuiet, 5)
    }

    /// 2026-10-18: over a deliverable too, once the user has left the Workdesk alone for a few seconds, unless the
    /// deliverable was put in front of him (filed, or opened) within `deliverableHold`. Settings › Browser's "Bring the
    /// agent's tab forward" turns it all off.
    func testAnAgentsWorkComesOverADeliverableUnlessItWasJustShown() {
        let now = Date(timeIntervalSince1970: 10_000)
        let working = tab("b", session: "s1")
        XCTAssertTrue(Workbench.follows(working, viewing: "s1", front: .deliverable, lastTouch: nil, now: now))
        XCTAssertTrue(Workbench.follows(working, viewing: "s1", front: .deliverable, lastTouch: nil, deliverableSince: now.addingTimeInterval(-Workbench.deliverableHold), now: now))
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .deliverable, lastTouch: nil, deliverableSince: now.addingTimeInterval(-29), now: now), "filed or opened 29 s ago")
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .deliverable, lastTouch: now.addingTimeInterval(-2), deliverableSince: now.addingTimeInterval(-300), now: now), "reading it: touched 2 s ago")
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .browser("a"), lastTouch: nil, enabled: false, now: now), "following turned off")
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .deliverable, lastTouch: nil, enabled: false, now: now))
        // A tab in front that needs the user is his until he answers it.
        XCTAssertFalse(Workbench.follows(working, viewing: "s1", front: .browser("a"), frontNeedsYou: true, lastTouch: nil, now: now))
        XCTAssertEqual(Workbench.deliverableHold, 30)
        XCTAssertEqual(Workbench.followSettingKey, "conch.workbench.followAgent")
    }

    /// A tab whose agent asked the user to act in it takes the stage: over anything the Workdesk shows, and from the
    /// conversation alone by opening the Workdesk beside it, whatever the follow setting says. Not while the user's hand
    /// is on the Workdesk (or, with it off screen, typing): then it waits until he has been quiet for `followQuiet`.
    func testATabThatNeedsTheUserTakesTheStageWhenHesQuiet() {
        let now = Date(timeIntervalSince1970: 20_000)
        let asked = tab("b", session: "s1").with(ask: Workbench.Tab.Ask(reason: "Sign in to Swatchbook", at: 19_999_000))
        for front: Workbench.Front in [.browser("a"), .deliverable, .place] {
            XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: front, lastTouch: nil, lastTyped: nil, now: now), .bringForward(opensStage: false), "\(front)")
            // Typing in the composer doesn't hold it while the Workdesk is on screen: nothing under his hands moves.
            XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: front, lastTouch: nil, lastTyped: now, now: now), .bringForward(opensStage: false))
        }
        XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: nil, lastTouch: nil, lastTyped: nil, now: now), .bringForward(opensStage: true), "from the conversation alone")
        XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: .deliverable, lastTouch: now.addingTimeInterval(-2), lastTyped: nil, now: now), .wait(until: now.addingTimeInterval(3)))
        XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: nil, lastTouch: nil, lastTyped: now.addingTimeInterval(-1), now: now), .wait(until: now.addingTimeInterval(4)), "typing with the Workdesk off screen")
        XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: .deliverable, lastTouch: now.addingTimeInterval(-5), lastTyped: nil, now: now), .bringForward(opensStage: false))
        XCTAssertEqual(Workbench.summons(asked, viewing: "s1", front: .browser("b"), lastTouch: nil, lastTyped: nil, now: now), .stay, "already in front")
        XCTAssertEqual(Workbench.summons(asked, viewing: "s2", front: .deliverable, lastTouch: nil, lastTyped: nil, now: now), .stay, "another session's: its row says so")
        XCTAssertEqual(Workbench.summons(tab("b", session: "s1"), viewing: "s1", front: .deliverable, lastTouch: nil, lastTyped: nil, now: now), .stay, "nothing asked")
        // Paused or not: the user holds the tab, and the agent asks him in it.
        XCTAssertEqual(Workbench.summons(asked.with(paused: true), viewing: "s1", front: .deliverable, lastTouch: nil, lastTyped: nil, now: now), .bringForward(opensStage: false))
    }

    /// The session's newest ask is the one in front; each ask is brought forward once, by its key.
    func testTheNewestAskOfASessionIsTheOneThatNeedsTheUser() {
        let first = tab("a", session: "s1").with(ask: Workbench.Tab.Ask(reason: "Sign in", at: 5))
        let second = tab("b", session: "s1").with(ask: Workbench.Tab.Ask(reason: "Approve the consent screen", at: 9))
        let other = tab("c", session: "s2").with(ask: Workbench.Tab.Ask(reason: "Sign in", at: 12))
        let tabs = [first, second, tab("d", session: "s1"), other]
        XCTAssertEqual(Workbench.asking(in: tabs, session: "s1")?.id, "b")
        XCTAssertEqual(Workbench.asking(in: tabs, session: "s2")?.id, "c")
        XCTAssertNil(Workbench.asking(in: tabs, session: "s3"))
        XCTAssertNil(Workbench.asking(in: tabs, session: nil))
        XCTAssertEqual(second.askKey, "b@9")
        XCTAssertNil(tab("d", session: "s1").askKey)
        XCTAssertNotEqual(first.askKey, first.with(ask: Workbench.Tab.Ask(reason: "Sign in", at: 6)).askKey, "asked again is a new ask")
        // Done hides it at once; pausing keeps it.
        XCTAssertNil(second.with(ask: nil).ask)
        XCTAssertEqual(second.with(paused: true).ask, second.ask)
        XCTAssertEqual(second.with(ask: nil), tab("b", session: "s1"))
    }

    func testWhatTheTabTheRowAndThePasskeyNoticeSay() {
        XCTAssertEqual(Workbench.askWords(agent: "Claude", reason: "Sign in to Swatchbook"), "Claude needs you · Sign in to Swatchbook")
        XCTAssertEqual(Workbench.rowAskLine(reason: "Sign in to Swatchbook"), "Browser tab: Sign in to Swatchbook")
        XCTAssertEqual(Workbench.passkeyWords, "Passkeys don't work in conch's browser yet · choose your password or another way to sign in")
    }

    func testATabAnAgentActedInHasItsDotUntilItIsShown() {
        XCTAssertTrue(Workbench.showsActivity("b", actedIn: ["b"], shown: "a"))
        XCTAssertTrue(Workbench.showsActivity("b", actedIn: ["b"], shown: nil))
        XCTAssertFalse(Workbench.showsActivity("b", actedIn: ["b"], shown: "b"))
        XCTAssertFalse(Workbench.showsActivity("c", actedIn: ["b"], shown: "a"))
    }

    /// The badge says what the agent is doing, never what it typed.
    func testTheBadgeSaysWhatTheAgentIsDoing() {
        XCTAssertEqual(Workbench.agentWords(op: "open"), "Opening")
        XCTAssertEqual(Workbench.agentWords(op: "read"), "Reading")
        XCTAssertEqual(Workbench.agentWords(op: "click"), "Clicking")
        XCTAssertEqual(Workbench.agentWords(op: "type"), "Typing")
        XCTAssertEqual(Workbench.agentWords(op: "screenshot"), "Capturing")
        XCTAssertEqual(Workbench.agentWords(op: "anything"), "Working")
        XCTAssertGreaterThan(Workbench.agentLinger, 0.5)
    }

    /// A mark goes where the page measured the element, at the page's zoom; anything that isn't a box on screen is none.
    func testAMarkGoesWhereThePageMeasuredItsElement() {
        XCTAssertEqual(Workbench.markRect(box: [10, 20, 120, 24]), CGRect(x: 10, y: 20, width: 120, height: 24))
        XCTAssertEqual(Workbench.markRect(box: [10, 20, 120, 24], scale: 1.5), CGRect(x: 15, y: 30, width: 180, height: 36))
        XCTAssertNil(Workbench.markRect(box: [10, 20, 0, 0]))
        XCTAssertNil(Workbench.markRect(box: [10, 20, 120]))
        XCTAssertNil(Workbench.markRect(box: [.nan, 20, 120, 24]))
        XCTAssertNil(Workbench.markRect(box: [10, 20, -1, 24]))
        XCTAssertNil(Workbench.markRect(box: [10, 20, 120, 24], scale: 0))
        let mark = WorkbenchMark(kind: .click, rect: CGRect(x: 10, y: 20, width: 120, height: 24), serial: 1)
        XCTAssertEqual(mark.point, CGPoint(x: 70, y: 32))
    }

    /// The Workdesk's items are typed: each type is named and marked, and a new one slots in as a case.
    func testTheWorkdeskHoldsTypedItems() {
        XCTAssertEqual(Workdesk.name, "Workdesk")
        XCTAssertEqual(Set(Workdesk.ItemType.allCases), [.deliverable, .browser, .files, .shell, .terminal])
        XCTAssertEqual(Workdesk.ItemType.allCases.map(Workdesk.name(of:)), ["Deliverable", "Files", "Shell", "Terminal", "Browser tab"])
        XCTAssertEqual(Workdesk.symbol(of: .browser), "globe")
        XCTAssertEqual(Workdesk.symbol(of: .files), "folder")
        // Remembered presentations still read: the raw values are what they were.
        XCTAssertEqual(WorkPane(rawValue: "browser"), .browser)
        XCTAssertEqual(WorkPane(rawValue: "deliverable"), .deliverable)
    }

    /// An Atlas page's copy is known by where atlas_show keeps it: Markdown under the copies folder, by its Atlas path.
    func testAnAtlasPagesCopyIsKnownByItsFolder() {
        let home = "/Users/someone"
        XCTAssertEqual(Workdesk.atlasPage(link: "/Users/someone/Documents/conch-notes/atlas/projects/acme/plan.md", home: home), "projects/acme/plan.md")
        XCTAssertNil(Workdesk.atlasPage(link: "/Users/someone/Documents/conch-notes/atlas/projects/acme/plan.png", home: home))
        XCTAssertNil(Workdesk.atlasPage(link: "/Users/someone/Documents/conch-notes/plan.md", home: home))
        XCTAssertNil(Workdesk.atlasPage(link: "/Users/someone/Documents/conch-notes/atlas/.drafts/plan.md", home: home))
        XCTAssertNil(Workdesk.atlasPage(link: "https://acme.dev/plan.md", home: home))
        XCTAssertNil(Workdesk.atlasPage(link: nil, home: home))
    }
}
