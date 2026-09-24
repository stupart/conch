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
      /NSWorkspace\.shared\.open\(url, configuration: configuration\) \{ app, error in[\s\S]*?guard let error else \{ Task \{ @MainActor in onOpened\(opener\) \}; return \}\s*Task \{ @MainActor in fail\(error\) \}/,
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

  test("the deliverable pane's two buttons and its rendered document go through the door", () => {
    const review = mac("ReviewView.swift");
    expect(review).toContain('Button("Reveal in Finder") { open(url.path, reveal: true) }');
    // Two, not three. "Open in browser" duplicated the header arrow one row above it, and the
    // arrow was the one getting it WRONG — it opened the filed link while the button opened
    // where you actually were. The arrow now takes the live address, so the invariant survives
    // the control that carried it. This one stays: recovering a page that FAILED to load is a
    // different job from leaving a page that works.
    expect(review).toContain("onOpenInBrowser: { open(failure.url.absoluteString) }");
    // BOTH halves, because either alone is a silent revert to the old bug.
    //
    // The pane must PUBLISH where it is — on a followed link, on a typed address, and on
    // first appearance — or `liveAddress` stays nil forever and the arrow quietly falls back
    // to the filed link with every test still green.
    // COUNTED, not contained: it appears on navigate and on appear, so a `toContain` would
    // still pass with one of them deleted and the address silently stale on arrival.
    expect((review.match(/liveAddress = addressText/g) ?? []).length).toBe(2);
    expect(review).toContain("liveAddress = target");
    // ...and the owner must PREFER it. Pinning only ReviewView's side would let the pane hand
    // up the right address to a caller that ignored it.
    expect(mac("DashboardView.swift")).toContain("let target = deliverableAddress ?? link");
    // The PANE owns it, so ⌘3 — which posts a notification the pane answers — opens the same
    // address the arrow does. Held as @State here it was invisible to that handler.
    expect(mac("DashboardView.swift")).toContain("@State private var deliverableAddress: String?");
    expect(mac("DashboardView.swift")).toContain("liveAddress: $deliverableAddress");
    // Cleared on both routes back, or a web address outlives the deliverable that published it
    // and the arrow opens the wrong thing. Only `case .web` ever sets it, so nothing else can
    // overwrite a stale value.
    expect(mac("DashboardView.swift")).toContain(
      ".onChange(of: selectedReview.id) { _, _ in deliverableAddress = nil }",
    );
    expect(mac("DashboardView.swift")).toContain(".onAppear { deliverableAddress = nil }");
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
    // The fallback renderer moved to its own file; the pane that hosts it did not.
    const fallback = mac("TranscriptFallback.swift");
    const renderer = fallback.slice(fallback.indexOf("struct ConversationTextView"));
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

  test("a missing deliverable is filed as open-deliverable with its path, not only shown", () => {
    ordered(
      slice(review, "case let .missing(url):", "case .web:"),
      'Text("Couldn\'t find \\(url.lastPathComponent)")',
      ".onAppear {",
      "store.reportAppError(",
      'operation: "open-deliverable"',
      'message: "Couldn\'t find \\(url.lastPathComponent)"',
      "sessionId: rowID",
      'state: ["target": url.path]',
    );
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
    // The stale-build line is one of the notices now.
    expect(mac("Notices.swift")).toContain(
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
  const swift = Bun.which("swift");

  // `/file` + `downloadFile` (BridgeClient.swift) can materialize a Mac file
  // now, so "a path is a file on the Mac, which the phone cannot open" is no
  // longer true — a currently PUBLISHED path can be shown; the door's job is
  // routing a file to whichever caller can show one and refusing honestly
  // where none can, not refusing every file outright.
  test("one door: a file goes to a caller that can show it, everything else opens or is honestly refused, all filed as open-link", () => {
    expect(door).toContain(
      "func openLink(_ url: URL, sessionId: String?, onFile: (@MainActor (String) -> Void)? = nil, onFailure: @escaping @MainActor (String) -> Void)",
    );
    ordered(door, "func fail(", "onFailure(message)", 'reportAppError(operation: "open-link", message: message, sessionId: sessionId)');
    ordered(
      door,
      "switch LinkRoute.decide(url) {",
      "case .invalid:",
      'fail("iPhone couldn\'t open \\(url.absoluteString).")',
      "case let .file(path):",
      "guard let onFile else {",
      'fail("That\'s a file on your Mac. Tap it in the conversation or a review to see it here.")',
      "return",
      "onFile(path)",
      "case .open:",
      "UIApplication.shared.open(url) { opened in",
      'if !opened { fail("iPhone couldn\'t open \\(url.absoluteString)") }',
    );
  });

  test.skipIf(!swift)(
    "LinkRoute.decide — no scheme is invalid, file:// is a path to try, anything else opens — run under swift",
    () => {
      // Foundation-only by design, so the real branching runs here rather
      // than being pinned by its spelling (LinkTarget, MacLocalPage's own rule).
      const route = slice(bridge, "enum LinkRoute: Equatable {", "/// One door for every link the phone opens");
      const dir = mkdtempSync(join(tmpdir(), "conch-link-route-"));
      const file = join(dir, "main.swift");
      writeFileSync(
        file,
        [
          "import Foundation",
          route,
          "func show(_ s: String) {",
          "  switch LinkRoute.decide(URL(string: s)!) {",
          '  case .invalid: print("invalid")',
          '  case let .file(path): print("file:\\(path)")',
          '  case .open: print("open")',
          "  }",
          "}",
          // Tyler's actual link, from the Mac's errors.jsonl (2026-09-17):
          // absolute, with the space percent-encoded, in a file:// URI.
          'show("file:///Users/t/Blueprint/Asset%20Generator/review.md")',
          'show("https://example.com/x")',
          'show("http://localhost:5173")',
          'show("mailto:t@example.com")',
          'show("not-a-url-at-all")',
        ].join("\n"),
      );
      try {
        const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
        expect(run.stdout.toString().trim().split("\n")).toEqual([
          "file:/Users/t/Blueprint/Asset Generator/review.md",
          "open",
          "open",
          "open",
          "invalid",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("downloadFile gives a 403 its own honest reason: unpublished, not a server error", () => {
    // The bridge's /file rule (phone-bridge.ts `servableFile`) 403s a path
    // conch isn't sending the phone — the only way a file link can fail once
    // `onFile` has tried it. "The Mac returned HTTP 403." reads as a bug; this
    // says what happened and why, before every other status keeps the
    // transport's own words.
    const download = slice(bridge, "func downloadFile(path: String) async -> URL? {", "private func authorizedRequest");
    ordered(download, "return try await fetchFile(path: path)", "} catch {", "lastError = Self.fileFailure(error)", "return nil");
    ordered(
      slice(download, "static func fileFailure(_ error: Error) -> String {", "\n    }\n"),
      "case BridgeTransportError.httpStatus(403):",
      '"conch only sends your phone what a session published, from its own folder or a temp folder, "',
      '"and this file isn\'t one of those. Ask the session to publish it."',
      "case BridgeTransportError.httpStatus(404):",
      "default:",
      "error.localizedDescription",
    );
  });

  test("the conversation goes through the door, opens a published file as a deliverable, and shows any other failure where it was tapped", () => {
    const stack = phone("ConversationStack.swift");
    expect(stack).not.toContain("failLink");
    expect(stack).toContain("LinkFailureLine(message: $linkFailure)");
    ordered(
      stack,
      ".environment(\\.openURL, OpenURLAction { url in",
      "linkFailure = nil",
      "bridge.openLink(url, sessionId: conversation.sessionId, onFile: { openFile = FileLink(id: $0) }) { linkFailure = $0 }",
      "return .handled",
    );
    ordered(
      stack,
      ".sheet(item: $openFile) { file in",
      "FileLinkSheet(bridge: bridge, path: file.id, sessionId: conversation.sessionId)",
    );
    // A different session leaves neither a stale failure nor a stale sheet.
    ordered(stack, ".onChange(of: conversation.sessionId)", "linkFailure = nil", "openFile = nil");
  });

  test("the deliverable sheet: fetch, text, PDF and page failures say why and are filed; a rendered .md's links take the door", () => {
    const sheet = phone("DeliverableSheet.swift");
    expect(sheet).not.toContain("localFailed");
    expect(phone("SessionView.swift")).toContain("ReviewSheet(bridge: bridge, talk: talk, sessionId: sessionId)");
    expect(sheet).toContain("DeliverableSheet(bridge: bridge, review: review, sessionId: sessionId)");
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
      "BridgedWebView(url: url, page: page, onFailure: fail)",
      "QuickLookView(url: url, fullScreen: $markingUp, onFailure: fail)",
      "RemoteDocumentView(url: url, renderMarkdown: true, document: review.link, bridge: bridge, onFailure: fail)",
      "RemoteDocumentView(url: url, renderMarkdown: false, onFailure: fail)",
      "LocalPageView(handler: .page(review.link ?? \"\", entry: url, bridge: bridge), url: url, page: page, onFailure: fail)",
    ]) expect(sheet).toContain(call);
    // Text and markdown: the read's own error, not a line that hid it.
    const document = slice(sheet, "private struct RemoteDocumentView", "private struct BridgedWebView");
    expect(document).not.toContain("failed = true");
    ordered(document, "} catch {", "onFailure(error.localizedDescription)");
    // A web page and a local page both have a delegate that hears the failure,
    // and one that opens a link asking for a new window.
    for (const page of [
      slice(sheet, "private struct BridgedWebView", "private struct LocalPageView"),
      slice(sheet, "private struct LocalPageView", "private final class PageLoadFailure"),
    ]) ordered(
      page,
      "view.navigationDelegate = context.coordinator",
      "view.uiDelegate = context.coordinator",
      "context.coordinator.onFailure = onFailure",
      "view.load",
    );
    const delegate = slice(sheet, "private final class PageLoadFailure", "struct LinkFailureLine");
    expect(delegate).toContain("didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {");
    expect(delegate).toContain("didFail navigation: WKNavigation!, withError error: Error) {");
    ordered(delegate, "guard (error as NSError).code != NSURLErrorCancelled else { return }", "onFailure(error.localizedDescription)");
    // A link in a rendered .md behaves like one in the conversation: a
    // currently published file opens as a deliverable too — nested, the same
    // sheet a link tapped anywhere else opens.
    ordered(
      sheet,
      ".environment(\\.openURL, OpenURLAction { url in",
      "linkFailure = nil",
      "bridge.openLink(url, sessionId: sessionId, onFile: { openFile = FileLink(id: $0) }) { linkFailure = $0 }",
      "return .handled",
    );
    ordered(sheet, ".sheet(item: $openFile) { file in", "FileLinkSheet(bridge: bridge, path: file.id, sessionId: sessionId)");
    expect(sheet).toContain("LinkFailureLine(message: $linkFailure)");
  });

  test("FileLinkSheet reuses DeliverableSheet for a tapped file — no second renderer, dismissible", () => {
    const sheet = phone("DeliverableSheet.swift");
    // Not a second viewer: a synthetic review carrying only the path, into
    // the exact same struct every ledger deliverable renders through.
    const wrapper = slice(sheet, "struct FileLinkSheet: View {", "private struct QuickLookView");
    ordered(
      wrapper,
      "NavigationStack {",
      "DeliverableSheet(bridge: bridge, review: .init(link: path), sessionId: sessionId)",
      'Button("Done") { dismiss() }',
    );
    expect(sheet).toContain("struct FileLink: Identifiable { let id: String }");
    // Only one struct in the file constructs a DeliverableSheet by hand — the
    // ledger's own ReviewSheet and this wrapper — never a duplicate renderer.
    expect((sheet.match(/DeliverableSheet\(bridge: bridge, review:/g) ?? []).length).toBe(2);
  });

  test("image, PDF and video open in Quick Look, and a file it can't preview says why and is filed", () => {
    const sheet = phone("DeliverableSheet.swift");
    ordered(
      slice(sheet, "case .image, .video, .pdf:", "case .markdown:"),
      "QuickLookView(url: url, fullScreen: $markingUp, onFailure: fail)",
    );
    const quickLook = slice(sheet, "private struct QuickLookView", "/// Markdown and text deliverables");
    // Quick Look draws its own "can't preview" page and reports nothing.
    ordered(
      quickLook,
      "if !QLPreviewController.canPreview(url as NSURL) {",
      'onFailure("Quick Look can\'t open this \\(ext) file")',
    );
    // Full screen is where Share and Markup live; Markup edits the downloaded copy.
    ordered(quickLook, "let full = QLPreviewController()", "full.delegate = context.coordinator", "controller.present(full, animated: true)");
    expect(quickLook).toContain(".updateContents");
    expect(sheet).not.toContain("private struct LocalImageView");
    expect(sheet).not.toContain("private struct BridgedPDFView");
  });

  test("a conversation image that won't download says why on its row and files load-image", () => {
    const stack = phone("ConversationStack.swift");
    expect(stack).toContain(
      "MaterialRow(bridge: bridge, material: item.material, fallback: item.text, sessionId: conversation.sessionId)",
    );
    const row = slice(stack, "private struct MaterialRow", "private func removeTemporaryFile()");
    ordered(
      row,
      "let downloaded = await bridge.downloadFile(path: path)",
      "guard let url = downloaded else {",
      'fail("Couldn\'t load the image from your Mac: \\(bridge.lastError ?? "it sent nothing back.")", path: path)',
      "temporaryURL = url",
    );
    ordered(
      row,
      "private func fail(_ reason: String, path: String) {",
      'let message = "\\(reason) — \\(path)"',
      "failure = message",
      'reportAppError(operation: "load-image", message: message, sessionId: sessionId)',
    );
    ordered(row, "if let failure {", "Text(failure)", "} else if !detail.isEmpty {");
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
