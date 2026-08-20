import { describe, expect, test } from "bun:test";
import {
  closeTerminalSession,
  startTerminalSession,
  terminalSessionCommand,
  type SessionLifecycleProcess,
} from "../src/session-lifecycle.ts";

function settledProcess(stdout = "", code = 0): SessionLifecycleProcess {
  return {
    exited: Promise.resolve(code),
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    cancel() {},
  };
}

describe("native Terminal session lifecycle", () => {
  test("builds new and resumed agent commands without tmux", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/tmp/a b" }))
      .toBe("cd -- '/tmp/a b' && exec claude");
    expect(terminalSessionCommand({ backend: "claude", cwd: "/tmp/repo", resumeSessionId: "abc'123" }))
      .toBe("cd -- '/tmp/repo' && exec claude --resume 'abc'\\''123'");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/tmp/repo", resumeSessionId: "thread-1" }))
      .toBe("cd -- '/tmp/repo' && exec codex resume 'thread-1'");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/tmp/repo" })).not.toContain("tmux");
  });

  test("preflights the binary and asks Terminal to run the exact command", async () => {
    let argv: string[] = [];
    await startTerminalSession(
      { backend: "codex", cwd: "/tmp/repo", resumeSessionId: "thread-1" },
      {
        which: () => "/opt/homebrew/bin/codex",
        isDirectory: () => true,
        spawn(args) {
          argv = args;
          return settledProcess();
        },
      },
    );
    expect(argv[0]).toBe("osascript");
    expect(argv.at(-1)).toBe("cd -- '/tmp/repo' && exec codex resume 'thread-1'");
    expect(argv.join(" ")).not.toContain("tmux");
  });

  test("does not claim success when the agent binary is absent", async () => {
    await expect(startTerminalSession(
      { backend: "claude", cwd: "/tmp" },
      { which: () => null, isDirectory: () => true },
    )).rejects.toThrow("claude is not installed");
  });

  test("clean close sends Ctrl-D to the pid's Terminal tty and waits for that pid to leave", async () => {
    let argv: string[] = [];
    const alive = [true, false];
    await closeTerminalSession(4321, {
      ttyForPid: async () => "ttys007",
      pidIsAlive: async () => alive.shift() ?? false,
      sleep: async () => {},
      spawn(args) {
        argv = args;
        return settledProcess("ok\n");
      },
    });
    expect(argv.join(" ")).toContain('keystroke "d" using control down');
    expect(argv.at(-1)).toBe("ttys007");
    expect(argv.join(" ")).not.toMatch(/kill|SIG|tmux/);
  });

  test("a helper timeout cancels osascript but never signals the agent pid", async () => {
    let cancelled = false;
    const never = new Promise<number>(() => {});
    await expect(closeTerminalSession(777, {
      ttyForPid: async () => "ttys009",
      automationTimeoutMs: 1,
      spawn() {
        return {
          exited: never,
          stdout: null,
          stderr: null,
          cancel: () => { cancelled = true; },
        };
      },
    })).rejects.toThrow("automation timed out");
    expect(cancelled).toBe(true);
  });

  test("success is withheld when Ctrl-D does not produce a clean exit", async () => {
    await expect(closeTerminalSession(888, {
      ttyForPid: async () => "ttys010",
      pidIsAlive: async () => true,
      sleep: async () => {},
      exitPollAttempts: 2,
      spawn: () => settledProcess("ok\n"),
    })).rejects.toThrow("did not exit cleanly");
  });
});
