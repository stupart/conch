import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applySessionCommand, createControlServer, type ControlServer } from "../src/control-server.ts";
import type { SessionActionsController, SessionActionsTarget } from "../src/session-actions-overlay.ts";
import { sendControlMessage } from "../src/settings.ts";

function harness(target: SessionActionsTarget | null) {
  const sent: Array<{ target: SessionActionsTarget; model?: string; effort?: string }> = [];
  const controller = {
    setSettings: (t: SessionActionsTarget, change: { model?: string; effort?: string }) => {
      sent.push({ target: t, ...change });
      return new Promise<boolean>(() => {}); // never settles: the reply must not wait on the drive
    },
  } as unknown as SessionActionsController;
  const pause = { open: () => {}, close: () => {} };
  return {
    sent,
    controller,
    options: { controller, pause, targetForSessionId: () => target },
    reply: (model = "opus") => applySessionCommand(
      { kind: "session-command", sessionId: "s1", command: "set-model", model },
      { controller, pause, targetForSessionId: () => target },
    ),
  };
}

/**
 * Change the model mid-session (B2), for this session only: the daemon drives the agent's own
 * /model picker to it (session-settings.ts). The ack says whether there was a window to drive —
 * a session conch only observes has none — and comes back before anything is typed.
 */
test("set-model hands the model to the controller and acks by whether there was a window", () => {
  const withPid = harness({ sessionId: "s1", label: "morrow", backend: "claude", pid: 4242 });
  expect(withPid.reply("sonnet[1m]")).toEqual({
    kind: "session-ack", sessionId: "s1", command: "set-model", changed: true, label: "morrow",
  });
  expect(withPid.sent).toEqual([{
    target: { sessionId: "s1", label: "morrow", backend: "claude", pid: 4242 },
    model: "sonnet[1m]",
  }]);

  const observed = harness({ sessionId: "s1", label: "morrow" });
  expect((observed.reply() as { changed: boolean }).changed).toBe(false);

  const unknown = harness(null);
  expect((unknown.reply() as { changed: boolean }).changed).toBe(false);
  expect(unknown.sent).toEqual([]);
});

test("set-settings hands model and effort, either or both, to the same drive", () => {
  const h = harness({ sessionId: "s1", label: "morrow", backend: "codex", pid: 4242 });
  const send = (extra: Record<string, string>) => applySessionCommand(
    { kind: "session-command", sessionId: "s1", command: "set-settings", ...extra },
    h.options,
  );
  expect(send({ model: "gpt-6-luna", effort: "max" })).toEqual({
    kind: "session-ack", sessionId: "s1", command: "set-settings", changed: true, label: "morrow",
  });
  send({ effort: "high" });
  send({ model: "gpt-5.5" });
  expect(h.sent.map(({ model, effort }) => ({ model, effort }))).toEqual([
    { model: "gpt-6-luna", effort: "max" },
    { model: undefined, effort: "high" },
    { model: "gpt-5.5", effort: undefined },
  ]);
});

const servers: Array<{ dir: string; server: ControlServer }> = [];
afterEach(async () => {
  for (const { dir, server } of servers.splice(0)) {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over the real socket, the CLI's client gets a validated set-model ack", async () => {
  const dir = mkdtempSync("/tmp/conch-model-");
  const socketPath = join(dir, "control.sock");
  const h = harness({ sessionId: "s1", label: "morrow", pid: 4242 });
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "this-mac",
    log: () => {},
    sessions: {
      resolve: (value) => value,
      current: () => ({ published: true, label: "morrow", cwd: "/x", pid: 4242 }),
    },
    application: {
      configuration: () => ({ kind: "config-error", error: "stub" }),
      session: (message) => applySessionCommand(message, h.options),
      runtime: () => ({ kind: "app-error-ack" }),
      turn: () => {},
      device: () => ({ kind: "ack" }),
    },
  });
  servers.push({ dir, server });
  expect(await server.start()).toBe(true);

  await expect(sendControlMessage(socketPath, {
    kind: "session-command", sessionId: "s1", command: "set-model", model: "opus",
  })).resolves.toEqual({
    ok: true,
    response: { kind: "session-ack", sessionId: "s1", command: "set-model", changed: true, label: "morrow" },
  });
  expect(h.sent.map((s) => s.model)).toEqual(["opus"]);

  // Hostile input is refused at the one validation boundary, in words.
  await expect(sendControlMessage(socketPath, {
    kind: "session-command", sessionId: "s1", command: "set-model", model: "-opus",
  })).resolves.toEqual({
    ok: true,
    response: { kind: "session-error", error: "set-model: model cannot start with -" },
  });
  expect(h.sent).toHaveLength(1);
});
