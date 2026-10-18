import AppKit
import WebKit
import XCTest
@testable import ConchDesign

/// The passkey watcher (`WorkbenchPasskeys`), in real WebKit: a page that asks for a passkey is heard, in conch's own
/// world alone, and gets exactly what it would have got without the watcher; the wrappers pass for the originals; the
/// quiet autofill offer a sign-in page makes as it loads isn't heard; and nothing new is on the page's `window`.
/// test/workbench-passkeys.test.ts holds the same script to the same rules against a pretend page.
@MainActor
final class WorkbenchPasskeysTests: XCTestCase {
    private final class Heard: NSObject, WKScriptMessageHandler {
        var ops: [String] = []
        var bodies: [Any] = []

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            bodies.append(message.body)
            if let op = WorkbenchPasskeys.attempt(message.body) { ops.append(op) }
        }
    }

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

    private func page(watched: Bool) async throws -> (WKWebView, Heard) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let heard = Heard()
        if watched {
            let event = WorkbenchPasskeys.eventName()
            let world = WKContentWorld.world(name: WorkbenchScript.contentWorld)
            let content = configuration.userContentController
            content.addUserScript(WKUserScript(source: WorkbenchPasskeys.pageScript(event: event), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
            content.addUserScript(WKUserScript(source: WorkbenchPasskeys.listenerScript(event: event), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
            content.add(heard, contentWorld: world, name: WorkbenchPasskeys.messageHandler)
        }
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 480, height: 320), configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 480, height: 320), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFrontRegardless()
        views.append(view)
        windows.append(window)
        view.loadHTMLString("<!doctype html><html><head><title>Sign in · Swatchbook</title></head><body><iframe srcdoc=\"<p>inner</p>\"></iframe></body></html>", baseURL: URL(string: "https://swatchbook.example/login"))
        let deadline = Date().addingTimeInterval(10)
        while view.isLoading || view.url == nil {
            guard Date() < deadline else { throw XCTSkip("WebKit didn't load a page in this process") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        return (view, heard)
    }

    /// What the page sees of `navigator.credentials` and what a passkey request gets, in the page's own world.
    private func look(_ view: WKWebView) async throws -> [String: Any] {
        let script = """
        const out = {};
        const C = navigator.credentials;
        out.hasCredentials = !!C;
        if (!C) return out;
        const ts = Function.prototype.toString;
        out.getSource = ts.call(C.get);
        out.createSource = ts.call(C.create);
        out.getString = String(C.get);
        out.toStringSource = ts.call(ts);
        out.toStringOfToString = ts.toString();
        out.getName = C.get.name + "/" + C.get.length;
        out.createName = C.create.name + "/" + C.create.length;
        out.descriptor = JSON.stringify(Object.getOwnPropertyDescriptor(CredentialsContainer.prototype, "get"));
        out.toStringDescriptor = JSON.stringify(Object.getOwnPropertyDescriptor(Function.prototype, "toString"));
        out.webkit = typeof window.webkit;
        out.ownKeys = Object.getOwnPropertyNames(window).filter((key) => key.toLowerCase().includes("conch")).join(",");
        const settle = (promise) => Promise.race([
            promise.then(() => "resolved", (error) => "rejected " + (error && error.name)),
            new Promise((resolve) => setTimeout(() => resolve("pending"), 2500)),
        ]);
        const challenge = new Uint8Array(16);
        out.getOutcome = await settle(C.get({ publicKey: { challenge, timeout: 1500 } }));
        out.badThis = await settle(Promise.resolve().then(() => C.get.call({}, { publicKey: { challenge } })));
        return out;
        """
        let value = try await view.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        return try XCTUnwrap(value as? [String: Any])
    }

    func testAPasskeyRequestIsHeardAndGetsWhatItWouldHaveGot() async throws {
        let (plain, _) = try await page(watched: false)
        let (watched, heard) = try await page(watched: true)
        let before = try await look(plain)
        let after = try await look(watched)
        guard before["hasCredentials"] as? Bool == true else { throw XCTSkip("this WebKit has no navigator.credentials") }

        // Heard for each get asking for a passkey (the second on the wrong object, which the original then turns down),
        // as "get" alone: never the page's own words.
        XCTAssertEqual(heard.ops, ["get", "get"])
        XCTAssertEqual(heard.bodies.count, 2)

        // Exactly what it would have got, rejection and all (here WebKit's NotAllowedError, as conch isn't an approved
        // browser), and the same for a call on the wrong object.
        XCTAssertEqual(after["getOutcome"] as? String, before["getOutcome"] as? String)
        XCTAssertEqual(after["badThis"] as? String, before["badThis"] as? String)

        // The wrappers pass for the originals, and toString for itself.
        for key in ["getSource", "createSource", "getString", "toStringSource", "toStringOfToString", "getName", "createName", "toStringDescriptor", "webkit", "ownKeys"] {
            XCTAssertEqual(after[key] as? String, before[key] as? String, key)
        }
        XCTAssertTrue((after["getSource"] as? String ?? "").contains("[native code]"))
        // The same attributes on the prototype: only the value differs.
        XCTAssertEqual((after["descriptor"] as? String)?.contains("\"writable\":true"), (before["descriptor"] as? String)?.contains("\"writable\":true"))
        XCTAssertEqual((after["descriptor"] as? String)?.contains("\"enumerable\":true"), (before["descriptor"] as? String)?.contains("\"enumerable\":true"))
    }

    func testTheQuietAutofillOfferAndOtherCredentialsAreNotHeard() async throws {
        let (view, heard) = try await page(watched: true)
        let script = """
        const C = navigator.credentials;
        if (!C) return "none";
        const settle = (promise) => Promise.race([promise.then(() => 0, () => 0), new Promise((resolve) => setTimeout(() => resolve(0), 600))]);
        await settle(C.get({ publicKey: { challenge: new Uint8Array(16) }, mediation: "conditional" }));
        await settle(C.get({ password: true }));
        await settle(C.get());
        await settle(C.create({ publicKey: { challenge: new Uint8Array(16), rp: { name: "Swatchbook" }, user: { id: new Uint8Array(8), name: "jordan", displayName: "Jordan" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 500 } }));
        return "ok";
        """
        let result = try await view.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) as? String
        guard result == "ok" else { throw XCTSkip("this WebKit has no navigator.credentials") }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(heard.ops, ["create"], "the conditional get, a password get and a bare get aren't passkeys asked for")
    }

    func testTheEventNameIsNewForEachPageAndOnlyEverItsOwnCharacters() {
        let one = WorkbenchPasskeys.eventName()
        XCTAssertNotEqual(one, WorkbenchPasskeys.eventName())
        XCTAssertNotNil(one.range(of: "^conch-pk-[0-9a-f]{32}$", options: .regularExpression))
        let script = WorkbenchPasskeys.pageScript(event: "conch-pk-abc\"; alert(1); //")
        XCTAssertTrue(script.contains("const EVENT = \"conch-pk-abcalert1\";"))
        XCTAssertFalse(script.contains(WorkbenchPasskeys.placeholder))
        let listener = WorkbenchPasskeys.listenerScript(event: one)
        XCTAssertTrue(listener.contains("window.webkit.messageHandlers.conchPasskeys.postMessage(op)"))
        XCTAssertTrue(listener.contains("const EVENT = \"\(one)\";"))
        XCTAssertEqual(WorkbenchPasskeys.attempt("get"), "get")
        XCTAssertEqual(WorkbenchPasskeys.attempt("create"), "create")
        XCTAssertNil(WorkbenchPasskeys.attempt("eval"))
        XCTAssertNil(WorkbenchPasskeys.attempt(["op": "get"]))
    }
}
