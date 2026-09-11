import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const phone = (name: string) =>
  readFileSync(join(root, "mobile", "conch-ios", "conch-ios", name), "utf8");

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
        return (text.match(/NSWorkspace\.shared\.open\(|activateFileViewerSelecting\(/g) ?? [])
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

describe("the phone: the same dead tap, said and recorded", () => {
  test("a path link says it lives on the Mac and files open-link; a refused web link says so too", () => {
    const stack = phone("ConversationStack.swift");
    expect(stack).toContain(".environment(\\.openURL, OpenURLAction { url in");
    expect(stack).toContain("That's a file on your Mac, not a page:");
    expect(stack).toMatch(/UIApplication\.shared\.open\(url\) \{ opened in\s*if !opened \{ failLink\(/);
    expect(stack).toContain('operation: "open-link"');
    expect(stack).toContain("sessionId: conversation.sessionId");
  });
});
