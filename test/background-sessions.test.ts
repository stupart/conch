import { afterAll, expect, test } from "bun:test";
import { backgroundStartupPid, managedBackgroundSession, startBackgroundProcess } from "../src/background-sessions.ts";
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
test("startup lookup and restart require an exact Conch pane owner", async () => {
  const probe = async () => `12 %1 ${name}\n13 %2 personal\n`;
  expect(await managedBackgroundSession(12, probe)).toEqual({ name, pane: "%1" });
  expect(await managedBackgroundSession(13, probe)).toBeUndefined();
  expect(await managedBackgroundSession(14, probe)).toBeUndefined();
  expect(await backgroundStartupPid(name, async () => `12 ${name}`)).toBe(12);
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

// Actual detached process + input, on a test-only tmux server. No provider,
// account, model request, audio, clipboard or live user session is involved.
const tmux = Bun.which("tmux");
const socket = `conch-background-test-${process.pid}`;
afterAll(() => { if (tmux) Bun.spawnSync([tmux, "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" }); });
test.skipIf(!tmux)("a detached session accepts Conch messages without a terminal window or clipboard", async () => {
  const probe: typeof probeCommand = (args, ok, timeout) => probeCommand([args[0]!, "-L", socket, ...args.slice(1)], ok, timeout);
  const { pane, name } = await startBackgroundProcess("exec /bin/cat", "/tmp", probe);
  const pid = Number((await probe(["tmux", "display-message", "-p", "-t", pane, "#{pane_pid}"], [0]))?.trim());
  expect(await managedBackgroundSession(pid, probe)).toEqual({ pane, name });
  const result = await injectText({ autoSubmit: true } as Config, pid, "background round trip", undefined, {
    findTmuxPane: async () => pane,
    sendTmuxKeys: async (target, text, literal) => ({ exitCode: await probe(["tmux", "send-keys", "-t", target, ...(literal ? ["-l", "--"] : []), text], [0]) === null ? 1 : 0 }),
    osa: async () => { throw new Error("must not automate Terminal"); },
    copyToClipboard: async () => { throw new Error("must not touch the clipboard"); },
  });
  expect(result.via).toBe("tmux");
  expect(await probe(["tmux", "capture-pane", "-p", "-t", pane], [0])).toContain("background round trip");
  expect((await probe(["tmux", "list-clients"], [0]))?.trim()).toBe("");
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
