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
 * Passive reveals use `revealSessionWindow`, as `revealOnTurn` does. The
 * ack says whether there was a process to try —
 * a session conch only observes has nothing to raise — and it comes back
 * before the AppleScript does, because a click must not block on Terminal.
 */
test("reveal asks the controller and acks by whether there was a process to try", () => {
  const withPid = harness({ sessionId: "s1", label: "morrow", pid: 4242 });
  expect(withPid.reply()).toEqual({
    kind: "session-ack", sessionId: "s1", command: "reveal", changed: true, label: "morrow",
  });
  expect(withPid.revealed).toEqual([{ sessionId: "s1", label: "morrow", pid: 4242 }]);

  const observed = harness({ sessionId: "s1", label: "morrow" });
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

test("the Mac title focuses a session's own terminal instead of passively revealing it", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const at = dashboard.indexOf("private func sessionBar(for row: SessionRow) -> some View {");
  expect(at).toBeGreaterThan(-1);
  // The bar also carries a subagent's way back (C4) ahead of the title.
  const bar = dashboard.slice(at, at + 1_600);
  expect(bar).toContain("if let location = row.location {");
  expect(bar).toContain("Button { store.openSessionLocation(row) } label: { sessionTitle(row) }");
  expect(bar).not.toContain("store.reveal(row)");
  const store = read("mac-app/conch-mac/StateStore.swift");
  expect(store).toContain("guard row.revealable else { return Task { false } }");
  expect(store).toContain("ConchSessionCommandRequest(sessionId: row.id, command: .reveal)");
  expect(read("mac-app/conch-mac/Models.swift"))
    .toContain('(try? container.decodeIfPresent(Bool.self, forKey: .revealable)) ?? false');
});

/**
 * A Codex row with `noTerminal` (closed, or hosted by an app-server) has pid 0:
 * nothing to raise, type into, or close. The apps say why on the row and turn
 * off what would only fail; rename and voice need no pid and stay.
 */
test("the Mac gates messages separately while terminal-only controls remain disabled", () => {
  const models = read("mac-app/conch-mac/Models.swift");
  expect(models).toContain("let noTerminal: String?");
  expect(models).toContain("case noTerminal");
  // Optional and decodeIfPresent: an older daemon that omits it still decodes.
  expect(models).toContain("noTerminal = try? container.decodeIfPresent(String.self, forKey: .noTerminal)");
  expect(models).toContain("revealable: revealable,\n            noTerminal: noTerminal,");

  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  // Off the row's line now, in its tooltip and VoiceOver's value (sidebar-names-source.test.ts).
  const detail = dashboard.indexOf("private var detailLine: String {");
  expect(detail).toBeGreaterThan(-1);
  const detailEnd = dashboard.indexOf("\n    }\n", detail);
  expect(detailEnd).toBeGreaterThan(detail);
  expect(dashboard.slice(detail, detailEnd)).toContain('return row.noTerminal ?? ""');
  const close = dashboard.indexOf('Button("Close session…", role: .destructive) {');
  expect(close).toBeGreaterThan(-1);
  const closeEnd = dashboard.indexOf("} label: {", close);
  expect(closeEnd).toBeGreaterThan(close);
  expect(dashboard.slice(close, closeEnd)).toContain(".disabled(row.noTerminal != nil && !row.attachable)");
  // The composer's one construction (`SessionComposer`), which the window and the panel both build.
  expect(read("mac-app/conch-mac/ComposerView.swift")).toContain("noTerminal: row.noTerminal,\n            messageRoute: row.messageRoute,\n            onOpenInTerminal:");

  const composer = read("mac-app/conch-mac/ComposerView.swift");
  expect(composer).toContain("!composed.isEmpty && !isSending && messageUnavailableReason == nil");
  // Return asks the button's whole gate, a send in flight included.
  expect(composer).toContain("private func send() {\n        // Return reaches here without the button, so the button's own gate is asked again here, all of it: with a send\n        // still on its way, Return sent the same words a second time.\n        guard canSend else { return }");
  const stop = composer.indexOf("Button(action: onInterrupt) {");
  expect(stop).toBeGreaterThan(-1);
  const stopEnd = composer.indexOf("Button(action: send) {", stop);
  expect(stopEnd).toBeGreaterThan(stop);
  expect(composer.slice(stop, stopEnd)).toContain(".disabled(noTerminal != nil)");
  expect(composer).toContain('Text(messageUnavailableReason ?? "Message \\(sessionLabel)")');
});

test("the iPhone gates messages separately while terminal-only controls remain disabled", () => {
  const models = read("mobile/conch-ios/conch-ios/Models.swift");
  expect(models).toContain("var noTerminal: String?");
  // Anchored to the Row key list but not to its full contents: this test is about
  // noTerminal, and a key added beside it cannot affect whether noTerminal decodes — which
  // the next assertion pins directly.
  expect(models).toMatch(/case id, label, status,[^\n]*\bnoTerminal\b[^\n]*attachable/);
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
  expect(session.slice(send, sendEnd)).toContain(".disabled(isSending || row?.messageUnavailableReason != nil)");
  expect(session).toContain('TextField(row?.messageUnavailableReason ?? "Type or talk…"');
});
