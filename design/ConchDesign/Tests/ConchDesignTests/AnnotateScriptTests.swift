import AppKit
import WebKit
import XCTest
@testable import ConchDesign

/// Annotate's page script (`AnnotationScript.source`) in real WebKit, in its own content world as the pane runs it: a
/// click names the element with a selector that matches it alone and doesn't follow the link; selected words become a
/// one-line quote that agent ink's finder finds where they were; and the notes are found again as the page scrolls,
/// lose their element when the page changes, and are found again after a reload. The page itself is never changed.
@MainActor
final class AnnotateScriptTests: XCTestCase {
    private final class Heard: NSObject, WKScriptMessageHandler {
        var messages: [AnnotationScript.Message] = []
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if let read = AnnotationScript.Message.read(message.body) { messages.append(read) }
        }
    }

    private var views: [WKWebView] = []
    private var windows: [NSWindow] = []
    private let address = URL(string: "https://swatchbook.example/landing")!

    override func tearDown() {
        MainActor.assumeIsolated {
            views.forEach { $0.stopLoading() }
            windows.forEach { $0.orderOut(nil) }
            views = []
            windows = []
        }
        super.tearDown()
    }

    static let html = """
        <!doctype html><html><head><title>Landing</title><style>
        body { margin: 0; font: 16px -apple-system, sans-serif; } section, div, p, nav, h1 { margin: 8px; }
        a { display: inline-block; padding: 6px; } .card { padding: 8px; border: 1px solid #ccc; }
        </style></head><body>
        <nav class="sc-AxjAm nav"><span class="Button_root__3xk9P">Menu</span></nav>
        <h1 id="title">Ship faster with
            fewer meetings</h1>
        <section class="hero"><a class="cta primary" href="https://example.com/signup">Start free trial</a> <a class="cta" href="#more">See how</a></section>
        <div id="pricing"><div class="card">Solo <a href="#solo">Learn more</a></div><div class="card">Team <a href="#team">Learn more</a></div><div class="card" data-testid="plan-pro">Pro</div></div>
        <p class="lede">Plain words here and Plain words there</p>
        <div style="height: 1600px"></div>
        <p id="far">At the foot of the page</p>
        </body></html>
        """

    private func page() async throws -> (WKWebView, Heard) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let heard = Heard()
        let world = WKContentWorld.world(name: AnnotationScript.world)
        configuration.userContentController.addUserScript(WKUserScript(source: AnnotationScript.source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        configuration.userContentController.add(heard, contentWorld: world, name: AnnotationScript.handler)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 800, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFrontRegardless()
        views.append(view)
        windows.append(window)
        view.loadHTMLString(Self.html, baseURL: address)
        try await until("the page and its script", heard) { $0.messages.contains { if case .ready = $0 { true } else { false } } }
        return (view, heard)
    }

    private func until(_ what: String, _ heard: Heard, timeout: TimeInterval = 5, _ done: (Heard) -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !done(heard) {
            guard Date() < deadline else { throw XCTSkip("WebKit never gave \(what) in this process") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// The last message of a kind, once one comes after `count` messages.
    private func next<T>(_ heard: Heard, after count: Int, _ pick: (AnnotationScript.Message) -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(5)
        while true {
            if let found = heard.messages.dropFirst(count).reversed().lazy.compactMap(pick).first { return found }
            guard Date() < deadline else { throw XCTSkip("no such message came") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    @discardableResult
    private func page(_ view: WKWebView, _ script: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await view.callAsyncJavaScript(script, arguments: arguments, in: nil, contentWorld: .page)
    }

    private func annotate(_ view: WKWebView, on: Bool, notes: [[String]] = []) async throws {
        _ = try await view.callAsyncJavaScript("return conchAnnotate.set(on, notes)", arguments: ["on": on, "notes": notes], in: nil, contentWorld: .world(name: AnnotationScript.world))
    }

    /// A click on `selector`'s middle, as a person's arrives: from the page's own world, cancelable.
    private func click(_ view: WKWebView, _ selector: String) async throws {
        try await page(view, """
            const el = document.querySelector(selector);
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window }));
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window }));
            """, ["selector": selector])
    }

    /// Words selected as a drag selects them, from `from` characters into `selector`'s text for `length`, then let go.
    private func select(_ view: WKWebView, _ selector: String, from: Int = 0, length: Int? = nil) async throws {
        try await page(view, """
            const el = document.querySelector(selector);
            const node = [...el.childNodes].find((n) => n.nodeType === 3);
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, length == null ? node.data.length : from + length);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, view: window }));
            """, ["selector": selector, "from": from, "length": length ?? NSNull()])
    }

    /// The elements a selector matches, by their outerHTML's start.
    private func matches(_ view: WKWebView, _ selector: String) async throws -> [String] {
        try await page(view, "return [...document.querySelectorAll(selector)].map((el) => el.outerHTML.slice(0, 60))", ["selector": selector]) as? [String] ?? []
    }

    /// Where agent ink's own finder finds a quote or a selector, in client pixels.
    private func finder(_ view: WKWebView, _ how: String, _ what: String) async throws -> CGRect? {
        let answer = try await view.callAsyncJavaScript(AgentInk.finder, arguments: ["marks": [["m", how, what]]], in: nil, contentWorld: .defaultClient) as? [String: Any]
        guard let xywh = (answer?["found"] as? [String: [Double]])?["m"] else { return nil }
        return CGRect(x: xywh[0], y: xywh[1], width: xywh[2], height: xywh[3])
    }

    // MARK: - Pointing at an element

    func testAClickNamesTheElementAloneAndFollowsNoLink() async throws {
        let (view, heard) = try await page()
        let before = try await page(view, "return document.documentElement.outerHTML") as? String
        try await annotate(view, on: true)
        let count = heard.messages.count
        try await click(view, ".hero a.cta.primary")
        let (element, rect) = try await next(heard, after: count) { message -> (AnnotationElement, CGRect)? in
            if case let .element(element, rect, _, _) = message { (element, rect) } else { nil }
        }
        XCTAssertEqual(element.selector, "a.cta.primary")
        XCTAssertEqual(element.tag, "a")
        XCTAssertEqual(element.text, "Start free trial")
        XCTAssertEqual(element.attributes.first { $0.name == "href" }?.value, "https://example.com/signup")
        let same = try await page(view, "return document.querySelectorAll(selector).length === 1 && document.querySelector(selector) === document.querySelector('.hero a.cta.primary')", ["selector": element.selector]) as? Bool
        XCTAssertEqual(same, true)
        // Agent ink finds the element by the same selector, where the click said it was.
        let found = try await finder(view, "selector", element.selector)
        XCTAssertEqual(found, rect)

        // The link wasn't followed, and the page is as it was.
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(view.url, address)
        let after = try await page(view, "return document.documentElement.outerHTML") as? String
        XCTAssertEqual(after, before)
        // Nothing of conch's is in the page's own world.
        let seen = try await page(view, "return typeof window.conchAnnotate") as? String
        XCTAssertEqual(seen, "undefined")
    }

    func testASelectorTakesAsManyStepsAsItNeedsAndSkipsMachineMadeNames() async throws {
        let (view, heard) = try await page()
        try await annotate(view, on: true)
        // The second card's link: no class of its own, so its card, by its place among the cards.
        var count = heard.messages.count
        try await click(view, "#pricing .card:nth-of-type(2) a")
        let second = try await next(heard, after: count) { if case let .element(element, _, _, _) = $0 { element } else { nil } }
        XCTAssertEqual(second.selector, "div.card:nth-of-type(2) > a")
        let matched = try await matches(view, second.selector)
        XCTAssertEqual(matched, ["<a href=\"#team\">Learn more</a>"])

        // A test id names it alone.
        count = heard.messages.count
        try await click(view, "[data-testid=plan-pro]")
        let pro = try await next(heard, after: count) { if case let .element(element, _, _, _) = $0 { element } else { nil } }
        XCTAssertEqual(pro.selector, #"[data-testid="plan-pro"]"#)

        // A styled-components class and a CSS module's are a tool's, not a person's: never in a selector.
        count = heard.messages.count
        try await click(view, "nav")
        let nav = try await next(heard, after: count) { if case let .element(element, _, _, _) = $0 { element } else { nil } }
        XCTAssertEqual(nav.selector, "nav.nav")
        count = heard.messages.count
        try await click(view, "nav span")
        let menu = try await next(heard, after: count) { if case let .element(element, _, _, _) = $0 { element } else { nil } }
        XCTAssertFalse(menu.selector.contains("Button_root"), menu.selector)
        let menus = try await matches(view, menu.selector)
        XCTAssertEqual(menus.count, 1)
    }

    func testOffAClickIsThePagesOwn() async throws {
        let (view, heard) = try await page()
        try await annotate(view, on: true)
        try await annotate(view, on: false)
        let count = heard.messages.count
        try await click(view, ".hero a.cta:nth-of-type(2)")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(heard.messages.dropFirst(count).contains { if case .element = $0 { true } else { false } })
        // The in-page link was followed, as it is when nobody is annotating.
        XCTAssertEqual(view.url?.fragment, "more")
    }

    // MARK: - Words

    func testSelectedWordsBecomeAOneLineQuoteAgentInkFindsWhereTheyWere() async throws {
        let (view, heard) = try await page()
        try await annotate(view, on: true)
        let count = heard.messages.count
        // The heading's words run over a line break in the source.
        try await select(view, "#title")
        let (quote, selected, rect) = try await next(heard, after: count) { message -> (String, String?, CGRect)? in
            if case let .words(quote, selected, rect, _, _) = message { (quote, selected, rect) } else { nil }
        }
        XCTAssertEqual(quote, "Ship faster with")
        XCTAssertEqual(selected, "Ship faster with fewer meetings")
        XCTAssertFalse(quote.contains("\n"))
        let looked = try await finder(view, "quote", quote)
        let found = try XCTUnwrap(looked)
        XCTAssertTrue(found.intersects(rect), "agent ink finds \(found), the words were at \(rect)")
        // The selection was taken, so nothing is left highlighted under the note.
        let left = try await page(view, "return getSelection().isCollapsed") as? Bool
        XCTAssertEqual(left, true)
    }

    func testWordsThatShowEarlierOnThePageGrowUntilTheyAreTheOnesSelected() async throws {
        let (view, heard) = try await page()
        try await annotate(view, on: true)
        let count = heard.messages.count
        // The second "Plain words" in "Plain words here and Plain words there".
        try await select(view, ".lede", from: 21, length: 11)
        let (quote, rect) = try await next(heard, after: count) { message -> (String, CGRect)? in
            if case let .words(quote, _, rect, _, _) = message { (quote, rect) } else { nil }
        }
        XCTAssertEqual(quote, "and Plain words")
        let looked = try await finder(view, "quote", quote)
        let found = try XCTUnwrap(looked)
        XCTAssertTrue(found.intersects(rect))
    }

    // MARK: - Finding the notes again

    func testNotesAreFoundAsThePageScrollsLostWhenItChangesAndFoundAgainAfterAReload() async throws {
        let (view, heard) = try await page()
        let notes = [["n1", "selector", "a.cta.primary"], ["n2", "quote", "Ship faster with"], ["n3", "selector", "#far"]]
        var count = heard.messages.count
        try await annotate(view, on: false, notes: notes)
        let first = try await next(heard, after: count) { message -> ([String: CGRect], [String])? in
            if case let .placed(found, missing, _, _, _, _) = message { (found, missing) } else { nil }
        }
        XCTAssertEqual(Set(first.0.keys), ["n1", "n2", "n3"])
        XCTAssertTrue(first.1.isEmpty)

        // Scrolled, each moves with the page.
        count = heard.messages.count
        try await page(view, "window.scrollTo(0, 300)")
        let scrolled = try await next(heard, after: count) { message -> [String: CGRect]? in
            if case let .placed(found, _, _, _, _, _) = message { found } else { nil }
        }
        XCTAssertEqual(try XCTUnwrap(scrolled["n1"]).minY, try XCTUnwrap(first.0["n1"]).minY - 300, accuracy: 1)

        // The agent's next change takes the button away: it is missing, the rest are still found.
        count = heard.messages.count
        try await page(view, "document.querySelector('a.cta.primary').remove()")
        let changed = try await next(heard, after: count) { message -> ([String: CGRect], [String])? in
            if case let .placed(found, missing, _, _, _, _) = message, !missing.isEmpty { (found, missing) } else { nil }
        }
        XCTAssertEqual(changed.1, ["n1"])
        XCTAssertNotNil(changed.0["n2"])

        // Reloaded (the same page at the same address, fresh: a string has nothing to fetch again), the page says it is
        // ready again; handed its notes, it finds them where the page now has them.
        count = heard.messages.count
        view.loadHTMLString(Self.html, baseURL: address)
        try await until("the reload", heard) { $0.messages.dropFirst(count).contains { if case .ready = $0 { true } else { false } } }
        count = heard.messages.count
        try await annotate(view, on: false, notes: notes)
        let reloaded = try await next(heard, after: count) { message -> [String: CGRect]? in
            if case let .placed(found, _, true, _, _, _) = message { found } else { nil }
        }
        XCTAssertEqual(Set(reloaded.keys), ["n1", "n2", "n3"])
    }

    func testAnElementNamedByItsPlaceIsLostWhenAnotherTakesThatPlace() async throws {
        let (view, heard) = try await page()
        // The Team card, second of three; and Pro, named by its test id.
        let notes = [["team", "selector", "div.card:nth-of-type(2)", "Team Learn more"], ["pro", "selector", #"[data-testid="plan-pro"]"#, "Pro"]]
        var count = heard.messages.count
        try await annotate(view, on: false, notes: notes)
        let before = try await next(heard, after: count) { message -> [String: CGRect]? in
            if case let .placed(found, _, _, _, _, _) = message { found } else { nil }
        }
        XCTAssertEqual(Set(before.keys), ["team", "pro"])
        // The agent takes Team out: Pro is now the second card, and the note on Team must not move onto it.
        count = heard.messages.count
        try await page(view, "document.querySelector('#pricing .card:nth-of-type(2)').remove()")
        let after = try await next(heard, after: count) { message -> ([String: CGRect], [String])? in
            if case let .placed(found, missing, _, _, _, _) = message, !missing.isEmpty { (found, missing) } else { nil }
        }
        XCTAssertEqual(after.1, ["team"])
        XCTAssertNotNil(after.0["pro"])
    }

    func testWhileAnnotatingWhatIsUnderThePointerIsNamed() async throws {
        let (view, heard) = try await page()
        try await annotate(view, on: true)
        let count = heard.messages.count
        try await page(view, """
            const r = document.querySelector("[data-testid=plan-pro]").getBoundingClientRect();
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + 4, clientY: r.top + 4, view: window }));
            """)
        let hover = try await next(heard, after: count) { message -> AnnotationScript.Message.Hover? in
            if case let .placed(_, _, _, hover?, _, _) = message { hover } else { nil }
        }
        XCTAssertEqual(hover.label, #"[data-testid="plan-pro"]"#)
        XCTAssertGreaterThan(hover.rect.width, 10)
    }
}
