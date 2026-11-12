import { describe, expect, test } from "bun:test";
import { withUITransaction } from "../src/inject.ts";
import { claudeExitBlocker, lastScreenLine, stillRunningReason, stopTasksMessage } from "../src/exit-screen.ts";
import { claudeInputBoxText } from "../src/agent-adapter.ts";
import { closeTerminalSession, type SessionLifecycleDependencies, type SessionLifecycleProcess } from "../src/session-lifecycle.ts";

/**
 * The two screens a close's Ctrl-D landed on without leaving, 2026-10-23, Claude Code 2.1.280, as `tmux capture-pane -p`
 * printed them. Case A: closing "conch brand", whose `until grep …; do sleep 3; done` had run for three weeks. Case B:
 * restarting a session whose Claude Code had lost its own install folder to a Homebrew upgrade, in its
 * background-sessions view.
 */
const CASE_A = `
  Background work is running
  The following will stop when you exit:
  shell · Wait for WebKit run to finish and show tail
  ❯ 1. Exit and stop tasks
    2. Move to background and exit
    3. Stay
  Enter to confirm · Esc to cancel
`;
const CASE_B = `
Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits
Completed
 ∙ Conch session modal bug and mobile feat…  …
❯ the prompt conch had injected, never submitted
  Couldn't reach the background service (spawn background service: ENOENT …)
`;
/** An idle conversation at its empty input box (pane %3's shape on the same day). */
const CONVERSATION = `
  If you'd rather not roll the key yet, closing the account or unlinking its bank account removes that risk too.

✻ Cooked for 10s · done 1:55 AM
                                                                                                    new task? /clear to save 163.9k tokens
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;
const withInput = (words: string) => CONVERSATION.replace(/^❯ ?$/m, `❯ ${words}`);

describe("reading the screen a Ctrl-D landed on", () => {
  test("case A: the question names the work an exit would stop, and that Exit is highlighted", () => {
    expect(claudeExitBlocker(CASE_A)).toEqual({
      kind: "stop-tasks",
      tasks: ["Wait for WebKit run to finish and show tail"],
      more: 0,
      complete: true,
      exitHighlighted: true,
    });
  });

  test("case A in a frame, with several tasks and a count for the rest", () => {
    const framed = `╭──────────────────────────────────────────╮
│ Background work is running               │
│ The following will stop when you exit:   │
│ shell · npm run dev                      │
│ agent · Checking sdk.test.ts progress    │
│ … and 3 more                             │
│   1. Exit and stop tasks                 │
│ ❯ 2. Move to background and exit         │
│   3. Stay                                │
╰──────────────────────────────────────────╯`;
    expect(claudeExitBlocker(framed)).toEqual({
      kind: "stop-tasks",
      tasks: ["npm run dev", "Checking sdk.test.ts progress"],
      more: 3,
      complete: true,
      exitHighlighted: false,
    });
  });

  test("a list whose heading has scrolled off the top is read as far as it goes, and says so", () => {
    const tall = `  shell · one\n  shell · two\n  ❯ 1. Exit and stop tasks\n    2. Move to background and exit\n    3. Stay\n`;
    expect(claudeExitBlocker(tall)).toMatchObject({ tasks: ["one", "two"], complete: false });
  });

  test("case B: the background-sessions view, and whether it says Ctrl-C twice quits", () => {
    expect(claudeExitBlocker(CASE_B)).toEqual({ kind: "background-view", quitsOnCtrlC: true });
    // Wrapped by a narrow Terminal tab.
    expect(claudeExitBlocker("Your conversation moved to the\nbackground — enter opens it · esc returns\nto it\n"))
      .toEqual({ kind: "background-view", quitsOnCtrlC: false });
  });

  test("neither is read into an ordinary conversation, or one that mentions a choice", () => {
    expect(claudeExitBlocker(CONVERSATION)).toBeNull();
    expect(claudeExitBlocker(`${CONVERSATION}\n  It offered "Exit and stop tasks", so I picked that.\n`)).toBeNull();
    // This very screen, pasted into a turn: the input box below it says it is conversation, and Return would send the box.
    expect(claudeExitBlocker(`> ${CASE_A}\n${CONVERSATION}`)).toBeNull();
    expect(claudeExitBlocker("")).toBeNull();
  });

  test("the last line that says something: not the rules round the input box, nor a bare prompt", () => {
    expect(lastScreenLine(CONVERSATION)).toBe("⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents");
    expect(lastScreenLine("Thinking about it\n────────────\n❯ \n────────────\n\n")).toBe("Thinking about it");
    expect(lastScreenLine("\n\n[Process completed]\n")).toBeUndefined();
  });
});

describe("what a close says", () => {
  test("case A, named as Claude Code names it, and what pressing again does", () => {
    const question = claudeExitBlocker(CASE_A);
    if (question?.kind !== "stop-tasks") throw new Error("not read as the question");
    expect(stopTasksMessage(question)).toBe(
      'Claude Code is asking before it stops 1 background task: "Wait for WebKit run to finish and show tail". Close again to stop it and exit.',
    );
    expect(stopTasksMessage(question, true)).toBe(
      'Claude Code is asking before it stops 1 background task: "Wait for WebKit run to finish and show tail". Restart again to stop it and restart.',
    );
  });

  test("several tasks, a count past three, and a list cut off at the top", () => {
    const base = { kind: "stop-tasks" as const, more: 0, complete: true, exitHighlighted: true };
    expect(stopTasksMessage({ ...base, tasks: ["a", "b"] })).toBe(
      'Claude Code is asking before it stops 2 background tasks: "a" and "b". Close again to stop them and exit.',
    );
    expect(stopTasksMessage({ ...base, tasks: ["a", "b", "c", "d"], more: 2 })).toBe(
      'Claude Code is asking before it stops 6 background tasks: "a", "b", "c" and 3 more. Close again to stop them and exit.',
    );
    expect(stopTasksMessage({ ...base, tasks: ["a"], complete: false })).toContain("stops at least 1 background task:");
    expect(stopTasksMessage({ ...base, tasks: [] })).toBe(
      "Claude Code is asking before it stops its background work. Close again to stop them and exit.",
    );
  });

  test("still running: the view it is in, the words in its box, its last line, or that it couldn't be read", () => {
    expect(stillRunningReason(CASE_B, claudeExitBlocker(CASE_B), null)).toBe(
      "It is still in Claude Code's background-sessions view: \"Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits\".",
    );
    expect(stillRunningReason(withInput("fix the modal"), null, "fix the modal"))
      .toBe('Its input box holds "fix the modal", and Ctrl-D leaves only from an empty one.');
    expect(stillRunningReason(CONVERSATION, null, ""))
      .toBe('Its screen ends: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents".');
    expect(stillRunningReason(null, null, null)).toBe("Its screen couldn't be read.");
    expect(stillRunningReason("\n\n", null, null)).toBe("Its screen is blank.");
    // A Terminal tab's text can hold a tab character, which the app's error report would refuse.
    expect(stillRunningReason("Saving\tthe transcript\n", null, null)).toBe('Its screen ends: "Saving the transcript".');
  });
});

const identityFor = (pid: number) => ({ pid, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/claude", ttyDevice: 7 });
const NAME = "conch-5e5e5e07-0007-4000-8000-000000000007";

/**
 * A background session on conch's tmux server whose screen is whatever `screens` says next (the last one stays), whose
 * keys are recorded, and which leaves when `leaves` says the keys so far would make it.
 */
function backgroundSession(pid: number, screens: string[], leaves: (keys: string[]) => boolean = () => false) {
  const keys: string[] = [];
  const looks: Array<{ pane: string } | { tty: string }> = [];
  const dependencies: SessionLifecycleDependencies = {
    backend: "claude",
    expectedIdentity: identityFor(pid),
    processIdentity: identityFor,
    backgroundSession: async () => ({ name: NAME, pane: "conch:%7" }),
    probe: async (argv) => {
      if (argv.includes("send-keys")) keys.push(argv.at(-1)!);
      return "";
    },
    readScreen: async (at) => {
      looks.push(at);
      return (screens.length > 1 ? screens.shift() : screens[0]) ?? null;
    },
    pidIsAlive: async () => !leaves(keys),
    sleep: async () => {},
    spawn: () => { throw new Error("a background close must not automate Terminal"); },
  };
  return { keys, looks, dependencies };
}

describe("closing a background session that asks before it stops its work (case A)", () => {
  test("the question is put to the person and nothing is pressed, the first time", async () => {
    const session = backgroundSession(4101, [CASE_A]);
    await expect(closeTerminalSession(4101, session.dependencies)).rejects.toThrow(
      'Claude Code is asking before it stops 1 background task: "Wait for WebKit run to finish and show tail". Close again to stop it and exit.',
    );
    expect(session.keys).toEqual([]);
    expect(session.looks).toEqual([{ pane: "conch:%7" }]);
  });

  test("asked on Ctrl-D, it says so at once, and a second close answers Exit and stop tasks", async () => {
    // Ctrl-D twice, then the question, as on "conch brand".
    let looks = 0;
    const first = backgroundSession(4102, [CONVERSATION, CASE_A]);
    first.dependencies.pidIsAlive = async () => { looks += 1; return true; };
    await expect(closeTerminalSession(4102, first.dependencies)).rejects.toThrow("Close again to stop it and exit.");
    expect(first.keys).toEqual(["C-d", "C-d"]);
    // Within about a second of polls, not the whole 15 s wait.
    expect(looks).toBeLessThanOrEqual(10);

    const second = backgroundSession(4102, [CASE_A], (keys) => keys.includes("Enter"));
    await closeTerminalSession(4102, second.dependencies);
    expect(second.keys).toEqual(["Enter"]);
  });

  test("a restart asks in a restart's words, and its second press answers the same way", async () => {
    const first = backgroundSession(4103, [CASE_A]);
    await expect(closeTerminalSession(4103, { ...first.dependencies, restart: true }))
      .rejects.toThrow("Restart again to stop it and restart.");
    const second = backgroundSession(4103, [CASE_A], (keys) => keys.includes("Enter"));
    await closeTerminalSession(4103, { ...second.dependencies, restart: true });
    expect(second.keys).toEqual(["Enter"]);
  });

  test("a question about different work is put again, not answered", async () => {
    await expect(closeTerminalSession(4104, backgroundSession(4104, [CASE_A]).dependencies)).rejects.toThrow("Close again");
    const changed = CASE_A.replace("Wait for WebKit run to finish and show tail", "npm run dev");
    const second = backgroundSession(4104, [changed]);
    await expect(closeTerminalSession(4104, second.dependencies)).rejects.toThrow('stops 1 background task: "npm run dev"');
    expect(second.keys).toEqual([]);
  });

  test("the same pid in a new process is a new session: its question is put, not answered", async () => {
    await expect(closeTerminalSession(4105, backgroundSession(4105, [CASE_A]).dependencies)).rejects.toThrow("Close again");
    const reborn = backgroundSession(4105, [CASE_A]);
    const identity = { ...identityFor(4105), birth: "2000.000001", birthTimeMs: 2_000_000.001 };
    await expect(closeTerminalSession(4105, { ...reborn.dependencies, expectedIdentity: identity, processIdentity: () => identity }))
      .rejects.toThrow("Close again");
    expect(reborn.keys).toEqual([]);
  });

  test("never Move to background: with the highlight moved off Exit, Escape (Stay) and Ctrl-D ask again", async () => {
    await expect(closeTerminalSession(4106, backgroundSession(4106, [CASE_A]).dependencies)).rejects.toThrow("Close again");
    const moved = CASE_A.replace("❯ 1. Exit and stop tasks", "  1. Exit and stop tasks").replace("  2. Move to background", "❯ 2. Move to background");
    const second = backgroundSession(4106, [moved, CONVERSATION, CASE_A]);
    await expect(closeTerminalSession(4106, second.dependencies)).rejects.toThrow("Close again to stop it and exit.");
    expect(second.keys).toEqual(["Escape", "C-d", "C-d"]);
    expect(second.keys).not.toContain("Enter");
    expect(second.keys).not.toContain("Down");
  });

  test("a session that leaves once the question is answered is forgotten: a later question is put afresh", async () => {
    await expect(closeTerminalSession(4107, backgroundSession(4107, [CASE_A]).dependencies)).rejects.toThrow("Close again");
    await closeTerminalSession(4107, backgroundSession(4107, [CASE_A], (keys) => keys.includes("Enter")).dependencies);
    const later = backgroundSession(4107, [CASE_A]);
    await expect(closeTerminalSession(4107, later.dependencies)).rejects.toThrow("Close again");
    expect(later.keys).toEqual([]);
  });
});

describe("closing a background session in its background-sessions view (case B)", () => {
  test("Escape returns to the conversation, and Ctrl-D leaves from there", async () => {
    const session = backgroundSession(4201, [CASE_B, CONVERSATION], (keys) => keys.filter((key) => key === "C-d").length === 2);
    await closeTerminalSession(4201, session.dependencies);
    expect(session.keys).toEqual(["Escape", "C-d", "C-d"]);
  });

  test("still in the view after Escape: Ctrl-C twice, as the view says quits", async () => {
    const session = backgroundSession(4202, [CASE_B], (keys) => keys.filter((key) => key === "C-c").length === 2);
    await closeTerminalSession(4202, { ...session.dependencies, restart: true });
    expect(session.keys).toEqual(["Escape", "C-c", "C-c"]);
  });

  test("and if even that doesn't take, it says where it still is", async () => {
    const session = backgroundSession(4203, [CASE_B]);
    await expect(closeTerminalSession(4203, { ...session.dependencies, exitPollAttempts: 3 })).rejects.toThrow(
      "Ctrl-C was pressed twice, as its screen says to quit, but the background session is still running after 300 ms. It is still in Claude Code's background-sessions view",
    );
  });
});

describe("closing a background session that stays for a reason conch doesn't know", () => {
  test("the message quotes its screen, never \"it may be finishing up\"", async () => {
    const session = backgroundSession(4301, [CONVERSATION, "  Running SessionEnd hooks…\n"]);
    const close = closeTerminalSession(4301, { ...session.dependencies, exitPollAttempts: 3 });
    await expect(close).rejects.toThrow(
      'Ctrl-D was sent, but the background session is still running after 300 ms. Its screen ends: "Running SessionEnd hooks…".',
    );
    await expect(close).rejects.not.toThrow("finishing up");
  });

  test("words left in its input box are named: Ctrl-D leaves only from an empty one", async () => {
    const session = backgroundSession(4302, [withInput("ship the modal fix")]);
    await expect(closeTerminalSession(4302, { ...session.dependencies, exitPollAttempts: 3 })).rejects.toThrow(
      'Its input box holds "ship the modal fix", and Ctrl-D leaves only from an empty one.',
    );
    expect(claudeInputBoxText(withInput("ship the modal fix"))).toBe("ship the modal fix");
  });

  test("Codex screens are not read as Claude Code's: one Ctrl-D, and only its last line quoted", async () => {
    const identity = { ...identityFor(4303), executable: "/opt/bin/codex" };
    const session = backgroundSession(4303, [CASE_A]);
    await expect(closeTerminalSession(4303, {
      ...session.dependencies, backend: "codex", expectedIdentity: identity, processIdentity: () => identity, exitPollAttempts: 3,
    })).rejects.toThrow('Its screen ends: "Enter to confirm · Esc to cancel".');
    expect(session.keys).toEqual(["C-d"]);
  });
});

function settledProcess(stdout = "", code = 0): SessionLifecycleProcess {
  return { exited: Promise.resolve(code), stdout: new Response(stdout).body, stderr: new Response("").body, cancel() {} };
}
const isTabClose = (script: string) => script.includes('tell application "conch"');

describe("closing a session in a Terminal tab that asks before it stops its work", () => {
  const terminalSession = (pid: number, screens: string[], leaves: (scripts: string[]) => boolean = () => false) => {
    const scripts: string[] = [];
    const dependencies: SessionLifecycleDependencies = {
      backend: "claude",
      expectedIdentity: identityFor(pid),
      processIdentity: identityFor,
      ttyForPid: async () => "ttys044",
      readScreen: async (at) => {
        expect(at).toEqual({ tty: "ttys044" });
        return (screens.length > 1 ? screens.shift() : screens[0]) ?? null;
      },
      pidIsAlive: async () => !leaves(scripts),
      sleep: async () => {},
      spawn(args) {
        scripts.push(args.join(" "));
        return settledProcess("ok\n");
      },
    };
    return { scripts, dependencies };
  };

  test("the tab is read without raising it, the question is put, and the tab is left as it is", async () => {
    const session = terminalSession(4401, [CASE_A]);
    await expect(closeTerminalSession(4401, session.dependencies)).rejects.toThrow("Close again to stop it and exit.");
    expect(session.scripts).toEqual([]);
  });

  test("the second close raises the tab and presses Return behind the focus guard, never Ctrl-D", async () => {
    await expect(closeTerminalSession(4402, terminalSession(4402, [CASE_A]).dependencies)).rejects.toThrow("Close again");
    const second = terminalSession(4402, [CASE_A], (scripts) => scripts.some((script) => script.includes("key code 36")));
    await closeTerminalSession(4402, second.dependencies);
    const press = second.scripts.find((script) => script.includes("key code 36"));
    expect(press).toContain("/dev/ttys044");
    expect(second.scripts.some((script) => script.includes('keystroke "d"'))).toBe(false);
    await withUITransaction(async () => {});
    expect(second.scripts.filter(isTabClose)).toHaveLength(1);
  });

  test("still running for another reason: its last line, and the tab to look at", async () => {
    const session = terminalSession(4403, [CONVERSATION, "Still saving the transcript"]);
    await expect(closeTerminalSession(4403, { ...session.dependencies, exitPollAttempts: 3 })).rejects.toThrow(
      'Ctrl-D was sent, but the session is still running after 300 ms. Its screen ends: "Still saving the transcript". Check its Terminal tab.',
    );
    await withUITransaction(async () => {});
    expect(session.scripts.some(isTabClose)).toBe(false);
  });
});
