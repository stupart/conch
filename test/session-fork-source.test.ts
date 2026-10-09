import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Forking from the apps (2026-10-09): every place a session's actions are offered, and the daemon's two halves.
const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("the daemon forks on request and adopts the fork when it appears", () => {
  const daemon = read("src/daemon.ts");
  expect(daemon).toContain("    fork: forkLiveSession,");
  expect(daemon).toContain("if (pendingForks.length) void adoptForks(visible);");
  // Declared before any render reads it.
  expect(daemon.indexOf("const pendingForks: PendingFork[] = [];")).toBeLessThan(daemon.indexOf("if (pendingForks.length) void adoptForks(visible);"));
  expect(read("src/control-server.ts")).toContain('kind: "session-forked"');
});

test("the Mac offers Fork in the session's menu, the sidebar row's, and the command palette", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  expect(dashboard).toContain('Button("Fork session") {\n                        store.forkSession(row)');
  expect(dashboard).toContain('Button("Fork", action: onFork)');
  expect(dashboard).toContain("onFork: row.canFork ? { actions.onFork(row) } : nil,");
  expect(read("mac-app/conch-mac/ContentView.swift")).toContain("onFork: { store.forkSession($0) },");
  expect(read("mac-app/conch-mac/CommandPaletteView.swift")).toContain("case .fork: store.forkSession(row)");
  expect(read("mac-app/conch-mac/StateStore.swift")).toContain("ConchSessionForkRequest(sessionId: row.id)");
});

test("the phone offers Fork in a session's long-press menu", () => {
  expect(read("mobile/conch-ios/conch-ios/LedgerView.swift")).toContain("await bridge.forkSession(sessionId: row.id)");
  expect(read("mobile/conch-ios/conch-ios/BridgeClient.swift")).toContain('"kind": "session-fork",');
});
