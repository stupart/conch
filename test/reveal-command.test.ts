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

test("the daemon raises through revealSessionWindow, via the one logged door, and only for a known process", () => {
  const daemon = read("src/daemon.ts");
  expect(daemon).toContain(
    'reveal: (target) => target.pid ? raiseWindow(target.pid, "app") : Promise.resolve(false),',
  );
  // raiseWindow is revealSessionWindow plus a log line (A17: a raise used to leave no trace).
  const door = daemon.indexOf("const raiseWindow = async (pid: number, why: string)");
  expect(door).toBeGreaterThan(-1);
  expect(daemon.slice(door, door + 300)).toContain("await revealSessionWindow(pid);");
  const panel = read("src/panel.ts");
  expect(panel).toContain("...(session.pid ? { revealable: true } : {}),");
  expect(panel).toContain("...(row.revealable ? { revealable: true as const } : {}),");
});

test("the Mac app makes the title a button only when the row says it can be raised", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const at = dashboard.indexOf("private func sessionBar(for row: SessionRow) -> some View {");
  expect(at).toBeGreaterThan(-1);
  // The bar also carries a subagent's way back (C4) ahead of the title.
  const bar = dashboard.slice(at, at + 1_600);
  expect(bar).toContain("if row.revealable {");
  expect(bar).toContain("Button { store.reveal(row) } label: { sessionTitle(row) }");
  const store = read("mac-app/conch-mac/StateStore.swift");
  expect(store).toContain("guard row.revealable else { return }");
  expect(store).toContain("ConchSessionCommandRequest(sessionId: row.id, command: .reveal)");
  expect(read("mac-app/conch-mac/Models.swift"))
    .toContain('(try? container.decodeIfPresent(Bool.self, forKey: .revealable)) ?? false');
});

/**
 * A Codex row with `noTerminal` (closed, or hosted by an app-server) has pid 0:
 * nothing to raise, type into, or close. The apps say why on the row and turn
 * off what would only fail; rename and voice need no pid and stay.
 */
test("the Mac shows a no-terminal row's reason and offers no send, stop or close on it", () => {
  const models = read("mac-app/conch-mac/Models.swift");
  expect(models).toContain("let noTerminal: String?");
  expect(models).toContain("case noTerminal");
  // Optional and decodeIfPresent: an older daemon that omits it still decodes.
  expect(models).toContain("noTerminal = try? container.decodeIfPresent(String.self, forKey: .noTerminal)");
  expect(models).toContain("revealable: revealable,\n            noTerminal: noTerminal,");

  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const detail = dashboard.indexOf("private var inlineDetail: String {");
  expect(detail).toBeGreaterThan(-1);
  const detailEnd = dashboard.indexOf("\n    }\n", detail);
  expect(detailEnd).toBeGreaterThan(detail);
  expect(dashboard.slice(detail, detailEnd)).toContain('return row.noTerminal ?? ""');
  const close = dashboard.indexOf('Button("Close session…", role: .destructive) {');
  expect(close).toBeGreaterThan(-1);
  const closeEnd = dashboard.indexOf("} label: {", close);
  expect(closeEnd).toBeGreaterThan(close);
  expect(dashboard.slice(close, closeEnd)).toContain(".disabled(row.noTerminal != nil)");
  expect(dashboard).toContain("noTerminal: row.noTerminal,\n            onSend:");

  const composer = read("mac-app/conch-mac/ComposerView.swift");
  expect(composer).toContain("!composed.isEmpty && !isSending && noTerminal == nil");
  expect(composer).toContain("guard noTerminal == nil, !payload.isEmpty else { return }");
  const stop = composer.indexOf("Button(action: onInterrupt) {");
  expect(stop).toBeGreaterThan(-1);
  const stopEnd = composer.indexOf("Button(action: send) {", stop);
  expect(stopEnd).toBeGreaterThan(stop);
  expect(composer.slice(stop, stopEnd)).toContain(".disabled(noTerminal != nil)");
  expect(composer).toContain('Text(noTerminal ?? "Message \\(sessionLabel)")');
});

test("the iPhone shows a no-terminal row's reason and offers no send, stop or end on it", () => {
  const models = read("mobile/conch-ios/conch-ios/Models.swift");
  expect(models).toContain("var noTerminal: String?");
  expect(models).toContain("case id, label, status, backend, context, detail, at, live, paused, review, noTerminal");
  expect(models).toContain("noTerminal = try? c.decodeIfPresent(String.self, forKey: .noTerminal)");
  expect(read("mobile/conch-ios/conch-ios/LedgerView.swift"))
    .toContain("row.review?.summary ?? row.detail ?? row.noTerminal");

  const session = read("mobile/conch-ios/conch-ios/SessionView.swift");
  const end = session.indexOf('Button("End session…"');
  expect(end).toBeGreaterThan(-1);
  const endEnd = session.indexOf("} label: {", end);
  expect(endEnd).toBeGreaterThan(end);
  expect(session.slice(end, endEnd)).toContain("row?.noTerminal != nil");
  expect(session).toContain("if isWorking, !canSend, !isSending, row?.noTerminal == nil {");
  const send = session.indexOf("Button(action: sendDraft) {");
  expect(send).toBeGreaterThan(-1);
  const sendEnd = session.indexOf('.accessibilityLabel("Send")', send);
  expect(sendEnd).toBeGreaterThan(send);
  expect(session.slice(send, sendEnd)).toContain(".disabled(isSending || row?.noTerminal != nil)");
  expect(session).toContain('TextField(row?.noTerminal ?? "Type or talk…"');
});
