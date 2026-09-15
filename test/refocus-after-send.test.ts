import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** The text from `marker` to the end of that member (four-space indented Swift). */
function member(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("\n    }\n", at));
}

const client = read("mac-app/conch-mac/ConchSocketClient.swift");
const store = read("mac-app/conch-mac/StateStore.swift");

/**
 * Sending from the Mac app types into the session's Terminal window, and the
 * daemon activates Terminal to do it, so Tyler had to click back into conch
 * after every message. The app now asks the daemon to answer only when the
 * keystrokes are done (`awaitDelivery` → `inject-done`, pinned executably in
 * control-server.test.ts) and then takes the front back.
 */
test("a Mac-app send takes the front back only after the daemon says delivery finished", () => {
  expect(client).toContain(
    "Self(type: .inject, sessionId: sessionId, label: label, announce: text, awaitDelivery: true)",
  );
  const write = member(client, "private static func write(\n        _ event: ConchDaemonEvent,");
  const written = write.indexOf("guard write(payload, to: descriptor, deadline: deadline) == .complete else {");
  const readsReply = write.indexOf("let outcome = readReplyLine(");
  const done = write.indexOf('reply["kind"] as? String == "inject-done" else { return }');
  const calls = write.indexOf("await whenDelivered()");
  expect(written).toBeGreaterThan(-1);
  expect(readsReply).toBeGreaterThan(written);
  expect(done).toBeGreaterThan(readsReply);
  expect(calls).toBeGreaterThan(done);

  const send = member(store, "func send(_ event: ConchDaemonEvent) -> Task<Bool, Never> {");
  const captured = send.indexOf("let refocus = event.awaitDelivery == true && NSApp.isActive");
  expect(captured).toBeGreaterThan(-1);
  // Captured at the press, not inside the task that runs after the raise.
  expect(captured).toBeLessThan(send.indexOf("let task = Task {"));
  expect(send).toContain("if refocus {\n            whenDelivered = { await StateStore.refocusAfterDelivery() }\n        } else if let underFog {\n            whenDelivered = { await StateStore.handBack(to: underFog) }\n        } else {\n            whenDelivered = nil\n        }");
  // M3: a reply typed in the conversation fog, over another app, hands that app back.
  const fog = send.indexOf("let underFog = event.awaitDelivery == true && !refocus && NSApp.keyWindow is FloatingPanel");
  expect(fog).toBeGreaterThan(captured);
  expect(fog).toBeLessThan(send.indexOf("let task = Task {"));
  const handBack = member(store, "private static func handBack(to pid: pid_t) {");
  // Presence first: a missing line is indexOf -1, which would pass the ordering check below.
  expect(handBack).toContain('front.bundleIdentifier == "com.apple.Terminal",');
  expect(handBack).toContain("NSRunningApplication(processIdentifier: pid)?.activate()");
  expect(handBack.indexOf('front.bundleIdentifier == "com.apple.Terminal",')).toBeLessThan(
    handBack.indexOf("NSRunningApplication(processIdentifier: pid)?.activate()"),
  );
  expect(send).toContain("let delivered = await socketClient.send(event, whenDelivered: whenDelivered)");

  // Composer, question options (incl. multi-select and "Something else…",
  // which fills the composer) and palette type lines all take this door.
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  expect(dashboard).toContain("store.send(.inject(sessionId: row.id, label: row.label, text: text))");
  expect(dashboard).toContain("onAnswer: { label in\n                                store.send(\n                                    .inject(");
  expect(read("mac-app/conch-mac/CommandPaletteView.swift")).toContain("store.send(.inject(\n");
});

test("only an inject, and the session commands conch types, ask to hear about delivery", () => {
  expect(client.split("awaitDelivery: true").length - 1).toBe(1);
  // One definition, two callers: send's inject path, and the hand-back that
  // `/model` and `/rename` take (refocus-after-session-command.test.ts).
  expect(store.split("refocusAfterDelivery()").length - 1).toBe(3);
  expect(store.split("Self.refocusWhenDelivered()").length - 1).toBe(2);
});

/**
 * The phone's sends are typed on the Mac too, but it is not in front of anyone
 * there. It now asks for `awaitDelivery` to show "delivered" on its own screen;
 * the front coming back is the Mac app's own StateStore path, which a phone
 * inject never enters.
 */
test("phone and remote sends never ask for the front back", () => {
  const phone = read("mobile/conch-ios/conch-ios/BridgeClient.swift");
  expect(phone).toContain('"type": "inject",');
  expect(phone).toContain('"awaitDelivery": true,');
  expect(phone).not.toContain("refocus");
  const remote = read("mac-app/conch-mac/RemoteMacStore.swift");
  expect(remote).toContain('"type": "inject"');
  expect(remote).not.toContain("awaitDelivery");
  expect(read("src/phone-bridge.ts")).not.toContain("refocus");
  expect(read("src/control-server.ts")).not.toContain("refocus");
});

/** These exist to SHOW the terminal; handing the front back would undo them. */
test("reveal, Open in Terminal and close never take the front back", () => {
  for (const [marker, request] of [
    ["func reveal(_ row: SessionRow) -> Task<Bool, Never> {", "ConchSessionCommandRequest(sessionId: row.id, command: .reveal)"],
    ["func openInTerminal(_ row: SessionRow) {", "ConchSessionCommandRequest(sessionId: row.id, command: .attach)"],
    ["func closeSession(_ row: SessionRow) {", "ConchSessionCloseRequest(sessionId: row.id)"],
  ] as const) {
    const body = member(store, marker);
    expect(body).toContain(request);
    expect(body).not.toContain("refocusAfterDelivery");
    expect(body).not.toContain("send(");
  }
});

test("the front comes back only from the Terminal conch raised, without touching focus or selection", () => {
  const helper = member(store, "private static func refocusAfterDelivery() {");
  const inactive = helper.indexOf("guard !NSApp.isActive,");
  const terminal = helper.indexOf(
    'NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Terminal" else { return }',
  );
  const activate = helper.indexOf("NSApp.activate(ignoringOtherApps: true)");
  expect(inactive).toBeGreaterThan(-1);
  expect(terminal).toBeGreaterThan(inactive);
  expect(activate).toBeGreaterThan(terminal);
  for (const intrusion of ["makeKey", "makeFirstResponder", "focusedRow", "selected"]) {
    expect(helper).not.toContain(intrusion);
  }
  // Terminal targeting and the input transaction are exercised through fake UI
  // boundaries in inject-transactions.test.ts, rather than pinning script layout.
});

test("the daemon hands back an immediate inject's handling instead of dropping it", () => {
  const daemon = read("src/daemon.ts");
  const branch = daemon.slice(daemon.indexOf('if (event.type === "inject" || event.type === "interrupt") {'));
  expect(branch.slice(0, 400)).toContain("return handle(event).catch((error) => {");
  expect(branch.slice(0, 400)).not.toContain("void handle(event)");
});
