import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeAccount } from "../src/claude-accounts.ts";
import { defaultResumeLookup, resumeAccountFor, type ResumeLookup } from "../src/resume-account.ts";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";

/**
 * 2026-10-18: `conch start claude --resume 162f2800 --fork-session` from an agent in the Blueprint profile, with no
 * --account. The new Terminal's shell had no CLAUDE_CONFIG_DIR, so Claude Code started under Default, where that
 * conversation doesn't exist, and exited. The start now finds the profile that holds the conversation.
 */
const ID = "162f2800-09b3-42b2-a462-850ad1a9a1e9";
const DEFAULT: ClaudeAccount = { id: "default", label: "Default", configDir: "/Users/alex/.claude" };
const BLUEPRINT: ClaudeAccount = { id: "39b4dccc-1262-45cd-86aa-69038e482db6", label: "Blueprint", configDir: "/Users/alex/.config/conch/claude/39b4dccc" };

function lookup(held: Record<string, number>, callerConfigDir?: string): ResumeLookup {
  return {
    accounts: [DEFAULT, BLUEPRINT],
    ...(callerConfigDir ? { callerConfigDir } : {}),
    heldAt: (dir, id) => (id === ID ? held[dir] : undefined),
    canonical: (path) => path.replace(/\/$/, ""),
  };
}

describe("which profile a resume starts in", () => {
  test("the one that holds the conversation, named on the command line", () => {
    const resolved = resumeAccountFor({ backend: "claude", resumeSessionId: ID, options: { "fork-session": true } }, lookup({ [BLUEPRINT.configDir]: 5 }));
    expect(resolved).toEqual({
      ok: true,
      request: { backend: "claude", resumeSessionId: ID, options: { "fork-session": true }, claudeAccountId: BLUEPRINT.id },
      said: `resuming in the "Blueprint" account profile, which has conversation ${ID}`,
    });
  });

  test("held in two: the caller's own profile first, else the one written last, and it says the other", () => {
    const both = { [DEFAULT.configDir]: 9, [BLUEPRINT.configDir]: 5 };
    const own = resumeAccountFor({ backend: "claude", resumeSessionId: ID }, lookup(both, `${BLUEPRINT.configDir}/`));
    expect(own).toMatchObject({ ok: true, request: { claudeAccountId: BLUEPRINT.id } });
    const newest = resumeAccountFor({ backend: "claude", resumeSessionId: ID }, lookup(both));
    expect(newest).toMatchObject({ ok: true, request: { claudeAccountId: "default" } });
    expect(newest.ok && newest.said).toContain('(also in "Blueprint": pass --account to choose)');
  });

  test("an --account that doesn't hold it is refused, naming the one that does", () => {
    expect(resumeAccountFor({ backend: "claude", resumeSessionId: ID, claudeAccountId: "default" }, lookup({ [BLUEPRINT.configDir]: 5 }))).toEqual({
      ok: false,
      error: `conversation ${ID} isn't in the "Default" account profile; it is in "Blueprint" (--account ${BLUEPRINT.id})`,
    });
    expect(resumeAccountFor({ backend: "claude", resumeSessionId: ID, claudeAccountId: BLUEPRINT.id }, lookup({ [BLUEPRINT.configDir]: 5 })))
      .toMatchObject({ ok: true, request: { claudeAccountId: BLUEPRINT.id } });
  });

  test("no profile has it: refused clearly, before anything starts", () => {
    const refused = resumeAccountFor({ backend: "claude", resumeSessionId: ID }, lookup({}));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toStartWith(`no Claude account profile has conversation ${ID} (looked in "Default" (/Users/alex/.claude), "Blueprint"`);
    expect(!refused.ok && refused.error).toContain("would start with nothing to resume and exit");
  });

  test("a profile conch doesn't know, but the caller's own: started there by name, in Terminal only", () => {
    const mine = "/Users/alex/.claude-work";
    const resolved = resumeAccountFor({ backend: "claude", resumeSessionId: ID }, lookup({ [mine]: 1 }, mine));
    expect(resolved).toMatchObject({ ok: true, request: { claudeConfigDir: mine }, said: expect.stringContaining("your CLAUDE_CONFIG_DIR") });
    if (resolved.ok) expect(terminalSessionCommand({ ...resolved.request, cwd: "/tmp" })).toContain(`CLAUDE_CONFIG_DIR='${mine}' claude`);
    expect(resumeAccountFor({ backend: "claude", host: "background", resumeSessionId: ID }, lookup({ [mine]: 1 }, mine)))
      .toMatchObject({ ok: false, error: expect.stringContaining("start it in Terminal") });
  });

  test("a new session, or Codex, is left as it was", () => {
    expect(resumeAccountFor({ backend: "claude" }, lookup({}))).toEqual({ ok: true, request: { backend: "claude" } });
    expect(resumeAccountFor({ backend: "codex", resumeSessionId: ID }, lookup({}))).toEqual({ ok: true, request: { backend: "codex", resumeSessionId: ID } });
  });

  test("the real lookup finds <id>.jsonl under a profile's projects", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-resume-"));
    const dir = join(home, "profile");
    mkdirSync(join(dir, "projects", "-Users-alex-acme"), { recursive: true });
    writeFileSync(join(dir, "projects", "-Users-alex-acme", `${ID}.jsonl`), "{}\n");
    const real = defaultResumeLookup(dir);
    expect(real.heldAt(dir, ID)).toBeGreaterThan(0);
    expect(real.heldAt(dir, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
    expect(real.accounts[0]).toMatchObject({ id: "default" });
  });
});
