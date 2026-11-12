import AppKit
import WebKit
import XCTest
@testable import ConchDesign

/// The passkey watcher (`WorkbenchPasskeys`), in real WebKit: a page that offers a passkey is heard, from conch's own
/// world, and one that doesn't isn't; Tyler pressing one is heard at once; and the page's own world is exactly as it is
/// without the watcher, so a bot check finds nothing tampered with. test/workbench-passkeys.test.ts holds the same script
/// to the same rules against a pretend page.
@MainActor
final class WorkbenchPasskeysTests: XCTestCase {
    private final class Heard: NSObject, WKScriptMessageHandler {
        var said: [String] = []
        var bodies: [Any] = []

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            bodies.append(message.body)
            if let what = WorkbenchPasskeys.attempt(message.body) { said.append(what) }
        }
    }

    /// Held as the app holds it: WebKit drops a named world once nothing holds it.
    private static let world = WKContentWorld.world(name: WorkbenchScript.contentWorld)
    private var views: [WKWebView] = []
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            views.forEach { $0.stopLoading() }
            windows.forEach { $0.orderOut(nil) }
            views = []
            windows = []
        }
        super.tearDown()
    }

    private static let offering = """
    <!doctype html><html><head><title>Sign in · Swatchbook</title></head><body>
    <h1>Sign in</h1><input id="email" aria-label="Email">
    <button id="passkey" style="width:200px;height:30px">Sign in with a passkey</button>
    <iframe srcdoc="<p>inner</p>"></iframe></body></html>
    """

    private static let plain = """
    <!doctype html><html><head><title>Sign in · Swatchbook</title></head><body>
    <h1>Sign in</h1><input id="email" aria-label="Email"><button>Continue</button>
    <p>Read our guide to passkeys.</p><button style="display:none">Use a passkey</button></body></html>
    """

    private func page(_ html: String, watched: Bool) async throws -> (WKWebView, NSWindow, Heard) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let heard = Heard()
        if watched {
            let content = configuration.userContentController
            content.addUserScript(WKUserScript(source: WorkbenchPasskeys.script, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: Self.world))
            content.add(heard, contentWorld: Self.world, name: WorkbenchPasskeys.messageHandler)
        }
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 480, height: 320), configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 480, height: 320), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFrontRegardless()
        views.append(view)
        windows.append(window)
        view.loadHTMLString(html, baseURL: URL(string: "https://swatchbook.example/login"))
        let deadline = Date().addingTimeInterval(10)
        while view.isLoading || view.url == nil {
            guard Date() < deadline else { throw XCTSkip("WebKit didn't load a page in this process") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return (view, window, heard)
    }

    private func settle() async throws {
        try await Task.sleep(nanoseconds: 1_600_000_000)
    }

    func testAPageThatOffersAPasskeyIsHeardAndOneThatDoesntIsnt() async throws {
        let (_, _, offered) = try await page(Self.offering, watched: true)
        let (_, _, plain) = try await page(Self.plain, watched: true)
        try await settle()
        XCTAssertEqual(offered.said, ["offer"], "once a page, however many frames and changes")
        // Words about passkeys in a paragraph, and a passkey button not shown: no offer.
        XCTAssertEqual(plain.said, [])
    }

    func testAPageThatOffersOneLaterIsHeardWhenItDoes() async throws {
        let (view, _, heard) = try await page(Self.plain, watched: true)
        try await settle()
        XCTAssertEqual(heard.said, [])
        _ = try await view.callAsyncJavaScript("document.body.insertAdjacentHTML('beforeend', '<h2>Use your passkey to confirm it’s really you</h2>')", arguments: [:], in: nil, contentWorld: .page)
        try await settle()
        XCTAssertEqual(heard.said, ["offer"])
    }

    func testTylerPressingOneIsHeardAtOnce() async throws {
        let (view, window, heard) = try await page(Self.offering, watched: true)
        let box = try await view.callAsyncJavaScript("const b = document.getElementById('passkey').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]", arguments: [:], in: nil, contentWorld: .page) as? [Double]
        let point = try XCTUnwrap(WorkbenchInput.viewPoint(css: try XCTUnwrap(box), scale: Double(view.pageZoom), in: view.bounds.size))
        view.mouseDown(with: try XCTUnwrap(WorkbenchInput.mouseEvent(.leftMouseDown, at: point, in: view, window: window)))
        view.mouseUp(with: try XCTUnwrap(WorkbenchInput.mouseEvent(.leftMouseUp, at: point, in: view, window: window)))
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(heard.said.contains("pressed"), "\(heard.said)")
        // A script's click is the page's own doing, not his.
        let before = heard.said.filter { $0 == "pressed" }.count
        _ = try await view.callAsyncJavaScript("document.getElementById('passkey').click()", arguments: [:], in: nil, contentWorld: .page)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(heard.said.filter { $0 == "pressed" }.count, before)
    }

    /// 2026-11-11: the old watcher wrapped `navigator.credentials` and `Function.prototype.toString` in the page's world,
    /// and CreepJS read it as a stealth plugin, every native function as a lie. Now the page's world is as it would be
    /// without the watcher: the same sources, the same answers to the recursion test that caught the Proxy, and nothing
    /// new on `window`.
    func testThePagesOwnWorldIsUntouched() async throws {
        let (plainView, _, _) = try await page(Self.offering, watched: false)
        let (watchedView, _, _) = try await page(Self.offering, watched: true)
        try await settle()
        let script = """
        const out = {};
        const ts = Function.prototype.toString;
        const C = navigator.credentials;
        out.toString = ts.call(ts);
        out.get = C ? ts.call(C.get) : "none";
        out.same = C ? (Object.getOwnPropertyDescriptor(CredentialsContainer.prototype, "get").value === C.get) : true;
        // The recursion test: a Proxy round toString overflows the stack where the native one throws a TypeError.
        const recursion = (fn) => { try { Object.setPrototypeOf(fn, Object.create(fn)); return String(fn); } catch (error) { return error.constructor.name; } finally { try { Object.setPrototypeOf(fn, Function.prototype); } catch (_) {} } };
        out.toStringRecursion = recursion(ts);
        out.getRecursion = C ? recursion(C.get) : "none";
        out.keys = Object.getOwnPropertyNames(window).filter((key) => /conch/i.test(key)).join(",");
        out.webkit = typeof window.webkit;
        return out;
        """
        let plainLook = try await plainView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        let watchedLook = try await watchedView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        let plain = try XCTUnwrap(plainLook as? [String: Any])
        let watched = try XCTUnwrap(watchedLook as? [String: Any])
        for key in ["toString", "get", "toStringRecursion", "getRecursion", "keys", "webkit"] {
            XCTAssertEqual(watched[key] as? String, plain[key] as? String, key)
        }
        XCTAssertEqual(watched["same"] as? Bool, true)
        XCTAssertNotEqual(watched["toStringRecursion"] as? String, "RangeError")
        XCTAssertEqual(watched["webkit"] as? String, "undefined", "the handler is in conch's world alone")
    }

    func testOnlyItsOwnTwoWordsAreHeard() {
        XCTAssertEqual(WorkbenchPasskeys.attempt("offer"), "offer")
        XCTAssertEqual(WorkbenchPasskeys.attempt("pressed"), "pressed")
        XCTAssertNil(WorkbenchPasskeys.attempt("get"))
        XCTAssertNil(WorkbenchPasskeys.attempt(["what": "offer"]))
        XCTAssertFalse(WorkbenchPasskeys.script.contains(WorkbenchPasskeys.handlerPlaceholder))
        XCTAssertTrue(WorkbenchPasskeys.script.contains("window.webkit.messageHandlers.conchPasskeys.postMessage(what)") || WorkbenchPasskeys.script.contains("W.webkit.messageHandlers.conchPasskeys.postMessage(what)"))
        XCTAssertEqual(WorkbenchPasskeys.entitlement, "com.apple.developer.web-browser.public-key-credential")
        // Nothing of the page's is touched: the watcher never names what it used to wrap.
        for wrapped in ["navigator", "credentials", "Function.prototype", "toString", "defineProperty"] {
            XCTAssertFalse(WorkbenchPasskeys.script.contains(wrapped), wrapped)
        }
    }
}
