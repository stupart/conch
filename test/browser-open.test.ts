import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_SHIM,
  CLAUDE_ENV_SCRIPT,
  OPEN_SHIM,
  SHIMS_OFF_MARKER,
  browseRequest,
  browserOpenOutcome,
  browserShimDir,
  browserShimsReady,
  decodeBrowserOpenRequest,
  requestBrowserOpen,
  routeSessionBrowsers,
  sessionBrowserAssignments,
  setUpSessionBrowsers,
  writeBrowserShims,
} from "../src/browser-open.ts";
import { loadConfig } from "../src/config.ts";
import { SETTING_REGISTRY } from "../src/settings.ts";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";

const REPO = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-browser-open-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  routeSessionBrowsers(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the browser-open request", () => {
  test("is decoded only for its own kind, with an http(s) link and the caller's pid", () => {
    expect(decodeBrowserOpenRequest({ kind: "session-start" })).toBeNull();
    expect(decodeBrowserOpenRequest(null)).toBeNull();
    expect(decodeBrowserOpenRequest({ kind: "browser-open", url: "https://example.com/a?b=1", callerPid: 4242 }))
      .toEqual({ kind: "browser-open", url: "https://example.com/a?b=1", callerPid: 4242 });
    expect(decodeBrowserOpenRequest({ kind: "browser-open", url: "http://localhost:3000", callerPid: 4242, profile: " work " }))
      .toEqual({ kind: "browser-open", url: "http://localhost:3000", callerPid: 4242, profile: "work" });
    for (const url of ["file:///etc/passwd", "mailto:a@b.c", "javascript:alert(1)", "example.com", "https://", "https://a.test/\nx", 7]) {
      expect(decodeBrowserOpenRequest({ kind: "browser-open", url, callerPid: 4242 })).toEqual({ error: "url must be an http or https link" });
    }
    for (const callerPid of [0, 1, -5, 1.5, "4242", undefined]) {
      expect(decodeBrowserOpenRequest({ kind: "browser-open", url: "https://a.test", callerPid })).toHaveProperty("error");
    }
    for (const profile of ["", "  ", "x".repeat(129), "a\u0007b", 3]) {
      expect(decodeBrowserOpenRequest({ kind: "browser-open", url: "https://a.test", callerPid: 4242, profile })).toHaveProperty("error");
    }
  });

  test("`conch browse <url> [--profile <name>]` builds exactly that request", () => {
    expect(browseRequest(["https://a.test/x"], 77)).toEqual({ kind: "browser-open", url: "https://a.test/x", callerPid: 77 });
    expect(browseRequest(["https://a.test", "--profile", "work"], 77)).toEqual({ kind: "browser-open", url: "https://a.test", callerPid: 77, profile: "work" });
    expect(browseRequest(["--profile=work", "https://a.test"], 77)).toEqual({ kind: "browser-open", url: "https://a.test", callerPid: 77, profile: "work" });
    expect(browseRequest([], 77)).toHaveProperty("error");
    expect(browseRequest(["https://a.test", "--profile"], 77)).toHaveProperty("error");
    expect(browseRequest(["https://a.test", "https://b.test"], 77)).toHaveProperty("error");
    expect(browseRequest(["--new", "https://a.test"], 77)).toHaveProperty("error");
    expect(browseRequest(["./README.md"], 77)).toEqual({ error: "url must be an http or https link" });
  });

  test("only browser-opened counts as opened", () => {
    expect(browserOpenOutcome({ kind: "browser-opened", tabId: "t1", sessionId: "s1" })).toEqual({ ok: true });
    expect(browserOpenOutcome({ kind: "browser-error", error: "no Workbench" })).toEqual({ ok: false, error: "no Workbench" });
    // A daemon from before browser-open answers with its own error kind: the link still goes somewhere.
    expect(browserOpenOutcome({ kind: "session-error", error: "invalid turn event" })).toEqual({ ok: false, error: "invalid turn event" });
    expect(browserOpenOutcome("nope").ok).toBe(false);
  });
});

/** A one-line control server: records each request and answers with `reply(request)`, or never when that is null. */
async function fakeDaemon(socketPath: string, reply: (request: any) => object | null): Promise<{ server: Server; received: any[] }> {
  const received: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      received.push(request);
      const answer = reply(request);
      if (answer) socket.end(JSON.stringify(answer) + "\n");
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { server, received };
}
const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("requestBrowserOpen", () => {
  test("sends the request as one line and reads the daemon's answer", async () => {
    const socketPath = join(scratch(), "d.sock");
    const { server, received } = await fakeDaemon(socketPath, (request) =>
      request.url.includes("refuse") ? { kind: "browser-error", error: "the Workbench is closed" } : { kind: "browser-opened", tabId: "t1", sessionId: "s1" });
    try {
      const request = { kind: "browser-open" as const, url: "https://a.test", callerPid: 4242, profile: "work" };
      expect(await requestBrowserOpen(socketPath, request)).toEqual({ ok: true });
      expect(received).toEqual([request]);
      expect(await requestBrowserOpen(socketPath, { ...request, url: "https://a.test/refuse" })).toEqual({ ok: false, error: "the Workbench is closed" });
    } finally {
      await closeServer(server);
    }
  });

  test("fails, rather than waiting on, a daemon that is down or silent", async () => {
    const root = scratch();
    expect(await requestBrowserOpen(join(root, "missing.sock"), { kind: "browser-open", url: "https://a.test", callerPid: 4242 }))
      .toEqual({ ok: false, error: "conch's daemon is not running" });
    const { server } = await fakeDaemon(join(root, "silent.sock"), () => null);
    try {
      const outcome = await requestBrowserOpen(join(root, "silent.sock"), { kind: "browser-open", url: "https://a.test", callerPid: 4242 }, 200);
      expect(outcome).toEqual({ ok: false, error: "the daemon did not answer (timed out)" });
    } finally {
      await closeServer(server);
    }
  });
});

/**
 * The shim folder with stand-ins: a `conch` that logs `browse <args>` and exits with $FAKE_CONCH_STATUS, and an `open`
 * in place of /usr/bin/open that logs `open <args>` and exits with $FAKE_OPEN_STATUS. Each argument is logged with a
 * `|` after it, so the exact argv is checked.
 */
function shimFixture(options: { enabled?: boolean } = {}) {
  const root = scratch();
  const dir = join(root, "conch bin");
  const log = join(root, "calls.log");
  const conch = join(root, "fake conch");
  const systemOpen = join(root, "fake open");
  writeFileSync(conch, `#!/bin/sh\nprintf 'conch' >> "$LOG"; for a do printf ' %s|' "$a" >> "$LOG"; done; echo >> "$LOG"\nexit "\${FAKE_CONCH_STATUS:-0}"\n`);
  writeFileSync(systemOpen, `#!/bin/sh\nprintf 'open' >> "$LOG"; for a do printf ' %s|' "$a" >> "$LOG"; done; echo >> "$LOG"\nexit "\${FAKE_OPEN_STATUS:-0}"\n`);
  chmodSync(conch, 0o755);
  chmodSync(systemOpen, 0o755);
  writeBrowserShims({ dir, invocation: quote(conch), enabled: options.enabled ?? true, systemOpen });
  const run = (shim: string, args: string[], env: Record<string, string> = {}) => {
    rmSync(log, { force: true });
    const result = Bun.spawnSync([join(dir, shim), ...args], { env: { PATH: "/usr/bin:/bin", LOG: log, ...env }, stdout: "pipe", stderr: "pipe" });
    return { status: result.exitCode, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  return { dir, root, open: (args: string[], env?: Record<string, string>) => run(OPEN_SHIM, args, env), browser: (args: string[], env?: Record<string, string>) => run(BROWSER_SHIM, args, env) };
}

describe("conch's open", () => {
  test("hands each http(s) link to `conch browse`, and opens nothing itself", () => {
    const { open } = shimFixture();
    expect(open(["https://example.com/a?b=1&c=2"])).toEqual({ status: 0, calls: ["conch browse| https://example.com/a?b=1&c=2|"] });
    expect(open(["https://a.test", "http://localhost:3000/x y"]).calls).toEqual(["conch browse| https://a.test|", "conch browse| http://localhost:3000/x y|"]);
    expect(open(["HTTPS://A.TEST/'quoted'"]).calls).toEqual(["conch browse| HTTPS://A.TEST/'quoted'|"]);
    // Flags that only say how a browser comes up don't stop a link landing in the Workbench.
    expect(open(["-g", "https://a.test"]).calls).toEqual(["conch browse| https://a.test|"]);
    expect(open(["-u", "https://a.test"]).calls).toEqual(["conch browse| https://a.test|"]);
    expect(open(["--url", "https://a.test", "-n"]).calls).toEqual(["conch browse| https://a.test|"]);
  });

  test("passes anything that isn't only links to macOS's open, arguments unchanged", () => {
    const { open } = shimFixture();
    for (const args of [
      [],
      ["-a", "Safari", "https://a.test"],
      ["-b", "com.apple.Safari", "https://a.test"],
      ["-na", "Safari", "https://a.test"],
      ["-e", "notes.txt"],
      ["-t", "https://a.test"],
      ["-f"],
      ["-R", "https://a.test"],
      ["-W", "https://a.test"],
      ["https://a.test", "--args", "--kiosk"],
      ["--env", "A=1", "https://a.test"],
      ["./README.md"],
      ["/Applications/Safari.app"],
      ["file:///tmp/a.html"],
      ["mailto:someone@example.com"],
      ["https://a.test", "./README.md"],
      ["-u"],
      ["-u", "./README.md"],
    ]) {
      expect(open(args)).toEqual({ status: 0, calls: [`open${args.map((arg) => ` ${arg}|`).join("")}`] });
    }
  });

  test("CONCH_OPEN_EXTERNAL=1 sends links to the default browser", () => {
    const { open, browser } = shimFixture();
    expect(open(["https://a.test"], { CONCH_OPEN_EXTERNAL: "1" }).calls).toEqual(["open https://a.test|"]);
    expect(browser(["https://a.test"], { CONCH_OPEN_EXTERNAL: "1" }).calls).toEqual(["open https://a.test|"]);
    // Only exactly 1.
    expect(open(["https://a.test"], { CONCH_OPEN_EXTERNAL: "0" }).calls).toEqual(["conch browse| https://a.test|"]);
  });

  test("a link `conch browse` can't place opens in the default browser, with the same flags", () => {
    const { open } = shimFixture();
    expect(open(["-g", "https://a.test", "https://b.test"], { FAKE_CONCH_STATUS: "1" })).toEqual({
      status: 0,
      calls: ["conch browse| https://a.test|", "open -g| https://a.test|", "conch browse| https://b.test|", "open -g| https://b.test|"],
    });
    // And when that fails too, `open` says so.
    expect(open(["https://a.test"], { FAKE_CONCH_STATUS: "1", FAKE_OPEN_STATUS: "1" }).status).toBe(1);
    // macOS's own exit status comes back from a pass-through.
    expect(open(["-a", "Nope"], { FAKE_OPEN_STATUS: "1" }).status).toBe(1);
  });

  test("with the setting off, passes everything through, even in a session started while it was on", () => {
    const { open, browser } = shimFixture({ enabled: false });
    expect(open(["https://a.test"]).calls).toEqual(["open https://a.test|"]);
    expect(browser(["https://a.test"]).calls).toEqual(["open https://a.test|"]);
  });
});

describe("conch's $BROWSER", () => {
  test("hands its one link to `conch browse`, and anything else, or a link it can't place, to macOS's open", () => {
    const { browser } = shimFixture();
    expect(browser(["https://a.test/x"])).toEqual({ status: 0, calls: ["conch browse| https://a.test/x|"] });
    expect(browser(["https://a.test/x"], { FAKE_CONCH_STATUS: "1" }).calls).toEqual(["conch browse| https://a.test/x|", "open https://a.test/x|"]);
    expect(browser(["./index.html"]).calls).toEqual(["open ./index.html|"]);
    expect(browser(["https://a.test", "https://b.test"]).calls).toEqual(["open https://a.test| https://b.test|"]);
  });
});

describe("the shim folder", () => {
  test("lives under the config dir", () => {
    expect(browserShimDir({ CONCH_CONFIG_DIR: "/x/conch" })).toBe("/x/conch/bin");
  });

  test("is written once, executable, and rewritten only when it would change", () => {
    const dir = join(scratch(), "bin");
    expect(browserShimsReady(dir)).toBe(false);
    expect(writeBrowserShims({ dir, invocation: '"/bin/conch"', enabled: true })).toBe(true);
    expect(browserShimsReady(dir)).toBe(true);
    for (const name of [OPEN_SHIM, BROWSER_SHIM]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, OPEN_SHIM), "utf8")).toContain('"/bin/conch" browse "$arg"');
    expect(readFileSync(join(dir, OPEN_SHIM), "utf8")).toContain("exec '/usr/bin/open' \"$@\"");
    const before = statSync(join(dir, OPEN_SHIM)).mtimeMs;
    expect(writeBrowserShims({ dir, invocation: '"/bin/conch"', enabled: true })).toBe(false);
    expect(statSync(join(dir, OPEN_SHIM)).mtimeMs).toBe(before);
    expect(writeBrowserShims({ dir, invocation: '"/bin/conch"', enabled: false })).toBe(true);
    expect(existsSync(join(dir, SHIMS_OFF_MARKER))).toBe(true);
    expect(writeBrowserShims({ dir, invocation: '"/bin/conch"', enabled: false })).toBe(false);
    expect(writeBrowserShims({ dir, invocation: '"/bin/conch"', enabled: true })).toBe(true);
    expect(existsSync(join(dir, SHIMS_OFF_MARKER))).toBe(false);
    // A moved conch is written into the shims on the daemon's next start.
    expect(writeBrowserShims({ dir, invocation: '"/opt/conch"', enabled: true })).toBe(true);
    expect(readFileSync(join(dir, BROWSER_SHIM), "utf8")).toContain('"/opt/conch" browse "$1"');
  });

  test("the daemon's set-up routes sessions through it only while the setting is on, and never through a folder it couldn't write", () => {
    const root = scratch();
    const dir = join(root, "bin");
    expect(setUpSessionBrowsers(true, '"/bin/conch"', dir)).toBeUndefined();
    expect(sessionBrowserAssignments("codex")).toContain(`PATH='${dir}':"$PATH"`);
    expect(setUpSessionBrowsers(false, '"/bin/conch"', dir)).toBeUndefined();
    expect(sessionBrowserAssignments("codex")).toBe("");
    const blocked = join(root, "a file");
    writeFileSync(blocked, "");
    expect(setUpSessionBrowsers(true, '"/bin/conch"', join(blocked, "bin"))).toContain("could not write conch's open shim");
    expect(sessionBrowserAssignments("claude")).toBe("");
  });
});

describe("sessions conch starts", () => {
  const dir = "/Users/t/.config/conch/bin";
  const path = `PATH='${dir}':"$PATH" BROWSER='${dir}/conch-browser'`;
  const claudeEnv = `CONCH_CLAUDE_ENV_FILE="$CLAUDE_ENV_FILE" CLAUDE_ENV_FILE='${dir}/claude-env.sh'`;

  test("get nothing while the setting is off", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/work/demo" })).toBe("cd -- '/work/demo' && exec claude");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/work/demo" })).toBe("cd -- '/work/demo' && exec codex");
  });

  test("Claude in Terminal: the folder first on PATH, $BROWSER, and the env file for its Bash commands", () => {
    routeSessionBrowsers(dir);
    expect(terminalSessionCommand({ backend: "claude", cwd: "/work/demo" }))
      .toBe(`cd -- '/work/demo' && exec env ${path} ${claudeEnv} claude`);
    // After a profile's own `env` options, in the same `env`.
    const profiled = terminalSessionCommand({ backend: "claude", cwd: "/work/demo", claudeAccountId: "default" });
    expect(profiled).toStartWith("cd -- '/work/demo' && exec env ");
    expect(profiled).toEndWith(` ${path} ${claudeEnv} claude`);
    expect(profiled.split(" env ")).toHaveLength(2);
    expect(profiled.indexOf("CLAUDE_CONFIG_DIR")).toBeLessThan(profiled.indexOf("PATH="));
  });

  test("Codex in Terminal: the folder and $BROWSER, no Claude env file", () => {
    routeSessionBrowsers(dir);
    expect(terminalSessionCommand({ backend: "codex", cwd: "/work/demo" })).toBe(`cd -- '/work/demo' && exec env ${path} codex`);
    expect(terminalSessionCommand({ backend: "codex", cwd: "/work/demo", resumeSessionId: "abc" }))
      .toBe(`cd -- '/work/demo' && exec env ${path} codex resume 'abc'`);
  });

  test("in the background, both agents carry it in the command tmux's zsh runs", () => {
    routeSessionBrowsers(dir);
    // `startBackgroundSession` builds its command this way: host background, the default profile named.
    const claude = terminalSessionCommand({ backend: "claude", host: "background", claudeAccountId: "default", cwd: "/work/demo" });
    expect(claude).toContain("-u ANTHROPIC_API_KEY");
    expect(claude).toEndWith(` ${path} ${claudeEnv} claude`);
    const codex = terminalSessionCommand({ backend: "codex", host: "background", codexAccountId: "default", cwd: "/work/demo" });
    expect(codex).toContain("-u OPENAI_API_KEY");
    expect(codex).toEndWith(` ${path} codex --no-daemon`);
    // The `-e PATH` tmux is given would not do: the login shell's path_helper puts it back after /usr/bin.
    expect(read("src/session-lifecycle.ts")).toContain("const command = terminalSessionCommand({ ...request, host: \"background\"");
  });

  /** A fake agent on PATH that reports which `open` it would run, before and after a login shell's path_helper. */
  function runCommand(shell: string[], command: string, root: string, priorEnvFile?: string) {
    const bin = join(root, "agents");
    mkdirSync(bin, { recursive: true });
    const report = `#!/bin/sh
echo "open=$(command -v open)"
echo "browser=$BROWSER"
eval "$(/usr/libexec/path_helper -s)"
echo "login open=$(command -v open)"
if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then . "$CLAUDE_ENV_FILE"; echo "env-file open=$(command -v open)"; echo "user=\${FROM_USER_FILE:-}"; fi
`;
    for (const agent of ["claude", "codex"]) {
      writeFileSync(join(bin, agent), report);
      chmodSync(join(bin, agent), 0o755);
    }
    const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: root };
    if (priorEnvFile) env.CLAUDE_ENV_FILE = priorEnvFile;
    const result = Bun.spawnSync([...shell, command], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    return Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  }

  test.skipIf(!existsSync("/usr/libexec/path_helper"))("run: `open` is conch's, also in Claude's Bash commands after a login shell", () => {
    const root = scratch();
    const shims = join(root, "conch's bin");
    writeBrowserShims({ dir: shims, invocation: '"/bin/conch"', enabled: true });
    routeSessionBrowsers(shims);
    const userFile = join(root, "user-env.sh");
    writeFileSync(userFile, "export FROM_USER_FILE=yes\n");
    for (const shell of [["/bin/sh", "-c"], ["/bin/zsh", "-fc"]]) {
      const claude = runCommand(shell, terminalSessionCommand({ backend: "claude", cwd: root }), root, userFile);
      expect(claude.open).toBe(join(shims, "open"));
      expect(claude.browser).toBe(join(shims, "conch-browser"));
      // What Claude Code's login-shell snapshot does to PATH, and what its CLAUDE_ENV_FILE puts back.
      expect(claude["login open"]).toBe("/usr/bin/open");
      expect(claude["env-file open"]).toBe(join(shims, "open"));
      expect(claude.user).toBe("yes");
      const codex = runCommand(shell, terminalSessionCommand({ backend: "codex", cwd: root }), root);
      expect(codex.open).toBe(join(shims, "open"));
      expect(codex.browser).toBe(join(shims, "conch-browser"));
    }
    // The env file never runs itself, when the session was started with it already set.
    const looped = runCommand(["/bin/sh", "-c"], terminalSessionCommand({ backend: "claude", cwd: root }), root, join(shims, CLAUDE_ENV_SCRIPT));
    expect(looped["env-file open"]).toBe(join(shims, "open"));
  });
});

describe("`conch browse`, run", () => {
  async function browse(args: string[], reply: ((request: any) => object | null) | null) {
    const root = scratch();
    const socketPath = join(root, "d.sock");
    const daemon = reply ? await fakeDaemon(socketPath, reply) : undefined;
    try {
      const proc = Bun.spawn([process.execPath, join(REPO, "src", "cli.ts"), "browse", ...args], {
        cwd: REPO,
        env: { ...process.env, CONCH_SOCKET: socketPath, CONCH_CONFIG_DIR: join(root, "config") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { status, stdout, stderr, received: daemon?.received ?? [] };
    } finally {
      if (daemon) await closeServer(daemon.server);
    }
  }

  test("sends browser-open with its parent's pid and prints nothing once it is open", async () => {
    const run = await browse(["https://a.test/x", "--profile", "work"], () => ({ kind: "browser-opened", tabId: "t1", sessionId: "s1" }));
    expect(run).toEqual({ status: 0, stdout: "", stderr: "", received: [{ kind: "browser-open", url: "https://a.test/x", callerPid: process.pid, profile: "work" }] });
  }, 60_000);

  test("fails on a browser-error, with no daemon, and on arguments it can't send", async () => {
    const refused = await browse(["https://a.test"], () => ({ kind: "browser-error", error: "the Workbench is closed" }));
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("the Workbench is closed");
    const down = await browse(["https://a.test"], null);
    expect(down.status).toBe(1);
    expect(down.stderr).toContain("conch's daemon is not running");
    const bad = await browse(["./README.md"], () => ({ kind: "browser-opened", tabId: "t1", sessionId: "s1" }));
    expect(bad.status).toBe(2);
    expect(bad.received).toEqual([]);
  }, 60_000);

  test("end to end: the shim's link reaches the daemon, and one it refuses opens in the default browser", async () => {
    const root = scratch();
    const dir = join(root, "bin");
    const log = join(root, "calls.log");
    const systemOpen = join(root, "fake open");
    writeFileSync(systemOpen, `#!/bin/sh\nprintf 'open %s\\n' "$*" >> "$LOG"\n`);
    chmodSync(systemOpen, 0o755);
    writeBrowserShims({ dir, invocation: `${quote(process.execPath)} ${quote(join(REPO, "src", "cli.ts"))}`, enabled: true, systemOpen });
    const socketPath = join(root, "d.sock");
    const { server, received } = await fakeDaemon(socketPath, (request) =>
      request.url.includes("refuse") ? { kind: "browser-error", error: "no" } : { kind: "browser-opened", tabId: "t1", sessionId: "s1" });
    try {
      const env = { ...process.env, LOG: log, CONCH_SOCKET: socketPath, CONCH_CONFIG_DIR: join(root, "config") };
      const opened = Bun.spawn([join(dir, OPEN_SHIM), "https://a.test/ok"], { env, stdout: "pipe", stderr: "pipe" });
      expect(await opened.exited).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ kind: "browser-open", url: "https://a.test/ok" });
      // `conch browse`'s parent: the shim's own process, alive while the daemon walks up from it to the agent.
      expect(received[0].callerPid).toBe(opened.pid);
      expect(existsSync(log)).toBe(false);
      const refused = Bun.spawn([join(dir, BROWSER_SHIM), "https://a.test/refuse"], { env, stdout: "pipe", stderr: "pipe" });
      expect(await refused.exited).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("open https://a.test/refuse\n");
    } finally {
      await closeServer(server);
    }
  }, 60_000);
});

describe("the browser-open-in-conch setting", () => {
  test("is on by default, live, and read from CONCH_BROWSER_OPEN_IN_CONCH", () => {
    expect(SETTING_REGISTRY.get("browser-open-in-conch")).toMatchObject({
      field: "browserOpenInConch", env: "CONCH_BROWSER_OPEN_IN_CONCH", default: true, apply: "live", kind: "boolean",
    });
    const none = join(scratch(), "none.json");
    expect(loadConfig({ env: {}, settingsPath: none }).browserOpenInConch).toBe(true);
    expect(loadConfig({ env: { CONCH_BROWSER_OPEN_IN_CONCH: "0" }, settingsPath: none }).browserOpenInConch).toBe(false);
  });

  test("the daemon writes the shim folder at start and again whenever the setting changes", () => {
    const daemon = read("src/daemon.ts");
    expect(daemon).toContain("setUpBrowsers(cfg.browserOpenInConch);");
    expect(daemon).toContain('if (key === "browser-open-in-conch") setUpBrowsers(value === true);');
    expect(daemon).toContain("setUpSessionBrowsers(on, conchInvocation())");
    // Before anything can start a session.
    expect(daemon.indexOf("setUpBrowsers(cfg.browserOpenInConch);")).toBeLessThan(daemon.indexOf("const controlServer = createControlServer("));
    // A start from a terminal goes through the folder too, once the daemon has written it.
    const cli = read("src/cli.ts");
    expect(cli.match(/await routeDirectStartBrowsers\(\);/g)).toHaveLength(2);
  });

  test("agents are told where `open` goes and how to reach the default browser", () => {
    for (const file of ["src/agent-instructions.ts", "plugin/plugins/conch/AGENTS.md"]) {
      expect(read(file)).toContain("CONCH_OPEN_EXTERNAL=1 open <url>");
    }
  });
});
