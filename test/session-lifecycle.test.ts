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

const identityFor = (pid: number) => ({ pid, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/claude", ttyDevice: 7 });

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

  /**
   * Claude Code 2.1.266 treats Ctrl-D like Ctrl-C: one press shows "Press Ctrl-D again to
   * exit" and only a second within 800ms leaves. Tyler's close "did not exit cleanly after
   * Ctrl-D" because conch pressed once; the session sat at its prompt with the hint on screen.
   * Codex 0.155.1 leaves on one press, and its tab's process is gone within 200ms, so a second
   * press there would land in whatever the finished tab gives way to. The count is the
   * adapter's, and every press — not only the first — sits behind the front-window guard.
   */
  for (const [backend, presses] of [["claude", 2], ["codex", 1]] as const) {
    test(`clean close sends ${presses} Ctrl-D to a ${backend} pid's Terminal tty and waits for that pid to leave`, async () => {
      let argv: string[] = [];
      const alive = [true, false];
      await closeTerminalSession(4321, {
        expectedIdentity: { ...identityFor(4321), executable: `/opt/bin/${backend}` }, backend,
        processIdentity: (pid) => ({ ...identityFor(pid), executable: `/opt/bin/${backend}` }),
        ttyForPid: async () => "ttys007",
        pidIsAlive: async () => alive.shift() ?? false,
        sleep: async () => {},
        spawn(args) {
          argv = args;
          return settledProcess("ok\n");
        },
      });
      const script = argv.join(" ");
      const press = 'keystroke "d" using control down';
      expect(script.split(press).length - 1).toBe(presses);
      // The tty travels as the guard's own argument now: the script checks the front window is
      // still this session's before the key, instead of trusting the raise it just asked for.
      expect(argv.at(-1)).toBe("/dev/ttys007");
      expect(script.split("conch-focus-guard").length - 1).toBe(presses);
      // A guard precedes each press, and the presses are one script: the second must land
      // inside Claude Code's 800ms window, which two osascript launches cannot promise.
      expect(script.indexOf("conch-focus-guard")).toBeLessThan(script.indexOf(press));
      if (presses === 2) {
        const second = script.indexOf(press, script.indexOf(press) + 1);
        expect(script.indexOf("conch-focus-guard", script.indexOf(press))).toBeLessThan(second);
        expect(script.slice(script.indexOf(press), second)).toContain("delay 0.15");
      }
      expect(script).not.toMatch(/kill|SIG|tmux/);
    });
  }

  test("a helper timeout cancels osascript but never signals the agent pid", async () => {
    let cancelled = false;
    let observedExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { observedExit = resolve; });
    await expect(closeTerminalSession(777, {
      expectedIdentity: identityFor(777), processIdentity: identityFor,
      ttyForPid: async () => "ttys009",
      automationTimeoutMs: 1,
      spawn() {
        return {
          exited,
          stdout: null,
          stderr: null,
          cancel: () => { cancelled = true; observedExit(0); },
        };
      },
    })).rejects.toThrow("automation timed out");
    expect(cancelled).toBe(true);
  });

  test("success is withheld when Ctrl-D does not produce a clean exit", async () => {
    await expect(closeTerminalSession(888, {
      expectedIdentity: identityFor(888), processIdentity: identityFor,
      ttyForPid: async () => "ttys010",
      pidIsAlive: async () => true,
      sleep: async () => {},
      exitPollAttempts: 2,
      spawn: () => settledProcess("ok\n"),
    })).rejects.toThrow("did not exit cleanly");
  });

  /**
   * Close types Ctrl-D into a window it has just raised. The UI transaction queue holds off
   * conch's own actions, not the user's: a Cmd-Tab in the gap between the raise and the key
   * puts an end-of-file into whatever came forward. The injector already refuses that — its
   * guarded action re-reads the frontmost app and the front tab's tty inside the same script
   * as the keystroke — and Close now asks the same question before ending anything.
   */
  test("close refuses to send Ctrl-D once another window is in front", async () => {
    const scripts: string[] = [];
    await expect(closeTerminalSession(5150, {
      expectedIdentity: identityFor(5150), processIdentity: identityFor,
      ttyForPid: async () => "ttys011",
      pidIsAlive: async () => false,
      sleep: async () => {},
      spawn(args) {
        const script = args.join(" ");
        scripts.push(script);
        return settledProcess(script.includes("conch-focus-guard") ? "front-window-changed\n" : "ok\n");
      },
    })).rejects.toThrow("another window came to the front");
    // Every Ctrl-D conch can send is inside a script that checks the front window first.
    expect(scripts.some((script) => script.includes('keystroke "d"'))).toBe(true);
    for (const script of scripts.filter((s) => s.includes('keystroke "d"'))) {
      expect(script).toContain("conch-focus-guard");
    }
  });
});
