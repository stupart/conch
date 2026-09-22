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
    // Repointed: closeTerminalSession now runs a third osascript after the Ctrl-D presses
    // (close the tab, return to conch), so every spawn call is captured instead of just the
    // last one — the original single `argv` capture would otherwise silently start asserting
    // against the tidy-up script instead of the Ctrl-D script.
    test(`clean close sends ${presses} Ctrl-D to a ${backend} pid's Terminal tty, waits for that pid to leave, then closes its tab and returns to conch`, async () => {
      const calls: string[][] = [];
      const alive = [true, false];
      await closeTerminalSession(4321, {
        expectedIdentity: { ...identityFor(4321), executable: `/opt/bin/${backend}` }, backend,
        processIdentity: (pid) => ({ ...identityFor(pid), executable: `/opt/bin/${backend}` }),
        ttyForPid: async () => "ttys007",
        pidIsAlive: async () => alive.shift() ?? false,
        sleep: async () => {},
        spawn(args) {
          calls.push(args);
          return settledProcess("ok\n");
        },
      });
      const pressCall = calls.find((args) => args.join(" ").includes('keystroke "d"'));
      if (!pressCall) throw new Error("Ctrl-D script never ran");
      const script = pressCall.join(" ");
      const press = 'keystroke "d" using control down';
      expect(script.split(press).length - 1).toBe(presses);
      // The tty travels as the guard's own argument now: the script checks the front window is
      // still this session's before the key, instead of trusting the raise it just asked for.
      expect(pressCall.at(-1)).toBe("/dev/ttys007");
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
      // The tidy-up script runs strictly after the Ctrl-D script, only once the pid is
      // confirmed gone (waitForExit above has already returned by this point).
      const tidyIndex = calls.findIndex((args) => args.join(" ").includes('tell application "conch"'));
      expect(tidyIndex).toBeGreaterThan(calls.indexOf(pressCall));
      const tidyScript = calls[tidyIndex]!.join(" ");
      expect(tidyScript).toContain('if tty of t is "/dev/ttys007" then');
      expect(tidyScript).toContain("close t saving no");
      expect(tidyScript).toContain('tell application "conch" to activate');
      expect(tidyScript).not.toMatch(/kill|SIG|tmux/);
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

  // A poll timeout must skip the tab close and the return-to-conch entirely: if the process is
  // still stuck, the tab (and whatever it's showing) has to stay on screen for the user to look
  // at, not get closed out from under them.
  test("success is withheld when Ctrl-D does not produce a clean exit, and the tab is never closed", async () => {
    const calls: string[][] = [];
    await expect(closeTerminalSession(888, {
      expectedIdentity: identityFor(888), processIdentity: identityFor,
      ttyForPid: async () => "ttys010",
      pidIsAlive: async () => true,
      sleep: async () => {},
      exitPollAttempts: 2,
      spawn(args) {
        calls.push(args);
        return settledProcess("ok\n");
      },
    })).rejects.toThrow("did not exit cleanly");
    expect(calls.some((args) => args.join(" ").includes('tell application "conch"'))).toBe(false);
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
    // The close throws before waitForExit is ever reached, so the tab close and the
    // return-to-conch — which only run once the pid is confirmed gone — never fire either.
    expect(scripts.some((script) => script.includes('tell application "conch"'))).toBe(false);
  });

  /**
   * A window can hold tabs from unrelated sessions — Tyler was explicit that closing one
   * session's tab must never take a sibling tab, or its window, with it. These tests never
   * drive a real Terminal, so the proof is a property of the generated script itself: the
   * close is nested inside an `if` that matches ONLY this session's own tty by exact string
   * equality, it is the sole close statement the script contains, and its direct object is
   * the tab (`t`), never the window (`w`) — so a second tab sharing the window, on any other
   * tty, has no path in this script that can reach it.
   */
  test("closing one session's tab cannot touch a sibling tab sharing its window", async () => {
    const calls: string[][] = [];
    await closeTerminalSession(4242, {
      expectedIdentity: identityFor(4242), processIdentity: identityFor,
      ttyForPid: async () => "ttys042",
      pidIsAlive: async () => false,
      sleep: async () => {},
      spawn(args) {
        calls.push(args);
        return settledProcess("ok\n");
      },
    });
    const tidyUp = calls.find((args) => args.join(" ").includes('tell application "conch"'));
    if (!tidyUp) throw new Error("tidy-up script did not run");
    const script = tidyUp.join(" ");
    // A sibling tab's tty (e.g. "ttys099", belonging to a session conch was not asked to
    // close) never has any literal to match against, because this session's tty is the only
    // one the script ever embeds.
    expect(script).not.toContain("ttys099");
    const terminalStart = script.indexOf('tell application "Terminal"');
    const terminalEnd = script.indexOf("end tell", terminalStart);
    expect(terminalStart).toBeGreaterThanOrEqual(0);
    expect(terminalEnd - terminalStart).toBeGreaterThan(60); // a real repeat/if body, not an empty tell
    const block = script.slice(terminalStart, terminalEnd);
    const ifIndex = block.indexOf('if tty of t is "/dev/ttys042" then');
    const closeIndex = block.indexOf("close t saving no");
    const endIfIndex = block.indexOf("end if", closeIndex);
    expect(ifIndex).toBeGreaterThanOrEqual(0);
    // The close sits between the matching `if` and its `end if` — never outside it.
    expect(closeIndex).toBeGreaterThan(ifIndex);
    expect(endIfIndex).toBeGreaterThan(closeIndex);
    // Exactly one close in the whole Terminal block, and it targets a tab, never a window.
    expect(block.match(/\bclose /g)?.length).toBe(1);
    expect(block).not.toMatch(/close w\b/);
    expect(block).not.toContain("close window");
    // conch is raised only after the Terminal tell block finishes — in the same script, not a
    // separate call — so an error closing the tab leaves conch un-raised instead of covering
    // up whatever is stuck.
    const conchIndex = script.indexOf('tell application "conch" to activate');
    expect(conchIndex).toBeGreaterThan(terminalEnd);
  });

  /**
   * The tab close and return-to-conch are best-effort: the pid is already confirmed gone by
   * this point, so nothing about tidying up the Terminal window is allowed to turn a session
   * that actually closed into a reported failure. Simulated here as Terminal wedging on its
   * own "terminate running processes?" prompt (the one case `saving no` cannot silence) —
   * the automation helper never returns, and the call must still resolve once the bounded
   * automation timeout reaps it.
   */
  test("a wedged Terminal prompt while closing the tab does not fail an already-successful close", async () => {
    const calls: string[][] = [];
    await closeTerminalSession(6001, {
      expectedIdentity: identityFor(6001), processIdentity: identityFor,
      ttyForPid: async () => "ttys060",
      pidIsAlive: async () => false,
      sleep: async () => {},
      automationTimeoutMs: 5,
      spawn(args) {
        calls.push(args);
        if (args.join(" ").includes('tell application "conch"')) {
          return { exited: new Promise<number>(() => {}), stdout: null, stderr: null, cancel() {} };
        }
        return settledProcess("ok\n");
      },
    }); // resolving at all is the assertion — a throw here would fail the test
    expect(calls.some((args) => args.join(" ").includes('tell application "conch"'))).toBe(true);
  });
});
