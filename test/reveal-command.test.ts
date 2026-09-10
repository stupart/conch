import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySessionCommand } from "../src/control-server.ts";
import type { SessionActionsController, SessionActionsTarget } from "../src/session-actions-overlay.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function harness(target: SessionActionsTarget | null) {
  const revealed: SessionActionsTarget[] = [];
  const controller = {
    reveal: (t: SessionActionsTarget) => {
      revealed.push(t);
      return new Promise<boolean>(() => {}); // never settles: the reply must not wait on AppleScript
    },
  } as unknown as SessionActionsController;
  const pause = { open: () => {}, close: () => {} };
  return {
    revealed,
    reply: () => applySessionCommand(
      { kind: "session-command", sessionId: "s1", command: "reveal" },
      { controller, pause, targetForSessionId: () => target },
    ),
  };
}

/**
 * Click a session's title to bring its window to the front (C10). The raise
 * is `revealSessionWindow`, which `revealOnTurn` already uses; what is new is
 * a socket command for it. The ack says whether there was a process to try —
 * a session conch only observes has nothing to raise — and it comes back
 * before the AppleScript does, because a click must not block on Terminal.
 */
test("reveal asks the controller and acks by whether there was a process to try", () => {
  const withPid = harness({ sessionId: "s1", label: "arch", pid: 4242 });
  expect(withPid.reply()).toEqual({
    kind: "session-ack", sessionId: "s1", command: "reveal", changed: true, label: "arch",
  });
  expect(withPid.revealed).toEqual([{ sessionId: "s1", label: "arch", pid: 4242 }]);

  const observed = harness({ sessionId: "s1", label: "arch" });
  expect(observed.reply().kind).toBe("session-ack");
  expect((observed.reply() as { changed: boolean }).changed).toBe(false);

  const unknown = harness(null);
  expect((unknown.reply() as { changed: boolean }).changed).toBe(false);
});

test("the daemon raises through revealSessionWindow, and only for a known process", () => {
  const daemon = read("src/daemon.ts");
  expect(daemon).toContain(
    "reveal: (target) => target.pid ? revealSessionWindow(target.pid) : Promise.resolve(false),",
  );
  const panel = read("src/panel.ts");
  expect(panel).toContain("...(session.pid ? { revealable: true } : {}),");
  expect(panel).toContain("...(row.revealable ? { revealable: true as const } : {}),");
});

test("the Mac app makes the title a button only when the row says it can be raised", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const at = dashboard.indexOf("private func sessionBar(for row: SessionRow) -> some View {");
  expect(at).toBeGreaterThan(-1);
  const bar = dashboard.slice(at, at + 900);
  expect(bar).toContain("if row.revealable {");
  expect(bar).toContain("Button { store.reveal(row) } label: { sessionTitle(row) }");
  const store = read("mac-app/conch-mac/StateStore.swift");
  expect(store).toContain("guard row.revealable else { return }");
  expect(store).toContain("ConchSessionCommandRequest(sessionId: row.id, command: .reveal)");
  expect(read("mac-app/conch-mac/Models.swift"))
    .toContain('(try? container.decodeIfPresent(Bool.self, forKey: .revealable)) ?? false');
});
