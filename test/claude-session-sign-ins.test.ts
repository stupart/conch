import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validAccountId } from "../src/claude-accounts.ts";
import {
  addSessionSignIn,
  addTokenLine,
  claudeSignInForLaunch,
  readSessionSignIns,
  redactTokens,
  removeSessionSignIn,
  runKeychainCommand,
  SessionSignInLedger,
  sessionSignInStorePath,
  SIGN_IN_TOKEN_ERROR,
  signInMarker,
  signInSecurityBinary,
  signInShellPrefix,
  withSessionSignIn,
  type ClaudeSessionSignIn,
  type KeychainRunner,
} from "../src/claude-session-sign-ins.ts";
import { applyRuntimeControlMessage, createControlServer, sessionStartLine, validateSocketTurnEvent, type ControlServer } from "../src/control-server.ts";
import { deliverToDaemon, sessionStartEvent, type TurnEvent } from "../src/hook.ts";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";
import { forwardToDaemonSocket, isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import { followSignIn, RestartGuard, type RestartLedger } from "../src/restart-recovery.ts";
import { forkRequest } from "../src/session-fork.ts";
import {
  backgroundSessionCommand,
  restartRequest,
  startClaudeSetupToken,
  terminalSessionCommand,
  type StartSessionRequest,
} from "../src/session-lifecycle.ts";
import { startBackgroundProcess } from "../src/background-sessions.ts";
import { resolveTmux } from "../src/tmux-binary.ts";
import { validateControlMessage, validateControlResponse } from "../src/settings.ts";
import type { SessionInfo } from "../src/sessions.ts";

// 2026-11-01, Tyler: "one profile, choose which account a new session signs in as". A sign-in is a long-lived token from
// `claude setup-token`, kept in the Keychain and read by the launched shell. Nothing here reads, prints or keeps a real
// token, and nothing touches a real Keychain: the runner is injected and asserted on, and the launched shell's lookup is
// a stand-in script (`CONCH_SIGN_IN_SECURITY`).

/** Made up, in the shape `claude setup-token` prints. */
const FAKE_TOKEN = `sk-ant-oat01-${"FAKE0fake1FAKE2fake3_-".repeat(3)}x`;
/** Anything that looks like a token at all. */
const TOKEN_SHAPED = /sk-ant-[A-Za-z0-9_-]{8,}/;
const SESSION = "11111111-2222-4333-8444-555555555555";

let root: string;
let oldConfig: string | undefined;
let oldClaude: string | undefined;
let oldSecurity: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conch-sign-ins-"));
  oldConfig = process.env.CONCH_CONFIG_DIR;
  oldClaude = process.env.CLAUDE_CONFIG_DIR;
  oldSecurity = process.env.CONCH_SIGN_IN_SECURITY;
  process.env.CONCH_CONFIG_DIR = join(root, "conch");
  delete process.env.CONCH_SIGN_IN_SECURITY;
});
afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  restore("CONCH_CONFIG_DIR", oldConfig);
  restore("CLAUDE_CONFIG_DIR", oldClaude);
  restore("CONCH_SIGN_IN_SECURITY", oldSecurity);
  rmSync(root, { recursive: true, force: true });
});

/** A Keychain that only writes down what `security -i` was given on its stdin. */
function recordingKeychain(code = 0, stderr = ""): { seen: string[]; run: KeychainRunner } {
  const seen: string[] = [];
  return { seen, run: async (command) => { seen.push(command); return { code, stderr }; } };
}

async function saved(label = "Work Max"): Promise<ClaudeSessionSignIn> {
  return addSessionSignIn(label, FAKE_TOKEN, { keychain: recordingKeychain().run, now: () => 1_793_000_000_000 });
}

describe("storing a sign-in", () => {
  test("the token goes to the Keychain on security's stdin, and only the name and the date into conch's list", async () => {
    const keychain = recordingKeychain();
    const signIn = await addSessionSignIn(" Work Max ", FAKE_TOKEN, { keychain: keychain.run, now: () => 1_793_000_000_000 });
    expect(validAccountId(signIn.id)).toBe(true);
    expect(signIn).toEqual({ id: signIn.id, label: "Work Max", addedAt: 1_793_000_000_000 });
    expect(keychain.seen).toEqual([
      `add-generic-password -U -s conch.claude.session-sign-in -a ${signIn.id} -l "conch sign-in: Work Max" -w ${FAKE_TOKEN}\n`,
    ]);
    const file = sessionSignInStorePath();
    expect(file).toBe(join(root, "conch", "claude-session-sign-ins.json"));
    const written = readFileSync(file, "utf8");
    expect(written).not.toMatch(TOKEN_SHAPED);
    expect(JSON.parse(written)).toEqual([{ id: signIn.id, label: "Work Max", addedAt: 1_793_000_000_000 }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSessionSignIns()).toEqual([signIn]);
  });

  test("the real runner hands security its command on stdin, never in argv, and refuses to run in conch's tests", async () => {
    await expect(runKeychainCommand(addTokenLine("abc", "Work", FAKE_TOKEN))).rejects.toThrow("won't touch the Keychain");
    const source = readFileSync(join(import.meta.dir, "..", "src", "claude-session-sign-ins.ts"), "utf8");
    expect(source).toContain('Bun.spawn(["/usr/bin/security", "-i"], { stdin: new Response(command), stdout: "ignore", stderr: "pipe" })');
    // No keychain path is named: one that doesn't exist sends `security` to the default keychain without a word.
    expect(addTokenLine("abc", "Work", FAKE_TOKEN)).toBe(`add-generic-password -U -s conch.claude.session-sign-in -a abc -l "conch sign-in: Work" -w ${FAKE_TOKEN}\n`);
  });

  test("a token that isn't one never reaches the Keychain, and the refusal doesn't repeat what was pasted", async () => {
    const keychain = recordingKeychain();
    for (const token of ["", "sk-ant-oat01-short", `${FAKE_TOKEN} -w other`, `${FAKE_TOKEN}\nadd-generic-password -s x`,
      `${FAKE_TOKEN}"`, `Bearer ${FAKE_TOKEN}`, `sk-ant-OAT01-${"a".repeat(30)}`, `sk-ant-oat01-${"a".repeat(2_000)}`]) {
      const refused = await addSessionSignIn("Work", token, { keychain: keychain.run }).catch((error: Error) => error.message);
      expect(refused).toBe(SIGN_IN_TOKEN_ERROR);
    }
    for (const label of ['Work "Max"', "Work\\Max", "", "   ", "x".repeat(61), "line\nbreak"]) {
      await expect(addSessionSignIn(label, FAKE_TOKEN, { keychain: keychain.run })).rejects.toThrow("Name the sign-in");
    }
    expect(keychain.seen).toEqual([]);
    expect(existsSync(sessionSignInStorePath())).toBe(false);
  });

  test("a Keychain that refuses saves nothing, and what security said comes back with nothing token-shaped in it", async () => {
    const keychain = recordingKeychain(45, `security: SecKeychainItemCreateFromContent: something ${FAKE_TOKEN}`);
    const message = await addSessionSignIn("Work", FAKE_TOKEN, { keychain: keychain.run }).catch((error: Error) => error.message);
    expect(message).toContain("security exited 45");
    expect(message).toContain("Nothing was saved");
    expect(message).not.toMatch(TOKEN_SHAPED);
    expect(readSessionSignIns()).toEqual([]);
    expect(redactTokens(`a ${FAKE_TOKEN} b`)).toBe("a sk-ant-… b");
  });

  test("a list that can't be written takes the Keychain item back out", async () => {
    // A file where conch's folder would be: the list can't be written there.
    writeFileSync(join(root, "conch"), "not a folder");
    const keychain = recordingKeychain();
    const message = await addSessionSignIn("Work", FAKE_TOKEN, { keychain: keychain.run, newId: () => "fresh-id" }).catch((error: Error) => error.message);
    expect(message).toContain("wasn't added");
    expect(message).not.toMatch(TOKEN_SHAPED);
    expect(keychain.seen).toHaveLength(2);
    expect(keychain.seen[1]).toBe("delete-generic-password -s conch.claude.session-sign-in -a fresh-id\n");
  });

  test("one name each, and two adds at once both land", async () => {
    await saved("Work Max");
    const keychain = recordingKeychain();
    await expect(addSessionSignIn("work max", FAKE_TOKEN, { keychain: keychain.run })).rejects.toThrow("different name");
    expect(keychain.seen).toEqual([]);
    await Promise.all([saved("Personal"), saved("Studio")]);
    expect(readSessionSignIns().map((one) => one.label).sort()).toEqual(["Personal", "Studio", "Work Max"]);
  });

  test("removing takes out the Keychain item and the name; an item already gone is fine, a sign-in nobody has isn't", async () => {
    const signIn = await saved();
    const keychain = recordingKeychain();
    expect(await removeSessionSignIn(signIn.id, { keychain: keychain.run })).toEqual(signIn);
    expect(keychain.seen).toEqual([`delete-generic-password -s conch.claude.session-sign-in -a ${signIn.id}\n`]);
    expect(readSessionSignIns()).toEqual([]);
    await expect(removeSessionSignIn(signIn.id, { keychain: recordingKeychain(44).run })).rejects.toThrow("not found");
    const listed = await saved("Listed only");
    expect(await removeSessionSignIn(listed.id, { keychain: recordingKeychain(44).run })).toEqual(listed);
    const kept = await saved("Kept");
    await expect(removeSessionSignIn(kept.id, { keychain: recordingKeychain(51, "denied").run })).rejects.toThrow("security exited 51: denied");
    expect(readSessionSignIns()).toEqual([kept]);
    await expect(removeSessionSignIn("$(touch x)", { keychain: keychain.run })).rejects.toThrow("Invalid sign-in id");
  });
});

describe("on the wire", () => {
  test("add carries a name and a token, list and remove nothing more, and no refusal repeats a token", () => {
    expect(validateControlMessage({ kind: "claude-session-sign-ins", action: "add", label: " Work ", token: FAKE_TOKEN, configDir: "/x" }))
      .toEqual({ ok: true, value: { kind: "claude-session-sign-ins", action: "add", label: "Work", token: FAKE_TOKEN } });
    expect(validateControlMessage({ kind: "claude-session-sign-ins", action: "list" }))
      .toEqual({ ok: true, value: { kind: "claude-session-sign-ins", action: "list" } });
    expect(validateControlMessage({ kind: "claude-session-sign-ins", action: "remove", id: "abc-1" }))
      .toEqual({ ok: true, value: { kind: "claude-session-sign-ins", action: "remove", id: "abc-1" } });
    expect(validateControlMessage({ kind: "claude-session-sign-ins", action: "setup" }))
      .toEqual({ ok: true, value: { kind: "claude-session-sign-ins", action: "setup" } });
    for (const body of [
      { action: "remove" }, { action: "remove", id: "a b" }, { action: "list", token: FAKE_TOKEN }, { action: "steal" },
      { action: "add", label: "Work", token: `${FAKE_TOKEN} x` }, { action: "add", label: "Work" }, { action: "add", token: FAKE_TOKEN },
    ]) {
      const result = validateControlMessage({ kind: "claude-session-sign-ins", ...body });
      expect(result.ok, JSON.stringify(body)).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(TOKEN_SHAPED);
    }
  });

  test("a start names a sign-in for Claude in Default only, by a shell-safe id", () => {
    const start = (extra: Record<string, unknown>) => validateControlMessage({ kind: "session-start", backend: "claude", cwd: "/work/demo", ...extra });
    expect(start({ claudeSignInId: "abc-1" })).toEqual({ ok: true, value: { kind: "session-start", backend: "claude", cwd: "/work/demo", claudeSignInId: "abc-1" } });
    expect(start({ claudeSignInId: "abc-1", claudeAccountId: "default" }).ok).toBe(true);
    expect(start({ claudeSignInId: "abc-1", claudeAccountId: "work" })).toEqual({ ok: false, err: "A sign-in runs in the Default profile only. Choose Default to use it." });
    expect(start({ claudeSignInId: "$(touch x)" }).ok).toBe(false);
    expect(start({ claudeSignInId: 7 }).ok).toBe(false);
    expect(validateControlMessage({ kind: "session-start", backend: "codex", claudeSignInId: "abc-1" }).ok).toBe(false);
  });

  test("the phone bridge refuses every sign-in request, bare or in an envelope", () => {
    for (const body of [{ action: "list" }, { action: "add", label: "Work", token: FAKE_TOKEN }, { action: "remove", id: "a" }, { action: "setup" }]) {
      expect(isMacAppOnlyRequest({ kind: "claude-session-sign-ins", ...body })).toBe(true);
      expect(isMacAppOnlyRequest({ kind: "control-envelope", body: { kind: "claude-session-sign-ins", ...body } })).toBe(true);
    }
  });

  test("a reply is the list and nothing else: one that carried a token isn't one", () => {
    const signIns = [{ id: "abc-1", label: "Work", addedAt: 1 }];
    expect(validateControlResponse({ kind: "claude-session-sign-ins", signIns, added: "abc-1" }).ok).toBe(true);
    expect(validateControlResponse({ kind: "claude-session-sign-ins", signIns, token: FAKE_TOKEN }).ok).toBe(false);
    expect(validateControlResponse({ kind: "claude-session-sign-ins", signIns: [{ ...signIns[0], token: FAKE_TOKEN }] }).ok).toBe(false);
    expect(validateControlResponse({ kind: "claude-session-sign-ins", signIns: [{ id: "a b", label: "Work", addedAt: 1 }] }).ok).toBe(false);
  });

  test("the daemon's start line names the sign-in by its id", () => {
    expect(sessionStartLine({ kind: "session-start", backend: "claude", claudeSignInId: "abc-1" }, "/work/demo", false))
      .toBe("session-start: claude terminal account=default sign-in=abc-1 trustFolder=no folder=demo");
  });
});

describe("launching on a sign-in", () => {
  test("Terminal and background read the token in the launched shell, by id, and hand it over on a descriptor", async () => {
    const signIn = await saved();
    delete process.env.CLAUDE_CONFIG_DIR;
    const terminal = terminalSessionCommand({ backend: "claude", cwd: "/work/demo", claudeSignInId: signIn.id });
    const background = backgroundSessionCommand({ backend: "claude", cwd: "/work/demo", claudeSignInId: signIn.id });
    for (const command of [terminal, background]) {
      expect(command.startsWith("cd -- '/work/demo' && { conch_sign_in=\"$(")).toBe(true);
      expect(command).toContain(` find-generic-password -s conch.claude.session-sign-in -a '${signIn.id}' -w 2>/dev/null)"`);
      expect(command).toContain(`&& export CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 CONCH_CLAUDE_SIGN_IN='${signIn.id}' && exec env `);
      expect(command).toEndWith(` 3< <(printf '%s' "$conch_sign_in")`);
      // Every other credential the shell has is dropped, an inherited token included; the descriptor and marker are kept.
      expect(command).toContain("-u ANTHROPIC_API_KEY");
      expect(command).toContain("-u CLAUDE_CODE_OAUTH_TOKEN ");
      expect(command).not.toContain("-u CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR");
      expect(command).not.toContain("-u CONCH_CLAUDE_SIGN_IN");
      expect(command).not.toMatch(/export [^&]*CLAUDE_CODE_OAUTH_TOKEN(?!_FILE_DESCRIPTOR)/);
      // Default's own folder, unset as Default always is.
      expect(command).toContain("-u CLAUDE_CONFIG_DIR claude");
      expect(command).not.toMatch(TOKEN_SHAPED);
    }
    expect(terminalSessionCommand({ backend: "claude", cwd: "/work/demo", claudeSignInId: signIn.id, resumeSessionId: SESSION }))
      .toEndWith(`claude --resume '${SESSION}' 3< <(printf '%s' "$conch_sign_in")`);
    // Nothing changes for a launch with no sign-in.
    expect(terminalSessionCommand({ backend: "claude", cwd: "/work/demo" })).toBe("cd -- '/work/demo' && exec claude");
    expect(backgroundSessionCommand({ backend: "claude", cwd: "/work/demo" })).toContain("-u CONCH_CLAUDE_SIGN_IN");
  });

  test("tmux is handed the command, holding the id and never a token", async () => {
    if (!resolveTmux().found) return;
    const signIn = await saved();
    const argv: string[][] = [];
    await startBackgroundProcess(backgroundSessionCommand({ backend: "claude", cwd: root, claudeSignInId: signIn.id }), root, async (args) => {
      argv.push(args);
      return args.includes("new-session") ? "%1\n" : args.includes("display-message") ? "0\n" : "";
    });
    const all = argv.flat().join(" ");
    expect(all).toContain(`find-generic-password -s conch.claude.session-sign-in -a '${signIn.id}' -w`);
    expect(all).not.toMatch(TOKEN_SHAPED);
  });

  test("the lookup is /usr/bin/security outside conch's tests, and never inside them", () => {
    expect(signInSecurityBinary({})).toBe("/usr/bin/security");
    expect(signInSecurityBinary({ CONCH_SIGN_IN_SECURITY: "/tmp/fake" })).toBe("/usr/bin/security");
    expect(signInSecurityBinary({ CONCH_TEST_ROOT: "/x" })).toBe("/usr/bin/false");
    expect(signInSecurityBinary({ CONCH_TEST_ROOT: "/x", CONCH_SIGN_IN_SECURITY: "/tmp/fake-security" })).toBe("/tmp/fake-security");
    expect(signInSecurityBinary({ CONCH_TEST_ROOT: "/x", CONCH_SIGN_IN_SECURITY: "/tmp/x; rm -rf ~" })).toBe("/usr/bin/false");
    expect(signInShellPrefix({ id: "abc-1", label: "Work" }, "/usr/bin/security"))
      .toContain(`"$(/usr/bin/security find-generic-password -s conch.claude.session-sign-in -a 'abc-1' -w 2>/dev/null)"`);
  });

  test("a sign-in is Claude's, in Default; a removed one refuses in words and never falls back to the rotating login", async () => {
    const signIn = await saved();
    expect(() => terminalSessionCommand({ backend: "codex", claudeSignInId: signIn.id })).toThrow("only for a Claude session");
    expect(() => terminalSessionCommand({ backend: "claude", claudeAccountId: "work", claudeSignInId: signIn.id })).toThrow("Default profile only");
    expect(() => terminalSessionCommand({ backend: "claude", claudeConfigDir: "/x", claudeSignInId: signIn.id })).toThrow("Default profile only");
    expect(() => terminalSessionCommand({ backend: "claude", claudeSignInId: "a b" })).toThrow("only for a Claude session");
    await removeSessionSignIn(signIn.id, { keychain: recordingKeychain().run });
    for (const build of [terminalSessionCommand, backgroundSessionCommand]) {
      expect(() => build({ backend: "claude", cwd: "/work/demo", claudeSignInId: signIn.id })).toThrow("has been removed");
    }
    expect(claudeSignInForLaunch({ backend: "claude" })).toBeUndefined();
  });

  test("Add a sign-in opens claude setup-token in Terminal in a throwaway folder, with no credential from the shell", async () => {
    let command = "";
    const folder = join(root, "conch", "claude-session-sign-ins", "setup-test");
    await startClaudeSetupToken(folder, {
      which: () => "/bin/claude", isDirectory: () => true,
      spawn: (args) => { command = args.at(-1)!; return { exited: Promise.resolve(0), cancel() {} }; },
    });
    expect(command).toStartWith("env -u ANTHROPIC_API_KEY ");
    expect(command).toContain("-u CLAUDE_CODE_OAUTH_TOKEN");
    expect(command).toContain(`CLAUDE_CONFIG_DIR='${folder}' claude setup-token;`);
    expect(command).toContain(`rm -rf -- '${folder}';`);
    expect(command).toContain("/usr/bin/security delete-generic-password -s 'Claude Code-credentials-");
    expect(command).toContain("clear; printf '\\033[3J'");
    expect(command).not.toContain(".claude'");
  });
});

describe("the launch prefix, run", () => {
  /**
   * A stand-in `security` that answers only the one lookup the prefix makes, and a stand-in `claude` that says whether it
   * got the token, the marker and an API key the shell had, and what it was run with.
   */
  function fakes(signIn: ClaudeSessionSignIn, answer: "token" | "nothing" | "missing") {
    const dir = join(root, "fakes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "token"), FAKE_TOKEN);
    const security = join(dir, "security");
    writeFileSync(security, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${join(dir, "security-argv")}'`,
      `if [ "$1" = find-generic-password ] && [ "$2" = -s ] && [ "$3" = conch.claude.session-sign-in ] && [ "$4" = -a ] && [ "$5" = '${signIn.id}' ] && [ "$6" = -w ]; then`,
      answer === "token" ? `  cat '${join(dir, "token")}'; exit 0` : answer === "nothing" ? "  exit 0" : "  exit 44",
      "fi",
      "exit 44",
    ].join("\n") + "\n");
    const claude = join(dir, "claude");
    writeFileSync(claude, [
      "#!/bin/sh",
      // The token is read where Claude Code reads it, the descriptor the environment names; the environment itself must hold none.
      `if [ -n "$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ] && [ "$(eval "cat <&$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")" = "$(cat '${join(dir, "token")}')" ]; then echo "token: matches"; else echo "token: does not match"; fi`,
      'echo "token in environment: ${CLAUDE_CODE_OAUTH_TOKEN:+yes}"',
      'echo "marker: ${CONCH_CLAUDE_SIGN_IN:-unset}"',
      'echo "api key: ${ANTHROPIC_API_KEY:-unset}"',
      'echo "args: $*"',
    ].join("\n") + "\n");
    chmodSync(security, 0o755);
    chmodSync(claude, 0o755);
    return { dir, security };
  }

  async function run(command: string, dir: string): Promise<{ code: number; out: string }> {
    // zsh as Terminal's shell and the background host's are, without anyone's rc files: the command alone.
    const child = Bun.spawn(["/bin/zsh", "-f", "-c", command], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: root, ANTHROPIC_API_KEY: "from-the-shell", CLAUDE_CODE_OAUTH_TOKEN: "inherited-from-the-shell" },
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: out + err };
  }

  test("Terminal's and the background host's launch give Claude Code the token and the marker, and nothing else", async () => {
    const signIn = await saved();
    const { dir, security } = fakes(signIn, "token");
    process.env.CONCH_SIGN_IN_SECURITY = security;
    const request: StartSessionRequest = { backend: "claude", cwd: root, claudeSignInId: signIn.id };
    // The background host runs the command after its own two statements (background-sessions.ts).
    for (const command of [terminalSessionCommand(request), `export CONCH_BACKGROUND_PID=$$; unset TMUX TMUX_PANE; ${backgroundSessionCommand(request)}`]) {
      expect(command).not.toMatch(TOKEN_SHAPED);
      const { code, out } = await run(command, dir);
      expect(out).toContain("token: matches");
      expect(out).toContain(`marker: ${signIn.id}`);
      expect(out).toContain("api key: unset");
      expect(out).toContain("token in environment: \n");
      expect(out).not.toMatch(TOKEN_SHAPED);
      expect(code).toBe(0);
    }
    const asked = readFileSync(join(dir, "security-argv"), "utf8");
    expect(asked.trim().split("\n")).toEqual(Array(2).fill(`find-generic-password -s conch.claude.session-sign-in -a ${signIn.id} -w`));
  });

  test("a sign-in the Keychain no longer has, or answers empty for, stops the launch with words: Claude Code never runs", async () => {
    const signIn = await saved();
    for (const answer of ["missing", "nothing"] as const) {
      const { dir, security } = fakes(signIn, answer);
      process.env.CONCH_SIGN_IN_SECURITY = security;
      const { code, out } = await run(terminalSessionCommand({ backend: "claude", cwd: root, claudeSignInId: signIn.id }), dir);
      expect(code).toBe(1);
      expect(out).toContain(`conch: the Claude sign-in "Work Max" isn't in your Keychain any more, so this session didn't start.`);
      expect(out).not.toContain("token:");
    }
  });

  test("a test that names no stand-in reads no Keychain at all", async () => {
    const signIn = await saved();
    const { dir } = fakes(signIn, "token");
    delete process.env.CONCH_SIGN_IN_SECURITY;
    const command = terminalSessionCommand({ backend: "claude", cwd: root, claudeSignInId: signIn.id });
    expect(command).toContain('"$(/usr/bin/false find-generic-password');
    const { code, out } = await run(command, dir);
    expect(code).toBe(1);
    expect(out).not.toContain("token:");
  });
});

describe("which sessions run on which sign-in", () => {
  test("the hook reads the marker, the id only, and says it on a session's start", () => {
    expect(signInMarker({ CONCH_CLAUDE_SIGN_IN: "abc-1", CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN })).toBe("abc-1");
    expect(signInMarker({ CONCH_CLAUDE_SIGN_IN: "$(touch x)" })).toBeUndefined();
    expect(signInMarker({})).toBeUndefined();
    const payload = { session_id: SESSION, cwd: "/work/demo", source: "startup" };
    expect(sessionStartEvent(payload, null, "demo", 1, "abc-1")).toMatchObject({ type: "session-start", sessionId: SESSION, claudeSignIn: "abc-1" });
    expect("claudeSignIn" in sessionStartEvent(payload, null, "demo", 1, undefined)).toBe(false);
    const hook = readFileSync(join(import.meta.dir, "..", "src", "hook.ts"), "utf8");
    // The token beside the marker in the hook's environment is never read.
    expect(hook).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(hook).toContain("...(signIn ? { claudeSignIn: signIn } : {}),");
  });

  test("the daemon takes it on a start or a prompt, as an id", () => {
    const event = (type: string, claudeSignIn: unknown) => validateSocketTurnEvent({ type, sessionId: SESSION, label: "demo", announce: "", claudeSignIn });
    expect(event("session-start", "abc-1")).toMatchObject({ ok: true, value: { claudeSignIn: "abc-1" } });
    expect(event("working", "abc-1").ok).toBe(true);
    expect(event("turn-end", "abc-1").ok).toBe(false);
    expect(event("session-start", "a b").ok).toBe(false);
    expect(event("session-start", FAKE_TOKEN).ok).toBe(false);
  });

  describe("through a real control server", () => {
    const servers: ControlServer[] = [];
    afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

    async function server(handlers: { turn?: (event: TurnEvent) => void; runtime?: Parameters<typeof applyRuntimeControlMessage>[1] }, logs: string[] = []) {
      // A short private path: a socket's is capped near 104 bytes.
      const dir = mkdtempSync("/tmp/conch-sign-in-");
      const socketPath = join(dir, "c.sock");
      const created = createControlServer({
        socketPath, ownerDeviceId: "this-mac", log: (line) => logs.push(line),
        sessions: { resolve: (value) => value, current: () => ({ published: true, label: "demo" }) },
        application: {
          configuration: () => ({ kind: "config-error", error: "stub" }),
          session: () => ({ kind: "session-error", error: "stub" }),
          runtime: (message) => handlers.runtime ? applyRuntimeControlMessage(message, handlers.runtime) : ({ kind: "session-error", error: "stub" }),
          turn: (event) => { handlers.turn?.(event); },
          device: () => ({ kind: "ack" }),
        },
      });
      servers.push(created);
      expect(await created.start()).toBe(true);
      return { socketPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    test("the hook's marker reaches the daemon, and the daemon's map", async () => {
      const turns: TurnEvent[] = [];
      const { socketPath, cleanup } = await server({ turn: (event) => turns.push(event) });
      try {
        const event = sessionStartEvent({ session_id: SESSION, cwd: "/work/demo", source: "startup" }, null, "demo", 1, "abc-1");
        expect(await deliverToDaemon(socketPath, event, 2_000)).toBe(true);
        for (let i = 0; i < 50 && !turns.length; i += 1) await Bun.sleep(20);
        expect(turns.map((turn) => [turn.type, turn.sessionId, turn.claudeSignIn])).toEqual([["session-start", SESSION, "abc-1"]]);
        // As the daemon takes it (daemon.ts `enqueue`).
        const ledger = new SessionSignInLedger(join(root, "map.json"));
        expect(ledger.note(turns[0]!.sessionId, turns[0]!.claudeSignIn)).toBe(true);
        expect(ledger.for({ sessionId: SESSION })).toBe("abc-1");
        const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
        expect(daemon).toContain("sessionSignIns.note(event.sessionId, event.claudeSignIn)");
      } finally {
        cleanup();
      }
    });

    test("an add's token reaches the store and nothing else: not the reply, not a refusal, not the log", async () => {
      const logs: string[] = [];
      const handed: string[] = [];
      const { socketPath, cleanup } = await server({
        runtime: {
          claudeSessionSignIns: async (message) => {
            if (message.token) handed.push(message.token);
            return { kind: "claude-session-sign-ins", signIns: [{ id: "abc-1", label: message.label ?? "x", addedAt: 1 }], added: "abc-1" };
          },
          listResumable: () => ({ sessions: [], complete: true }),
          start: () => {},
          close: () => {},
          report: () => {},
        },
      }, logs);
      try {
        const reply = await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: "claude-session-sign-ins", action: "add", label: "Work", token: FAKE_TOKEN }));
        expect(JSON.parse(reply)).toEqual({ kind: "claude-session-sign-ins", signIns: [{ id: "abc-1", label: "Work", addedAt: 1 }], added: "abc-1" });
        expect(handed).toEqual([FAKE_TOKEN]);
        const refused = await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: "claude-session-sign-ins", action: "add", label: "Work", token: `${FAKE_TOKEN} -w x` }));
        expect(JSON.parse(refused)).toEqual({ kind: "session-error", error: SIGN_IN_TOKEN_ERROR });
        for (const text of [reply, refused, ...logs]) expect(text).not.toMatch(TOKEN_SHAPED);
        expect(handed).toEqual([FAKE_TOKEN]);
      } finally {
        cleanup();
      }
    });
  });

  test("the daemon's handler only hands the token to the store", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    const start = daemon.indexOf("claudeSessionSignIns: async (message) => {");
    const handler = daemon.slice(start, daemon.indexOf("readCapabilities: (message) => {", start));
    expect(start).toBeGreaterThan(-1);
    expect(handler.match(/message\.token/g)).toEqual(["message.token"]);
    expect(handler).toContain("await addSessionSignIn(message.label!, message.token!)");
    expect(handler).not.toContain("recordDaemonError");
  });

  test("the map keeps what each session's hook said, across a restart, and forgets sessions that have gone", () => {
    const file = join(root, "map.json");
    const ledger = new SessionSignInLedger(file);
    expect(ledger.note(SESSION, "abc-1", 0)).toBe(true);
    expect(ledger.note(SESSION, "abc-1", 1)).toBe(false);
    expect(ledger.note("", "abc-1")).toBe(false);
    expect(ledger.for({ sessionId: `${SESSION}#4242`, agentSessionId: SESSION })).toBe("abc-1");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new SessionSignInLedger(file).for({ sessionId: SESSION })).toBe("abc-1");
    // A start that says nothing is a session on no sign-in.
    expect(ledger.note(SESSION, undefined)).toBe(true);
    expect(new SessionSignInLedger(file).size).toBe(0);
    ledger.note("gone", "abc-1", 0);
    ledger.note("live", "abc-1", 0);
    expect(ledger.prune(new Set(["live"]), 5 * 60_000)).toBe(false);
    expect(ledger.prune(new Set(["live"]), 11 * 60_000)).toBe(true);
    expect([ledger.for({ sessionId: "gone" }), ledger.for({ sessionId: "live" })]).toEqual([undefined, "abc-1"]);
  });

  test("a row on a sign-in reads as it, and says which; its profile stays Default", () => {
    const signIns = [{ id: "abc-1", label: "Work Max", addedAt: 1 }];
    const row: SessionInfo = { sessionId: SESSION, backend: "claude", claudeAccountId: "default", accountLabel: "Default" };
    expect(withSessionSignIn(row, "abc-1", signIns)).toEqual({ ...row, claudeSignInId: "abc-1", accountLabel: "Work Max" });
    expect(withSessionSignIn(row, "gone-1", signIns)).toEqual({ ...row, claudeSignInId: "gone-1", accountLabel: "Removed sign-in" });
    expect(withSessionSignIn(row, "abc-1", undefined)).toEqual({ ...row, claudeSignInId: "abc-1" });
    expect(withSessionSignIn(row, undefined, signIns)).toBe(row);
    const other = { ...row, claudeAccountId: "work", accountLabel: "Work" };
    expect(withSessionSignIn(other, "abc-1", signIns)).toBe(other);
    const codex: SessionInfo = { sessionId: "t", backend: "codex", codexAccountId: "default" };
    expect(withSessionSignIn(codex, "abc-1", signIns)).toBe(codex);

    const model = buildPanelModel({ sessions: [withSessionSignIn(row, "abc-1", signIns)], sessionStates: new Map(), pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" }, mode: { muted: false, paused: false, holding: 0 }, activeSessionId: null, navSelectedId: null });
    const state = buildPublishedState("mac-a", model, new Map(), new Set(), 100, { runtimeLabel: "Laptop" });
    expect(state.rows[0]).toMatchObject({ claudeAccountId: "default", claudeSignInId: "abc-1", accountLabel: "Work Max" });
    expect(state.execution!.accounts.map((account) => account.label)).toEqual(["Default"]);
  });
});

describe("restart, fork and resume keep it", () => {
  const running = { sessionId: SESSION, backend: "claude" as const, cwd: "/work/demo", claudeAccountId: "default", claudeSignInId: "abc-1" };

  test("a restart and a fork relaunch on the session's sign-in", async () => {
    const signIn = await saved();
    const live = { ...running, claudeSignInId: signIn.id };
    const restart = restartRequest(live, ["--resume", SESSION]).request;
    expect(restart).toMatchObject({ backend: "claude", resumeSessionId: SESSION, claudeAccountId: "default", claudeSignInId: signIn.id });
    expect(terminalSessionCommand(restart)).toContain(`CONCH_CLAUDE_SIGN_IN='${signIn.id}'`);
    expect(forkRequest(live, ["--resume", SESSION]).request).toMatchObject({ claudeSignInId: signIn.id, options: { "fork-session": true } });
    expect(forkRequest({ ...live, jobId: "f31f0d15" }, []).request).toMatchObject({ host: "background", claudeSignInId: signIn.id });
    expect("claudeSignInId" in restartRequest({ ...live, claudeSignInId: undefined }, []).request).toBe(false);
  });

  test("a resume from Start names the sign-in it was given", async () => {
    const signIn = await saved();
    const wire = validateControlMessage({ kind: "session-start", backend: "claude", resumeSessionId: SESSION, cwd: "/work/demo", claudeSignInId: signIn.id });
    expect(wire.ok).toBe(true);
    const { kind: _, ...request } = (wire as { value: StartSessionRequest & { kind: string } }).value;
    const command = terminalSessionCommand(request);
    expect(command).toContain(`-a '${signIn.id}' -w`);
    expect(command).toEndWith(`--resume '${SESSION}' 3< <(printf '%s' "$conch_sign_in")`);
  });

  test("a relaunch on a sign-in that's since been removed fails, in words, before anything is closed or started", async () => {
    const signIn = await saved();
    const restart = restartRequest({ ...running, claudeSignInId: signIn.id }, ["--resume", SESSION]).request;
    await removeSessionSignIn(signIn.id, { keychain: recordingKeychain().run });
    // closeLiveSession and forkLiveSession build the command before closing or starting anything (daemon.ts).
    expect(() => terminalSessionCommand(restart)).toThrow("has been removed, so conch won't start it on another account");
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    expect(daemon).toContain("terminalSessionCommand(relaunch.request); // throws on anything invalid, before the close");
    expect(daemon).toContain("terminalSessionCommand(fork.request); // throws on anything invalid, before anything starts");
  });

  test("what comes back after a Mac restart follows the sign-in its hook told of after the record was taken", async () => {
    const request: StartSessionRequest = { backend: "claude", resumeSessionId: SESSION };
    expect(followSignIn(request, { claudeSignInId: "abc-1" })).toBe(true);
    expect(request.claudeSignInId).toBe("abc-1");
    expect(followSignIn(request, { claudeSignInId: "abc-1" })).toBe(false);
    expect(followSignIn(request, {})).toBe(true);
    expect("claudeSignInId" in request).toBe(false);

    const file = join(root, "running.json");
    const guard = new RestartGuard({
      file, relaunchFor: async (s) => ({ backend: "claude", cwd: "/work/demo", resumeSessionId: s.sessionId }),
      launch: async () => {}, log: () => {}, now: () => 1_000, boot: () => 1,
    });
    await guard.observe([{ sessionId: SESSION, label: "demo", backend: "claude" }], new Set([SESSION]));
    await guard.observe([{ sessionId: SESSION, label: "demo", backend: "claude", claudeSignInId: "abc-1" }], new Set([SESSION]));
    const ledger = JSON.parse(readFileSync(file, "utf8")) as RestartLedger;
    expect(ledger.records.map((record) => record.request.claudeSignInId)).toEqual(["abc-1"]);
  });
});
