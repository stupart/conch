import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAccounts } from "../src/codex-accounts.ts";
import {
  backgroundHookReviewError,
  codexHookReview,
  decodeHooksList,
  readCodexHooks,
  type CodexHookListing,
} from "../src/codex-hook-trust.ts";
import { restartRequest, startRequestFromArgv, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateRuntimeControlMessage } from "../src/settings.ts";

let root: string;
let codexHome: string;
let old: NodeJS.ProcessEnv;
beforeEach(() => {
  old = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), "conch-codex-hook-trust-")));
  codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "hooks.json"), "{}");
  process.env.CONCH_CONFIG_DIR = join(root, "conch");
  process.env.CODEX_HOME = codexHome;
});
afterEach(() => {
  for (const key of ["CONCH_CONFIG_DIR", "CODEX_HOME"]) {
    if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const COMMAND = `"/opt/homebrew/bin/bun" "/Users/someone/Projects/Conch/src/cli.ts" codex-hook`;
const HASH = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

/** One `hooks/list` entry, as codex-cli 0.164.0 gives it for a hook in this home's hooks.json. */
function hook(event: string, overrides: Partial<CodexHookListing> = {}): CodexHookListing {
  const hooksJson = join(codexHome, "hooks.json");
  return {
    key: `${hooksJson}:${event}:0:0`,
    source: "user",
    sourcePath: hooksJson,
    command: COMMAND,
    currentHash: HASH(event.length),
    trustStatus: "untrusted",
    ...overrides,
  };
}

describe("codexHookReview", () => {
  test("conch's own untrusted hooks are trusted for the launch, at the hash Codex gave them, as one -c table", () => {
    const review = codexHookReview([hook("session_start"), hook("stop", { trustStatus: "modified", currentHash: HASH(7) })], codexHome, COMMAND);
    const hooksJson = join(codexHome, "hooks.json");
    expect(review).toEqual({
      trust: `hooks.state={"${hooksJson}:session_start:0:0"={trusted_hash="${HASH(13)}"},"${hooksJson}:stop:0:0"={trusted_hash="${HASH(7)}"}}`,
      others: [],
    });
  });

  test("a hook already trusted, or managed, needs nothing", () => {
    expect(codexHookReview([hook("stop", { trustStatus: "trusted" }), hook("session_start", { trustStatus: "managed" })], codexHome, COMMAND))
      .toEqual({ others: [] });
  });

  test("only conch's exact command, from this home's own hooks.json, is conch's to vouch for", () => {
    const repo = join(root, "repo", ".codex", "hooks.json");
    const review = codexHookReview([
      hook("stop"),
      // Another hook of the person's own: Codex's question, not conch's.
      hook("user_prompt_submit", { command: "say done" }),
      // A cloned repo's hooks naming conch's command are still the repo's.
      hook("session_start", { source: "project", sourcePath: repo, key: `${repo}:session_start:0:0` }),
      // Close to conch's command is not conch's command.
      hook("pre_tool_use", { command: `${COMMAND} --and-more` }),
      // A handler with no command is named by its key.
      { ...hook("post_tool_use"), command: undefined },
    ], codexHome, COMMAND);
    expect(review.trust).toBe(`hooks.state={"${join(codexHome, "hooks.json")}:stop:0:0"={trusted_hash="${HASH(4)}"}}`);
    expect(review.others).toEqual(["say done", COMMAND, `${COMMAND} --and-more`, `${join(codexHome, "hooks.json")}:post_tool_use:0:0`]);
  });

  test("nothing goes on a command line that a TOML string would have to escape, or a hash that isn't one", () => {
    const quoted = join(root, 'we"ird', "hooks.json");
    expect(codexHookReview([hook("stop", { currentHash: "md5:abc" })], codexHome, COMMAND).trust).toBeUndefined();
    expect(codexHookReview([hook("stop", { key: `${join(codexHome, "hooks.json")}:stop:0:0\n` })], codexHome, COMMAND).trust).toBeUndefined();
    expect(codexHookReview([hook("stop", { sourcePath: quoted, key: `${quoted}:stop:0:0` })], codexHome, COMMAND).trust).toBeUndefined();
  });

  test("the hooks.json Codex keys is the real path, as it resolves a symlinked home", () => {
    const linked = join(root, "linked-codex");
    Bun.spawnSync(["ln", "-s", codexHome, linked]);
    expect(codexHookReview([hook("stop")], linked, COMMAND).trust).toContain(`"${join(codexHome, "hooks.json")}:stop:0:0"`);
  });

  test("the refusal names what Codex would ask about and what to do", () => {
    expect(backgroundHookReviewError(["say done"])).toBe("Codex would stop before starting to ask you to review a hook conch didn't add"
      + " (say done), and in the background nobody would see it. Start this one in Terminal and answer it there once, or review"
      + " them in any Codex session first.");
    expect(backgroundHookReviewError(["a", "b", "c", "d", "e"])).toContain("review 5 hooks conch didn't add (a; b; c and 2 more)");
  });
});

describe("hooks/list", () => {
  test("each hook once, from every folder's entry, and only the shapes the review reads", () => {
    const raw = { data: [
      { cwd: "/a", hooks: [hook("stop"), { key: 3 }, null], warnings: [], errors: [] },
      { cwd: "/b", hooks: [hook("stop"), hook("session_start", { command: undefined })], warnings: [], errors: [] },
    ] };
    expect(decodeHooksList(raw)?.map((entry) => entry.key)).toEqual([hook("stop").key, hook("session_start").key]);
    expect(decodeHooksList({})).toBeNull();
    expect(decodeHooksList(null)).toBeNull();
  });

  test("asked of a short-lived app-server in the account's home, for the session's folder; null when it can't say", async () => {
    const account = readCodexAccounts()[0]!;
    const answer = { data: [{ cwd: "/work", hooks: [hook("stop")], warnings: [], errors: [] }] };
    const executable = join(root, "mock-codex");
    writeFileSync(executable, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nimport { appendFileSync } from 'node:fs';\n`
      + `for await (const line of createInterface({input: process.stdin})) {\nconst msg = JSON.parse(line);\n`
      + `appendFileSync(process.env.CODEX_HOME+'/calls', msg.method+' '+JSON.stringify(msg.params ?? null)+'\\n');\nif(!msg.id) continue;\n`
      + `console.log(JSON.stringify({id:msg.id,result:msg.method === 'hooks/list' ? ${JSON.stringify(answer)} : {}}));\n}\n`);
    chmodSync(executable, 0o700);
    expect(await readCodexHooks(account, "/work", executable, 3000)).toEqual([hook("stop")]);
    const calls = readFileSync(join(codexHome, "calls"), "utf8").split("\n").filter(Boolean);
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["initialize", "initialized", "hooks/list"]);
    expect(calls[2]).toBe(`hooks/list {"cwds":["/work"]}`);

    // A Codex from before hook trust: no such method.
    const older = join(root, "older-codex");
    writeFileSync(older, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\n`
      + `for await (const line of createInterface({input: process.stdin})) {\nconst msg = JSON.parse(line);\nif(!msg.id) continue;\n`
      + `console.log(JSON.stringify(msg.method === 'hooks/list' ? {id:msg.id,error:{code:-32601,message:'unknown method'}} : {id:msg.id,result:{}}));\n}\n`);
    chmodSync(older, 0o700);
    expect(await readCodexHooks(account, "/work", older, 3000)).toBeNull();
    const stalled = join(root, "stalled-codex");
    writeFileSync(stalled, `#!${process.execPath}\nsetInterval(() => {},1000);`);
    chmodSync(stalled, 0o700);
    expect(await readCodexHooks(account, "/work", stalled, 100)).toBeNull();
  });
});

describe("a background Codex launch", () => {
  const trust = `hooks.state={"/Users/someone/.codex/hooks.json:stop:0:0"={trusted_hash="${HASH(4)}"}}`;

  test("carries no update check and conch's hook trust, before the subcommand; Terminal and Claude carry neither", () => {
    const request = { ...startRequestFromArgv(["codex", "--background", "--resume", "thread-1", "--cwd", "/work"]), hookTrust: trust };
    expect(terminalSessionCommand(request)).toBe(
      `cd -- '/work' && exec codex --no-daemon -c check_for_update_on_startup=false -c '${trust}' resume 'thread-1'`,
    );
    expect(terminalSessionCommand({ ...request, host: "terminal", hookTrust: undefined })).toBe(`cd -- '/work' && exec codex resume 'thread-1'`);
    expect(terminalSessionCommand({ backend: "claude", host: "background", resumeSessionId: "abc", cwd: "/work", hookTrust: trust }))
      .toBe("cd -- '/work' && exec claude --resume 'abc'");
  });

  test("the trust can't be sent in on a start: it is the daemon's, from what Codex reports", () => {
    const validated = validateRuntimeControlMessage({ kind: "session-start", backend: "codex", host: "background", resumeSessionId: "thread-1", hookTrust: "hooks.state={}" });
    expect(validated).toEqual({ ok: true, value: { kind: "session-start", backend: "codex", host: "background", resumeSessionId: "thread-1" } });
  });

  test("a restart or fork drops conch's own launch overrides quietly and builds them again", () => {
    // `ps -o args=` of a background session conch started: quoting gone, one word per space.
    const args = `--no-daemon -c check_for_update_on_startup=false -c ${trust} --dangerously-bypass-approvals-and-sandbox resume thread-1 -c model_provider=openai`.split(" ");
    const built = restartRequest({ sessionId: "thread-1", backend: "codex", cwd: "/work" }, args);
    expect(built.notCarriedOver).toEqual(["--no-daemon", "-c model_provider=openai"]);
    expect(built.request).toEqual({ backend: "codex", resumeSessionId: "thread-1", cwd: "/work",
      options: { "bypass-permissions": true } });
  });
});
