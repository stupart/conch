import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySessionCommand } from "../src/control-server.ts";
import type { SessionActionsController, SessionActionsTarget } from "../src/session-actions-overlay.ts";
import {
  attachTerminalCommand,
  attachTerminalSession,
  closeSession,
  type SessionLifecycleProcess,
} from "../src/session-lifecycle.ts";
import { BG_NO_TERMINAL } from "../src/sessions.ts";
import { validateSessionControlMessage } from "../src/settings.ts";

/**
 * A Claude Code background job is a conversation with zero or more terminal
 * windows attached. With one attached, the row routes to it (see
 * continued-sessions.test.ts). With none, the row offers "Open in Terminal":
 * `claude attach <jobId>` in a new Terminal window. Closing a job is `claude
 * stop <jobId>`, whether a window is attached or not.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function settled(code = 0, stdout = "", stderr = ""): SessionLifecycleProcess {
  return {
    exited: Promise.resolve(code),
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    cancel() {},
  };
}

/** The text between two markers, each asserted present first. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Open in Terminal: claude attach <jobId>", () => {
  test("the command is exactly claude attach <jobId> in the job's folder, shell-quoted", () => {
    expect(attachTerminalCommand("f31f0d15", "/Users/tylerstupart"))
      .toBe("cd -- '/Users/tylerstupart' && claude attach 'f31f0d15'");
    expect(attachTerminalCommand("f31f0d15", "/tmp/it's here"))
      .toBe("cd -- '/tmp/it'\\''s here' && claude attach 'f31f0d15'");
    for (const hostile of ["", "-h", "f31f0d15; rm -rf ~", "a b", "$(id)", "'x'"]) {
      expect(() => attachTerminalCommand(hostile, "/tmp")).toThrow("background job id");
    }
  });

  test("it opens through the same Terminal door a start uses", async () => {
    const calls: string[][] = [];
    await attachTerminalSession("f31f0d15", "/Users/t", {
      which: () => "/opt/homebrew/bin/claude",
      isDirectory: () => true,
      spawn(argv) {
        calls.push(argv);
        return settled();
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("osascript");
    expect(calls[0]!).toContain("do script (item 1 of argv)");
    expect(calls[0]!.at(-1)).toBe("cd -- '/Users/t' && claude attach 'f31f0d15'");
  });

  test("the socket command reaches the controller and acks by whether there is a job to attach", () => {
    expect(validateSessionControlMessage({ kind: "session-command", sessionId: "succ", command: "attach" }))
      .toEqual({ ok: true, value: { kind: "session-command", sessionId: "succ", command: "attach" } });
    const attached: SessionActionsTarget[] = [];
    const controller = {
      attach: (target: SessionActionsTarget) => {
        attached.push(target);
        return new Promise<boolean>(() => {}); // never settles: the reply must not wait on AppleScript
      },
    } as unknown as SessionActionsController;
    const reply = (target: SessionActionsTarget | null) => applySessionCommand(
      { kind: "session-command", sessionId: "succ", command: "attach" },
      { controller, pause: { open() {}, close() {} }, targetForSessionId: () => target },
    );
    expect(reply({ sessionId: "succ", label: "conch", jobId: "f31f0d15" })).toEqual({
      kind: "session-ack", sessionId: "succ", command: "attach", changed: true, label: "conch",
    });
    expect(attached).toEqual([{ sessionId: "succ", label: "conch", jobId: "f31f0d15" }]);
    expect(reply({ sessionId: "cx", label: "codex" })).toMatchObject({ kind: "session-ack", changed: false });
  });

  test("the daemon opens the row's own job, in its folder, and records a failure", () => {
    const daemon = read("src/daemon.ts");
    const body = between(daemon, "    attach: (target) => {", "\n    },\n");
    expect(body).toContain("const session = panelSessions.get(target.sessionId);");
    expect(body).toContain("if (!session?.jobId) return Promise.resolve(false);");
    expect(body).toContain("return attachTerminalSession(session.jobId, session.cwd)");
    expect(body).toContain('"session-attach"');
    expect(daemon).toContain("...(session?.jobId ? { jobId: session.jobId } : {}),");
  });
});

describe("close on a background job", () => {
  test("runs claude stop <jobId> and waits out the job's own process, never the window's", async () => {
    for (const row of [
      { pid: 61637, jobId: "f31f0d15", agentPid: 72858 }, // a window attached
      { pid: 0, jobId: "f31f0d15", agentPid: 72858, noTerminal: BG_NO_TERMINAL }, // none
    ]) {
      const spawned: string[][] = [];
      const probed: number[] = [];
      const alive = [true, false];
      await closeSession(row, {
        which: () => "/opt/homebrew/bin/claude",
        spawn(argv) {
          spawned.push(argv);
          return settled();
        },
        ttyForPid: async () => {
          throw new Error("closing a job must not look for a terminal tab");
        },
        pidIsAlive: async (pid) => {
          probed.push(pid);
          return alive.shift() ?? false;
        },
        sleep: async () => {},
      });
      expect(spawned).toEqual([["/opt/homebrew/bin/claude", "stop", "f31f0d15"]]);
      expect(probed).toEqual([72858, 72858]);
    }
  });

  test("a stop that fails says why, in claude's words", async () => {
    await expect(closeSession(
      { pid: 61637, jobId: "f31f0d15", agentPid: 72858 },
      { which: () => "/opt/homebrew/bin/claude", spawn: () => settled(1, "", "no background session f31f0d15\n") },
    )).rejects.toThrow("no background session f31f0d15");
  });

  test("a terminal session still closes with Ctrl-D, and a no-terminal row still refuses", async () => {
    let argv: string[] = [];
    const identity = { pid: 4321, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/claude", ttyDevice: 7 };
    await closeSession({ pid: 4321, processIdentity: identity }, {
      processIdentity: () => identity,
      ttyForPid: async () => "ttys007",
      pidIsAlive: async () => false,
      sleep: async () => {},
      spawn(args) {
        argv = args;
        return settled(0, "ok");
      },
    });
    expect(argv[0]).toBe("osascript");
    expect(argv.at(-1)).toBe("ttys007");
    await expect(closeSession({ pid: 0, noTerminal: "closed: no Codex process has this thread open" }))
      .rejects.toThrow("closed: no Codex process has this thread open");
  });

  test("the daemon closes through closeSession, letting a job past the no-pid refusal", () => {
    const body = between(read("src/daemon.ts"), "const closeLiveSession = async", "const sessionActions");
    expect(body).toContain("if (!session.pid && !session.jobId) {");
    expect(body).toContain("await closeSession(session);");
    expect(body).not.toContain("closeTerminalSession(");
  });
});

describe("the apps offer Open in Terminal only on an attachable row", () => {
  test("Mac: decoded optionally, sent as `attach`, shown beside the reason, and close stays available", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain("let attachable: Bool");
    expect(models).toContain("case attachable");
    expect(models).toContain("(try? container.decodeIfPresent(Bool.self, forKey: .attachable)) ?? false");
    expect(models).toContain("noTerminal: noTerminal,\n            attachable: attachable,");

    expect(between(read("mac-app/conch-mac/ConchSocketClient.swift"), "enum ConchSessionCommand", "}"))
      .toContain("case attach");

    const open = between(read("mac-app/conch-mac/StateStore.swift"), "func openInTerminal(_ row: SessionRow) {", "\n    }\n");
    expect(open).toContain("guard row.attachable else { return }");
    expect(open).toContain("ConchSessionCommandRequest(sessionId: row.id, command: .attach)");

    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    expect(dashboard).toContain("onOpenInTerminal: row.attachable ? { store.openInTerminal(row) } : nil,");
    expect(between(dashboard, 'Button("Close session…", role: .destructive) {', "} label: {"))
      .toContain(".disabled(row.noTerminal != nil && !row.attachable)");

    const composer = read("mac-app/conch-mac/ComposerView.swift");
    expect(composer).toContain("var onOpenInTerminal: (() -> Void)? = nil");
    const button = between(composer, "if noTerminal != nil, let onOpenInTerminal {", "Spacer(minLength: 8)");
    expect(button).toContain("Button(action: onOpenInTerminal) {");
    expect(button).toContain('Label("Open in Terminal", systemImage: "terminal")');
  });

  test("iPhone: decoded optionally, sent as `attach`, shown in the composer, and End stays available", () => {
    const models = read("mobile/conch-ios/conch-ios/Models.swift");
    expect(models).toContain("var attachable = false");
    expect(models).toContain(", noTerminal, attachable\n");
    expect(models).toContain("attachable = (try? c.decodeIfPresent(Bool.self, forKey: .attachable)) ?? false");

    expect(between(read("mobile/conch-ios/conch-ios/BridgeClient.swift"), "enum SessionCommand: String {", "}"))
      .toContain("case attach");

    const session = read("mobile/conch-ios/conch-ios/SessionView.swift");
    const button = between(session, "if row?.attachable == true {", ".accessibilityHint(");
    expect(button).toContain("Button(action: openInTerminal) {");
    expect(button).toContain('Label("Open in Terminal", systemImage: "terminal")');
    expect(between(session, "private func openInTerminal() {", "\n    }\n"))
      .toContain("await bridge.send(sessionCommand: .attach, sessionId: sessionId)");
    expect(between(session, 'Button("End session…"', "} label: {"))
      .toContain("(row?.noTerminal != nil && row?.attachable != true)");
  });
});
