import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applySessionCommand, createControlServer, type ControlServer } from "../src/control-server.ts";
import type { SessionActionsController, SessionActionsTarget } from "../src/session-actions-overlay.ts";
import { sendControlMessage } from "../src/settings.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

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
  const withPid = harness({ sessionId: "s1", label: "arch", backend: "claude", pid: 4242 });
  expect(withPid.reply("sonnet[1m]")).toEqual({
    kind: "session-ack", sessionId: "s1", command: "set-model", changed: true, label: "arch",
  });
  expect(withPid.sent).toEqual([{
    target: { sessionId: "s1", label: "arch", backend: "claude", pid: 4242 },
    model: "sonnet[1m]",
  }]);

  const observed = harness({ sessionId: "s1", label: "arch" });
  expect((observed.reply() as { changed: boolean }).changed).toBe(false);

  const unknown = harness(null);
  expect((unknown.reply() as { changed: boolean }).changed).toBe(false);
  expect(unknown.sent).toEqual([]);
});

test("set-settings hands model and effort, either or both, to the same drive", () => {
  const h = harness({ sessionId: "s1", label: "arch", backend: "codex", pid: 4242 });
  const send = (extra: Record<string, string>) => applySessionCommand(
    { kind: "session-command", sessionId: "s1", command: "set-settings", ...extra },
    h.options,
  );
  expect(send({ model: "gpt-6-luna", effort: "max" })).toEqual({
    kind: "session-ack", sessionId: "s1", command: "set-settings", changed: true, label: "arch",
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
  const h = harness({ sessionId: "s1", label: "arch", pid: 4242 });
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "this-mac",
    log: () => {},
    sessions: {
      resolve: (value) => value,
      current: () => ({ published: true, label: "arch", cwd: "/x", pid: 4242 }),
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
    response: { kind: "session-ack", sessionId: "s1", command: "set-model", changed: true, label: "arch" },
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

/**
 * Measured 2026-09-28 in a tmux lab: Claude Code's `/model <name>` saves the model as the default
 * for every new session, and Codex's goes to the model as a message. So the daemon never types a
 * one-line `/model`: it drives the picker, reading the screen between keys, in one UI hold.
 */
test("the daemon drives the agent's own picker, never a one-line /model", () => {
  const daemon = read("src/daemon.ts");
  const at = daemon.indexOf("const sessionActions: SessionActionsController = {");
  expect(at).toBeGreaterThan(-1);
  const controller = daemon.slice(at, daemon.indexOf("\n  };", at));
  const drive = controller.slice(controller.indexOf("setSettings: async (target, requested) => {"));
  expect(controller.indexOf("setSettings: async (target, requested) => {")).toBeGreaterThan(-1);
  expect(drive).toContain("const outcome = await withUIHold((ui) => driveSessionSettings(backend, change, {");
  expect(drive).toContain("read: () => readSessionScreen(target.pid),");
  // Typed and not submitted, so the driver can check the prompt before Enter.
  expect(drive).toContain("delivered(await ui.text({ ...cfg, autoSubmit: false }, target.pid, words, { clipboardFallback: false }))");
  expect(drive).toContain('if (status === "working") return refuse(');
  expect(drive).toContain('if (status === "needs") return refuse(');
  expect(drive).toMatch(/recordDaemonError\("session-settings",/);
  expect(daemon).not.toContain("`/model ${");
  expect(daemon).not.toContain("injectProviderCommand");
  const rename = controller.indexOf("renameProviderSession(cfg, target, renamed.label)");
  expect(rename).toBeGreaterThan(-1);
  expect(controller.indexOf("setSettings:")).toBeGreaterThan(rename);
  // The overlay's key ring is untouched: no TUI key in this slice.
  expect(read("src/panel.ts")).toContain(
    'export type SessionActionKey = "voice" | "prioritize" | "rename" | "dismiss" | "close";',
  );
});

test("the Mac inspector shows the recorded model, or says it is not reported, and sends the command", () => {
  const inspector = read("mac-app/conch-mac/CapabilityInspectorView.swift");
  expect(inspector).toContain('Text("Model")');
  expect(inspector).toContain('return "not reported"');
  expect(inspector).toContain("guard let thread = capabilities?.context.threadConfiguration, let model = thread.model else {");
  expect(inspector).toContain('TextField("new model", text: $modelDraft)');
  expect(inspector).toContain('Button("Apply") { apply(onSetModel) }');
  expect(inspector).toContain("Task { @MainActor in modelResult = await send(model) }");
  expect(inspector).toContain("onSetModel: { model in await store.setModel(id: row.id, model: model) }");

  const store = read("mac-app/conch-mac/StateStore.swift");
  const at = store.indexOf("func setModel(id: SessionRow.ID, model: String) async -> String {");
  expect(at).toBeGreaterThan(-1);
  const body = store.slice(at, at + 1400);
  expect(body).toContain("ConchSessionCommandRequest(\n            sessionId: id,\n            command: .setModel,\n            model: model,");
  expect(body).toContain("return error.error"); // the daemon's refusal, verbatim
  expect(body).toContain('"not sent: the session has no terminal window to type into"');

  const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
  expect(socket).toContain('case setModel = "set-model"');
  expect(socket).toContain("let model: String?");
});
