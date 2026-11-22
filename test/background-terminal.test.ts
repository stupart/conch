import { describe, expect, test } from "bun:test";
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

function settled(code = 0, stdout = "", stderr = ""): SessionLifecycleProcess {
  return {
    exited: Promise.resolve(code),
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    cancel() {},
  };
}

describe("Open in Terminal: claude attach <jobId>", () => {
  test("the command is exactly claude attach <jobId> in the job's folder, shell-quoted", () => {
    expect(attachTerminalCommand("5e5e5e13", "/Users/you"))
      .toBe("cd -- '/Users/you' && claude attach '5e5e5e13'");
    expect(attachTerminalCommand("5e5e5e13", "/tmp/it's here"))
      .toBe("cd -- '/tmp/it'\\''s here' && claude attach '5e5e5e13'");
    for (const hostile of ["", "-h", "5e5e5e13; rm -rf ~", "a b", "$(id)", "'x'"]) {
      expect(() => attachTerminalCommand(hostile, "/tmp")).toThrow("background job id");
    }
  });

  test("it opens through the same Terminal door a start uses", async () => {
    const calls: string[][] = [];
    await attachTerminalSession("5e5e5e13", "/Users/t", {
      which: () => "/opt/homebrew/bin/claude",
      isDirectory: () => true,
      spawn(argv) {
        calls.push(argv);
        return settled();
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("osascript");
    expect(calls[0]!).toContain("set newTab to do script (item 1 of argv)");
    expect(calls[0]!).toContain("return tty of newTab");
    expect(calls[0]!.at(-1)).toBe("cd -- '/Users/t' && claude attach '5e5e5e13'");
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
    expect(reply({ sessionId: "succ", label: "conch", jobId: "5e5e5e13" })).toEqual({
      kind: "session-ack", sessionId: "succ", command: "attach", changed: true, label: "conch",
    });
    expect(attached).toEqual([{ sessionId: "succ", label: "conch", jobId: "5e5e5e13" }]);
    expect(reply({ sessionId: "cx", label: "codex" })).toMatchObject({ kind: "session-ack", changed: false });
  });
});

describe("close on a background job", () => {
  test("runs claude stop <jobId> and waits out the job's own process, never the window's", async () => {
    for (const row of [
      { pid: 61637, jobId: "5e5e5e13", agentPid: 72858 }, // a window attached
      { pid: 0, jobId: "5e5e5e13", agentPid: 72858, noTerminal: BG_NO_TERMINAL }, // none
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
      expect(spawned).toEqual([["/opt/homebrew/bin/claude", "stop", "5e5e5e13"]]);
      expect(probed).toEqual([72858, 72858]);
    }
  });

  test("a stop that fails says why, in claude's words", async () => {
    await expect(closeSession(
      { pid: 61637, jobId: "5e5e5e13", agentPid: 72858 },
      { which: () => "/opt/homebrew/bin/claude", spawn: () => settled(1, "", "no background session 5e5e5e13\n") },
    )).rejects.toThrow("no background session 5e5e5e13");
  });

  test("a terminal session still closes with Ctrl-D, and a no-terminal row still refuses", async () => {
    // Repointed: closing now runs a further osascript after the Ctrl-D press — closing the
    // tab and returning to conch — so every call is captured instead of just the last one.
    const calls: string[][] = [];
    const identity = { pid: 4321, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/claude", ttyDevice: 7 };
    await closeSession({ pid: 4321, processIdentity: identity }, {
      processIdentity: () => identity,
      ttyForPid: async () => "ttys007",
      pidIsAlive: async () => false,
      sleep: async () => {},
      spawn(args) {
        calls.push(args);
        return settled(0, "ok");
      },
    });
    const argv = calls.find((args) => args.join(" ").includes('keystroke "d"'));
    if (!argv) throw new Error("Ctrl-D script never ran");
    expect(argv[0]).toBe("osascript");
    expect(argv.at(-1)).toBe("/dev/ttys007");
    await expect(closeSession({ pid: 0, noTerminal: "closed: no Codex process has this thread open" }))
      .rejects.toThrow("closed: no Codex process has this thread open");
  });
});
