import AppKit
import WebKit

// Compiled by test/lagoon-page.test.ts with mac-app/conch-mac/LagoonWeb.swift, LagoonSource.swift, Models.swift,
// ExecutionModels.swift, StateStore.swift's `LinkTarget` and ConchDesign's sources, as one module: the app's own lagoon web
// view, scheme handler and snapshot, run against a fixture state. Two modes:
//
//   lagoon-harness snapshot <state.json> <home>
//       the `LagoonSnapshot` the app would send for that `PublishedState`, as JSON on stdout (the test compares it with
//       the brand repo's sanitize.mjs).
//   lagoon-harness page <bundle folder> <state.json> <out folder> <stub|real>
//       loads the bundle in a real web view through conch-lagoon://, in an offscreen window (off every screen, never key,
//       taking no clicks, with WebKit's occlusion check off as PageCapturer does), and prints one JSON line per check.
//
// Nothing here touches conch's own state: the state is the test's file, and the web view's data store is its own
// (`.nonPersistent()`, `LagoonWebHost.dataStore`).

struct Line {
    static func print(_ name: String, _ fields: [String: Any]) {
        var line = fields
        line["check"] = name
        let data = try! JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
        Swift.print(String(decoding: data, as: UTF8.self))
        fflush(stdout)
    }
}

func loadState(_ path: String) -> PublishedState {
    let data = try! Data(contentsOf: URL(fileURLWithPath: path))
    return try! JSONDecoder().decode(PublishedState.self, from: data)
}

/// Every message's fate, in order, and the snapshots sent.
@MainActor
final class Recorder {
    var reports: [LagoonWebHost.Report] = []
    var routed: [(LagoonIntent.Message, LagoonRouting)] {
        reports.compactMap { if case let .routed(message, routing) = $0 { return (message, routing) } else { return nil } }
    }
    var refused: [String] {
        reports.compactMap { if case let .refused(reason, _) = $0 { return reason } else { return nil } }
    }
}

/// The sink phase A must never reach.
@MainActor
final class Sink: LagoonActionSink {
    var calls: [String] = []
    func focusSession(_ sessionId: String) { calls.append("focusSession") }
    func markReviewViewed(sessionId: String, reviewId: String) { calls.append("markReviewViewed") }
    func openReview(sessionId: String, reviewId: String) { calls.append("openReview") }
    func reply(sessionId: String, text: String) { calls.append("reply") }
    func answer(sessionId: String, allow: Bool, approvalId: String) { calls.append("answer") }
    func pause(sessionId: String) { calls.append("pause") }
}

final class ParkedWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
func waitFor(_ seconds: TimeInterval, _ done: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if done() { return true }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return done()
}

@MainActor
func js(_ web: WKWebView, _ body: String, _ arguments: [String: Any] = [:]) async -> Any? {
    await withCheckedContinuation { continuation in
        web.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
            switch result {
            case let .success(value): continuation.resume(returning: value)
            case let .failure(error): continuation.resume(returning: ["error": error.localizedDescription])
            }
        }
    }
}

@MainActor
func page(bundle: URL, statePath: String, out: URL, kind: String) async {
    var state = loadState(statePath)
    let recorder = Recorder()
    let sink = Sink()
    let home = NSHomeDirectory()
    let host = LagoonWebHost(bundleRoot: bundle, environment: .init(
        source: { LagoonSnapshot.Source(state) },
        resolveLink: { LinkTarget.url(for: $0, cwd: $1) },
        flags: { LagoonActionFlags() },
        home: home,
        report: { recorder.reports.append($0) }
    ))
    host.sink = sink
    host.dataStore = .nonPersistent()
    let size = NSSize(width: 1280, height: 800)
    let window = ParkedWindow(contentRect: NSRect(origin: NSPoint(x: -30_000, y: -30_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.hasShadow = false
    window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
    let web = host.attach()
    web.frame = NSRect(origin: .zero, size: size)
    window.contentView = web
    let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if web.responds(to: occlusion) {
        typealias Setter = @convention(c) (NSObject, Selector, Bool) -> Void
        unsafeBitCast(web.method(for: occlusion), to: Setter.self)(web, occlusion, false)
    }
    window.orderFrontRegardless()
    host.setVisibility(LagoonVisibility(pageCurrent: true, windowVisible: true, appHidden: false))
    host.setLiveness("alive")

    let started = Date()
    let ready = await waitFor(kind == "real" ? 90 : 20) { recorder.routed.contains { $0.0.name == .ready } }
    Line.print("ready", ["ok": ready, "seconds": Date().timeIntervalSince(started), "url": web.url?.absoluteString ?? "",
                         "refused": recorder.refused, "readOnly": (web.url?.query ?? "").contains("readonly=1")])
    guard ready else { return }

    let expected = try! LagoonSnapshot(LagoonSnapshot.Source(state), home: home).jsonObject()

    if kind == "stub" {
        // `update` called with the encoded snapshot, after `setVisible`, with liveness after it.
        _ = await waitFor(5) { host.sentCount >= 1 }
        try? await Task.sleep(nanoseconds: 300_000_000)
        let calls = await js(web, "return window.__calls") as? [[String: Any]] ?? []
        let updates = calls.filter { $0["name"] as? String == "update" }
        let sent = updates.last?["snapshot"]
        Line.print("update", [
            "count": updates.count,
            "matches": sent.map { NSDictionary(dictionary: $0 as? [String: Any] ?? [:]).isEqual(to: expected as? [String: Any] ?? [:]) } ?? false,
            "order": calls.compactMap { $0["name"] as? String },
            "rows": ((sent as? [String: Any])?["rows"] as? [Any])?.count ?? -1,
            "hello": await js(web, "return window.__hello?.hello") as? String ?? "",
        ])

        // The same ts again: nothing. A newer one: sent, once the quarter second is up.
        host.offer(LagoonSnapshot.Source(state))
        try? await Task.sleep(nanoseconds: 400_000_000)
        let same = host.sentCount
        let newer = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: statePath))) as! [String: Any]
        var bumped = newer
        bumped["ts"] = (newer["ts"] as! Double) + 1000
        state = try! JSONDecoder().decode(PublishedState.self, from: JSONSerialization.data(withJSONObject: bumped))
        host.offer(LagoonSnapshot.Source(state))
        _ = await waitFor(3) { host.sentCount > same }
        // Unseen, nothing is sent; seen again, the latest is.
        host.setVisibility(LagoonVisibility(pageCurrent: false, windowVisible: true, appHidden: false))
        bumped["ts"] = (newer["ts"] as! Double) + 2000
        state = try! JSONDecoder().decode(PublishedState.self, from: JSONSerialization.data(withJSONObject: bumped))
        host.offer(LagoonSnapshot.Source(state))
        try? await Task.sleep(nanoseconds: 600_000_000)
        let whileHidden = host.sentCount
        let visibleAfterHide = await js(web, "return window.conchWorld.visible") as? Bool
        host.setVisibility(LagoonVisibility(pageCurrent: true, windowVisible: true, appHidden: false))
        _ = await waitFor(3) { host.sentCount > whileHidden }
        Line.print("pacing", ["sameTs": same, "afterNewer": whileHidden, "afterShown": host.sentCount, "visibleWhileHidden": visibleAfterHide as Any,
                              "visibleNow": await js(web, "return window.conchWorld.visible") as? Bool as Any])

        // focus reaches the page.
        let row = state.rows.first!.id
        host.focus(row)
        try? await Task.sleep(nanoseconds: 300_000_000)
        let focused = (await js(web, "return window.__calls.filter(c => c.name === 'focus').map(c => c.sessionId)") as? [String]) ?? []
        Line.print("focus", ["ids": focused])

        // The review route: a page's file with a byte range, the bare route sent on to its file, a plain file served as it
        // is, a stale review id, and every way out of the folder.
        let fetches = await js(web, """
            const go = async (url, headers = {}) => {
              try { const r = await fetch(url, { headers }); return { status: r.status, range: r.headers.get('content-range'), type: r.headers.get('content-type'), body: await r.text() }; }
              catch (e) { return { error: String(e) }; }
            };
            const out = {};
            for (const [k, u] of Object.entries(urls)) out[k] = await go(u, k === 'range' ? { Range: 'bytes=2-5' } : {});
            return out;
            """, ["urls": [
                "range": "conch-lagoon://lagoon/review/s-page/r-page/page.html",
                "bare": "conch-lagoon://lagoon/review/s-page/r-page",
                "image": "conch-lagoon://lagoon/review/s-page/r-page/img/dot.txt",
                "notes": "conch-lagoon://lagoon/review/s-page/r-notes",
                "stale": "conch-lagoon://lagoon/review/s-page/r-gone/page.html",
                "gone": "conch-lagoon://lagoon/review/s-nobody/r-page/page.html",
                "encoded": "conch-lagoon://lagoon/review/s-page/r-page/..%2F..%2Fsecret%2Fkeys.txt",
                "dots": "conch-lagoon://lagoon/review/s-page/r-page/%2e%2e/%2e%2e/secret/keys.txt",
                "literal": "conch-lagoon://lagoon/review/s-page/r-page/../../secret/keys.txt",
                "symlink": "conch-lagoon://lagoon/review/s-page/r-page/out/keys.txt",
                "web": "conch-lagoon://lagoon/review/s-page/r-web",
                "bundleOut": "conch-lagoon://lagoon/..%2F..%2Fsecret%2Fkeys.txt",
            ]])
        Line.print("fetch", ["results": fetches ?? NSNull()])
        let post = await js(web, """
            const r = await fetch('conch-lagoon://lagoon/data/hello.json', { method: 'POST', body: 'x' }).catch(e => ({ status: 'error ' + e }));
            return r.status;
            """)
        Line.print("post", ["status": post ?? NSNull()])

        // What the page says: checked, logged, and in phase A acted on by nothing, not even a valid one.
        let before = recorder.reports.count
        let noWindow = await js(web, """
            const h = window.webkit.messageHandlers.conchWorld;
            h.postMessage({ v: 1, name: 'focusSession', sessionId: id, readOnly: true });
            h.postMessage({ v: 1, name: 'reply', sessionId: id, text: 'hello', readOnly: true });
            h.postMessage({ v: 1, name: 'pause', sessionId: id, readOnly: true });
            h.postMessage({ v: 1, name: 'focusSession', sessionId: 'not-a-session' });
            h.postMessage({ v: 1, name: 'rm -rf' });
            const f = document.createElement('iframe');
            f.srcdoc = '<script>window.webkit.messageHandlers.conchWorld.postMessage({ v: 1, name: "focusSession", sessionId: "' + id + '" })<\\/script>';
            document.body.append(f);
            const opened = window.open('conch-lagoon://lagoon/index.html');
            return opened === null;
            """, ["id": row])
        // The frame's script runs when the frame loads, after the rest: wait for it.
        _ = await waitFor(5) {
            recorder.reports.count >= before + 6 && recorder.refused.contains("from a frame that isn't the lagoon's own")
        }
        let after = Array(recorder.reports[before...])
        Line.print("intents", [
            "routed": after.compactMap { if case let .routed(m, r) = $0 { return "\(m.name.rawValue):\(r)" } else { return nil } },
            "refused": after.compactMap { if case let .refused(reason, _) = $0 { return reason } else { return nil } },
            "sink": sink.calls,
            "noWindow": noWindow as? Bool ?? false,
        ])
        // Navigation: the page itself never leaves the lagoon.
        _ = await js(web, "location.href = 'https://example.com/'; return true")
        try? await Task.sleep(nanoseconds: 500_000_000)
        Line.print("navigation", ["url": web.url?.absoluteString ?? "", "refused": recorder.refused.filter { $0.hasPrefix("navigation") }])

        // Ten minutes unseen (here, at once): the web view goes, and a new one says ready for itself.
        host.drop()
        let readies = recorder.routed.filter { $0.0.name == .ready }.count
        let rebuilt = host.attach()
        rebuilt.frame = NSRect(origin: .zero, size: size)
        window.contentView = rebuilt
        let again = await waitFor(20) { recorder.routed.filter { $0.0.name == .ready }.count > readies }
        _ = await waitFor(3) { host.sentCount > 0 }
        let updatesAfter = (await js(rebuilt, "return window.__calls.filter(c => c.name === 'update').length") as? Int) ?? -1
        Line.print("rebuild", ["ready": again, "updates": updatesAfter, "sameView": rebuilt === web])
    } else {
        // The real lagoon: one crab per row, from the app's own snapshot.
        let ids = state.rows.map(\.id)
        var crabs: [[String: Any]] = []
        for _ in 0..<120 {
            crabs = await js(web, "return window.conchWorld?.state?.() ?? []") as? [[String: Any]] ?? []
            if crabs.count == ids.count { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        // Let it draw a moment before the picture.
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        crabs = await js(web, "return window.conchWorld?.state?.() ?? []") as? [[String: Any]] ?? []
        let version = await js(web, "return [window.conchWorld?.version, window.conchWorld?.mode, window.conchWorld?.readOnly]") as? [Any] ?? []
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let png = out.appendingPathComponent("lagoon-real.png")
        let image: NSImage? = await withCheckedContinuation { continuation in
            web.takeSnapshot(with: configuration) { image, _ in continuation.resume(returning: image) }
        }
        var wrote = false
        if let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            let rep = NSBitmapImageRep(cgImage: cg)
            if let data = rep.representation(using: .png, properties: [:]) { try? data.write(to: png); wrote = true }
        }
        Line.print("real", [
            "crabs": crabs.count,
            "rows": ids.count,
            "ids": crabs.compactMap { $0["id"] as? String }.sorted(),
            "expectedIds": ids.sorted(),
            "zones": crabs.compactMap { $0["zone"] as? String },
            "api": version,
            "png": wrote ? png.path : "",
            "sent": host.sentCount,
            "expectedRows": ((expected as? [String: Any])?["rows"] as? [Any])?.count ?? -1,
            "refused": recorder.refused,
        ])
    }
    window.orderOut(nil)
}

let arguments = CommandLine.arguments
switch arguments[1] {
case "snapshot":
    let state = loadState(arguments[2])
    let snapshot = LagoonSnapshot(LagoonSnapshot.Source(state), home: arguments[3])
    let data = try! JSONEncoder().encode(snapshot)
    print(String(decoding: data, as: UTF8.self))
    exit(0)
default:
    let app = NSApplication.shared
    // Never in the Dock, never in front: this process draws a page and nothing else.
    app.setActivationPolicy(.prohibited)
    DispatchQueue.main.asyncAfter(deadline: .now() + 200) {
        FileHandle.standardError.write("the harness ran out of time\n".data(using: .utf8)!)
        exit(3)
    }
    Task { @MainActor in
        await page(bundle: URL(fileURLWithPath: arguments[2]), statePath: arguments[3], out: URL(fileURLWithPath: arguments[4]), kind: arguments[5])
        exit(0)
    }
    app.run()
}
