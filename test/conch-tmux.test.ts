import { describe, expect, test } from "bun:test";
import {
  CONCH_TMUX_OPTIONS,
  CONCH_TMUX_SOCKET,
  conchTmuxArgv,
  conchTmuxSocket,
  HOSTED_FORMAT,
  hostedAttachArgs,
  hostedEnvironment,
  hostedSessionName,
  hostedShell,
  hostedStartArgv,
  hostedTerminalCommand,
  HostedTerminalCache,
  paneHostingPid,
  parseHostedPanes,
  readHostedTerminals,
  type HostedReadDeps,
} from "../src/conch-tmux.ts";
import {
  attachHostedInTerminal,
  closeHostedSession,
  closeSession,
  startHostedSession,
  terminalSessionCommand,
  type StartSessionRequest,
} from "../src/session-lifecycle.ts";
import type { ProcessIdentity } from "../src/process-identity.ts";

const TMUX = "/Applications/conch.app/Contents/Helpers/tmux";
const SERVER = [TMUX, "-L", "conch"];
const SOCKET = "/private/tmp/tmux-501/conch";

describe("conch's own server", () => {
  test("is `tmux -L conch`, apart from the user's default server", () => {
    expect(CONCH_TMUX_SOCKET).toBe("conch");
    expect(conchTmuxSocket({})).toBe("conch");
    expect(conchTmuxArgv({}, () => ({ path: TMUX, source: "conch.app", found: true }))).toEqual(SERVER);
  });

  test("a test names a throwaway server; nothing else can steer it anywhere odd", () => {
    expect(conchTmuxSocket({ CONCH_TMUX_SOCKET: "conch-embed-test-42" })).toBe("conch-embed-test-42");
    for (const bad of ["", "a/b", "../x", "has space", "x".repeat(65)]) {
      expect(conchTmuxSocket({ CONCH_TMUX_SOCKET: bad })).toBe("conch");
    }
  });

  test("with no tmux anywhere, nothing can be hosted", () => {
    expect(conchTmuxArgv({}, () => ({ path: "tmux", source: "missing", found: false }))).toBeNull();
  });
});

describe("the start command", () => {
  const plan = { session: "claude-conch-7k2f", cwd: "/Users/tyler/Projects/Conch", shell: "/bin/zsh", command: "cd -- '/Users/tyler/Projects/Conch' && exec claude --model 'opus'" };
  const argv = hostedStartArgv(SERVER, plan);

  test("starts the server with no config file of the user's, then conch's options, then the session", () => {
    expect(argv.slice(0, 6)).toEqual([...SERVER, "-f", "/dev/null", "start-server"]);
    const session = argv.indexOf("new-session");
    expect(session).toBeGreaterThan(-1);
    // Every option is set, each as its own command, BEFORE the session's pane exists: `extended-keys always` only
    // holds for panes made after it (measured on tmux 3.7c).
    for (const option of CONCH_TMUX_OPTIONS) {
      const at = argv.findIndex((word, index) => word === option[2] && argv[index - 1] === option[1]);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(session);
      expect(argv[at - 3]).toBe(";");
    }
    expect(argv[session - 1]).toBe(";");
  });

  test("Shift-Enter, no prefix key, no status bar, mouse on, and every option quiet if a tmux lacks it", () => {
    const set = new Map(CONCH_TMUX_OPTIONS.map((option) => [option[2], option[3]]));
    expect(set.get("extended-keys")).toBe("always");
    expect(set.get("extended-keys-format")).toBe("csi-u");
    expect(set.get("prefix")).toBe("None");
    expect(set.get("status")).toBe("off");
    expect(set.get("mouse")).toBe("on");
    expect(set.get("escape-time")).toBe("10");
    expect(set.get("copy-command")).toBe("pbcopy");
    expect(set.get("terminal-features[90]")).toContain("extkeys");
    for (const option of CONCH_TMUX_OPTIONS) expect(option[1]).toMatch(/^-[sg]q$/);
  });

  test("the session: detached, named, in the folder, sized, 24-bit colour, through an interactive login shell", () => {
    const tail = argv.slice(argv.indexOf("new-session"));
    expect(tail).toEqual([
      "new-session", "-d", "-P", "-F", HOSTED_FORMAT,
      "-s", "claude-conch-7k2f", "-c", "/Users/tyler/Projects/Conch",
      "-x", "120", "-y", "40", "-e", "COLORTERM=truecolor",
      "--", "/bin/zsh", "-l", "-i", "-c", plan.command,
    ]);
  });

  test("refuses what it would not run", () => {
    expect(() => hostedStartArgv(SERVER, { ...plan, session: "x;y" })).toThrow("not a conch session name");
    expect(() => hostedStartArgv(SERVER, { ...plan, cwd: "relative" })).toThrow("absolute");
    expect(() => hostedStartArgv(SERVER, { ...plan, shell: "zsh" })).toThrow("absolute");
  });

  test("session names are the agent, the folder and four characters tmux accepts", () => {
    let n = 0;
    const random = () => (n++ % 32) / 32;
    expect(hostedSessionName("claude", "/Users/tyler/My Project.v2", random)).toBe("claude-My-Project-v2-abcd");
    expect(hostedSessionName("codex", "/", random)).toMatch(/^codex-home-[a-z2-9]{4}$/);
    expect(hostedSessionName("claude", "/x/" + "a".repeat(80))).toMatch(/^claude-a{32}-[a-z2-9]{4}$/);
  });

  test("the login shell is the user's; only a test replaces it", () => {
    expect(hostedShell({ CONCH_SESSION_SHELL: "/tmp/fake-shell" })).toBe("/tmp/fake-shell");
    expect(hostedShell({ CONCH_SESSION_SHELL: "relative" })).toMatch(/^\//);
    expect(hostedShell({})).toMatch(/^\/.*sh$/);
  });

  test("the server gets what Terminal gives a window, and nothing of the daemon's", () => {
    const env = hostedEnvironment({
      HOME: "/Users/tyler", USER: "tyler", LOGNAME: "tyler", SHELL: "/bin/zsh", TMPDIR: "/var/folders/x/",
      SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners", PATH: "/checkout/node_modules/.bin:/usr/bin",
      CONCH_SOCKET: "/tmp/conch.sock", CONCH_HOME: "/x", TMUX: "/tmp/tmux-501/default,1,0", CLAUDE_CONFIG_DIR: "/x",
      TMUX_TMPDIR: "/tmp/t",
    });
    expect(env).toEqual({
      HOME: "/Users/tyler", USER: "tyler", LOGNAME: "tyler", SHELL: "/bin/zsh", TMPDIR: "/var/folders/x/",
      SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners", TMUX_TMPDIR: "/tmp/t",
      // The login shell builds PATH from the system's paths and the profile, as it does in Terminal.
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      // An app launched from Finder has no LANG.
      LANG: "en_US.UTF-8",
    });
    expect(hostedEnvironment({ LANG: "fr_FR.UTF-8" }).LANG).toBe("fr_FR.UTF-8");
  });
});

describe("starting a session In conch", () => {
  type Ran = { argv: string[]; env: Record<string, string> };
  const started = (ran: Ran[], output = `claude-conch-abcd\t%3\t51234\t${SOCKET}\n`) => ({
    tmux: SERVER,
    env: { HOME: "/Users/tyler", CONCH_SESSION_SHELL: "/bin/zsh", CONCH_SOCKET: "/tmp/test.sock" },
    which: (name: string) => `/opt/homebrew/bin/${name}`,
    isDirectory: () => true,
    random: () => 0,
    run: async (argv: string[], env: Record<string, string>) => {
      ran.push({ argv, env });
      return { exitCode: 0, stdout: output, stderr: "" };
    },
  });

  test("runs the same command a Terminal window would, with #456's flags, in conch's server", async () => {
    const ran: Ran[] = [];
    const request: StartSessionRequest = { backend: "claude", cwd: "/Users/tyler/conch", options: { model: "opus", effort: "max" } };
    const out = await startHostedSession(request, { ...started(ran, `claude-conch-aaaa\t%3\t51234\t${SOCKET}\n`) });
    expect(out).toEqual({ tmux: TMUX, socket: SOCKET, session: "claude-conch-aaaa", pane: "%3", panePid: 51234 });
    expect(ran).toHaveLength(1);
    const argv = ran[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(SERVER);
    const command = argv.at(-1)!;
    expect(command).toBe(terminalSessionCommand(request));
    expect(command).toBe("cd -- '/Users/tyler/conch' && exec claude --model 'opus' --effort 'max'");
    expect(argv.slice(-5, -1)).toEqual(["/bin/zsh", "-l", "-i", "-c"]);
    expect(argv[argv.indexOf("-c", argv.indexOf("new-session")) + 1]).toBe("/Users/tyler/conch");
    // The daemon's own environment stays out of the session.
    expect(ran[0]!.env.CONCH_SOCKET).toBeUndefined();
    expect(ran[0]!.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("Codex's model and effort ride along as its own config overrides", async () => {
    const ran: Ran[] = [];
    await startHostedSession(
      { backend: "codex", cwd: "/Users/tyler/conch", options: { model: "gpt-6-luna", "reasoning-effort": "high" } },
      started(ran, `codex-conch-aaaa\t%4\t777\t${SOCKET}\n`),
    );
    expect(ran[0]!.argv.at(-1)).toBe(
      `cd -- '/Users/tyler/conch' && exec codex -c 'model="gpt-6-luna"' -c 'model_reasoning_effort="high"'`,
    );
  });

  test("refuses before tmux is asked: no tmux, no agent, no folder, bad options", async () => {
    const ran: Ran[] = [];
    await expect(startHostedSession({ backend: "claude" }, { ...started(ran), tmux: null })).rejects.toThrow("can't find tmux");
    await expect(startHostedSession({ backend: "claude" }, { ...started(ran), which: () => null })).rejects.toThrow("not installed");
    await expect(startHostedSession({ backend: "claude", cwd: "/nope" }, { ...started(ran), isDirectory: () => false }))
      .rejects.toThrow("session directory does not exist: /nope");
    await expect(startHostedSession({ backend: "claude", options: { nope: true } }, started(ran))).rejects.toThrow("no start option");
    expect(ran).toHaveLength(0);
  });

  test("a tmux that didn't start it says so, in its words", async () => {
    const run = async () => ({ exitCode: 1, stdout: "", stderr: "server exited unexpectedly" });
    await expect(startHostedSession({ backend: "claude", cwd: "/x" }, { ...started([]), run })).rejects.toThrow("server exited unexpectedly");
    // A pane from some other session is not this one.
    await expect(startHostedSession({ backend: "claude", cwd: "/x" }, started([], `other-x-aaaa\t%1\t5\t${SOCKET}\n`)))
      .rejects.toThrow("didn't start the session");
  });
});

describe("attaching", () => {
  const hosted = { tmux: TMUX, socket: SOCKET, session: "claude-conch-7k2f" };

  test("the app's client is ignore-size, so it never resizes a Terminal window attached to the same session", () => {
    expect(hostedAttachArgs(hosted, { ignoreSize: true }))
      .toEqual(["-u", "-S", SOCKET, "attach-session", "-f", "ignore-size", "-t", "=claude-conch-7k2f"]);
  });

  test("Open in Terminal attaches a plain client to the same session, and exec means detaching closes the tab", () => {
    expect(hostedTerminalCommand(hosted))
      .toBe(`exec '${TMUX}' '-u' '-S' '${SOCKET}' 'attach-session' '-t' '=claude-conch-7k2f'`);
    expect(() => hostedTerminalCommand({ ...hosted, tmux: "tmux" })).toThrow("absolute");
    expect(() => hostedAttachArgs({ ...hosted, session: "a b" }, { ignoreSize: false })).toThrow();
  });

  test("Open in Terminal runs that command in a new Terminal window, through the usual door", async () => {
    const spawned: string[][] = [];
    await attachHostedInTerminal(hosted, "/Users/tyler/conch", {
      which: (name) => (name === TMUX ? TMUX : null),
      isDirectory: () => true,
      spawn: (argv) => {
        spawned.push(argv);
        return { exited: Promise.resolve(0), stdout: new Response("/dev/ttys009\n").body, stderr: new Response("").body, cancel() {} };
      },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]![0]).toBe("osascript");
    expect(spawned[0]).toContain("set newTab to do script (item 1 of argv)");
    expect(spawned[0]!.at(-1)).toBe(hostedTerminalCommand(hosted));
  });
});

describe("re-adoption: the server is the record", () => {
  const listing = [
    `claude-conch-7k2f\t%3\t5000\t${SOCKET}`,
    `codex-web-abcd\t%4\t6000\t${SOCKET}`,
    "garbage line",
    `bad\t3\t7000\t${SOCKET}`,
  ].join("\n");
  const parents = new Map([[5000, 1], [6000, 1], [6100, 6000], [6200, 6100], [9000, 1]]);
  const deps = (run: HostedReadDeps["run"] = async () => ({ text: listing, stderr: "", exitCode: 0, timedOut: false })): HostedReadDeps => ({
    tmux: SERVER,
    run,
    parents: async () => parents,
  });

  test("panes parse; malformed lines are skipped", () => {
    expect(parseHostedPanes(listing)).toEqual([
      { session: "claude-conch-7k2f", pane: "%3", panePid: 5000, socket: SOCKET },
      { session: "codex-web-abcd", pane: "%4", panePid: 6000, socket: SOCKET },
    ]);
  });

  test("a process is in the pane whose process is it or an ancestor", () => {
    const panes = parseHostedPanes(listing);
    expect(paneHostingPid(5000, panes, parents)?.pane).toBe("%3");
    expect(paneHostingPid(6200, panes, parents)?.pane).toBe("%4");
    expect(paneHostingPid(9000, panes, parents)).toBeNull();
    // A loop in a bad table ends.
    expect(paneHostingPid(42, panes, new Map([[42, 43], [43, 42]]))).toBeNull();
  });

  test("a daemon that remembers nothing finds every hosted session from tmux alone", async () => {
    const sessions = [
      { sessionId: "a", pid: 5000 },
      { sessionId: "b", pid: 6200 },
      { sessionId: "in-terminal", pid: 9000 },
      { sessionId: "no-pid" },
    ];
    const found = await readHostedTerminals(sessions, deps());
    expect([...found.keys()].sort()).toEqual(["a", "b"]);
    expect(found.get("a")).toEqual({ tmux: TMUX, socket: SOCKET, session: "claude-conch-7k2f", pane: "%3" });
    expect(found.get("b")?.session).toBe("codex-web-abcd");
  });

  test("no server, or no tmux, is nothing hosted, and nothing is asked twice for nothing", async () => {
    let asked = 0;
    const none = await readHostedTerminals([{ sessionId: "a", pid: 5000 }], deps(async () => {
      asked += 1;
      return { text: "", stderr: "no server running", exitCode: 1, timedOut: false };
    }));
    expect(none.size).toBe(0);
    expect(asked).toBe(1);
    expect((await readHostedTerminals([{ sessionId: "a", pid: 5000 }], { ...deps(), tmux: null })).size).toBe(0);
    let spawned = 0;
    await readHostedTerminals([{ sessionId: "x" }], deps(async () => { spawned += 1; return { text: listing, stderr: "", exitCode: 0, timedOut: false }; }));
    expect(spawned).toBe(0);
  });

  test("the daemon's cache reads tmux again when the sessions change, when told, or after a few seconds", async () => {
    let reads = 0;
    let now = 1_000;
    const cache = new HostedTerminalCache(deps(async () => { reads += 1; return { text: listing, stderr: "", exitCode: 0, timedOut: false }; }), () => now, 3_000);
    const sessions = [{ sessionId: "a", pid: 5000 }];
    expect((await cache.refresh(sessions)).get("a")?.pane).toBe("%3");
    await cache.refresh(sessions);
    expect(reads).toBe(1);
    await cache.refresh([...sessions, { sessionId: "b", pid: 6200 }]);
    expect(reads).toBe(2);
    expect(cache.get("b")?.pane).toBe("%4");
    cache.invalidate();
    await cache.refresh([...sessions, { sessionId: "b", pid: 6200 }]);
    expect(reads).toBe(3);
    now += 3_000;
    await cache.refresh([...sessions, { sessionId: "b", pid: 6200 }]);
    expect(reads).toBe(4);
  });
});

describe("closing a hosted session", () => {
  const identity: ProcessIdentity = { pid: 5000, birth: "b", birthTimeMs: 1, executable: "/opt/homebrew/bin/claude", ttyDevice: 12 };
  const pane = { pane: "%3", tmux: SERVER };

  test("Ctrl-D, twice for Claude inside its window, with send-keys into its pane; then the pid goes", async () => {
    const ran: string[] = [];
    let alive = true;
    await closeHostedSession(5000, pane, {
      expectedIdentity: identity,
      backend: "claude",
      processIdentity: () => identity,
      runTmux: async (argv) => {
        ran.push(argv.join(" "));
        if (ran.filter((line) => line.endsWith("C-d")).length === 2) alive = false;
        return { exitCode: 0, timedOut: false };
      },
      sleep: async (ms) => { ran.push(`sleep ${ms}`); },
      pidIsAlive: async () => alive,
    });
    expect(ran.slice(0, 3)).toEqual([`${SERVER.join(" ")} send-keys -t %3 C-d`, "sleep 150", `${SERVER.join(" ")} send-keys -t %3 C-d`]);
  });

  test("never types into a pid that isn't the one conch bound", async () => {
    const ran: string[] = [];
    await expect(closeHostedSession(5000, pane, {
      expectedIdentity: identity,
      backend: "claude",
      processIdentity: () => ({ ...identity, birth: "reused" }),
      runTmux: async (argv) => { ran.push(argv.join(" ")); return { exitCode: 0, timedOut: false }; },
    })).rejects.toThrow("identity changed");
    expect(ran).toEqual([]);
  });

  test("a send-keys tmux refused is a close that didn't happen", async () => {
    await expect(closeHostedSession(5000, pane, {
      expectedIdentity: identity,
      backend: "claude",
      processIdentity: () => identity,
      runTmux: async () => ({ exitCode: 1, timedOut: false }),
    })).rejects.toThrow("didn't take the Ctrl-D");
  });

  test("closeSession takes the hosted route for a pid in conch's server, and never Terminal's", async () => {
    const ran: string[] = [];
    await closeSession({ pid: 5000, processIdentity: identity, backend: "claude" }, {
      findHostedPane: async () => pane,
      processIdentity: () => identity,
      runTmux: async (argv) => { ran.push(argv.join(" ")); return { exitCode: 0, timedOut: false }; },
      sleep: async () => {},
      pidIsAlive: async () => false,
      spawn: () => { throw new Error("Terminal is never scripted for a hosted session"); },
    });
    expect(ran).toEqual([`${SERVER.join(" ")} send-keys -t %3 C-d`, `${SERVER.join(" ")} send-keys -t %3 C-d`]);
  });
});
