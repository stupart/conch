import { afterAll, expect, test } from "bun:test";
import { backgroundStartupPid, conchServerSessions, managedBackgroundSession, startBackgroundProcess } from "../src/background-sessions.ts";
import { shellQuote } from "../src/agent-adapter.ts";
import { conchTmux, paneTarget, resolveTmux } from "../src/tmux-binary.ts";
import { backgroundCodexHookPid } from "../src/codex-hook.ts";
import { closeTerminalSession, startRequestFromArgv, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";
import { injectText } from "../src/inject.ts";
import { probeCommand } from "../src/probe.ts";
import type { Config } from "../src/config.ts";

const name = "conch-9a6849e9-3e94-4a76-8633-44c158565fb1";
test("host choices survive wire validation; unknown hosts are refused", () => {
  for (const host of ["terminal", "background"] as const) {
    expect(validateRuntimeControlMessage({ kind: "session-start", backend: "codex", host, resumeSessionId: "thread-1" }))
      .toEqual({ ok: true, value: { kind: "session-start", backend: "codex", host, resumeSessionId: "thread-1" } });
  }
  expect(validateRuntimeControlMessage({ kind: "session-start", backend: "claude", host: "cloud" }).ok).toBe(false);
  expect(validateControlResponse({ kind: "session-started", backend: "claude", resumed: false, backgroundId: name }))
    .toEqual({ ok: true, value: { kind: "session-started", backend: "claude", resumed: false, backgroundId: name } });
  expect(validateControlResponse({ kind: "session-started", backend: "claude", resumed: false, backgroundId: "$(touch bad)" }).ok).toBe(false);
});
test("background preserves the CLI resume, permissions and options and isolates Codex's server", () => {
  const request = startRequestFromArgv(["codex", "--background", "--resume", "thread-1", "--cwd", "/tmp/a b", "--model", "gpt-6-sol"]);
  expect(request.host).toBe("background");
  expect(terminalSessionCommand(request)).toBe(`cd -- '/tmp/a b' && exec codex --no-daemon resume 'thread-1' -c 'model="gpt-6-sol"'`);
  expect(terminalSessionCommand({ backend: "claude", host: "background", resumeSessionId: "abc", cwd: "/tmp/a b" }))
    .toBe("cd -- '/tmp/a b' && exec claude --resume 'abc'");
});
test("startup lookup and restart require an exact Conch pane owner, on either server, named with its server", async () => {
  // conch's own server (`-L`) holds one session; the default server holds an older one and a personal one.
  const older = "conch-1b0e4a59-962f-4823-bbff-c5024ba97a98";
  const probe = async (argv: string[]) => argv.includes("-L") ? `12 %1 ${name}\n` : `21 %1 ${older}\n13 %2 personal\n`;
  expect(await managedBackgroundSession(12, probe)).toEqual({ name, pane: "conch:%1" });
  expect(await managedBackgroundSession(21, probe)).toEqual({ name: older, pane: "%1" });
  expect(await managedBackgroundSession(13, probe)).toBeUndefined();
  expect(await managedBackgroundSession(14, probe)).toBeUndefined();
  expect(await backgroundStartupPid(name, async (argv) => argv.includes("-L") ? `12 ${name}` : "")).toBe(12);
  expect(await backgroundStartupPid(older, async (argv) => argv.includes("-L") ? "" : `21 ${older}`)).toBe(21);
  expect(await backgroundStartupPid("personal", async () => { throw new Error("must not probe"); })).toBeUndefined();
});
test("a private Codex server's hook resolves to its verified launcher, never a shared server or exec", async () => {
  const lookup = async (pid: number) => ({
    30: { ppid: 20, command: "/bin/zsh -c conch codex-hook" },
    20: { ppid: 10, command: "codex app-server --listen stdio://" },
    10: { ppid: 1, command: "codex --no-daemon resume thread-1" },
  }[pid] ?? null);
  expect(await backgroundCodexHookPid(30, "10", lookup)).toBe(10);
  expect(await backgroundCodexHookPid(30, "99", lookup)).toBeUndefined();
  expect(await backgroundCodexHookPid(30, "20", lookup)).toBeUndefined();
  expect(await backgroundCodexHookPid(30, "10", async pid => pid === 20 ? { ppid: 10, command: "codex exec test" } : lookup(pid))).toBeUndefined();
  expect(await backgroundCodexHookPid(30, "10", async pid => pid === 10 ? { ppid: 1, command: "codex resume thread-1" } : lookup(pid))).toBeUndefined();
});
test("closing a managed background CLI checks its identity, sends EOF and never controls a window", async () => {
  const identity = { pid: 12, birth: "1000.1", birthTimeMs: 1000000.1, executable: "/bin/claude", ttyDevice: 5 };
  const sent: string[][] = [];
  await closeTerminalSession(12, {
    backend: "claude", expectedIdentity: identity, processIdentity: () => identity,
    backgroundSession: async () => ({ name, pane: "%1" }),
    probe: async argv => { sent.push(argv); return ""; },
    pidIsAlive: async () => false, sleep: async () => {},
    spawn: () => { throw new Error("must not automate Terminal"); },
  });
  expect(sent).toEqual([["tmux", "send-keys", "-t", "%1", "C-d"], ["tmux", "send-keys", "-t", "%1", "C-d"]]);
});

// Actual detached processes on conch's own server — the suite's own (`CONCH_TMUX_SOCKET`, under its own
// `TMUX_TMPDIR`, test/preload.ts). No provider, account, model request, audio, clipboard or live session is involved.
const tmux = resolveTmux().found ? conchTmux() : null;
afterAll(() => { if (tmux) Bun.spawnSync([...tmux, "kill-server"], { stdout: "ignore", stderr: "ignore" }); });
const panePid = async (pane: string) => {
  const target = paneTarget(pane)!;
  return Number((await probeCommand([...target.tmux, "display-message", "-p", "-t", target.pane, "#{pane_pid}"], [0]))?.trim());
};
test.skipIf(!tmux)("a detached session runs on conch's own server and accepts messages without a terminal window or clipboard", async () => {
  const { pane, name } = await startBackgroundProcess("exec /bin/cat", "/tmp");
  expect(pane).toMatch(/^conch:%\d+$/);
  const pid = await panePid(pane);
  expect(await managedBackgroundSession(pid)).toEqual({ pane, name });
  const result = await injectText({ autoSubmit: true } as Config, pid, "background round trip", undefined, {
    osa: async () => { throw new Error("must not automate Terminal"); },
    copyToClipboard: async () => { throw new Error("must not touch the clipboard"); },
  });
  expect(result.via).toBe("tmux");
  const target = paneTarget(pane)!;
  expect(await probeCommand([...target.tmux, "capture-pane", "-p", "-t", target.pane], [0])).toContain("background round trip");
  expect((await probeCommand([...target.tmux, "list-clients"], [0]))?.trim()).toBe("");
}, 10_000);

/**
 * The 2026-10-02 outage, run for real: something inside a background session runs `tmux kill-server`, as an agent
 * did that day. It must reach no server of conch's: the session has no `$TMUX` to be steered by, so the command goes
 * to the default server (here the suite's own, empty) and every background session lives on.
 */
// Only ever against the suite's own tmux folder: never a real server, even by mistake.
const suiteTmux = process.env.TMUX_TMPDIR?.startsWith("/tmp/ctmux-") ? process.env.TMUX_TMPDIR : undefined;
test.skipIf(!tmux || !suiteTmux)("a tmux kill-server run inside a background session ends none of them", async () => {
  const first = await startBackgroundProcess("exec /bin/cat", "/tmp");
  const tmuxBin = conchTmux()[0]!;
  const killer = await startBackgroundProcess(
    `echo "TMUX=[$TMUX]"; TMUX_TMPDIR=${shellQuote(suiteTmux!)} ${shellQuote(tmuxBin)} kill-server; echo "kill-server exited $?"; exec /bin/cat`, "/tmp");
  const target = paneTarget(killer.pane)!;
  let screen = "";
  for (let tries = 0; tries < 40 && !screen.includes("kill-server exited"); tries++) {
    await Bun.sleep(100);
    screen = (await probeCommand([...target.tmux, "capture-pane", "-p", "-t", target.pane], [0])) ?? "";
  }
  // The agent saw no TMUX, and its kill-server found no server of its own to stop.
  expect(screen).toContain("TMUX=[]");
  expect(screen).toMatch(/kill-server exited [1-9]/);
  // Both sessions, and conch's server, are still there.
  const sessions = await conchServerSessions();
  expect(sessions?.has(first.name)).toBe(true);
  expect(sessions?.has(killer.name)).toBe(true);
}, 15_000);

test.skipIf(!tmux)("conch's server stays up when its last session ends, so a missing server always means it was stopped", async () => {
  const solo = await startBackgroundProcess("sleep 0.3", "/tmp");
  await Bun.sleep(900);
  const sessions = await conchServerSessions();
  expect(sessions).not.toBeNull();
  expect(sessions!.has(solo.name)).toBe(false);
}, 10_000);

test("background startup asks about unknown folder trust and reports its recovery target", async () => {
  const { applyRuntimeControlMessage } = await import("../src/control-server.ts");
  const starts: unknown[] = [];
  const deps = {
    listResumable: () => ({ sessions: [], complete: true }),
    close: () => {}, report: () => {}, folderTrusted: () => null,
    start: (request: unknown) => { starts.push(request); return { backgroundId: name }; },
  };
  const request = { kind: "session-start" as const, backend: "claude" as const, host: "background" as const, cwd: "/tmp/project" };
  expect(await applyRuntimeControlMessage(request, deps)).toEqual({ kind: "session-needs-trust", backend: "claude", cwd: "/tmp/project" });
  expect(starts).toHaveLength(0);
  expect(await applyRuntimeControlMessage({ ...request, trustFolder: true }, deps))
    .toEqual({ kind: "session-started", backend: "claude", resumed: false, backgroundId: name });
  expect(starts).toEqual([{ ...request, trustFolder: true }]);
});

test("background subscription profiles clear credentials inherited from an older tmux server", () => {
  for (const backend of ["claude", "codex"] as const) {
    const command = terminalSessionCommand({ backend, host: "background", [`${backend}AccountId`]: "default" });
    expect(command).toContain(backend === "claude" ? "-u ANTHROPIC_API_KEY" : "-u OPENAI_API_KEY");
    expect(command).toContain(backend === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME");
  }
});
