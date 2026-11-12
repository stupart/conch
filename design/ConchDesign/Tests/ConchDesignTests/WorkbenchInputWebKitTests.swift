import AppKit
import WebKit
import XCTest
@testable import ConchDesign

/// An agent's real input in real WebKit (`WorkbenchInput`, `WorkbenchScript`), the way `WorkbenchPage` delivers it: a
/// page parked off screen in a window that is never key, in an app that isn't active, its keyboard focus elsewhere. The
/// page hears a press and keys, every event trusted, with the `key` and `code` a person's typing gives; the field gets the
/// text; and the window's keyboard stays where it was.
///
/// What it holds WebKit to, measured first in a harness on 2026-11-11: mouse events handed to the view are the page's
/// own (`isTrusted`); a key handed to a view that isn't first responder types once its field's text is selected by script
/// (`focus-field`), and not before; text an input method would commit goes in by `insertText`; and a press makes WebKit
/// take the keyboard for the view a moment later unless the view turns it down.
@MainActor
final class WorkbenchInputWebKitTests: XCTestCase {
    /// `WorkbenchWebView`'s rule: the keyboard turned down while an agent presses, and given straight back.
    private final class PressedView: WKWebView {
        var pressing = false
        weak var keeper: NSResponder?
        override func becomeFirstResponder() -> Bool {
            guard pressing else { return super.becomeFirstResponder() }
            let window = self.window, keeper = self.keeper
            DispatchQueue.main.async { if let window, window.firstResponder === window, let keeper { window.makeFirstResponder(keeper) } }
            return false
        }
    }

    /// conch's world, held for the test as the app holds it (`WorkbenchPage.world`): WebKit drops a named world, and the
    /// script's state in it (`window.__conchWorkbench`), once nothing holds it.
    private static let world = WKContentWorld.world(name: WorkbenchScript.contentWorld)

    private var window: NSWindow?

    override func tearDown() {
        MainActor.assumeIsolated {
            window?.orderOut(nil)
            window = nil
        }
        super.tearDown()
    }

    private static let page = """
    <!doctype html><html><body style="margin:0">
    <form id="f" action="javascript:void(0)">
    <label for="name" style="position:absolute;left:20px;top:20px">Name</label>
    <input id="name" value="old" autocomplete="off" style="position:absolute;left:60px;top:60px;width:300px;height:30px">
    <textarea id="note" aria-label="Note" style="position:absolute;left:60px;top:140px;width:300px;height:80px"></textarea>
    <button id="go" style="position:absolute;left:60px;top:260px;width:120px;height:36px">Go</button>
    </form>
    <script>
    window.heard = [];
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "keydown", "keypress", "beforeinput", "input", "keyup", "submit"]) {
        document.addEventListener(type, (event) => {
            heard.push({ type, trusted: event.isTrusted, target: event.target.id || event.target.nodeName, key: event.key, code: event.code, shift: event.shiftKey });
        }, true);
    }
    document.getElementById("f").addEventListener("submit", (event) => event.preventDefault());
    </script></body></html>
    """

    private func view() async throws -> (PressedView, NSWindow, NSTextView) {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = PressedView(frame: CGRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: 640, height: 480), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content = NSView(frame: CGRect(x: 0, y: 0, width: 640, height: 480))
        // Where the keyboard is, and must stay: the composer, say.
        let composer = NSTextView(frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        content.addSubview(view)
        content.addSubview(composer)
        window.contentView = content
        window.orderFrontRegardless()
        window.makeFirstResponder(composer)
        self.window = window
        view.loadHTMLString(Self.page, baseURL: URL(string: "https://swatchbook.example/"))
        let deadline = Date().addingTimeInterval(10)
        while view.isLoading || view.url == nil {
            guard Date() < deadline else { throw XCTSkip("WebKit didn't load a page in this process") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        return (view, window, composer)
    }

    private func script(_ view: WKWebView, _ op: String, _ what: String) async throws -> [String: Any] {
        let arguments: [String: Any] = ["op": op, "how": "auto", "what": what, "text": "", "submit": false]
        let value = try await view.callAsyncJavaScript(WorkbenchScript.page, arguments: arguments, in: nil, contentWorld: Self.world)
        return try XCTUnwrap(value as? [String: Any])
    }

    private func heard(_ view: WKWebView) async throws -> [[String: Any]] {
        let value = try await view.callAsyncJavaScript("return window.heard", arguments: [:], in: nil, contentWorld: .page)
        return try XCTUnwrap(value as? [[String: Any]])
    }

    private func press(_ view: PressedView, at point: CGPoint, in window: NSWindow) async throws {
        view.keeper = window.firstResponder
        view.pressing = true
        defer { view.pressing = false }
        let start = WorkbenchInput.pointerStart(towards: point, last: nil, in: view.bounds.size)
        for spot in WorkbenchInput.path(from: start, to: point, steps: 6) {
            view.mouseMoved(with: try XCTUnwrap(WorkbenchInput.mouseEvent(.mouseMoved, at: spot, in: view, window: window)))
        }
        view.mouseDown(with: try XCTUnwrap(WorkbenchInput.mouseEvent(.leftMouseDown, at: point, in: view, window: window)))
        try await Task.sleep(nanoseconds: 60_000_000)
        view.mouseUp(with: try XCTUnwrap(WorkbenchInput.mouseEvent(.leftMouseUp, at: point, in: view, window: window)))
        try await Task.sleep(nanoseconds: 300_000_000)
    }

    private func type(_ strokes: [WorkbenchInput.Stroke], into view: WKWebView, window: NSWindow) async throws {
        var shifted = false
        for stroke in strokes {
            switch stroke {
            case let .key(character, unshifted, code, shift):
                if shift != shifted {
                    shifted = shift
                    view.flagsChanged(with: try XCTUnwrap(WorkbenchInput.shiftEvent(down: shift, window: window)))
                }
                view.keyDown(with: try XCTUnwrap(WorkbenchInput.keyEvent(.keyDown, character: character, unshifted: unshifted, keyCode: code, shift: shift, window: window)))
                view.keyUp(with: try XCTUnwrap(WorkbenchInput.keyEvent(.keyUp, character: character, unshifted: unshifted, keyCode: code, shift: shift, window: window)))
            case let .text(text):
                view.insertText(text)
            }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
        if shifted { view.flagsChanged(with: try XCTUnwrap(WorkbenchInput.shiftEvent(down: false, window: window))) }
        try await Task.sleep(nanoseconds: 200_000_000)
    }

    func testAPressAndKeysAreTheBrowsersOwnTrustedAndTheKeyboardStays() async throws {
        let (view, window, composer) = try await view()

        // The press: where `locate-field` says a click reaches the field.
        let located = try await script(view, "locate-field", "#name")
        XCTAssertEqual(located["native"] as? Bool, true)
        let css = try XCTUnwrap(located["point"] as? [Double])
        let point = try XCTUnwrap(WorkbenchInput.viewPoint(css: css, scale: Double(view.pageZoom), in: view.bounds.size))
        try await press(view, at: point, in: window)
        XCTAssertTrue(window.firstResponder === composer, "an agent's press never takes the keyboard")

        // The keys: the field's text selected, then each one pressed, replacing it.
        let ready = try await script(view, "focus-field", "#name")
        XCTAssertEqual(ready["ready"] as? Bool, true)
        try await Task.sleep(nanoseconds: 80_000_000)
        try await type(WorkbenchInput.strokes(for: "Hi Jo é", singleLine: true), into: view, window: window)
        let ended = try await script(view, "end-field", "#name")
        XCTAssertEqual(ended["changed"] as? Bool, true)
        XCTAssertEqual(ended["strayed"] as? Bool, false)
        let value = try await view.callAsyncJavaScript("return document.getElementById('name').value", arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(value, "Hi Jo é")

        let events = try await heard(view)
        let untrusted = events.filter { $0["trusted"] as? Bool != true }
        XCTAssertTrue(untrusted.isEmpty, "every event the page heard is trusted: \(untrusted)")
        let types = events.map { $0["type"] as? String ?? "" }
        for type in ["mousedown", "mouseup", "click", "keydown", "keypress", "beforeinput", "input", "keyup"] {
            XCTAssertTrue(types.contains(type), "the page heard \(type)")
        }
        let keys = events.filter { $0["type"] as? String == "keydown" }.map { "\($0["key"] ?? "")/\($0["code"] ?? "")" }
        // Shift down for each capital (its release is a keyup), and no key for the é an input method would commit.
        XCTAssertEqual(keys, ["Shift/ShiftLeft", "H/KeyH", "i/KeyI", " /Space", "Shift/ShiftLeft", "J/KeyJ", "o/KeyO", " /Space"])
        XCTAssertTrue(window.firstResponder === composer, "nor do its keys")
    }

    func testReturnSubmitsAsAPersonsWouldAndAKeyBeforeTheSelectionTypesNothing() async throws {
        let (view, window, _) = try await view()
        let located = try await script(view, "locate", "Go")
        let css = try XCTUnwrap(located["point"] as? [Double])
        // A key with nothing selected by script, the field not first responder: nothing types (the reason for
        // `focus-field`, and for `end-field`'s answer, which sends the app back to the script).
        _ = try await script(view, "locate-field", "#name")
        try await type([.key(character: "z", unshifted: "z", keyCode: 6, shift: false)], into: view, window: window)
        let untouched = try await view.callAsyncJavaScript("return document.getElementById('name').value", arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(untouched, "old")

        let ready = try await script(view, "focus-field", "#name")
        XCTAssertEqual(ready["ready"] as? Bool, true)
        try await Task.sleep(nanoseconds: 80_000_000)
        try await type(WorkbenchInput.strokes(for: "new", singleLine: true), into: view, window: window)
        view.keyDown(with: try XCTUnwrap(WorkbenchInput.keyEvent(.keyDown, character: "\r", unshifted: "\r", keyCode: WorkbenchInput.returnKeyCode, shift: false, window: window)))
        view.keyUp(with: try XCTUnwrap(WorkbenchInput.keyEvent(.keyUp, character: "\r", unshifted: "\r", keyCode: WorkbenchInput.returnKeyCode, shift: false, window: window)))
        try await Task.sleep(nanoseconds: 300_000_000)
        _ = try await script(view, "end-field", "#name")
        let events = try await heard(view)
        let submits = events.filter { $0["type"] as? String == "submit" }
        XCTAssertEqual(submits.count, 1)
        XCTAssertEqual(submits.first?["trusted"] as? Bool, true)
        let value = try await view.callAsyncJavaScript("return document.getElementById('name').value", arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(value, "new")
        XCTAssertEqual(css.count, 2)
    }
}
