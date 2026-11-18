import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      { sessionId: "codex-1", backend: "codex", cwd: "/Users/t/Projects/Acme", pid: 7 },
      { sessionId: "claude-1", backend: "claude" },
    ]);
    expect(rows.find((row) => row.id === "codex-1")?.cwd).toBe("/Users/t/Projects/Acme");
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
        { sessionId: "codex-acme", backend: "codex", cwd: "/Users/t/Projects/Acme", pid: 9 },
      ]);
      const rowCwd = JSON.stringify(codexRow?.cwd ?? "");
      const dir = mkdtempSync(join(tmpdir(), "conch-link-target-"));
      const file = join(dir, "main.swift");
      writeFileSync(file, [
        "import Foundation",
        resolver,
        `print(LinkTarget.url(for: "output/x/review-guide.md", cwd: ${rowCwd}).path)`,
        // Then the shapes around it.
        'print(LinkTarget.url(for: "./output/x/review-guide.md", cwd: "/Users/t/Projects/Acme").path)',
        'print(LinkTarget.url(for: "~/notes.md", cwd: "/Users/t/Projects/Acme").path)',
        'print(LinkTarget.url(for: "/Users/t/Acme Studio/guide.md", cwd: "/elsewhere").absoluteString)',
        'print(LinkTarget.url(for: "file:///Users/t/Acme%20Studio/guide.md", cwd: nil).path)',
        // Tyler's actual link, 2026-09-11: absolute, with the space encoded.
        'print(LinkTarget.url(for: "/Users/t/Acme/Web%20App/review-guide.md", cwd: "/Users/t").path)',
        'print(LinkTarget.url(for: "/Users/t/100%.md", cwd: nil).path)',
        'print(LinkTarget.url(for: "https://example.com/x", cwd: "/Users/t").absoluteString)',
        'print(LinkTarget.text(of: URL(string: "docs/my%20doc.md")!))',
        'print(LinkTarget.text(of: URL(string: "https://example.com/x")!))',
        'print(LinkTarget.text(of: "plain" as Any))',
        // A heading in the same text stays a link to it: as an empty path it resolved to the folder and opened Finder.
        'print(LinkTarget.text(of: URL(string: "#headline-findings")!))',
        'print(LinkTarget.text(of: URL(string: "other.md#headline-findings")!))',
      ].join("\n"));
      try {
        const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
        expect(run.stdout.toString().trim().split("\n")).toEqual([
          "/Users/t/Projects/Acme/output/x/review-guide.md",
          "/Users/t/Projects/Acme/output/x/review-guide.md",
          `${process.env.HOME}/notes.md`,
          // Percent-encoded by URL(fileURLWithPath:), which a monorepo path with spaces needs.
          "file:///Users/t/Acme%20Studio/guide.md",
          "/Users/t/Acme Studio/guide.md",
          "/Users/t/Acme/Web App/review-guide.md",
          "/Users/t/100%.md",
          "https://example.com/x",
          "docs/my doc.md",
          "https://example.com/x",
          "plain",
          "#headline-findings",
          "other.md",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("the Mac's one door for opening a link files what it opened, never what is in it", () => {
  test("an open-link record carries the link and its target, not file contents", () => {
    const store = mac("StateStore.swift");
    const door = slice(store, "func openLink(", "private var errorStateSnapshot");
    expect(door).toContain('operation: "open-link"');
    expect(door).toContain('state: ["link": link, "target": target]');
    expect(door).not.toMatch(/contentsOf|Data\(|String\(contentsOf/);
  });
});

describe("the Mac deliverable viewers say why a file would not show", () => {
  const review = mac("ReviewView.swift");
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

describe("the phone routes a tapped link", () => {
  const bridge = phone("BridgeClient.swift");
  const swift = Bun.which("swift");

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
          '  case let .atlas(page): print("atlas:\\(page)")',
          "  }",
          "}",
          // Tyler's actual link, from the Mac's errors.jsonl (2026-09-17):
          // absolute, with the space percent-encoded, in a file:// URI.
          'show("file:///Users/t/Acme/Web%20App/review.md")',
          'show("https://example.com/x")',
          'show("http://localhost:5173")',
          'show("mailto:t@example.com")',
          'show("not-a-url-at-all")',
          // A wiki link in an Atlas page, as the shared renderer writes it (`AtlasLink`).
          'show("atlas:projects/index")',
          'show("atlas:projects/acme/plan.md%23next-steps")',
        ].join("\n"),
      );
      try {
        const run = Bun.spawnSync([swift!, file], { stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(`swift exited ${run.exitCode}: ${run.stderr.toString()}`);
        expect(run.stdout.toString().trim().split("\n")).toEqual([
          "file:/Users/t/Acme/Web App/review.md",
          "open",
          "open",
          "open",
          "invalid",
          "atlas:projects/index",
          "atlas:projects/acme/plan",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
