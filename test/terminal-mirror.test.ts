import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRuntimeControlMessage, createControlServer, type ControlServer, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import type { UICommandResult } from "../src/pasteboard.ts";
import {
  isControlMessageCandidate,
  sendControlMessage,
  validateControlMessage,
  validateControlResponse,
  validateRuntimeControlMessage,
} from "../src/settings.ts";
import {
  createTerminalMirror,
  defaultTerminalMirrorDeps,
  HOST_RETRY_MS,
  NO_PROCESS,
  NOT_IN_TERMINAL,
  paneForPid,
  parseTerminalLocate,
  parseTmuxCapture,
  terminalFocusScript,
  terminalLocateScript,
  tmuxCaptureArgv,
  UNKNOWN_SESSION,
  type TerminalMirrorDeps,
} from "../src/terminal-mirror.ts";

/**
 * The Terminal tab's daemon half: where a session's agent is running and what its terminal shows, read without
 * touching focus. Everything below runs against fakes except the last block, which captures a real pane in a tmux
 * server of its own (`-L`), never the default one a live session might be in.
 */

const done = (text: string, exitCode = 0, stderr = ""): UICommandResult => ({ text, stderr, exitCode, timedOut: false });
const failed = (stderr = ""): UICommandResult => ({ text: "", stderr, exitCode: 1, timedOut: false });

/** A fake Mac: a tmux server with the panes given (or none), `ps`, and Terminal's AppleScript. */
function fakeMac(options: {
  panes?: string;
  processes?: string;
  tty?: string;
  capture?: (argv: string[]) => UICommandResult;
  locate?: (script: string) => UICommandResult;
  focus?: (script: string) => UICommandResult;
  clients?: string;
  now?: () => number;
} = {}) {
  const calls: string[][] = [];
  const scripts: string[] = [];
  const focused: string[] = [];
  let transactions = 0;
  const deps: TerminalMirrorDeps = {
    tmux: ["tmux", "-L", "fake"],
    now: options.now ?? (() => 1_000_000),
    async run(argv) {
      calls.push(argv);
      if (argv[3] === "list-panes") return options.panes === undefined ? failed("no server running") : done(options.panes);
      if (argv[0] === "ps" && argv[1] === "-A") return done(options.processes ?? "");
      if (argv[0] === "ps" && argv[1] === "-o") return done(options.tty ?? "??");
      if (argv[3] === "display-message" && argv.includes("capture-pane")) return options.capture?.(argv) ?? failed("can't find pane");
      if (argv[3] === "display-message") return done("$3\n");
      if (argv[3] === "list-clients") return done(options.clients ?? "");
      if (argv[3] === "select-window") return done("");
      return failed(`unexpected ${argv.join(" ")}`);
    },
    async osa(script) {
      scripts.push(script);
      return options.locate?.(script) ?? done("conch:notfound\n");
    },
    async focusOsa(script) {
      focused.push(script);
      return options.focus?.(script) ?? done("ok\n");
    },
    async transaction(work) {
      transactions += 1;
      return work();
    },
  };
  return { deps, calls, scripts, focused, transactions: () => transactions };
}

const SCREEN = "\u001b[38;2;215;119;87m╭───╮\u001b[39m\n│ > │\n";
const tmuxMac = (extra: Parameters<typeof fakeMac>[0] = {}) => fakeMac({
  panes: "700 %4\n500 %7\n",
  // 900 (claude) ← 800 (zsh) ← 500 (the pane's shell)
  processes: "  900   800\n  800   500\n  500     1\n  700     1\n",
  capture: () => done(`120 40 3 38 1 0\n${SCREEN}`),
  ...extra,
});

describe("reading a tmux pane", () => {
  test("the pane is the one whose process is an ancestor of the session's, and its screen comes with its size", async () => {
    const mac = tmuxMac();
    const reply = await createTerminalMirror(mac.deps).screen("s1", { pid: 900 });
    expect(reply).toEqual({
      kind: "terminal-screen", sessionId: "s1", host: "tmux", pane: "%7", columns: 120, rows: 40,
      cursor: { x: 3, y: 38 }, screen: SCREEN,
    });
    // One tmux call for the size and the screen together, with `;` as its own argument.
    const capture = mac.calls.find((argv) => argv.includes("capture-pane"))!;
    expect(capture).toEqual(tmuxCaptureArgv(["tmux", "-L", "fake"], "%7"));
    expect(capture.slice(capture.indexOf(";") + 1)).toEqual(["capture-pane", "-p", "-e", "-N", "-t", "%7"]);
  });

  test("a found pane is kept, so a read every few hundred milliseconds is ONE tmux call", async () => {
    const mac = tmuxMac();
    const mirror = createTerminalMirror(mac.deps);
    await mirror.screen("s1", { pid: 900 });
    const before = mac.calls.length;
    await mirror.screen("s1", { pid: 900 });
    await mirror.screen("s1", { pid: 900 });
    expect(mac.calls.slice(before).map((argv) => argv[3] ?? argv[0])).toEqual(["display-message", "display-message"]);
  });

  test("a pane that has gone is looked for again, once", async () => {
    let captures = 0;
    const mac = tmuxMac({ capture: () => (captures++ === 0 ? failed("can't find pane: %7") : done(`80 24 0 0 0 1\nhello\n`)) });
    const reply = await createTerminalMirror(mac.deps).screen("s1", { pid: 900 });
    expect(reply).toMatchObject({ host: "tmux", pane: "%7", columns: 80, rows: 24, alternate: true, screen: "hello\n" });
    expect(reply).not.toHaveProperty("cursor");
    expect(mac.calls.filter((argv) => argv[3] === "list-panes")).toHaveLength(2);
  });

  test("the capture's first line is the size line, and nothing else is taken for one", () => {
    expect(parseTmuxCapture("100 34 0 33 1 0\nline one\nline two\n")).toEqual({
      columns: 100, rows: 34, cursor: { x: 0, y: 33 }, alternate: false, screen: "line one\nline two\n",
    });
    // A hidden cursor (Claude Code draws its own) is no cursor.
    expect(parseTmuxCapture("100 34 5 5 0 0\n")).toMatchObject({ screen: "" });
    expect(parseTmuxCapture("100 34 5 5 0 0\n")).not.toHaveProperty("cursor");
    // One off the edge (a pane resized under it) is dropped, not drawn outside the grid.
    expect(parseTmuxCapture("100 34 100 5 1 0\nx")).not.toHaveProperty("cursor");
    expect(parseTmuxCapture("hello world\n")).toBeNull();
    expect(parseTmuxCapture("0 34 0 0 1 0\n")).toBeNull();
    expect(parseTmuxCapture("100 34 0 0 1\n")).toBeNull();
  });

  test("the pane is found through the process tree, however deep, and not through a stranger's", () => {
    const panes = "500 %1\n600 %2";
    expect(paneForPid(903, panes, "903 902\n902 901\n901 600\n600 1\n500 1")).toBe("%2");
    expect(paneForPid(600, panes, "600 1")).toBe("%2");
    expect(paneForPid(42, panes, "42 41\n41 1")).toBeNull();
    // A cycle in a bogus table ends rather than spinning.
    expect(paneForPid(7, panes, "7 8\n8 7")).toBeNull();
    expect(paneForPid(7, "", "7 500")).toBeNull();
  });
});

describe("reading a Terminal.app tab", () => {
  const located = (text?: string) => done(`4242\tfalse\ttrue${text === undefined ? "" : `\n${text}`}\n`);

  test("no tmux: the tty's Terminal window, by the id the window server knows it by", async () => {
    const mac = fakeMac({ tty: "ttys012\n", locate: () => located() });
    const reply = await createTerminalMirror(mac.deps).screen("s2", { pid: 321 });
    expect(reply).toEqual({ kind: "terminal-screen", sessionId: "s2", host: "terminal", tty: "ttys012", window: 4242, minimized: false, selected: true });
    expect(mac.scripts).toEqual([terminalLocateScript("ttys012", false)]);
  });

  test("its text only when asked, since only the tab's fallback wants it", async () => {
    const mac = fakeMac({ tty: "ttys012", locate: (script) => located(script.includes("contents of tab") ? "$ claude\n> hi" : undefined) });
    const mirror = createTerminalMirror(mac.deps);
    expect(await mirror.screen("s2", { pid: 321 })).not.toHaveProperty("text");
    expect(await mirror.screen("s2", { pid: 321 }, { text: true })).toMatchObject({ host: "terminal", text: "$ claude\n> hi" });
  });

  test("a tty no Terminal tab has (iTerm, an editor's terminal) is said plainly", async () => {
    const mac = fakeMac({ tty: "ttys030", locate: () => done("conch:notfound\n") });
    expect(await createTerminalMirror(mac.deps).screen("s2", { pid: 321 }))
      .toEqual({ kind: "terminal-screen", sessionId: "s2", host: "none", reason: NOT_IN_TERMINAL });
  });

  test("Automation refused names Automation", async () => {
    const mac = fakeMac({ tty: "ttys012", locate: () => failed("execution error: Not authorized to send Apple events to Terminal. (-1743)") });
    expect(await createTerminalMirror(mac.deps).screen("s2", { pid: 321 }))
      .toMatchObject({ host: "none", reason: "conch isn't allowed to control Terminal: allow conch in Automation." });
  });

  test("the script never opens Terminal to ask it, and never changes anything", () => {
    const script = terminalLocateScript("ttys012", true);
    // The first thing it does, before anything is told to Terminal.
    expect(script.trim().split("\n")[0]).toBe('if application "Terminal" is not running then return "conch:notrunning"');
    expect(script.split('tell application "Terminal"')).toHaveLength(2);
    expect(script).toContain('if tty of tab ti of window wi is "/dev/ttys012" then');
    expect(script).toContain("id of window wi");
    // `tab` inside Terminal's tell names its tab class, so the separator is spelled out.
    expect(script).toContain("character id 9");
    expect(script).not.toMatch(/activate|set index|set selected|AXRaise|miniaturized of window wi to/);
    expect(terminalLocateScript("ttys012", false)).not.toContain("contents of tab");
    expect(() => terminalLocateScript('ttys1" then do shell script "x', false)).toThrow();
  });

  test("Terminal's answer is read strictly", () => {
    expect(parseTerminalLocate("17\ttrue\tfalse\n")).toEqual({ window: 17, minimized: true, selected: false });
    expect(parseTerminalLocate("17\tfalse\ttrue\nline 1\nline 2\n")).toEqual({ window: 17, minimized: false, selected: true, text: "line 1\nline 2" });
    expect(parseTerminalLocate("conch:notrunning\n")).toBe("notrunning");
    expect(parseTerminalLocate("conch:notfound\n")).toBe("notfound");
    expect(parseTerminalLocate("window 17\n")).toBeNull();
    expect(parseTerminalLocate("17\tyes\ttrue\n")).toBeNull();
  });
});

describe("a session with no terminal asks nothing of the Mac", () => {
  for (const [name, session, reason] of [
    ["the practice session, or a closed Codex thread", { noTerminal: "The practice turn is conch's own. There's no terminal behind it." }, "The practice turn is conch's own. There's no terminal behind it."],
    ["a session with no known process", {}, NO_PROCESS],
    ["a session the daemon doesn't know", undefined, UNKNOWN_SESSION],
  ] as const) {
    test(name, async () => {
      const mac = tmuxMac();
      const mirror = createTerminalMirror(mac.deps);
      expect(await mirror.screen("s3", session as never)).toEqual({ kind: "terminal-screen", sessionId: "s3", host: "none", reason });
      expect(await mirror.focus("s3", session as never)).toEqual({ kind: "terminal-focus", sessionId: "s3", focused: false, reason });
      expect(mac.calls).toEqual([]);
      expect(mac.scripts).toEqual([]);
      expect(mac.focused).toEqual([]);
    });
  }

  test("a tty is believed for a while too, then tmux is looked for again", async () => {
    let now = 0;
    const mac = fakeMac({ tty: "ttys012", locate: () => done("9\tfalse\ttrue\n"), now: () => now });
    const mirror = createTerminalMirror(mac.deps);
    await mirror.screen("s4", { pid: 56 });
    const looked = mac.calls.filter((argv) => argv[3] === "list-panes").length;
    now += HOST_RETRY_MS - 1;
    await mirror.screen("s4", { pid: 56 });
    expect(mac.calls.filter((argv) => argv[3] === "list-panes").length).toBe(looked);
    now += 2;
    await mirror.screen("s4", { pid: 56 });
    expect(mac.calls.filter((argv) => argv[3] === "list-panes").length).toBe(looked + 1);
  });

  test("nothing found is believed for a while, then looked for again", async () => {
    let now = 0;
    const mac = fakeMac({ now: () => now });
    const mirror = createTerminalMirror(mac.deps);
    expect(await mirror.screen("s4", { pid: 55 })).toMatchObject({ host: "none", reason: NOT_IN_TERMINAL });
    const looked = mac.calls.length;
    now += HOST_RETRY_MS - 1;
    await mirror.screen("s4", { pid: 55 });
    expect(mac.calls.length).toBe(looked);
    now += 2;
    await mirror.screen("s4", { pid: 55 });
    expect(mac.calls.length).toBeGreaterThan(looked);
  });
});

describe("reading is view-only", () => {
  test("no read focuses, raises or joins the typing queue", async () => {
    const tmux = tmuxMac();
    const terminal = fakeMac({ tty: "ttys012", locate: () => done("9\tfalse\ttrue\n") });
    for (const mac of [tmux, terminal]) {
      const mirror = createTerminalMirror(mac.deps);
      for (let i = 0; i < 3; i++) await mirror.screen("s", { pid: 900 }, { text: true });
      expect(mac.focused).toEqual([]);
      expect(mac.transactions()).toBe(0);
      expect(mac.calls.some((argv) => argv.includes("select-window") || argv.includes("select-pane"))).toBe(false);
    }
  });

  test("the reads run in the mirror's own command scope, never the typing paths'", () => {
    const source = readFileSync(join(import.meta.dir, "../src/terminal-mirror.ts"), "utf8");
    const defaults = source.slice(source.indexOf("export function defaultTerminalMirrorDeps"), source.indexOf("/**\n * Terminal's window and tab"));
    expect(defaults).toContain("run: (argv) => runUICommand(argv, undefined, { scope: mirrorScope, timeoutMs: 2_000 })");
    expect(defaults).toContain("osa: (script) => runUICommand(osaArgv(script), undefined, { scope: mirrorScope, timeoutMs: 3_000 })");
    // Only the press shares the typing paths' scope and queue.
    expect(defaults).toContain("focusOsa: (script) => runUICommand(osaArgv(script), undefined, { timeoutMs: 4_000 })");
    expect(defaults).toContain("transaction: withUITransaction");
  });
});

describe("Open in Terminal", () => {
  test("a Terminal tab: out of the Dock, its tab selected, its window first, Terminal active — in the UI queue", async () => {
    const mac = fakeMac({ tty: "ttys012", locate: () => done("9\tfalse\ttrue\n") });
    expect(await createTerminalMirror(mac.deps).focus("s5", { pid: 321 })).toEqual({ kind: "terminal-focus", sessionId: "s5", focused: true });
    expect(mac.transactions()).toBe(1);
    expect(mac.focused).toEqual([terminalFocusScript("ttys012")]);
    const script = mac.focused[0]!;
    for (const line of ["if miniaturized of w then set miniaturized of w to false", "set selected tab of w to t", "set index of w to 1", "activate"]) {
      expect(script).toContain(line);
    }
    expect(script.trim().split("\n")[0]).toBe('if application "Terminal" is not running then return "conch:notrunning"');
  });

  test("a tmux pane: its window and pane selected, then the terminal its newest client is in", async () => {
    const mac = tmuxMac({ clients: "1700000000 /dev/ttys040\n1700000500 /dev/ttys041\n" });
    expect(await createTerminalMirror(mac.deps).focus("s6", { pid: 900 })).toMatchObject({ focused: true });
    expect(mac.calls).toContainEqual(["tmux", "-L", "fake", "list-clients", "-t", "$3", "-F", "#{client_activity} #{client_tty}"]);
    expect(mac.calls).toContainEqual(["tmux", "-L", "fake", "select-window", "-t", "%7", ";", "select-pane", "-t", "%7"]);
    expect(mac.focused).toEqual([terminalFocusScript("ttys041")]);
  });

  test("a client on something that isn't a tty is refused in words, and nothing is scripted with it", async () => {
    const mac = tmuxMac({ clients: "1700000000 /dev/cu.debug-console\n" });
    expect(await createTerminalMirror(mac.deps).focus("s6", { pid: 900 }))
      .toEqual({ kind: "terminal-focus", sessionId: "s6", focused: false, reason: NOT_IN_TERMINAL });
    expect(mac.focused).toEqual([]);
  });

  test("the process tree is walked as deep as a real one goes", () => {
    const chain = Array.from({ length: 30 }, (_, i) => `${1000 + i} ${1001 + i}`).join("\n") + "\n1030 500\n500 1";
    expect(paneForPid(1000, "500 %9", chain)).toBe("%9");
  });

  test("a tmux session nothing is attached to says so, and brings nothing forward", async () => {
    const mac = tmuxMac({ clients: "" });
    expect(await createTerminalMirror(mac.deps).focus("s6", { pid: 900 }))
      .toEqual({ kind: "terminal-focus", sessionId: "s6", focused: false, reason: "No terminal window is attached to this session's tmux." });
    expect(mac.focused).toEqual([]);
  });

  test("a window Terminal can't find is a refusal in words", async () => {
    const mac = fakeMac({ tty: "ttys012", focus: () => done("conch:notfound\n") });
    expect(await createTerminalMirror(mac.deps).focus("s7", { pid: 321 }))
      .toMatchObject({ focused: false, reason: "conch couldn't find this session's Terminal window." });
  });
});

describe("on the wire", () => {
  test("both requests are control messages, validated at the one boundary", () => {
    for (const kind of ["terminal-screen", "terminal-focus"]) expect(isControlMessageCandidate({ kind })).toBe(true);
    expect(validateRuntimeControlMessage({ kind: "terminal-screen", sessionId: " s1 " }))
      .toEqual({ ok: true, value: { kind: "terminal-screen", sessionId: "s1" } });
    expect(validateRuntimeControlMessage({ kind: "terminal-screen", sessionId: "s1", text: true }))
      .toEqual({ ok: true, value: { kind: "terminal-screen", sessionId: "s1", text: true } });
    expect(validateRuntimeControlMessage({ kind: "terminal-screen", sessionId: "s1", text: "yes" }))
      .toEqual({ ok: false, err: "terminal-screen: text must be true when present" });
    expect(validateRuntimeControlMessage({ kind: "terminal-focus", sessionId: "" })).toMatchObject({ ok: false });
    expect(validateRuntimeControlMessage({ kind: "terminal-focus", sessionId: "s1", pid: 1 }))
      .toEqual({ ok: true, value: { kind: "terminal-focus", sessionId: "s1" } });
    expect(validateControlMessage({ kind: "terminal-focus", sessionId: "s1" })).toMatchObject({ ok: true });
  });

  test("the replies parse, and a malformed one doesn't", () => {
    const tmux = { kind: "terminal-screen", sessionId: "s", host: "tmux", pane: "%1", columns: 80, rows: 24, cursor: { x: 1, y: 2 }, screen: "x" } as const;
    expect(validateControlResponse(tmux)).toEqual({ ok: true, value: tmux });
    const terminal = { kind: "terminal-screen", sessionId: "s", host: "terminal", tty: "ttys001", window: 5, minimized: false, selected: true, text: "t" } as const;
    expect(validateControlResponse(terminal)).toEqual({ ok: true, value: terminal });
    expect(validateControlResponse({ kind: "terminal-screen", sessionId: "s", host: "none", reason: "r" })).toMatchObject({ ok: true });
    expect(validateControlResponse({ ...tmux, columns: -1 })).toEqual({ ok: false, err: "invalid terminal-screen response" });
    expect(validateControlResponse({ ...terminal, window: "5" })).toEqual({ ok: false, err: "invalid terminal-screen response" });
    expect(validateControlResponse({ kind: "terminal-screen", sessionId: "s", host: "iterm" })).toMatchObject({ ok: false });
    expect(validateControlResponse({ kind: "terminal-focus", sessionId: "s", focused: false, reason: "r" })).toMatchObject({ ok: true });
    expect(validateControlResponse({ kind: "terminal-focus", sessionId: "s" })).toMatchObject({ ok: false });
  });

  test("a daemon without the mirror says so rather than failing", async () => {
    const bare = {} as RuntimeControlDispatchOptions;
    expect(await applyRuntimeControlMessage({ kind: "terminal-screen", sessionId: "s" }, bare))
      .toEqual({ kind: "terminal-screen", sessionId: "s", host: "none", reason: "This conch can't mirror terminals." });
    expect(await applyRuntimeControlMessage({ kind: "terminal-focus", sessionId: "s" }, bare))
      .toMatchObject({ kind: "terminal-focus", focused: false });
  });

  const servers: ControlServer[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("over a real socket, asked by session id alone, answered by the daemon's own record of it", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-mirror-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const mac = tmuxMac();
    const mirror = createTerminalMirror(mac.deps);
    const known = new Map([["s1", { pid: 900 }]]);
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: false }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: (message) => applyRuntimeControlMessage(message, {
          listResumable: () => ({ sessions: [], complete: true }),
          start: () => {},
          close: () => {},
          report: () => {},
          terminalScreen: (asked) => mirror.screen(asked.sessionId, known.get(asked.sessionId), asked.text ? { text: true } : {}),
          terminalFocus: (asked) => mirror.focus(asked.sessionId, known.get(asked.sessionId)),
        }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    const reply = await sendControlMessage(socketPath, { kind: "terminal-screen", sessionId: "s1" }, 2_000);
    expect(reply).toEqual({ ok: true, response: {
      kind: "terminal-screen", sessionId: "s1", host: "tmux", pane: "%7", columns: 120, rows: 40, cursor: { x: 3, y: 38 }, screen: SCREEN,
    } });
    const stranger = await sendControlMessage(socketPath, { kind: "terminal-screen", sessionId: "nobody" }, 2_000);
    expect(stranger).toEqual({ ok: true, response: { kind: "terminal-screen", sessionId: "nobody", host: "none", reason: UNKNOWN_SESSION } });
  });

  test("the daemon keys it on its own session record, never a pid the asker sends", () => {
    const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
    expect(daemon).toContain("terminalScreen: (message) => terminalMirror.screen(message.sessionId, panelSessions.get(message.sessionId), message.text ? { text: true } : {}),");
    expect(daemon).toContain("const focused = await terminalMirror.focus(message.sessionId, panelSessions.get(message.sessionId));");
  });
});

/** A real tmux server of this test's own, so what tmux actually emits is what is parsed. */
const tmuxPath = Bun.which("tmux");
describe.skipIf(!tmuxPath)("a real tmux pane", () => {
  const socket = `conch-mirror-test-${process.pid}`;
  const tmux = [tmuxPath!, "-L", socket];
  let socketPath = "";
  afterAll(() => {
    Bun.spawnSync([...tmux, "kill-server"], { stderr: "ignore", stdout: "ignore" });
    // tmux leaves its socket file behind; this test's own, named for it, goes too.
    if (socketPath.endsWith(`/${socket}`)) rmSync(socketPath, { force: true });
  });

  test("its colours come back exactly, with its size, from a pane found by process", async () => {
    // The ✻ as octal escapes: tmux escapes a command line's non-ASCII (`\u273B`) when the client starting it is Bun.
    const draw = String.raw`printf '\033[38;2;215;119;87m\342\234\273 Welcome\033[0m \033[1mbold\033[0m \033[48;2;34;92;43m+ added \033[0m\n\033[36mcyan\033[39m \033[38;5;245mgrey\033[39m\n'; sleep 30`;
    const started = Bun.spawnSync([...tmux, "new-session", "-d", "-s", "mirror", "-x", "90", "-y", "12", "bash", "-c", draw]);
    expect(started.exitCode).toBe(0);
    socketPath = Bun.spawnSync([...tmux, "display-message", "-p", "#{socket_path}"]).stdout.toString().trim();
    const panePid = Number(Bun.spawnSync([...tmux, "display-message", "-p", "-t", "mirror", "#{pane_pid}"]).stdout.toString().trim());
    expect(panePid).toBeGreaterThan(1);
    const mirror = createTerminalMirror({ ...defaultTerminalMirrorDeps(), tmux });
    let reply = await mirror.screen("real", { pid: panePid });
    for (let tries = 0; tries < 20 && !(reply.host === "tmux" && reply.screen.includes("grey")); tries++) {
      await Bun.sleep(100);
      reply = await mirror.screen("real", { pid: panePid });
    }
    expect(reply).toMatchObject({ host: "tmux", columns: 90, rows: 12 });
    if (reply.host !== "tmux") throw new Error("not tmux");
    expect(reply.pane).toMatch(/^%\d+$/);
    const lines = reply.screen.split("\n");
    expect(lines[0]).toContain("\u001b[38;2;215;119;87m✻ Welcome");
    expect(lines[0]).toContain("\u001b[1mbold");
    expect(lines[0]).toContain("\u001b[48;2;34;92;43m+ added");
    expect(lines[1]).toContain("\u001b[36mcyan");
    expect(lines[1]).toContain("\u001b[38;5;245mgrey");
    // -N: a row keeps the spaces its background colours.
    expect(lines.length).toBeGreaterThanOrEqual(12);
  });
});
