import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexThreadServer } from "../src/codex-threads.ts";
import { placeHeldResume, restartRequest, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateRuntimeControlMessage } from "../src/settings.ts";

/**
 * A Codex session conch opens in Terminal runs on a private server, so its window holds its own thread's lock and is
 * the pid conch types into (2026-11-12: two sessions started from conch were "hosted by codex app-server … which has
 * no terminal to type into", because a plain `codex` had attached to Codex's shared daemon).
 */
describe("a Codex session opened in Terminal", () => {
  test("gets its own server, before the subcommand, fresh, resumed or forked", () => {
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w" })).toBe("cd -- '/w' && exec codex --no-daemon");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", resumeSessionId: "t1" }))
      .toBe("cd -- '/w' && exec codex --no-daemon resume 't1'");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", resumeSessionId: "t1", fork: true }))
      .toBe("cd -- '/w' && exec codex --no-daemon fork 't1'");
    // Background already had one; it is not said twice.
    expect(terminalSessionCommand({ backend: "codex", host: "background", cwd: "/w" }))
      .toBe("cd -- '/w' && exec codex --no-daemon -c check_for_update_on_startup=false");
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w" })).toBe("cd -- '/w' && exec claude");
  });

  test("joins the app-server that already holds a conversation it resumes", () => {
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", resumeSessionId: "t1", sharedServer: true }))
      .toBe("cd -- '/w' && exec codex resume 't1'");
  });

  test("the shared server can't be asked for on a start: it is the daemon's, read from the lock", () => {
    const validated = validateRuntimeControlMessage({ kind: "session-start", backend: "codex", resumeSessionId: "t1", sharedServer: true });
    expect(validated).toEqual({ ok: true, value: { kind: "session-start", backend: "codex", resumeSessionId: "t1" } });
  });

  test("a restart or fork puts its own server back without reporting it as not carried over", () => {
    const args = "--no-daemon --dangerously-bypass-approvals-and-sandbox resume t1".split(" ");
    const built = restartRequest({ sessionId: "t1", backend: "codex", cwd: "/w" }, args);
    expect(built.notCarriedOver).toEqual([]);
    expect(terminalSessionCommand(built.request))
      .toBe("cd -- '/w' && exec codex --no-daemon --dangerously-bypass-approvals-and-sandbox resume 't1'");
  });
});

describe("a resume of a conversation a server already holds, from the daemon or the CLI", () => {
  const held = (pid: number | undefined) => async () => pid;

  test("in Terminal joins that server: no private one, and it says which", async () => {
    const placed = await placeHeldResume({ backend: "codex", cwd: "/w", resumeSessionId: "t1" }, { holding: held(90170) });
    expect(placed.joined).toBe(90170);
    expect(terminalSessionCommand(placed.request)).toBe("cd -- '/w' && exec codex resume 't1'");
  });

  test("in the background is refused, rather than left on Codex's \"open in another app\" in a pane nobody sees", async () => {
    await expect(placeHeldResume({ backend: "codex", host: "background", cwd: "/w", resumeSessionId: "t1" }, { holding: held(90170) }))
      .rejects.toThrow("Codex's app-server (pid 90170) already has this conversation open");
  });

  test("a fresh start, a fork, a thread nobody holds, and an agent with no such server launch as they were", async () => {
    for (const request of [
      { backend: "codex" as const, cwd: "/w" },
      { backend: "codex" as const, cwd: "/w", resumeSessionId: "t1", fork: true as const },
    ]) expect(await placeHeldResume(request, { holding: held(90170) })).toEqual({ request });
    const free = { backend: "codex" as const, cwd: "/w", resumeSessionId: "t1" };
    expect(await placeHeldResume(free, { holding: held(undefined) })).toEqual({ request: free });
    expect(await placeHeldResume(free, { holding: async () => { throw new Error("lsof timed out"); } })).toEqual({ request: free });
    const claude = { backend: "claude" as const, cwd: "/w", resumeSessionId: "c1" };
    expect(await placeHeldResume(claude)).toEqual({ request: claude });
  });

  test("`conch start` in a shell asks before it launches, as the daemon does (2026-11-12)", () => {
    // The CLI launches on its own; it skipped the daemon's check and its window stopped on Codex's lock screen.
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const start = cli.slice(cli.indexOf('case "start": {'));
    expect(start.indexOf("await placeHeldResume(request)")).toBeGreaterThan(0);
    expect(start.indexOf("await placeHeldResume(request)")).toBeLessThan(start.indexOf("startBackgroundSession : startTerminalSession"));
    const daemon = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    expect(daemon.match(/await placeHeldResume\(request,/g)).toHaveLength(2);
  });
});

describe("which app-server holds a thread", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "conch-codex-server-")));
  const locks = join(home, "thread-writer-locks");
  mkdirSync(locks, { recursive: true });
  for (const id of ["daemon-thread", "app-thread", "tui-thread", "closed-thread"]) writeFileSync(join(locks, `${id}.lock`), "");
  // `lsof -F pn` over the locks: the shared daemon, the ChatGPT app's server and an embedded TUI each hold one.
  const lockProbe = () => [
    "p700", `n${join(locks, "daemon-thread.lock")}`,
    "p800", `n${join(locks, "app-thread.lock")}`,
    "p900", `n${join(locks, "tui-thread.lock")}`,
  ].join("\n");
  const processArgs = (pids: number[]) => new Map([
    [700, "/Users/someone/.codex/packages/app-server-daemon/releases/0.167.2-aarch64-apple-darwin/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon"],
    [800, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled"],
    [900, "codex --no-daemon --dangerously-bypass-approvals-and-sandbox"],
  ].filter(([pid]) => pids.includes(pid as number)) as Array<[number, string]>);

  test("names the shared daemon or the app's server, and nothing for a TUI's own lock or a closed thread", async () => {
    expect(await codexThreadServer(home, "daemon-thread", { lockProbe, processArgs })).toBe(700);
    expect(await codexThreadServer(home, "app-thread", { lockProbe, processArgs })).toBe(800);
    expect(await codexThreadServer(home, "tui-thread", { lockProbe, processArgs })).toBeUndefined();
    expect(await codexThreadServer(home, "closed-thread", { lockProbe, processArgs })).toBeUndefined();
    expect(await codexThreadServer(home, "no-such-thread", { lockProbe, processArgs })).toBeUndefined();
  });

  test("says nothing when ps can't say who holds it, so the launch goes ahead as before", async () => {
    expect(await codexThreadServer(home, "daemon-thread", { lockProbe, processArgs: () => null })).toBeUndefined();
  });
});
