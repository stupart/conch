import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";
import type { SessionInfo } from "../src/sessions.ts";

/**
 * A13 — clicking a doc link in the Mac app's conversation errored.
 *
 * Reproduced 2026-09-11: a Codex reply linked `output/x/review-guide.md`,
 * SwiftUI's default link action handed the schemeless URL to LaunchServices,
 * and Finder said "The application can't be opened. -50" (paramErr). Nothing
 * resolved the link against the session's folder, and nothing recorded the
 * failure. Two halves: the daemon says what folder a row runs in, and every
 * open site in the app goes through one door that shows the OS's own words
 * in the pane that was clicked and files an `open-link` record.
 */

const root = join(import.meta.dir, "..");
const macRoot = join(root, "mac-app", "conch-mac");
const mac = (name: string) => readFileSync(join(macRoot, name), "utf8");
const phoneRoot = join(root, "mobile", "conch-ios", "conch-ios");
const phone = (name: string) => readFileSync(join(phoneRoot, name), "utf8");

/** Every marker present — so a missing one fails by name — then in this order. */
function ordered(text: string, ...markers: string[]): void {
  for (const marker of markers) expect(text).toContain(marker);
  let at = 0;
  for (const marker of markers) {
    const next = text.indexOf(marker, at);
    expect(next, `out of order: ${marker}`).toBeGreaterThanOrEqual(at);
    at = next + marker.length;
  }
}

/** The text from `start` up to `end`, both required to be there. */
function slice(text: string, start: string, end: string): string {
  expect(text).toContain(start);
  const from = text.indexOf(start);
  expect(text.indexOf(end, from), `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, text.indexOf(end, from));
}

const publishedRows = (sessions: SessionInfo[]) =>
  buildPublishedState(
    "owner",
    buildPanelModel({
      sessions,
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    }),
    new Map(),
    new Set(),
    0,
  ).rows;

describe("the daemon says what folder a row runs in", () => {
  test("a Codex row carries its cwd; a session without one carries no key", () => {
    const rows = publishedRows([
      { sessionId: "codex-1", backend: "codex", cwd: "/Users/t/Projects/Blueprint", pid: 7 },
      { sessionId: "claude-1", backend: "claude" },
    ]);
    expect(rows.find((row) => row.id === "codex-1")?.cwd).toBe("/Users/t/Projects/Blueprint");
    expect("cwd" in rows.find((row) => row.id === "claude-1")!).toBe(false);
  });
});

describe("LinkTarget — the resolver every Mac open goes through", () => {
  // Foundation-only by design, so the real code runs here under `swift`
  // rather than being pinned by its spelling.
  const store = mac("StateStore.swift");
  const start = store.indexOf("enum LinkTarget {");
  const resolver = store.slice(start, store.indexOf("\n}\n", start) + 3);
  const swift = Bun.which("swift");

  test.skipIf(!swift)(
    "the reported link — a relative path in a Codex reply — resolves against the session's cwd",
    () => {
      // The case from 2026-09-11, end to end: the cwd the Mac resolves
      // against is the one the daemon published on the Codex row.
      const [codexRow] = publishedRows([
        { sessionId: "codex-blueprint", backend: "codex", cwd: "/Users/t/Projects/Blueprint", pid: 9 },
      ]);
      const rowCwd = JSON.stringify(codexRow?.cwd ?? "");
      const dir = mkdtempSync(join(tmpdir(), "conch-link-target-"));
      const file = join(dir, "main.swift");
      writeFileSync(file, [
        "import Foundation",
        resolver,
        `print(LinkTarget.url(for: "output/x/review-guide.md", cwd: ${rowCwd}).path)`,
        // Then the shapes around it.
        'print(LinkTarget.url(for: "./output/x/review-guide.md", cwd: "/Users/t/Projects/Blueprint").path)',
        'print(LinkTarget.url(for: "~/notes.md", cwd: "/Users/t/Projects/Blueprint").path)',
        'print(LinkTarget.url(for: "/Users/t/Blueprint Studio/guide.md", cwd: "/elsewhere").absoluteString)',
        'print(LinkTarget.url(for: "file:///Users/t/Blueprint%20Studio/guide.md", cwd: nil).path)',
        // Tyler's actual link, 2026-09-11: absolute, with the space encoded.
        'print(LinkTarget.url(for: "/Users/t/Blueprint/Asset%20Generator/review-guide.md", cwd: "/Users/t").path)',
        'print(LinkTarget.url(for: "/Users/t/100%.md", cwd: nil).path)',
        'print(LinkTarget.url(for: "https://example.com/x", cwd: "/Users/t").absoluteString)',
        'print(LinkTarget.text(of: URL(string: "docs/my%20doc.md")!))',
        'print(LinkTarget.text(of: URL(string: "https://example.com/x")!))',
        'print(LinkTarget.text(of: "plain" as Any))',
      ].join("\n"));
      try {
        const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
        expect(run.stdout.toString().trim().split("\n")).toEqual([
          "/Users/t/Projects/Blueprint/output/x/review-guide.md",
          "/Users/t/Projects/Blueprint/output/x/review-guide.md",
          `${process.env.HOME}/notes.md`,
          // Percent-encoded by URL(fileURLWithPath:), which a monorepo path with spaces needs.
          "file:///Users/t/Blueprint%20Studio/guide.md",
          "/Users/t/Blueprint Studio/guide.md",
          "/Users/t/Blueprint/Asset Generator/review-guide.md",
          "/Users/t/100%.md",
          "https://example.com/x",
          "docs/my doc.md",
          "https://example.com/x",
          "plain",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("every open site in the Mac app goes through the one door that reports (A13)", () => {
  const store = mac("StateStore.swift");
  const door = store.slice(
    store.indexOf("func openLink("),
    store.indexOf("private var errorStateSnapshot"),
  );

  test("the door: reachability in Foundation's words, no Finder alert, the OS's words to the pane and to errors.jsonl as open-link", () => {
    expect(door).toContain("LinkTarget.url(for: link, cwd: cwd)");
    expect(door).toContain("checkResourceIsReachable()");
    expect(door).toContain("configuration.promptsUserIfNeeded = false");
    expect(door).toContain('onFailure("\\(error.localizedDescription) — \\(target)")');
    expect(door).toContain('operation: "open-link"');
    expect(door).toContain("sessionId: rowId");
    // The URL or path and the row id, never file contents.
    expect(door).toContain('state: ["link": link, "target": target]');
    expect(door).not.toMatch(/contentsOf|Data\(|String\(contentsOf/);
    // The completion handler's error reaches the pane; it is not dropped.
    expect(door).toMatch(
      /NSWorkspace\.shared\.open\(url, configuration: configuration\) \{ _, error in\s*guard let error else \{ return \}\s*Task \{ @MainActor in fail\(error\) \}/,
    );
    expect(store).toMatch(/state extra: \[String: String\] = \[:\][\s\S]*?errorStateSnapshot\.merging\(extra\)/);
  });

  test("no other site in the app opens a link or reveals a file on its own", () => {
    const strays = readdirSync(macRoot)
      .filter((name) => name.endsWith(".swift"))
      .flatMap((name) => {
        const text = name === "StateStore.swift" ? mac(name).replace(door, "") : mac(name);
        // SwiftUI's `Link` and `.systemAction` open a URL too, and drop the
        // answer the same way (the remote Mac window had both).
        return (text.match(/NSWorkspace\.shared\.open\(|activateFileViewerSelecting\(|\bLink\([^\n]*destination:|\.systemAction\b/g) ?? [])
          .map((hit) => `${name}: ${hit}`);
      });
    expect(strays).toEqual([]);
  });

  test("the conversation stack resolves the agent's link against the session and shows the failure where it was clicked", () => {
    const stack = mac("ConversationStackView.swift");
    expect(stack).toContain(".environment(\\.openURL, OpenURLAction { url in");
    expect(stack).toContain("store.openLink(LinkTarget.text(of: url), cwd: cwd, rowId: conversation.sessionId)");
    expect(stack).toContain("LinkFailureLine(message: $linkFailure)");
    expect(stack).toContain("var cwd: String? = nil");
    // The failure line must not outlive the session it belongs to.
    expect(stack).toMatch(/onChange\(of: conversation\.sessionId\)[\s\S]*?linkFailure = nil/);
    // The dashboard hands the row's folder in, and the row decodes it.
    expect(mac("DashboardView.swift")).toContain("cwd: row.cwd,");
    expect(mac("Models.swift")).toContain("cwd = try? container.decodeIfPresent(String.self, forKey: .cwd)");
  });

  test("the deliverable pane's three buttons and its rendered document go through the door", () => {
    const review = mac("ReviewView.swift");
    expect(review).toContain('Button("Reveal in Finder") { open(url.path, reveal: true) }');
    expect(review).toContain('Button("Open in browser") { open(link) }');
    expect(review).toContain("onOpenInBrowser: { open(failure.url.absoluteString) }");
    expect(review).toContain("store.openLink(link, cwd: cwd, rowId: rowID, reveal: reveal) { linkFailure = $0 }");
    expect(review).toContain("content.overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }");
    // A link inside a rendered .md resolves against the document's own folder.
    expect(review).toContain("open(link, cwd: url.deletingLastPathComponent().path)");
    const document = review.slice(
      review.indexOf("private struct DeliverableDocumentView"),
      review.indexOf("private struct DeliverableImageView"),
    );
    expect(document).toContain("func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool");
    expect(document).toContain("onOpenLink(LinkTarget.text(of: link))");
    expect(document).toContain("textView.delegate = context.coordinator");
    expect(document).toContain("context.coordinator.onOpenLink = onOpenLink");
  });

  test("the fallback AppKit conversation renderer has a delegate too, and the failure shows under it", () => {
    const dashboard = mac("DashboardView.swift");
    const renderer = dashboard.slice(dashboard.indexOf("private struct ConversationTextView"));
    expect(renderer).toContain("func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool");
    expect(renderer).toContain("textView.delegate = context.coordinator");
    expect(renderer).toContain("context.coordinator.onOpenLink = onOpenLink");
    expect(dashboard).toContain("store.openLink(link, cwd: focusedRow?.cwd, rowId: focusedRow?.id)");
    expect(dashboard).toContain("LinkFailureLine(message: $fallbackLinkFailure)");
  });
});

describe("the Mac deliverable viewers say why a file would not show", () => {
  const review = mac("ReviewView.swift");

  test("a failure goes to the pane's line with the path, and to errors.jsonl as open-deliverable", () => {
    ordered(
      slice(review, "private func loadFailed(", "@ViewBuilder"),
      'linkFailure = "\\(error.localizedDescription) — \\(url.path)"',
      "store.reportAppError(",
      'operation: "open-deliverable"',
      "sessionId: rowID",
      'state: ["target": url.path]',
    );
    for (const viewer of [
      "DeliverableImageView(url: url, onFailure: { loadFailed(url, $0) })",
      "DeliverableVideoView(url: url, onFailure: { loadFailed(url, $0) })",
      "DeliverablePDFView(url: url, onFailure: { loadFailed(url, $0) })",
      "DeliverableDocumentView(url: url, renderMarkdown: true, onFailure: { loadFailed(url, $0) })",
      "DeliverableDocumentView(url: url, renderMarkdown: false, onFailure: { loadFailed(url, $0) })",
    ]) expect(review).toContain(viewer);
  });

  test("text: the read throws macOS's words instead of printing \"Couldn't read X.\"", () => {
    const document = slice(review, "private struct DeliverableDocumentView", "private struct DeliverableImageView");
    expect(document).not.toContain("Couldn't read");
    expect(document).not.toContain("FileHandle(");
    expect(document).toContain("private static func read(_ url: URL) throws -> String");
    expect(document).toContain("try Data(contentsOf: url, options: .alwaysMapped)");
    ordered(document, "content = try Self.read(url)", "} catch {", "DispatchQueue.main.async { onFailure(error) }");
  });

  test("image: a file NSImage refuses is reported, not only an icon", () => {
    ordered(
      slice(review, "private struct DeliverableImageView", "private struct ReviewPressButtonStyle"),
      "let image = NSImage(contentsOf: url)",
      "if image == nil {",
      "DeliverableLoadError.reason(url)",
      "DispatchQueue.main.async { onFailure(error) }",
      "view.imageView.image = image",
    );
  });

  test("PDF: a nil document is reported, once per file, instead of an empty pane", () => {
    const pdf = slice(review, "private struct DeliverablePDFView", "private struct DeliverableDocumentView");
    // documentURL is nil after a failure, so comparing it re-filed on every publication.
    expect(pdf).not.toContain("documentURL != url");
    ordered(
      pdf,
      "guard context.coordinator.loadedURL != url else { return }",
      "context.coordinator.loadedURL = url",
      "view.document = PDFDocument(url: url)",
      "if view.document == nil {",
      "DeliverableLoadError.reason(url)",
      "DispatchQueue.main.async { onFailure(error) }",
    );
  });

  test("video: the player item's failed status is read, and the observation is kept alive", () => {
    const video = slice(review, "private struct DeliverableVideoView", "private struct DeliverablePDFView");
    expect(video).not.toContain("AVPlayer(url: url)");
    expect(video.match(/view\.player = player\(context\.coordinator\)/g)).toHaveLength(2);
    ordered(
      video,
      "var status: NSKeyValueObservation?",
      "let item = AVPlayerItem(url: url)",
      "coordinator.status = item.observe(\\.status)",
      "guard item.status == .failed, let error = item.error else { return }",
      "DispatchQueue.main.async { onFailure(error) }",
      "return AVPlayer(playerItem: item)",
    );
  });

  const swift = Bun.which("swift");
  test.skipIf(!swift)(
    "DeliverableLoadError gives macOS's own reason — run under swift",
    () => {
      const start = review.indexOf("enum DeliverableLoadError {");
      expect(start).toBeGreaterThan(-1);
      const source = review.slice(start, review.indexOf("\n}\n", start) + 3);
      const dir = mkdtempSync(join(tmpdir(), "conch-deliverable-"));
      const locked = join(dir, "locked.txt");
      writeFileSync(join(dir, "broken.pdf"), "not a pdf");
      writeFileSync(locked, "x");
      chmodSync(locked, 0o000);
      const file = join(dir, "main.swift");
      writeFileSync(file, [
        "import Foundation",
        source,
        `for name in ["broken.pdf", "locked.txt", "gone.png"] {`,
        `    print(DeliverableLoadError.reason(URL(fileURLWithPath: ${JSON.stringify(dir)} + "/" + name)).localizedDescription)`,
        "}",
      ].join("\n"));
      try {
        const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
        expect(run.stdout.toString().trim().split("\n")).toEqual([
          // Bytes that read fine but the renderer refused.
          "The file “broken.pdf” couldn’t be opened because it isn’t in the correct format.",
          // "to view it" — FileHandle would have said "to save the file".
          "The file “locked.txt” couldn’t be opened because you don’t have permission to view it.",
          "The file “gone.png” couldn’t be opened because there is no such file.",
        ]);
      } finally {
        chmodSync(locked, 0o600);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("Relaunch says why it didn't, instead of quitting into nothing", () => {
  test("quit only on success; otherwise macOS's words in the stale-build line and a relaunch record", () => {
    const relaunch = slice(mac("StateStore.swift"), "func relaunchForNewBuild()", "private func updateNewerDaemonWarning()");
    // The error was `_`, and the app quit whether or not the new one opened.
    expect(relaunch).not.toContain("{ _, _ in");
    expect(relaunch.match(/NSApp\.terminate\(nil\)/g)).toHaveLength(1);
    ordered(
      relaunch,
      "NSWorkspace.shared.openApplication(at: bundle, configuration: configuration) { _, error in",
      "guard let error else { NSApp.terminate(nil); return }",
      'self.relaunchFailure = "Couldn\'t relaunch: \\(error.localizedDescription) — \\(bundle.path)"',
      'operation: "relaunch"',
      'state: ["target": bundle.path]',
    );
    expect(mac("DashboardView.swift")).toContain(
      'Text(store.relaunchFailure ?? "A newer conch is installed — this window is still running the old one.")',
    );
  });
});

describe("the remote Mac window's web links go through the door", () => {
  test("the review link and a web link in remote prose both open through openLink and show a failure", () => {
    const views = mac("RemoteMacViews.swift");
    const session = views.slice(views.indexOf("struct RemoteSessionView:"));
    expect(session).toContain('Button(review.summary.isEmpty ? "Open review" : review.summary) { openWeb(url) }');
    ordered(
      session,
      'guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }',
      "openWeb(url)",
      "return .handled",
    );
    ordered(
      session,
      "private func openWeb(_ url: URL) {",
      "linkFailure = nil",
      "store.openLink(url.absoluteString, cwd: nil, rowId: nil) { linkFailure = $0 }",
    );
    expect(session).toContain("LinkFailureLine(message: $linkFailure)");
  });
});

describe("the phone: the same dead tap, said and recorded", () => {
  const bridge = phone("BridgeClient.swift");
  const door = slice(bridge, "func openLink(", "/// Hide or restore one ledger row");

  test("one door: a path says it lives on the Mac, a refused link says so too, both filed as open-link", () => {
    expect(door).toContain("func openLink(_ url: URL, sessionId: String?, onFailure: @escaping @MainActor (String) -> Void)");
    ordered(door, "func fail(", "onFailure(message)", 'reportAppError(operation: "open-link", message: message, sessionId: sessionId)');
    ordered(
      door,
      "guard url.scheme != nil, !url.isFileURL else {",
      'fail("That\'s a file on your Mac, not a page: \\(url.path)")',
      "return",
      "UIApplication.shared.open(url) { opened in",
      'if !opened { fail("iPhone couldn\'t open \\(url.absoluteString)") }',
    );
  });

  test("the conversation goes through the door and shows the failure where it was tapped", () => {
    const stack = phone("ConversationStack.swift");
    expect(stack).not.toContain("failLink");
    expect(stack).toContain("LinkFailureLine(message: $linkFailure)");
    ordered(
      stack,
      ".environment(\\.openURL, OpenURLAction { url in",
      "linkFailure = nil",
      "bridge.openLink(url, sessionId: conversation.sessionId) { linkFailure = $0 }",
      "return .handled",
    );
  });

  test("the deliverable sheet: fetch, text, PDF and page failures say why and are filed; a rendered .md's links take the door", () => {
    const sheet = phone("DeliverableSheet.swift");
    expect(sheet).not.toContain("localFailed");
    expect(phone("SessionView.swift")).toContain("DeliverableSheet(bridge: bridge, review: review, sessionId: sessionId)");
    ordered(
      slice(sheet, "private func fail(_ reason: String) {", "private func unavailableView"),
      'let message = "\\(reason) — \\(review.link ?? "")"',
      "failure = message",
      'operation: "open-deliverable"',
      "sessionId: sessionId",
    );
    expect(sheet).toContain(".overlay { if let failure { unavailableView(failure).background(Palette.bg) } }");
    // The fetch: the bridge's reason, not "couldn't be fetched" alone.
    ordered(
      sheet,
      "let downloaded = await bridge.downloadFile(path: link)",
      "if downloaded == nil {",
      'fail("Couldn\'t fetch this from your Mac: \\(bridge.lastError',
    );
    for (const call of [
      "BridgedWebView(url: url, onFailure: fail)",
      "BridgedPDFView(url: url, onFailure: fail)",
      "RemoteDocumentView(url: url, renderMarkdown: true, onFailure: fail)",
      "RemoteDocumentView(url: url, renderMarkdown: false, onFailure: fail)",
      "LocalPageView(url: url, onFailure: fail)",
    ]) expect(sheet).toContain(call);
    // Text and markdown: the read's own error, not a line that hid it.
    const document = slice(sheet, "private struct RemoteDocumentView", "private struct BridgedWebView");
    expect(document).not.toContain("failed = true");
    ordered(document, "} catch {", "onFailure(error.localizedDescription)");
    // PDF: PDFKit's nil is said, not left blank.
    ordered(
      slice(sheet, "private struct BridgedPDFView", "private final class PageLoadFailure"),
      "if let document {",
      "} else {",
      "onFailure(CocoaError(.fileReadCorruptFile).localizedDescription)",
    );
    // A web page and a local page both have a delegate that hears the failure.
    for (const page of [
      slice(sheet, "private struct BridgedWebView", "private struct LocalPageView"),
      slice(sheet, "private struct LocalPageView", "private struct BridgedPDFView"),
    ]) ordered(page, "view.navigationDelegate = context.coordinator", "context.coordinator.onFailure = onFailure", "view.load");
    const delegate = slice(sheet, "private final class PageLoadFailure", "struct LinkFailureLine");
    expect(delegate).toContain("didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {");
    expect(delegate).toContain("didFail navigation: WKNavigation!, withError error: Error) {");
    ordered(delegate, "guard (error as NSError).code != NSURLErrorCancelled else { return }", "onFailure(error.localizedDescription)");
    // A link in a rendered .md behaves like one in the conversation.
    ordered(
      sheet,
      ".environment(\\.openURL, OpenURLAction { url in",
      "linkFailure = nil",
      "bridge.openLink(url, sessionId: sessionId) { linkFailure = $0 }",
      "return .handled",
    );
    expect(sheet).toContain("LinkFailureLine(message: $linkFailure)");
  });

  test("the Settings button's result is no longer ignored", () => {
    const session = phone("SessionView.swift");
    ordered(
      slice(session, 'Button("Open Settings")', ".foregroundStyle(Palette.micOpen)"),
      "URL(string: UIApplication.openSettingsURLString)",
      "settingsFailure = nil",
      "bridge.openLink(url, sessionId: sessionId) { settingsFailure = $0 }",
    );
    ordered(session, 'Button("Open Settings")', "if let settingsFailure {", "Text(settingsFailure)");
  });

  test("no other site on the phone opens a link on its own", () => {
    const strays = readdirSync(phoneRoot)
      .filter((name) => name.endsWith(".swift"))
      .flatMap((name) => {
        const text = name === "BridgeClient.swift" ? bridge.replace(door, "") : phone(name);
        return (text.match(/UIApplication\.shared\.open\(|\.systemAction\b|\bLink\([^\n]*destination:/g) ?? [])
          .map((hit) => `${name}: ${hit}`);
      });
    expect(strays).toEqual([]);
  });
});
