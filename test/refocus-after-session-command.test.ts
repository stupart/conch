import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { applySessionCommand, createControlServer, type ControlServer } from "../src/control-server.ts";
import type { SessionActionsController, SessionDelivery } from "../src/session-actions-overlay.ts";
import { sendControlMessage } from "../src/settings.ts";

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
    setSettings: () => typing.promise.then(() => true),
    rename: (_t: unknown, label: string, delivered?: SessionDelivery) => {
      delivered?.(typing.promise);
      return label;
    },
  } as unknown as SessionActionsController;
  const options = {
    controller,
    pause: { open: () => {}, close: () => {} },
    targetForSessionId: () => ({ sessionId: "s1", label: "morrow", backend: "claude" as const, pid: 4242 }),
  };
  const dir = mkdtempSync("/tmp/conch-deliver-");
  const socketPath = join(dir, "control.sock");
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "this-mac",
    log: () => {},
    sessions: { resolve: (value) => value, current: () => ({ published: true, label: "morrow", pid: 4242 }) },
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
      controller: { setSettings: async () => true, rename: (_t: unknown, label: string) => label } as unknown as SessionActionsController,
      pause: { open: () => {}, close: () => {} },
      targetForSessionId: () => ({ sessionId: "s1", label: "morrow", pid: 4242 }),
    },
  )) + "\n";

/**
 * PR #190 took the front back after a Mac-app send landed in Terminal. The
 * palette's and inspector's `/model` and `/rename` type into the same window
 * but acked before typing, so the app never came back. Asked with
 * `awaitDelivery`, the ack still goes out at once (the app shows it), then the
 * daemon waits for the typing and says `session-delivered`.
 */
for (const [command, extra] of [["set-model", { model: "opus" }], ["set-settings", { effort: "high" }], ["rename", { label: "morrow" }]] as const) {
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
    kind: "session-command", sessionId: "s1", command: "rename", label: "morrow",
  })).resolves.toEqual({ ok: true, response: JSON.parse(ackLine("rename", { label: "morrow" })) });
});

test("awaitDelivery must be true when present", async () => {
  const d = await daemon();
  const p = peer(d.socketPath, { kind: "session-command", sessionId: "s1", command: "set-model", model: "opus", awaitDelivery: 1 });
  await Bun.sleep(80);
  expect(JSON.parse(p.data())).toEqual({ kind: "session-error", error: "awaitDelivery must be true when present" });
});
