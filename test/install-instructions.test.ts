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
import { isConchHookCommand, renderSupervisorScript, runInstall } from "../src/install.ts";


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
