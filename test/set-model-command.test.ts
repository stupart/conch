import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { applySessionCommand, createControlServer, type ControlServer } from "../src/control-server.ts";
import type { SessionActionsController, SessionActionsTarget } from "../src/session-actions-overlay.ts";
import { sendControlMessage } from "../src/settings.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function harness(target: SessionActionsTarget | null) {
  const sent: Array<{ target: SessionActionsTarget; model: string }> = [];
  const controller = {
    setModel: (t: SessionActionsTarget, model: string) => {
      sent.push({ target: t, model });
      return new Promise<boolean>(() => {}); // never settles: the reply must not wait on the typing
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
 * Change the model mid-session (B2). The daemon types `/model <model>` into
 * the session the way it syncs `/rename`, so the agent switches natively.
 * The ack says whether there was a window to deliver to — a session conch
 * only observes has none — and comes back before anything is typed.
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

test("the daemon types /model through the same slash-command route as the /rename sync", () => {
  const daemon = read("src/daemon.ts");
  const at = daemon.indexOf("const sessionActions: SessionActionsController = {");
  expect(at).toBeGreaterThan(-1);
  const controller = daemon.slice(at, daemon.indexOf("\n  };", at));
  expect(controller).toContain(
    "setModel: (target, model) => injectProviderCommand(cfg, target, `/model ${model}`).then((delivery) => {",
  );
  expect(controller).toContain('recordDaemonError(\n        "session-model",');
  const rename = controller.indexOf("renameProviderSession(cfg, target, renamed.label)");
  expect(rename).toBeGreaterThan(-1);
  expect(controller.indexOf("setModel:")).toBeGreaterThan(rename);
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
  expect(body).toContain("ConchSessionCommandRequest(sessionId: id, command: .setModel, model: model)");
  expect(body).toContain("return error.error"); // the daemon's refusal, verbatim
  expect(body).toContain('"not sent: the session has no terminal window to type into"');

  const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
  expect(socket).toContain('case setModel = "set-model"');
  expect(socket).toContain("let model: String?");
});
