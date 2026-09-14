import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { applySessionCommand, createControlServer, type ControlServer } from "../src/control-server.ts";
import type { SessionActionsController, SessionDelivery } from "../src/session-actions-overlay.ts";
import { sendControlMessage } from "../src/settings.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** The text from `marker` to the end of that member (four-space indented Swift); the marker must exist. */
function member(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("\n    }\n", at));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const servers: Array<{ dir: string; server: ControlServer }> = [];
const sockets: Socket[] = [];
afterEach(async () => {
  // A held connection (typing that never finishes) would keep close() waiting.
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const { dir, server } of servers.splice(0)) {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real control server whose set-model and rename typing finish only when the test says. */
async function daemon() {
  const typing = deferred();
  const controller = {
    setModel: () => typing.promise.then(() => true),
    rename: (_t: unknown, label: string, delivered?: SessionDelivery) => {
      delivered?.(typing.promise);
      return label;
    },
  } as unknown as SessionActionsController;
  const options = {
    controller,
    pause: { open: () => {}, close: () => {} },
    targetForSessionId: () => ({ sessionId: "s1", label: "arch", backend: "claude" as const, pid: 4242 }),
  };
  const dir = mkdtempSync("/tmp/conch-deliver-");
  const socketPath = join(dir, "control.sock");
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "this-mac",
    log: () => {},
    sessions: { resolve: (value) => value, current: () => ({ published: true, label: "arch", pid: 4242 }) },
    application: {
      configuration: () => ({ kind: "config-error", error: "stub" }),
      session: (message, delivered) => applySessionCommand(message, options, delivered),
      runtime: () => ({ kind: "app-error-ack" }),
      turn: () => {},
      device: () => ({ kind: "ack" }),
    },
  });
  servers.push({ dir, server });
  expect(await server.start()).toBe(true);
  return { socketPath, typing };
}

/** Everything the daemon writes, and whether it has closed the connection. */
function peer(socketPath: string, body: unknown) {
  let data = "";
  let ended = false;
  const socket = connect({ path: socketPath });
  sockets.push(socket);
  socket.on("data", (chunk) => { data += chunk.toString(); });
  socket.on("end", () => { ended = true; socket.end(); });
  socket.on("error", () => {});
  socket.write(JSON.stringify(body) + "\n");
  return { data: () => data, ended: () => ended };
}

/** The daemon's own ack for this command, as the one-reply CLI path returns it. */
const ackLine = (command: string, extra: object) =>
  JSON.stringify(applySessionCommand(
    { kind: "session-command", sessionId: "s1", command, ...extra } as never,
    {
      controller: { setModel: async () => true, rename: (_t: unknown, label: string) => label } as unknown as SessionActionsController,
      pause: { open: () => {}, close: () => {} },
      targetForSessionId: () => ({ sessionId: "s1", label: "arch", pid: 4242 }),
    },
  )) + "\n";

/**
 * PR #190 took the front back after a Mac-app send landed in Terminal. The
 * palette's and inspector's `/model` and `/rename` type into the same window
 * but acked before typing, so the app never came back. Asked with
 * `awaitDelivery`, the ack still goes out at once (the app shows it), then the
 * daemon waits for the typing and says `session-delivered`.
 */
for (const [command, extra] of [["set-model", { model: "opus" }], ["rename", { label: "arch" }]] as const) {
  test(`an awaitDelivery ${command} is acked at once and delivered only once typed`, async () => {
    const d = await daemon();
    const p = peer(d.socketPath, { kind: "session-command", sessionId: "s1", command, ...extra, awaitDelivery: true });
    await Bun.sleep(80);
    const ack = ackLine(command, extra);
    expect(JSON.parse(ack)).toMatchObject({ kind: "session-ack", command });
    expect(p.data()).toBe(ack);
    expect(p.ended()).toBe(false);
    d.typing.resolve();
    await Bun.sleep(80);
    expect(p.data()).toBe(ack + '{"kind":"session-delivered"}\n');
    expect(p.ended()).toBe(true);
  });
}

test("every other sender keeps the lone immediate ack, typing or not", async () => {
  const d = await daemon(); // the typing never finishes in this test
  const p = peer(d.socketPath, { kind: "session-command", sessionId: "s1", command: "set-model", model: "opus" });
  await Bun.sleep(80);
  expect(p.data()).toBe(ackLine("set-model", { model: "opus" }));
  expect(p.ended()).toBe(true);
  // The CLI's client reads exactly that.
  await expect(sendControlMessage(d.socketPath, {
    kind: "session-command", sessionId: "s1", command: "rename", label: "arch",
  })).resolves.toEqual({ ok: true, response: JSON.parse(ackLine("rename", { label: "arch" })) });
});

test("awaitDelivery must be true when present", async () => {
  const d = await daemon();
  const p = peer(d.socketPath, { kind: "session-command", sessionId: "s1", command: "set-model", model: "opus", awaitDelivery: 1 });
  await Bun.sleep(80);
  expect(JSON.parse(p.data())).toEqual({ kind: "session-error", error: "awaitDelivery must be true when present" });
});

test("the daemon hands back the /rename sync it types, and the wiring passes it through", () => {
  const daemonSource = read("src/daemon.ts");
  const at = daemonSource.indexOf("const sessionActions: SessionActionsController = {");
  expect(at).toBeGreaterThan(-1);
  const controller = daemonSource.slice(at, daemonSource.indexOf("\n  };", at));
  const synced = controller.indexOf("const synced = renameProviderSession(cfg, target, renamed.label)");
  const handed = controller.indexOf("delivered?.(synced);");
  expect(synced).toBeGreaterThan(-1);
  expect(handed).toBeGreaterThan(synced);
  expect(controller).toContain("rename: (target, label, delivered) => {");
  expect(daemonSource).toContain(
    "session: (message, delivered) => applySessionCommand(message, sessionCommandDispatchOptions, delivered),",
  );
});

test("the Mac app reads the ack, then waits for session-delivered before taking the front back", () => {
  const client = read("mac-app/conch-mac/ConchSocketClient.swift");
  expect(client).toContain("let awaitDelivery: Bool?\n\n    init(\n        sessionId: String,");
  const transact = member(client, "private static func transact(");
  const ackRead = transact.indexOf("let outcome = readReplyLine(from: descriptor, deadline: deadline, buffered: &buffered)");
  const onlyIfAsked = transact.indexOf("guard let whenDelivered, case .reply = outcome else {");
  const delivered = transact.indexOf('reply["kind"] as? String == "session-delivered" else { return }');
  const calls = transact.indexOf("await whenDelivered()");
  const returned = transact.lastIndexOf("return outcome");
  expect(ackRead).toBeGreaterThan(-1);
  expect(onlyIfAsked).toBeGreaterThan(ackRead);
  expect(delivered).toBeGreaterThan(onlyIfAsked);
  expect(calls).toBeGreaterThan(delivered);
  expect(returned).toBeGreaterThan(calls);
  // A second line that arrived in the same read as the ack is kept, not dropped.
  expect(transact).toContain("buffered: &pending");
  expect(client).toContain("reply = Data(reply[reply.index(after: newline)...])");

  const store = read("mac-app/conch-mac/StateStore.swift");
  const helper = member(store, "private static func refocusWhenDelivered() -> (@Sendable () async -> Void)? {");
  const front = helper.indexOf("guard NSApp.isActive else { return nil }");
  const back = helper.indexOf("return { await StateStore.refocusAfterDelivery() }");
  expect(front).toBeGreaterThan(-1);
  expect(back).toBeGreaterThan(front);

  // Read at the press: before the request exists, let alone the raise.
  const setModel = member(store, "func setModel(id: SessionRow.ID, model: String) async -> String {");
  const pressed = setModel.indexOf("let whenDelivered = Self.refocusWhenDelivered()");
  const sent = setModel.indexOf("switch await socketClient.request(request, whenDelivered: whenDelivered) {");
  expect(pressed).toBeGreaterThan(-1);
  expect(sent).toBeGreaterThan(pressed);
  expect(setModel).toContain("awaitDelivery: whenDelivered == nil ? nil : true");

  const rename = member(store, "func renameSession(id: SessionRow.ID, label: String) {");
  expect(rename).toContain("command: .rename,");
  expect(rename).toContain("whenDelivered: Self.refocusWhenDelivered()");
  const enqueue = member(store, "private func enqueueSessionCommand(");
  expect(enqueue).toContain("awaitDelivery: whenDelivered == nil ? nil : true");
  expect(enqueue).toContain("let outcome = await socketClient.request(request, whenDelivered: whenDelivered)");
  // Dismiss and restore share the queue but type nothing, so they never ask.
  for (const marker of ["func dismissSession(_ row: SessionRow) {", "func restoreSession(id: SessionRow.ID, label: String) {"]) {
    const body = member(store, marker);
    expect(body).toContain("enqueueSessionCommand(");
    expect(body).not.toContain("refocusWhenDelivered");
  }
});
