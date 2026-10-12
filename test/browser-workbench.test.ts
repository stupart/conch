import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addBrowserProfile,
  browserProfilesPath,
  checkBrowserProfileName,
  DEFAULT_BROWSER_PROFILE,
  findBrowserProfile,
  readBrowserProfiles,
  type BrowserProfile,
} from "../src/browser-profiles.ts";
import {
  BROWSER_APP_DOWN,
  BROWSER_KINDS,
  BROWSER_TABS_PER_SESSION,
  BrowserWorkbench,
  browserTabsPath,
  createBrowserService,
  decodeBrowserMessage,
  fileTabStore,
  BROWSER_CLI_USAGE,
  requestBrowser,
  runBrowserCli,
  withBrowserState,
  type BrowserMessage,
  type BrowserTab,
} from "../src/browser-workbench.ts";
import { decodeBrowserOpenRequest } from "../src/browser-open.ts";
import { sessionForCallerPid, type CallerBinding } from "../src/caller-session.ts";
import { appServerNoTerminal } from "../src/codex-threads.ts";
import { createControlServer, type ControlApplication } from "../src/control-server.ts";
import { captureFolder } from "../src/page-capture.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import type { SessionInfo } from "../src/sessions.ts";

/**
 * The Workbench's daemon half (src/browser-workbench.ts, browser-profiles.ts, caller-session.ts): the profiles, the
 * control messages and who may send them, the command channel to the Mac app (driven here by a pretend app over a real
 * control socket), and how agent B's `open` finds the session that ran it. The app's page script is held to the rules
 * about secrets in workbench-script.test.ts; the MCP tools in mcp.test.ts.
 */

const scratch = mkdtempSync(join(tmpdir(), "conch-workbench-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fresh = (name: string) => mkdtempSync(join(scratch, `${name}-`));
const WORK = "7d4e1c2a-9b3f-4a5e-8c6d-0f1e2d3c4b5a";

/** A real PNG header (the daemon reads the size from it), then filler. */
function pngBytes(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

describe("browser profiles: one per account, the default built in", () => {
  test("with no file there is the default alone, which is the review pane's store", () => {
    const file = join(fresh("p"), "browser-profiles.json");
    expect(readBrowserProfiles(file)).toEqual([{ id: "default", name: "Default" }]);
    expect(DEFAULT_BROWSER_PROFILE).toEqual({ id: "default", name: "Default" });
  });

  test("add makes a UUID profile, stored without the default, its owner's alone", () => {
    const file = join(fresh("p"), "conf", "browser-profiles.json");
    const added = addBrowserProfile("  Work ", file, () => WORK.toUpperCase());
    expect(added).toEqual({ added: true, profile: { id: WORK, name: "Work" }, profiles: [{ id: "default", name: "Default" }, { id: WORK, name: "Work" }] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ id: WORK, name: "Work" }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readBrowserProfiles(file)).toEqual(added.profiles);
  });

  test("add is idempotent by name, ignoring case, and the default's name is the default", () => {
    const file = join(fresh("p"), "browser-profiles.json");
    let minted = 0;
    const mint = () => { minted += 1; return crypto.randomUUID(); };
    const first = addBrowserProfile("Work", file, mint);
    const again = addBrowserProfile("WORK", file, mint);
    expect(again).toEqual({ added: false, profile: first.profile, profiles: first.profiles });
    expect(addBrowserProfile("default", file, mint)).toMatchObject({ added: false, profile: { id: "default", name: "Default" } });
    expect(minted).toBe(1);
    expect(readBrowserProfiles(file)).toHaveLength(2);
  });

  test("a name is 1-60 printable characters on one line", () => {
    expect(checkBrowserProfileName("Personal")).toEqual({ ok: true, name: "Personal" });
    expect(checkBrowserProfileName("é".repeat(60))).toMatchObject({ ok: true });
    for (const bad of ["", "   ", "x".repeat(61), "Work\nPersonal", "tab\there", "bell\u0007", "line sep", 42, null]) {
      expect(checkBrowserProfileName(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "a profile's name must be 1–60 printable characters" });
    }
    expect(() => addBrowserProfile("", join(fresh("p"), "x.json"))).toThrow("printable");
  });

  test("a hand-edited file never takes the browser away: bad entries are skipped, the default is always first", () => {
    const file = join(fresh("p"), "browser-profiles.json");
    writeFileSync(file, "{not json");
    expect(readBrowserProfiles(file)).toEqual([{ id: "default", name: "Default" }]);
    writeFileSync(file, JSON.stringify([
      { id: WORK, name: "Work" },
      { id: WORK, name: "Again" },
      { id: "default", name: "Mine" },
      { id: "not-a-uuid", name: "Bad" },
      { id: crypto.randomUUID(), name: "work" },
      { id: crypto.randomUUID(), name: "" },
      "nope",
    ]));
    expect(readBrowserProfiles(file)).toEqual([{ id: "default", name: "Default" }, { id: WORK, name: "Work" }]);
  });

  test("CONCH_CONFIG_DIR moves the file, as it moves the accounts'", () => {
    const before = process.env.CONCH_CONFIG_DIR;
    process.env.CONCH_CONFIG_DIR = "/tmp/conch-config-elsewhere";
    try {
      expect(browserProfilesPath()).toBe("/tmp/conch-config-elsewhere/browser-profiles.json");
      expect(browserTabsPath()).toBe("/tmp/conch-config-elsewhere/browser-tabs.json");
    } finally {
      if (before === undefined) delete process.env.CONCH_CONFIG_DIR;
      else process.env.CONCH_CONFIG_DIR = before;
    }
  });

  test("a profile is named by id or by name, ignoring case", () => {
    const profiles = [{ ...DEFAULT_BROWSER_PROFILE }, { id: WORK, name: "Work" }];
    expect(findBrowserProfile(profiles, "work")?.id).toBe(WORK);
    expect(findBrowserProfile(profiles, WORK.toUpperCase())?.name).toBe("Work");
    expect(findBrowserProfile(profiles, "Default")?.id).toBe("default");
    expect(findBrowserProfile(profiles, "Personal")).toBeUndefined();
  });
});

describe("the control messages, checked field by field, and the phone's to send none of them", () => {
  test("each kind decodes to its shape", () => {
    expect(decodeBrowserMessage({ kind: "browser-profiles", action: "list" })).toEqual({ kind: "browser-profiles", action: "list" });
    expect(decodeBrowserMessage({ kind: "browser-profiles", action: "add", name: "Work" })).toEqual({ kind: "browser-profiles", action: "add", name: "Work" });
    // agent B's, by its own decoder (browser-open.ts); this one leaves it alone.
    expect(decodeBrowserOpenRequest({ kind: "browser-open", url: "https://accounts.google.com/o/oauth2", callerPid: 4242, profile: "Work" }))
      .toEqual({ kind: "browser-open", url: "https://accounts.google.com/o/oauth2", callerPid: 4242, profile: "Work" });
    expect(decodeBrowserMessage({ kind: "browser-open", url: "https://acme.dev", callerPid: 4242 })).toBeNull();
    expect(decodeBrowserMessage({ kind: "browser-command", sessionId: "s1", op: "type", tab: "tab-1a2b3c4d", target: "Email", text: "a@b.c", submit: true, extra: 1 }))
      .toEqual({ kind: "browser-command", sessionId: "s1", op: "type", tab: "tab-1a2b3c4d", target: { auto: "Email" }, text: "a@b.c", submit: true });
    expect(decodeBrowserMessage({ kind: "browser-command", sessionId: "s1", op: "click", target: { ref: "e3" } }))
      .toEqual({ kind: "browser-command", sessionId: "s1", op: "click", target: { ref: "e3" } });
    expect(decodeBrowserMessage({ kind: "browser-answer", request: "r1", ack: true })).toEqual({ kind: "browser-answer", request: "r1", ack: true });
    expect(decodeBrowserMessage({ kind: "browser-tab-event", tab: "tab-1a2b3c4d", url: "https://acme.dev/", title: "Acme", closed: true }))
      .toEqual({ kind: "browser-tab-event", tab: "tab-1a2b3c4d", url: "https://acme.dev/", title: "Acme", closed: true });
    expect(decodeBrowserMessage({ kind: "page-capture" })).toBeNull();
    expect(decodeBrowserMessage("browser-open")).toBeNull();
  });

  test("a malformed one is refused with why", () => {
    const refused = (value: unknown) => {
      const decoded = decodeBrowserMessage(value);
      return decoded && "refused" in decoded ? decoded.refused : `not refused: ${JSON.stringify(decoded)}`;
    };
    expect(refused({ kind: "browser-profiles", action: "remove" })).toBe('action must be "list" or "add"');
    expect(refused({ kind: "browser-profiles", action: "add" })).toBe("add needs the profile's name");
    const openRefused = (value: unknown) => (decodeBrowserOpenRequest(value) as { error?: string } | null)?.error;
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x.dev/", "https://", "not a url", "https://a.dev/\n"]) {
      expect(openRefused({ kind: "browser-open", url, callerPid: 4242 }), url).toBe("url must be an http or https link");
    }
    for (const callerPid of [0, 1, -5, 1.5, "4242", undefined]) {
      expect(openRefused({ kind: "browser-open", url: "https://acme.dev", callerPid })).toBe("callerPid must be the calling process's pid");
    }
    expect(refused({ kind: "browser-command", op: "read" })).toBe("browser-command needs its session");
    expect(refused({ kind: "browser-command", sessionId: "s1", op: "eval" })).toContain("op must be one of");
    expect(refused({ kind: "browser-command", sessionId: "s1", op: "close" })).toBe("close names the tab it closes");
    expect(refused({ kind: "browser-command", sessionId: "s1", op: "read", tab: "../x" })).toBe("tab must be a tab's id");
    expect(refused({ kind: "browser-command", sessionId: "s1", op: "click", target: { ref: "e1", text: "x" } })).toContain("exactly one of");
    expect(refused({ kind: "browser-command", sessionId: "s1", op: "type", target: "Email", text: "x".repeat(4001) })).toContain("text must be up to");
    expect(refused({ kind: "browser-tab-event" })).toBe("a tab event names its tab");
  });

  test("every kind is the Mac app's, the CLI's or an agent's on this Mac: a phone sends none, shaped or not", () => {
    const shaped: Record<string, Record<string, unknown>> = {
      "browser-profiles": { action: "add", name: "Work" },
      "browser-open": { url: "https://acme.dev", callerPid: 4242 },
      "browser-command": { sessionId: "s1", op: "read" },
      "browser-answer": { request: "r1", ack: true },
      "browser-tab-event": { tab: "tab-1a2b3c4d", closed: true },
    };
    for (const kind of [...BROWSER_KINDS, "browser-open"]) {
      expect(isMacAppOnlyRequest({ kind, ...shaped[kind] }), kind).toBe(true);
      expect(isMacAppOnlyRequest({ kind, bogus: true }), `${kind} malformed`).toBe(true);
      expect(isMacAppOnlyRequest({ kind: "control-envelope", body: { kind, ...shaped[kind] } }), `${kind} enveloped`).toBe(true);
    }
  });
});

describe("which session ran a process: walked up to the agent, as the MCP server finds its own caller", () => {
  const claude: SessionInfo = { sessionId: "claude-1", pid: 500, backend: "claude" };
  const other: SessionInfo = { sessionId: "claude-2", pid: 600, backend: "claude" };
  // open shim 900 → zsh 800 → claude 500 → Terminal 100 → launchd 1
  const parents = new Map([[900, 800], [800, 500], [500, 100], [100, 1], [950, 700], [700, 650], [650, 1]]);
  const resolve = (pid: unknown, infos: SessionInfo[], read?: (path: string) => Promise<string>) =>
    sessionForCallerPid(pid, { infos, claudeDir: "/virtual/claude", parents: async () => parents, read: read ?? (async () => { throw new Error("no file"); }) });

  test("the nearest session process above the caller is its session", async () => {
    expect(await resolve(900, [claude, other])).toEqual({ status: "verified", session: claude });
    // The agent itself calling.
    expect(await resolve(500, [claude, other])).toEqual({ status: "verified", session: claude });
    // A Codex its Bash tool started is the Codex, not the Claude above it.
    const codex: SessionInfo = { sessionId: "codex-1", pid: 800, backend: "codex" };
    expect(await resolve(900, [claude, codex])).toEqual({ status: "verified", session: codex });
  });

  test("a background session with no pid on its row is found by its registry file", async () => {
    const background: SessionInfo = { sessionId: "bg-1", backend: "claude" };
    const read = async (path: string) => {
      if (path === "/virtual/claude/sessions/700.json") return JSON.stringify({ sessionId: "bg-1" });
      throw new Error("no file");
    };
    expect(await resolve(950, [claude, background], read)).toEqual({ status: "verified", session: background });
    // A file naming a session conch doesn't know is a refusal, not a walk past it.
    const stranger = async (path: string) => (path.endsWith("/700.json") ? JSON.stringify({ sessionId: "gone" }) : Promise.reject(new Error("no")));
    expect(await resolve(950, [claude], stranger)).toEqual({ status: "unverified", reason: "pid 700 (an ancestor of 950) is not a live session conch knows" });
  });

  test("a pid several rows share, or a Codex app-server's, can't say which: refused", async () => {
    const twin: SessionInfo = { sessionId: "claude-1b", pid: 500, backend: "claude" };
    expect(await resolve(900, [claude, twin])).toMatchObject({ status: "unverified", reason: expect.stringContaining("runs 2 sessions") });
    const thread: SessionInfo = { sessionId: "thread-1", backend: "codex", noTerminal: appServerNoTerminal(500) };
    expect(await resolve(900, [thread])).toMatchObject({ status: "unverified", reason: expect.stringContaining("Codex app-server") });
  });

  test("no session above it, or no pid at all: refused", async () => {
    expect(await resolve(950, [claude])).toEqual({ status: "unverified", reason: "no live session conch knows started pid 950" });
    expect(await resolve(1, [claude])).toEqual({ status: "unverified", reason: "callerPid must be the calling process's pid" });
    expect(await resolve("500", [claude])).toMatchObject({ status: "unverified" });
  });
});

/** A control server with the Workbench behind it, as the daemon wires it, and a pretend Mac app reading the sessions file. */
async function served(options: { appRunning?: () => boolean; ackMs?: number; timeoutMs?: number; binding?: CallerBinding; store?: string } = {}) {
  const dir = mkdtempSync("/tmp/conch-wb-");
  const socketPath = join(dir, "s.sock");
  const folder = captureFolder(join(dir, "captures"));
  const profilesFile = join(dir, "browser-profiles.json");
  let profiles: BrowserProfile[] = readBrowserProfiles(profilesFile);
  let published = 0;
  const workbench = new BrowserWorkbench({
    publish: () => { published += 1; },
    folder: () => folder,
    now: Date.now,
    profiles: () => profiles,
    ackMs: options.ackMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 4_000,
    ...(options.appRunning ? { appRunning: options.appRunning } : {}),
    ...(options.store ? { store: fileTabStore(options.store) } : {}),
  });
  const callers: number[] = [];
  const service = createBrowserService({
    workbench,
    profiles: () => profiles,
    addProfile: (name) => {
      const added = addBrowserProfile(name, profilesFile);
      profiles = added.profiles;
      return added;
    },
    resolveCaller: async (pid) => {
      callers.push(pid);
      return options.binding ?? { status: "verified", session: { sessionId: "session-1", pid: 500 } };
    },
    publish: () => { published += 1; },
    ...(options.appRunning ? { appRunning: options.appRunning } : {}),
  });
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "mac",
    log: () => {},
    sessions: { resolve: (value) => value, current: () => ({ published: false }) },
    application: {} as unknown as ControlApplication,
    browser: service,
  });
  expect(await server.start()).toBe(true);
  const exchange = (value: unknown) => new Promise<Record<string, any>>((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("error", reject);
    socket.write(`${JSON.stringify(value)}\n`);
  });
  /** What the sessions file says: the daemon's state, with the Workbench's. */
  const sessionsFile = () => JSON.parse(JSON.stringify(withBrowserState({ v: 1, rows: [] }, workbench)));
  /** The Mac app: once a command shows up on the file, ack it (hearing what to type), then answer it. */
  const app = async (answer: (request: Record<string, any>, typed: string | undefined) => Record<string, unknown>) => {
    let requests: Array<Record<string, any>> = [];
    while (!(requests = sessionsFile().browserRequests ?? []).length) await Bun.sleep(5);
    const request = requests[0]!;
    const ack = await exchange({ kind: "browser-answer", request: request.id, ack: true });
    expect(ack.kind).toBe("browser-ack");
    const reply = await exchange({ kind: "browser-answer", request: request.id, ...answer(request, ack.text) });
    return { request, ack, reply };
  };
  const command = (message: Omit<Extract<BrowserMessage, { kind: "browser-command" }>, "kind">) =>
    requestBrowser(socketPath, { kind: "browser-command", ...message } as BrowserMessage, 8_000);
  return {
    socketPath, folder, workbench, exchange, app, command, sessionsFile, callers, profilesFile,
    published: () => published,
    close: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("profiles over the socket", () => {
  test("list and add, as the Mac app's Settings and the CLI send them; add publishes the new list", async () => {
    const h = await served();
    try {
      expect(await requestBrowser(h.socketPath, { kind: "browser-profiles", action: "list" }, 5_000))
        .toEqual({ ok: true, reply: { kind: "browser-profiles", profiles: [{ id: "default", name: "Default" }] } });
      const before = h.published();
      const added = await requestBrowser(h.socketPath, { kind: "browser-profiles", action: "add", name: "Work" }, 5_000);
      if (!added.ok || added.reply.kind !== "browser-profiles") throw new Error(JSON.stringify(added));
      expect(added.reply.created).toMatchObject({ name: "Work", id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(added.reply.profiles).toHaveLength(2);
      expect(h.published()).toBe(before + 1);
      // Again, in another case: the same profile, nothing new.
      const again = await requestBrowser(h.socketPath, { kind: "browser-profiles", action: "add", name: "work" }, 5_000);
      expect(again).toEqual({ ok: true, reply: { kind: "browser-profiles", profiles: added.reply.profiles, created: added.reply.created! } });
      expect(h.published()).toBe(before + 1);
      expect(h.sessionsFile().browserProfiles).toEqual(added.reply.profiles);
      expect(await h.exchange({ kind: "browser-profiles", action: "add", name: "x".repeat(61) }))
        .toEqual({ kind: "browser-error", error: "a profile's name must be 1–60 printable characters" });
    } finally {
      await h.close();
    }
  });
});

describe("agent B's open: a page an agent opens becomes a tab of its session", () => {
  test("the session from callerPid, a new tab on the sessions file, and the tab's id back", async () => {
    const h = await served();
    try {
      const reply = await h.exchange({ kind: "browser-open", url: "https://accounts.google.com/signin", callerPid: 4242 });
      expect(reply).toEqual({ kind: "browser-opened", tabId: expect.stringMatching(/^tab-[0-9a-f]{8}$/), sessionId: "session-1" });
      expect(h.callers).toEqual([4242]);
      const [tab] = h.sessionsFile().browserTabs;
      expect(tab).toMatchObject({ id: reply.tabId, sessionId: "session-1", url: "https://accounts.google.com/signin", profile: "default" });
      // No command: the app loads a new tab's address when it first sees it.
      expect(h.sessionsFile().browserRequests).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  test("no session, the app down, an unknown profile, or not http(s): a browser-error, and `open` does what it always did", async () => {
    const lost = await served({ binding: { status: "unverified", reason: "no live session conch knows started pid 4242" } });
    try {
      expect(await lost.exchange({ kind: "browser-open", url: "https://acme.dev", callerPid: 4242 }))
        .toEqual({ kind: "browser-error", error: "conch can't tell which session opened it: no live session conch knows started pid 4242" });
      expect(await lost.exchange({ kind: "browser-open", url: "file:///etc/hosts", callerPid: 4242 }))
        .toEqual({ kind: "browser-error", error: "url must be an http or https link" });
      expect(lost.sessionsFile().browserTabs).toEqual([]);
    } finally {
      await lost.close();
    }
    const down = await served({ appRunning: () => false });
    try {
      expect(await down.exchange({ kind: "browser-open", url: "https://acme.dev", callerPid: 4242 })).toEqual({ kind: "browser-error", error: BROWSER_APP_DOWN });
      expect(down.callers).toEqual([]);
    } finally {
      await down.close();
    }
    const h = await served();
    try {
      expect((await h.exchange({ kind: "browser-open", url: "https://acme.dev", callerPid: 4242, profile: "Personal" })).error)
        .toBe('there\'s no browser profile "Personal"; conch has "Default"');
    } finally {
      await h.close();
    }
  });
});

describe("agent B's open is answered inside the shim's wait", () => {
  test("a caller lookup that hangs is a browser-error, so the shim opens the link elsewhere", async () => {
    const workbench = new BrowserWorkbench({ publish: () => {}, folder: () => "/tmp", now: Date.now, profiles: () => [{ ...DEFAULT_BROWSER_PROFILE }] });
    const service = createBrowserService({
      workbench,
      profiles: () => [{ ...DEFAULT_BROWSER_PROFILE }],
      resolveCaller: () => new Promise(() => {}),
      resolveMs: 30,
      publish: () => {},
    });
    const started = Date.now();
    expect(await service.handle({ kind: "browser-open", url: "https://acme.dev", callerPid: 4242 }))
      .toEqual({ kind: "browser-error", error: "conch can't tell which session opened it: finding its session took too long" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(workbench.tabs()).toEqual([]);
  });
});

describe("an agent's command, held open until the Mac app has run it", () => {
  test("open makes a tab, and the app's answer is its address and title", async () => {
    const h = await served();
    try {
      const [reply, { request }] = await Promise.all([
        h.command({ sessionId: "session-1", op: "open", url: "https://acme.dev/pricing" }),
        h.app(() => ({ result: { url: "https://acme.dev/pricing", title: "Pricing · Acme" } })),
      ]);
      expect(request).toMatchObject({ op: "open", url: "https://acme.dev/pricing", fresh: true, deadline: expect.any(Number) });
      if (!reply.ok || reply.reply.kind !== "browser-result") throw new Error(JSON.stringify(reply));
      expect(reply.reply.tab).toEqual({ id: request.tab, url: "https://acme.dev/pricing", title: "Pricing · Acme", profile: "default", profileName: "Default", current: true });
      expect(reply.reply.result).toEqual({ url: "https://acme.dev/pricing", title: "Pricing · Acme" });
      expect(h.sessionsFile().browserRequests).toBeUndefined();
      expect(h.sessionsFile().browserTabs[0]).toMatchObject({ id: request.tab, title: "Pricing · Acme" });
    } finally {
      await h.close();
    }
  });

  test("what an agent types is handed over in the ack's reply, never on the sessions file", async () => {
    const h = await served();
    try {
      h.workbench.open("session-1", "https://acme.dev/login", "default");
      let fileDuring = "";
      const [reply, { request, ack }] = await Promise.all([
        h.command({ sessionId: "session-1", op: "type", target: { auto: "Email" }, text: "agent@example.com", submit: true }),
        h.app((_, typed) => {
          fileDuring = JSON.stringify(h.sessionsFile());
          return { result: { url: "https://acme.dev/home", title: "Home", typed: 'field "Email"', submitted: true } };
        }),
      ]);
      expect(request).toMatchObject({ op: "type", target: { auto: "Email" }, submit: true });
      expect(JSON.stringify(request)).not.toContain("agent@example.com");
      expect(fileDuring).not.toContain("agent@example.com");
      expect(ack).toEqual({ kind: "browser-ack", text: "agent@example.com" });
      expect(reply).toMatchObject({ ok: true, reply: { kind: "browser-result", op: "type", result: { url: "https://acme.dev/home", title: "Home", typed: 'field "Email"', submitted: true } } });
    } finally {
      await h.close();
    }
  });

  test("read comes back in its own shape: no secret's value, nothing the app adds on", async () => {
    const h = await served();
    try {
      h.workbench.open("session-1", "https://acme.dev/login", "default");
      const [reply] = await Promise.all([
        h.command({ sessionId: "session-1", op: "read" }),
        h.app(() => ({
          result: {
            url: "https://acme.dev/login", title: "Sign in", text: "Sign in\n\n\n\nto Acme",
            links: [{ ref: "e1", text: "Docs", href: "https://acme.dev/docs" }, { ref: "bad ref", text: "x" }],
            buttons: [{ ref: "e2", text: "Sign in" }],
            fields: [{ ref: "e3", type: "password", name: "password", value: "hunter2-SECRET" }, { ref: "e4", type: "email", name: "email", value: "t@acme.dev" }],
            cookies: "session=abc123", localStorage: { token: "xyz" },
          },
        })),
      ]);
      if (!reply.ok || reply.reply.kind !== "browser-result") throw new Error(JSON.stringify(reply));
      expect(reply.reply.result).toEqual({
        url: "https://acme.dev/login", title: "Sign in", text: "Sign in\n\nto Acme",
        links: [{ ref: "e1", text: "Docs", href: "https://acme.dev/docs" }],
        buttons: [{ ref: "e2", text: "Sign in" }],
        fields: [{ ref: "e3", type: "password", name: "password" }, { ref: "e4", type: "email", name: "email", value: "t@acme.dev" }],
      });
      expect(JSON.stringify(reply)).not.toMatch(/hunter2|abc123|xyz/);
    } finally {
      await h.close();
    }
  });

  test("a screenshot is a PNG of conch's own in the capture folder, held to a capture's rule", async () => {
    const h = await served();
    try {
      h.workbench.open("session-1", "https://acme.dev/", "default");
      const [reply, { request }] = await Promise.all([
        h.command({ sessionId: "session-1", op: "screenshot" }),
        h.app((request) => {
          const path = join(request.folder, `${request.id}.png`);
          writeFileSync(path, pngBytes(2560, 1720));
          chmodSync(path, 0o600);
          return { result: { path, url: "https://acme.dev/", title: "Acme" } };
        }),
      ]);
      expect(request.folder).toBe(h.folder);
      expect(reply).toMatchObject({ ok: true, reply: { result: { path: join(h.folder, `${request.id}.png`), width: 2560, height: 1720, url: "https://acme.dev/", title: "Acme" } } });
      // Readable by others, or not where it was asked: refused.
      const [refused] = await Promise.all([
        h.command({ sessionId: "session-1", op: "screenshot" }),
        h.app((request) => {
          const path = join(request.folder, `${request.id}.png`);
          writeFileSync(path, pngBytes(10, 10));
          chmodSync(path, 0o644);
          return { result: { path } };
        }),
      ]);
      expect(refused).toEqual({ ok: true, reply: { kind: "browser-error", error: "the Mac app's screenshot was refused" } });
    } finally {
      await h.close();
    }
  });

  test("a command naming no tab runs in the session's most recent; another session's tab is refused", async () => {
    const h = await served();
    try {
      const first = h.workbench.open("session-1", "https://a.dev/", "default");
      await Bun.sleep(5);
      const second = h.workbench.open("session-1", "https://b.dev/", "default");
      const theirs = h.workbench.open("session-2", "https://c.dev/", "default");
      if (!first.ok || !second.ok || !theirs.ok) throw new Error("tabs");
      const [, { request }] = await Promise.all([
        h.command({ sessionId: "session-1", op: "click", target: { text: "Next" } }),
        h.app(() => ({ result: { url: "https://b.dev/next", title: "Next", clicked: 'link "Next"' } })),
      ]);
      expect(request.tab).toBe(second.tab.id);
      const [, again] = await Promise.all([
        h.command({ sessionId: "session-1", op: "read", tab: first.tab.id }),
        h.app(() => ({ result: { url: "https://a.dev/", title: "A", text: "" } })),
      ]);
      expect(again.request.tab).toBe(first.tab.id);
      expect(h.workbench.current("session-1")?.id).toBe(first.tab.id);
      expect(await h.command({ sessionId: "session-1", op: "read", tab: theirs.tab.id }))
        .toEqual({ ok: true, reply: { kind: "browser-error", error: `there's no tab ${theirs.tab.id} in this session; browser_tabs lists yours` } });
      expect(await h.command({ sessionId: "session-3", op: "read" }))
        .toEqual({ ok: true, reply: { kind: "browser-error", error: "this session has no browser tab yet; open one with browser_open" } });
      const tabs = await h.command({ sessionId: "session-1", op: "tabs" });
      expect(tabs).toMatchObject({ ok: true, reply: { kind: "browser-result", tabs: [{ id: first.tab.id, current: true }, { id: second.tab.id }] } });
      expect(await h.command({ sessionId: "session-1", op: "close", tab: second.tab.id }))
        .toEqual({ ok: true, reply: { kind: "browser-result", op: "close", result: { closed: second.tab.id } } });
      expect(h.sessionsFile().browserTabs.map((tab: BrowserTab) => tab.id)).toEqual([first.tab.id, theirs.tab.id]);
    } finally {
      await h.close();
    }
  });

  test("the app's own error comes through; the app down is said at once, and silence is said after the ack wait", async () => {
    const h = await served();
    try {
      h.workbench.open("session-1", "https://acme.dev/", "default");
      const [refused] = await Promise.all([
        h.command({ sessionId: "session-1", op: "type", target: { auto: "Password" }, text: "x" }),
        h.app(() => ({ error: "agents don't type passwords; sign in yourself in the tab", result: { url: "https://acme.dev/login", title: "Sign in" } })),
      ]);
      expect(refused).toEqual({ ok: true, reply: { kind: "browser-error", error: "agents don't type passwords; sign in yourself in the tab" } });
    } finally {
      await h.close();
    }
    const down = await served({ appRunning: () => false });
    try {
      expect(await down.command({ sessionId: "session-1", op: "open", url: "https://acme.dev/" }))
        .toEqual({ ok: true, reply: { kind: "browser-error", error: BROWSER_APP_DOWN } });
      expect(down.sessionsFile().browserTabs).toEqual([]);
    } finally {
      await down.close();
    }
    const quiet = await served({ ackMs: 50 });
    try {
      expect(await quiet.command({ sessionId: "session-1", op: "open", url: "https://acme.dev/" }))
        .toEqual({ ok: true, reply: { kind: "browser-error", error: BROWSER_APP_DOWN } });
      // A tab nobody could show is no tab.
      expect(quiet.sessionsFile().browserTabs).toEqual([]);
      expect(quiet.sessionsFile().browserRequests).toBeUndefined();
    } finally {
      await quiet.close();
    }
  });

  test("Tyler's own hand: a tab he navigates follows, one he closes goes", async () => {
    const h = await served();
    try {
      const opened = h.workbench.open("session-1", "https://acme.dev/", "default");
      if (!opened.ok) throw new Error("tab");
      expect(await h.exchange({ kind: "browser-tab-event", tab: opened.tab.id, url: "https://acme.dev/billing", title: "Billing" })).toEqual({ kind: "browser-ack" });
      expect(h.sessionsFile().browserTabs[0]).toMatchObject({ url: "https://acme.dev/billing", title: "Billing" });
      expect(await h.exchange({ kind: "browser-tab-event", tab: opened.tab.id, closed: true })).toEqual({ kind: "browser-ack" });
      expect(h.sessionsFile().browserTabs).toEqual([]);
      expect(await h.exchange({ kind: "browser-tab-event", tab: opened.tab.id, closed: true })).toEqual({ kind: "browser-error", error: "no such tab" });
    } finally {
      await h.close();
    }
  });
});

describe("the tabs themselves", () => {
  const options = (store?: string, now = () => 1_000_000) => ({
    publish: () => {}, folder: () => "/tmp", now, profiles: () => [{ ...DEFAULT_BROWSER_PROFILE }], ...(store ? { store: fileTabStore(store) } : {}),
  });

  test("kept across a daemon restart, readable by their owner alone; a week unused and they are gone", () => {
    const file = join(fresh("tabs"), "conf", "browser-tabs.json");
    const before = new BrowserWorkbench(options(file));
    const kept = before.open("session-1", "https://acme.dev/", "default");
    if (!kept.ok) throw new Error("tab");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new BrowserWorkbench(options(file)).tabs()).toEqual([kept.tab]);
    const later = new BrowserWorkbench(options(file, () => 1_000_000 + 8 * 24 * 60 * 60 * 1000));
    expect(later.tabs()).toEqual([]);
    // A file that isn't tabs is no tabs.
    writeFileSync(file, JSON.stringify([{ id: "../../x", sessionId: "s", url: "https://a.dev", profile: "default", usedAt: 1_000_000 }, { id: "tab-1", url: "javascript:x" }]));
    expect(new BrowserWorkbench(options(file)).tabs()).toEqual([]);
  });

  test("a session keeps at most eight; a day after its session ends, its tabs go", () => {
    let now = 1_000_000;
    const workbench = new BrowserWorkbench(options(undefined, () => now));
    for (let i = 0; i < BROWSER_TABS_PER_SESSION; i += 1) expect(workbench.open("s1", `https://a.dev/${i}`, "default").ok).toBe(true);
    expect(workbench.open("s1", "https://a.dev/9", "default")).toEqual({ ok: false, error: "this session has 8 tabs open; close one (browser_close) first" });
    expect(workbench.open("s2", "https://b.dev/", "default").ok).toBe(true);
    workbench.pruneEnded(new Set(["s2"]));
    expect(workbench.tabs()).toHaveLength(9);
    now += 25 * 60 * 60 * 1000;
    workbench.pruneEnded(new Set(["s2"]));
    expect(workbench.tabs().map((tab) => tab.sessionId)).toEqual(["s2"]);
  });

  test("published beside the rows on the sessions file: profiles and tabs always, commands while they wait", () => {
    const workbench = new BrowserWorkbench(options());
    expect(withBrowserState({ v: 1, rows: [] }, workbench)).toEqual({ v: 1, rows: [], browserProfiles: [{ id: "default", name: "Default" }], browserTabs: [] });
  });
});

describe("conch browser, from the CLI", () => {
  test("profiles lists and adds; open sends this process's pid and the profile; anything else is the usage", async () => {
    const sent: BrowserMessage[] = [];
    const send = async (_: string, message: BrowserMessage) => {
      sent.push(message);
      if (message.kind === "browser-open") return { ok: true as const, reply: { kind: "browser-opened" as const, tabId: "tab-1a2b3c4d", sessionId: "session-1" } };
      return { ok: true as const, reply: { kind: "browser-profiles" as const, profiles: [{ id: "default", name: "Default" }, { id: WORK, name: "Work" }], ...(message.kind === "browser-profiles" && message.action === "add" ? { created: { id: WORK, name: "Work" } } : {}) } };
    };
    expect(await runBrowserCli(["profiles"], "/s", send, 4242)).toEqual({ code: 0, lines: [`Default${" ".repeat(17)} default`, `Work${" ".repeat(20)} ${WORK}`] });
    expect((await runBrowserCli(["profiles", "add", "Work", "Stuff"], "/s", send, 4242)).lines[0]).toBe(`[conch] Work (${WORK})`);
    expect(await runBrowserCli(["open", "--profile", "Work", "https://acme.dev"], "/s", send, 4242))
      .toEqual({ code: 0, lines: ["[conch] opened tab-1a2b3c4d for session session-1"] });
    expect(sent).toEqual([
      { kind: "browser-profiles", action: "list" },
      { kind: "browser-profiles", action: "add", name: "Work Stuff" },
      { kind: "browser-open", url: "https://acme.dev", callerPid: 4242, profile: "Work" },
    ]);
    for (const args of [[], ["tabs"], ["open"], ["open", "--profile"], ["profiles", "add"], ["profiles", "remove", "Work"]]) {
      expect(await runBrowserCli(args, "/s", send, 4242), args.join(" ")).toEqual({ code: 2, lines: [BROWSER_CLI_USAGE] });
    }
    expect(await runBrowserCli(["profiles"], "/s", async () => ({ ok: false, reason: "daemon-down" }), 4242)).toEqual({ code: 1, lines: ["[conch] daemon not running"] });
    expect(await runBrowserCli(["open", "https://a.dev"], "/s", async () => ({ ok: true, reply: { kind: "browser-error", error: "nope" } }), 4242))
      .toEqual({ code: 1, lines: ["[conch] nope"] });
  });
});

describe("the daemon's wiring", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");

  test("the Workbench is on the sessions file alone, never the state the phone is sent", () => {
    const writer = daemon.slice(daemon.indexOf("function writeSessionsFile(): void {"), daemon.indexOf("const publishedStateWriter"));
    expect(writer).toContain("withBrowserState(withCaptureRequests(lastPublishedPanelState, pageCaptures.requests()), browserWorkbench)");
    expect(daemon).not.toMatch(/lastPublishedPanelState = [^;]*browser/);
    // agent B's `open` resolves its caller the way the MCP server does.
    expect(daemon).toContain("resolveCaller: (pid) => sessionForCallerPid(pid, { infos: [...panelSessions.values()], claudeDir: cfg.claudeDir })");
    expect(daemon).toContain("    browser,\n");
    // The Mac app drives the pages from its own snapshot; a remote Mac's store never sees them.
    const root = join(import.meta.dir, "..");
    expect(readFileSync(join(root, "mac-app/conch-mac/StateStore.swift"), "utf8")).toContain("WorkbenchStore.shared.accept(snapshot)");
    expect(readFileSync(join(root, "mac-app/conch-mac/RemoteMacStore.swift"), "utf8")).not.toContain("browser");
  });
});
