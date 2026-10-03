import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conchInvocation, isConchHookCommand, renderSupervisorScript, repairConchHooks, runInstall, stableExecPath, staleProgram } from "../src/install.ts";


describe("the retired supervisor", () => {
  // These tests used to guard a five-second shell loop that kept the daemon in
  // a detached tmux session. Both halves of that design were the problem, not
  // the details these tests were policing:
  //
  //  - launchd's KeepAlive already restarts a dead job, so the loop was a
  //    second supervisor competing with the first. Racing it produced three
  //    simultaneous daemons on a live machine.
  //  - a detached tmux pane is a terminal with no reader, so the daemon's own
  //    dashboard could block inside write(2) with the socket accept loop stuck
  //    behind it — alive in `ps`, while every phone request timed out.
  //
  // launchd now execs the daemon directly. What replaced this coverage is
  // test/renderer-headless.test.ts: with no TTY the daemon draws nothing, so
  // the blocking write is unreachable rather than merely unlikely.
  test("no longer supervises anything", () => {
    const code = renderSupervisorScript("/opt/homebrew/bin/tmux", "bun src/cli.ts daemon");
    expect(code).not.toMatch(/while true/);
    expect(code).not.toMatch(/new-session/);
  });
});

describe("installing conch leaves the user's own instruction files alone", () => {
  // `conch install` used to splice a managed review-contract block into the
  // GLOBAL ~/.claude/CLAUDE.md (and ~/.codex/AGENTS.md), so installing a voice
  // tool silently edited the standing prompt of every session on the machine.
  // On Tyler's Mac it had CREATED that file, whose entire contents were conch's
  // block. The contract belongs to the plugin, which ships and updates with the
  // thing it describes and uninstalls cleanly.
  //
  // The writer itself is gone. `conch uninstall` keeps its own copy of the
  // markers, to remove the block from machines that took the old install.
  test("runInstall writes settings.json and never CLAUDE.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-install-untouched-"));
    const log = console.log;
    try {
      console.log = () => {};
      await runInstall({ claudeDir: root } as any);
      expect(readdirSync(root)).toEqual(["settings.json"]);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a re-run after bun moved adds only what is missing, never a second copy", async () => {
    // Measured 2026-09-23: hooks written as bun 1.4.0, re-run under 1.4.2, from a checkout at
    // ~/Projects/Conch (no lowercase "conch" in the path): all three were added again.
    const root = mkdtempSync(join(tmpdir(), "conch-install-rerun-"));
    const old = '"/opt/homebrew/Cellar/bun/1.4.0/bin/bun" "/Users/t/Projects/Conch/src/cli.ts" hook';
    const settings = { hooks: Object.fromEntries(["Stop", "Notification", "UserPromptSubmit"].map((event) =>
      [event, [{ hooks: [{ type: "command", command: old, timeout: 15 }] }]])) };
    const log = console.log;
    try {
      console.log = () => {};
      writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
      await runInstall({ claudeDir: root } as any);
      const after = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
      for (const event of ["Stop", "Notification", "UserPromptSubmit"]) expect(after.hooks[event]).toHaveLength(1);
      expect(after.hooks.PermissionRequest).toHaveLength(1);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("conch's hook is recognised by shape, and nothing else is", () => {
    for (const mine of [
      '"/opt/homebrew/Cellar/bun/1.4.0/bin/bun" "/Users/t/Projects/Conch/src/cli.ts" hook',
      '"/usr/local/bin/conch" hook',
      "conch hook",
      // The Mac app's own daemon, which setup wires from the app.
      '"/Applications/conch.app/Contents/Helpers/conch-daemon" hook',
    ]) expect(isConchHookCommand(mine)).toBe(true);
    for (const other of ['"/usr/local/bin/other" hook', "node my-hooks.js", '"/x/cli.ts" hooks', undefined]) {
      expect(isConchHookCommand(other)).toBe(false);
    }
  });

  test("an existing CLAUDE.md is left byte-for-byte intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-install-untouched-"));
    const claudeMd = join(root, "CLAUDE.md");
    const mine = "# My rules\n\nNothing conch put here.\n";
    const log = console.log;
    try {
      console.log = () => {};
      writeFileSync(claudeMd, mine);
      await runInstall({ claudeDir: root } as any);
      expect(readFileSync(claudeMd, "utf8")).toBe(mine);
      // and no timestamped backup, which is the fingerprint of a write
      expect(readdirSync(root).filter((n) => n.includes("conch-backup"))).toEqual([]);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hooks that survive a bun upgrade", () => {
  // 2026-10-03: hooks named `/opt/homebrew/Cellar/bun/1.4.0/bin/bun`, Homebrew upgraded bun to 1.4.2 and deleted
  // 1.4.0, and every prompt in that account said "UserPromptSubmit hook error … No such file or directory" while
  // conch heard nothing from it. "Already wired" kept the broken ones.
  const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => {};
    try { return await run(); } finally { console.log = log; }
  };

  test("a Cellar path is written as the link Homebrew keeps current, when there is one", () => {
    const linked = new Set(["/opt/homebrew/bin/bun", "/usr/local/bin/conch"]);
    const exists = (path: string) => linked.has(path);
    expect(stableExecPath("/opt/homebrew/Cellar/bun/1.4.2/bin/bun", exists)).toBe("/opt/homebrew/bin/bun");
    expect(stableExecPath("/usr/local/Cellar/conch/0.3.0/bin/conch", exists)).toBe("/usr/local/bin/conch");
    // No link: the path as it is, never one that doesn't exist.
    expect(stableExecPath("/opt/homebrew/Cellar/node/22/bin/node", exists)).toBe("/opt/homebrew/Cellar/node/22/bin/node");
    expect(stableExecPath("/Users/t/.bun/bin/bun", exists)).toBe("/Users/t/.bun/bin/bun");
  });

  test("a command is stale when its program is gone or pinned to one Cellar version", () => {
    const live = mkdtempSync(join(tmpdir(), "conch-live-program-"));
    const program = join(live, "bun");
    writeFileSync(program, "");
    try {
      expect(staleProgram('"/opt/homebrew/Cellar/bun/1.4.2/bin/bun" "/x/src/cli.ts" hook', () => true)).toBe(true);
      expect(staleProgram('"/nowhere/bun" "/x/src/cli.ts" hook')).toBe(true);
      expect(staleProgram(`"${program}" "/x/src/cli.ts" hook`)).toBe(false);
      // The status line's own prefix comes first.
      expect(staleProgram(`CONCH_CONFIG_DIR='/c' "/nowhere/bun" "/x/src/cli.ts" usage-statusline 'a' '/d'`)).toBe(true);
      expect(staleProgram(`CONCH_CONFIG_DIR='/c' "${program}" "/x/src/cli.ts" usage-statusline 'a' '/d'`)).toBe(false);
      expect(staleProgram("conch hook")).toBe(false);
      expect(staleProgram(undefined)).toBe(false);
    } finally { rmSync(live, { recursive: true, force: true }); }
  });

  test("a re-run points a stale hook at this bun, in place, and leaves a live one alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-install-repair-"));
    const helper = join(root, "conch-daemon");
    writeFileSync(helper, "");
    const old = '"/opt/homebrew/Cellar/bun/1.4.0/bin/bun" "/Users/t/Projects/Conch/src/cli.ts" hook';
    const live = `"${helper}" hook`;
    writeFileSync(join(root, "settings.json"), JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: old, timeout: 15 }] }],
      Notification: [{ hooks: [{ type: "command", command: live, timeout: 15 }] }],
    } }));
    try {
      await quiet(() => runInstall({ claudeDir: root } as any));
      const after = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
      expect(after.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: `${conchInvocation()} hook`, timeout: 15 }] }]);
      expect(after.hooks.Notification).toEqual([{ hooks: [{ type: "command", command: live, timeout: 15 }] }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the daemon's repair mends only conch's stale hooks: it adds nothing, and keeps a backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-hook-repair-"));
    const old = '"/opt/homebrew/Cellar/bun/1.4.0/bin/bun" "/Users/t/Projects/Conch/src/cli.ts" hook';
    const theirs = '"/nowhere/their-tool" run';
    writeFileSync(join(root, "settings.json"), JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: old }] }, { hooks: [{ type: "command", command: theirs }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: old }] }],
    } }));
    try {
      expect(await repairConchHooks(root)).toBe(2);
      const after = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
      expect(after.hooks.Stop[0].hooks[0].command).toBe(`${conchInvocation()} hook`);
      expect(after.hooks.Stop[1].hooks[0].command).toBe(theirs);
      expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`${conchInvocation()} hook`);
      // A hook someone removed stays removed.
      expect(Object.keys(after.hooks).sort()).toEqual(["Stop", "UserPromptSubmit"]);
      expect(readdirSync(root).filter((name) => name.includes("conch-backup"))).toHaveLength(1);
      // Nothing left to mend: nothing written.
      expect(await repairConchHooks(root)).toBe(0);
      expect(readdirSync(root).filter((name) => name.includes("conch-backup"))).toHaveLength(1);
      // No settings, or settings it can't read: left alone.
      expect(await repairConchHooks(join(root, "missing"))).toBe(0);
      writeFileSync(join(root, "settings.json"), "{ not json");
      expect(await repairConchHooks(root)).toBe(0);
      expect(readFileSync(join(root, "settings.json"), "utf8")).toBe("{ not json");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
