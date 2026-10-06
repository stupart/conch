#!/usr/bin/env bun
/**
 * The agent contract, end to end: the real MCP server (`conch mcp`, over stdio, as Claude Code runs it) against a real
 * daemon from this checkout, both in a temporary home with their own socket, config, state and sessions files. Nothing
 * shared with a running conch: the live socket (/tmp/conch.sock), ~/.config/conch and /tmp/conch-*.json are never
 * touched, and the script refuses to start if a path would land on one of them.
 *
 *   bun scripts/agent-contract-e2e.ts [--keep]
 *
 * What it proves (2026-10-03 feedback, items 1, 5 and 6):
 * - `initialize` negotiates the revision and says conch is watching (`instructions`), within its budget;
 * - `review_to_front` waits for the daemon's verdict: `filed`, the daemon's own id and version, and `surfaces`, which
 *   move as the Mac app is heard from (its ping) and shows conch's window (a screen report);
 * - a file in macOS's per-user temp folder is accepted by both processes although each has a different `$TMPDIR`,
 *   and is filed as conch's own copy (0600, in a 0700 store under ~/Library/Application Support/conch), its pixel
 *   marks made fractions and pointed at the copy;
 * - the original deleted, the copy is still served by the phone's `/file` (the bridge's own code, in this process);
 * - a page in /tmp brings its folder; review_remove deletes the copy it held; a raw publication the daemon refuses
 *   comes back refused, with the daemon's reason;
 * - a copy nothing holds is swept when the daemon starts again, and the held ones survive the restart.
 *
 * And login walls (item 3): a local server whose `/dashboard` and `/admin` send anyone without cookies to a `/login`
 * with a password form, and whose `/pricing` is public; a fake Mac app that pings and answers the daemon's capture
 * requests over the socket as PageCaptureRequests.swift does, "signed in" to the dashboard and not the admin page:
 * - with the Mac app not running, a URL's check skips the capture and says so, and the anonymous look sees sign-in;
 * - with it running, `access`, `warning` and `snapshot` say what each device was shown; the snapshot is filed only
 *   when the Mac drew the page, the phone's `/file` serves it, the capture sweep keeps it however old, and
 *   review_remove takes it with the filing; an older MCP server (no `awaitAccess`) is answered once filed and the
 *   snapshot lands on the deliverable afterwards; and the server never saw a cookie or an Authorization header.
 *
 * Never plays audio, never opens the microphone, never downloads a model (the engine paths point at nothing), no phone
 * transport, and every process it stops is one it started, by pid.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";
import { publishForVerdict } from "../src/review-verdict.ts";
import { darwinUserTempDir, inTempFolder } from "../src/temp-folders.ts";

const repo = resolve(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | Promise<T>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | null = null;
    try { value = await probe(); } catch {}
    if (value) return value;
    await Bun.sleep(50);
  }
  say(`… gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

/** A PNG's signature and header, width × height: all `imagePixelSize` reads. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}

// A short /tmp path: a unix socket path must fit sockaddr_un.
const root = mkdtempSync(join("/tmp", "conch-ac-"));
// The home outside every temp folder (this checkout's ignored build folder), as a real one is: so a copy in conch's
// store under it is served by the store's own place in the publish rule, never because it happens to sit in /tmp.
mkdirSync(join(repo, "build"), { recursive: true });
const outside = mkdtempSync(join(repo, "build", "agent-contract-e2e-"));
const home = join(outside, "home");
const claude = join(root, "claude");
const project = join(root, "project");
const config = join(home, ".config", "conch");
// conch's own store where a real one is, under the (sandboxed) home: what the publish rule lets through.
const store = join(home, "Library", "Application Support", "conch", "deliverables");
for (const dir of [home, join(claude, "sessions"), project, config, join(root, "daemon-tmp"), join(root, "agent-tmp")]) mkdirSync(dir, { recursive: true });
const userTemp = darwinUserTempDir();
if (!userTemp) throw new Error("macOS did not name this user's temp folder (confstr _CS_DARWIN_USER_TEMP_DIR)");
const scratch = mkdtempSync(join(userTemp, "conch-ac-e2e-"));

const socket = join(root, "conch.sock");
const liveHome = process.env.HOME ?? "/nonexistent";
for (const path of [socket, join(root, "sessions.json"), join(root, "state.json"), config, store]) {
  if (path === "/tmp/conch.sock" || /^\/tmp\/conch-[^/]*\.json$/.test(path)
    || path.startsWith(join(liveHome, ".config", "conch")) || path.startsWith(join(liveHome, "Library", "Application Support", "conch"))) {
    throw new Error(`refusing a live conch path: ${path}`);
  }
}

// The calling session: this process, registered as Claude Code registers a window. The MCP server is its child.
const sessionId = "e2e00000-0000-4000-8000-0000000ac0de";
writeFileSync(join(claude, "sessions", `${process.pid}.json`), JSON.stringify({
  pid: process.pid, sessionId, cwd: project, startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle",
  name: "Remove Rowan from the Morrow site",
}));

const shared: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  CONCH_HOME: home,
  CONCH_SOCKET: socket,
  CONCH_CONFIG_DIR: config,
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(root, "codex"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_TMUX_SOCKET: `conch-ac-e2e-${process.pid}`,
};
const daemonEnv: Record<string, string> = {
  ...shared,
  // Each process its own TMPDIR, neither of them the folder the file is in: they must agree anyway.
  TMPDIR: `${join(root, "daemon-tmp")}/`,
  CONCH_WHISPER_PORT: String(freePort()),
  CONCH_APP_BUNDLE: join(root, "no-app"),
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  CONCH_WHISPER_MODEL: join(root, "no-model.bin"),
  CONCH_WHISPER_CLI: join(root, "no-whisper-cli"),
  CONCH_WHISPER_SERVER: join(root, "no-whisper-server"),
  CONCH_VAD_MODEL: join(root, "no-vad.bin"),
  CONCH_SOX: join(root, "no-sox"),
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_RECORDS_ENABLED: "0",
  CONCH_PHONE: "0",
};
const agentEnv: Record<string, string> = { ...shared, TMPDIR: `${join(root, "agent-tmp")}/` };

type Held = { id: string; summary: string; link?: string; version?: number; artifact?: string; scene?: { marks?: Array<{ frame: { image?: string }; rect?: number[] }> } };
type Row = { id: string; label?: string; review?: Held; reviews?: Held[] };
const published = (): { rows?: Row[] } => JSON.parse(readFileSync(shared.CONCH_SESSIONS_FILE!, "utf8"));
const ourRow = (): Row | null => {
  try { return published().rows?.find((row) => row.id === sessionId) ?? null; } catch { return null; }
};
const held = (): Held[] => ourRow()?.reviews ?? [];

function startDaemon() {
  return Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
    env: daemonEnv,
    cwd: root,
    stdin: "ignore",
    stdout: Bun.file(join(root, `daemon.${Date.now()}.stdout.log`)),
    stderr: Bun.file(join(root, `daemon.${Date.now()}.stderr.log`)),
  });
}

async function stop(process_: ReturnType<typeof Bun.spawn>, what: string): Promise<void> {
  process_.kill("SIGTERM");
  const exited = await Promise.race([process_.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) process_.kill("SIGKILL");
  say(`${what} ${process_.pid} stopped`);
}

/** The MCP server as a client speaks to it: one JSON-RPC line each way. */
function startMcp() {
  const server = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "mcp"], {
    env: agentEnv, cwd: project, stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(root, "mcp.stderr.log")),
  });
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waiting = new Map<number, (value: any) => void>();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    }
  })();
  let id = 0;
  const request = (method: string, params: unknown): Promise<any> => {
    const mine = ++id;
    const answer = new Promise((resolve) => waiting.set(mine, resolve));
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    server.stdin.flush();
    return Promise.race([answer, Bun.sleep(20_000).then(() => { throw new Error(`${method} got no answer`); })]);
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await request("tools/call", { name, arguments: args });
    const text: string = response.result?.content?.[0]?.text ?? "";
    return { isError: response.result?.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { server, request, call };
}

/** The daemon's socket, as the Mac app speaks to it: one line, one answer. */
async function ask(body: unknown): Promise<any> {
  const { connect } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const sock = connect({ path: socket });
    let data = "";
    sock.on("connect", () => sock.write(`${JSON.stringify(body)}\n`));
    sock.on("data", (chunk) => { data += chunk.toString(); if (data.includes("\n")) { sock.destroy(); resolve(JSON.parse(data.split("\n")[0]!)); } });
    sock.on("error", reject);
  });
}

/**
 * A site behind a login, on this Mac: `/dashboard` and `/admin` send anyone without the session cookie to `/login`, a
 * password form; `/pricing` is public. Every request's headers are kept, to show the daemon's own look sent nothing.
 */
const siteRequests: Array<{ path: string; headers: Record<string, string> }> = [];
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    siteRequests.push({ path: url.pathname, headers: Object.fromEntries(request.headers.entries()) });
    const html = (title: string, body: string) => new Response(`<!doctype html><title>${title}</title>${body}`, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/pricing") return html("Pricing", "<h1>Pricing</h1><button>Log in</button>");
    if (url.pathname === "/login") return html("Log in", '<form><input name="email"><input type="password" name="password"><button>Log in</button></form>');
    if (request.headers.get("cookie")?.includes("session=")) return html("Dashboard", "<h1>Deployments</h1>");
    return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(url.pathname)}` } });
  },
});
const siteUrl = (path: string) => `http://127.0.0.1:${site.port}${path}`;

/**
 * conch's Mac app, as far as the daemon can tell: its health ping, and its answers to the pages the daemon asks it to
 * draw (the sessions file's `captureRequests`), as PageCaptureRequests.swift gives them: `ack`, then a 0600 PNG named
 * for the request in the folder it names, and what it saw. Its review pane is signed in to the dashboard, not the
 * admin page.
 */
function fakeMacApp() {
  const handled = new Set<string>();
  const drawn: string[] = [];
  let running = true;
  let pinged = 0;
  const loop = (async () => {
    while (running) {
      if (Date.now() - pinged > 4_000) {
        const pong = await ask({ kind: "ping", from: "mac-app" }).catch(() => null);
        if (pong?.kind === "pong") pinged = Date.now();
      }
      let requests: Array<{ id: string; url: string; folder: string }> = [];
      try { requests = (published() as { captureRequests?: typeof requests }).captureRequests ?? []; } catch {}
      for (const request of requests) {
        if (handled.has(request.id)) continue;
        handled.add(request.id);
        await ask({ kind: "page-capture-answer", request: request.id, ack: true });
        const path = join(request.folder, `${request.id}.png`);
        writeFileSync(path, png(2880, 1800));
        chmodSync(path, 0o600);
        const walled = new URL(request.url).pathname === "/admin";
        await ask({
          kind: "page-capture-answer", request: request.id, path, devicePixelRatio: 2, settled: true,
          finalUrl: walled ? siteUrl("/login?next=%2Fadmin") : request.url, title: walled ? "Log in" : "Dashboard", loginWall: walled,
        });
        drawn.push(request.url);
      }
      await Bun.sleep(50);
    }
  })();
  return { drawn, pinged: () => pinged > 0, stop: async () => { running = false; await loop; } };
}
let macApp: ReturnType<typeof fakeMacApp> | null = null;

const mode = (path: string) => statSync(path).mode & 0o777;
let daemon = startDaemon();
say(`temp root ${root}; per-user temp scratch ${scratch}`);
say(`daemon started, pid ${daemon.pid}`);
const mcp = startMcp();

try {
  check(Boolean(await until("the session's row", 30_000, () => ourRow())), `the daemon publishes the registered session ${sessionId}`);

  // ── 1. Every session knows conch is watching.
  const init = await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  check(init.result?.protocolVersion === "2025-06-18", `initialize: a 2025-11-25 client is answered 2025-06-18 (got ${init.result?.protocolVersion})`);
  const instructions: string = init.result?.instructions ?? "";
  check(instructions.startsWith("This session is watched by conch") && instructions.length <= 500,
    `initialize carries instructions (${instructions.length} chars): "${instructions.slice(0, 60)}…"`);
  mcp.server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await mcp.request("tools/list", {});
  const publishTool = listed.result?.tools?.find((tool: { name: string }) => tool.name === "review_to_front");
  const description: string = publishTool?.description ?? "";
  // 2026-10-05: the description says when to publish and where the result says it landed; what a temp link's copy is
  // (copiedFrom) is the link parameter's to say, with the other mechanics the description used to carry.
  check(description.startsWith("Publish whenever you produce something the user would look at") && description.length <= 1000
    && description.includes("surfaces"), `review_to_front's description says when to publish, and where it landed (surfaces), in ${description.length} chars`);
  check(String(publishTool?.inputSchema?.properties?.link?.description ?? "").includes("copiedFrom"), "…and its link parameter says what copiedFrom is");

  // ── 2 & 3. A screenshot in the per-user temp folder, with a mark in pixels.
  const shot = join(scratch, "hero.png");
  writeFileSync(shot, png(1280, 800));
  const scene = { v: 1, target: { kind: "auto" }, marks: [{ id: "cta", kind: "box", frame: { image: shot }, rect: [320, 200, 640, 400], units: "px", label: "Moved up" }] };
  const first = await mcp.call("review_to_front", { summary: "Hero with the new headline", link: shot, scene });
  const filed = first.json;
  check(!first.isError && filed?.outcome === "filed", `review_to_front waited for the daemon: outcome ${filed?.outcome ?? first.text.slice(0, 200)}`);
  check(filed?.copiedFrom === shot && typeof filed?.link === "string" && filed.link.startsWith(`${store}/`),
    `…accepted by both processes although neither TMPDIR is ${userTemp}, and filed as a copy: ${filed?.link}`);
  check(JSON.stringify(filed?.surfaces) === JSON.stringify({ mac: "not-running", phone: "off", audio: filed?.surfaces?.audio })
    && ["mac", "manual"].includes(filed?.surfaces?.audio),
    `…surfaces before the Mac app is heard from: ${JSON.stringify(filed?.surfaces)}`);
  const v1 = await until("v1 on the row", 10_000, () => held().find((one) => one.id === filed?.id));
  check(v1?.link === filed?.link && v1?.version === filed?.version && filed?.version === 1, `the id, link and version it returned are what the daemon published (v${v1?.version})`);
  const mark = v1?.scene?.marks?.[0];
  check(mark?.frame.image === filed?.link && JSON.stringify(mark?.rect) === JSON.stringify([0.25, 0.25, 0.5, 0.5]),
    `the pixel mark was filed as fractions of the 1280×800 image, drawn on the copy: ${JSON.stringify(mark)}`);
  check(mode(filed.link) === 0o600 && mode(store) === 0o700 && mode(join(filed.link, "..")) === 0o700, "the copy is 0600 in a 0700 store");
  check(!inTempFolder(realpathSync(filed.link)), `…and the store is outside every temp folder (${store})`);

  // The relabel hint: this session's label is its first task, and its work moved on.
  const second = await mcp.call("review_to_front", { summary: "Team photo swapped on the about section", link: shot });
  check(second.json?.outcome === "filed" && second.json?.version === 2 && second.json?.artifact === filed?.artifact,
    `the same temp file again is the same artifact's v2, though each copy is its own (v${second.json?.version})`);
  check(second.json?.relabel?.label === "Remove Rowan from the Morrow site" && /conch_rename/.test(second.json?.relabel?.hint ?? ""),
    `a label the work drifted from is offered for renaming: ${JSON.stringify(second.json?.relabel)}`);

  // The Mac app is heard from: its health check, then conch's window in front.
  const pong = await ask({ kind: "ping", from: "mac-app" });
  check(pong?.kind === "pong", "the Mac app's ping is answered");
  const running = await mcp.call("review_to_front", { summary: "Headline copy final", link: shot });
  check(running.json?.surfaces?.mac === "running" && running.json?.relabel === undefined,
    `after its ping the Mac app counts as running (${running.json?.surfaces?.mac}), and the relabel is not offered twice`);
  const seen = await ask({ kind: "screen-observation", observation: { v: 1, source: "conch-staged", at: Date.now(), surface: { kind: "conch", sessionId, view: "main" } } });
  check(seen?.kind === "screen-ack", "a screen report from the app is taken");
  const showing = await mcp.call("review_to_front", { summary: "Headline copy final, again", link: shot });
  check(showing.json?.surfaces?.mac === "showing", `with conch's window in front it is showing (${showing.json?.surfaces?.mac})`);

  // The original goes, as /tmp does at a reboot: the copy is still what the phone and the Mac are served.
  rmSync(scratch, { recursive: true, force: true });
  // The phone's /file, run here by the bridge's own code, finds conch's store under the home it is given, as the
  // daemon's does under its own: the sandbox's.
  process.env.CONCH_HOME = home;
  const bridge = createPhoneBridgeApplication({
    getState: () => published() as never,
    forwardControl: async () => "",
    replyFor: async () => "",
    acceptUpload: async () => ({ received: 1, total: 1 }),
    log: () => {},
  } as never, { token: "t".repeat(32) });
  const fetched = async (path: string) => (await bridge.handle(new Request(`https://relay.invalid/file?path=${encodeURIComponent(path)}`, {
    headers: { authorization: `Bearer ${"t".repeat(32)}` },
  })) as Response).status;
  check(!existsSync(shot) && existsSync(filed.link) && await fetched(filed.link) === 200,
    "the original deleted, the phone's /file still serves the copy (200), and the Mac's path still exists");
  check(await fetched(shot) !== 200, "…and the deleted original is not served");

  // A page in /tmp brings its folder; its picture is served from the copy.
  const site = join(root, "renders", "site");
  mkdirSync(join(site, "img"), { recursive: true });
  writeFileSync(join(site, "index.html"), '<link rel="stylesheet" href="style.css"><img src="img/a.png">');
  writeFileSync(join(site, "style.css"), "body{}");
  writeFileSync(join(site, "img", "a.png"), png(10, 10));
  writeFileSync(join(site, ".env"), "SECRET=1");
  const page = await mcp.call("review_to_front", { summary: "The pricing page", link: join(site, "index.html") });
  const pageCopy: string = page.json?.link ?? "";
  check(page.json?.outcome === "filed" && page.json?.copiedFrom === join(site, "index.html") && pageCopy.endsWith("/site/index.html"),
    `a page in /tmp is filed as a copy of its folder: ${pageCopy}`);
  rmSync(site, { recursive: true, force: true });
  await until("the page on the row", 10_000, () => held().find((one) => one.link === pageCopy));
  check(await fetched(pageCopy) === 200 && await fetched(join(pageCopy, "..", "style.css")) === 200 && await fetched(join(pageCopy, "..", "img", "a.png")) === 200,
    "…its styles and pictures are served from the copy after the original folder is gone");
  check(!existsSync(join(pageCopy, "..", ".env")), "…and a hidden file in that folder was never copied");

  // A publication the daemon refuses, sent as a raw client would: the daemon's own reason comes back.
  const raw = await publishForVerdict(socket, {
    type: "review-published", sessionId, label: "e2e", cwd: project, announce: "raw", eventAt: Date.now(),
    review: { summary: "hosts", link: "/etc/hosts" },
  });
  check(raw.kind === "verdict" && raw.verdict.kind === "review-refused" && /outside this session's folder/.test(raw.verdict.reason),
    `the daemon's refusal reaches the publisher: ${raw.kind === "verdict" && raw.verdict.kind === "review-refused" ? raw.verdict.reason.slice(0, 120) : JSON.stringify(raw)}`);

  // review_remove takes the copy with the filing.
  const v1Dir = join(filed.link, "..");
  const removed = await mcp.call("review_remove", { id: filed.id });
  check(removed.json?.outcome === "removed", `review_remove took v1 back: ${removed.text.slice(0, 120)}`);
  check(Boolean(await until("v1's copy to go", 10_000, () => !existsSync(v1Dir))), "…and its copy is deleted from the store");
  check(existsSync(running.json.link) && existsSync(pageCopy), "…while the copies other filings hold stay");

  // A daemon restart: a copy nothing holds (a crash between copying and saving) goes; held ones stay.
  const orphan = join(store, "0000000000000000", "v1-orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "lost.png"), png(1, 1));
  await stop(daemon, "daemon");
  // Its published state goes with it, so what follows is the new daemon's word, restored from reviews.json.
  rmSync(shared.CONCH_SESSIONS_FILE!, { force: true });
  daemon = startDaemon();
  say(`daemon restarted, pid ${daemon.pid}`);
  check(Boolean(await until("the restarted daemon's row", 30_000, () => ourRow()?.reviews?.length === 4 ? ourRow() : null)),
    `the restarted daemon restores the four deliverables (${held().length})`);
  check(Boolean(await until("the orphan to be swept", 10_000, () => !existsSync(orphan))), "a copy no deliverable holds is swept at start");
  check(readFileSync(shared.CONCH_LOG_FILE!, "utf8").includes(`removed a copy no deliverable holds: ${orphan}`), "…and the daemon's log names it");
  check(existsSync(running.json.link) && existsSync(pageCopy) && await fetched(running.json.link) === 200, "…the held copies survive the restart and are served");
  const stored = readdirSync(store).flatMap((artifact) => readdirSync(join(store, artifact)).map((version) => join(store, artifact, version)));
  const named = new Set(held().map((one) => join(one.link ?? "", "..")).concat(held().map((one) => join(one.link ?? "", "..", ".."))));
  check(stored.every((dir) => named.has(dir)), `the store holds only what the deliverables name (${stored.length} version folders)`);

  // ── Login walls (item 3). The restarted daemon hasn't heard from a Mac app: the check skips the capture and says so.
  const captures = join(home, "Library", "Application Support", "conch", "captures");
  const alone = await mcp.call("review_to_front", { summary: "The deployments dashboard", link: siteUrl("/dashboard") });
  check(alone.json?.outcome === "filed" && alone.json?.kind === "url" && alone.json?.surfaces?.mac === "not-running",
    `a live page is filed as url while the Mac app is not running: ${alone.text.slice(0, 160)}`);
  check(alone.json?.access?.mac === "unchecked" && /Mac app isn't running/.test(alone.json?.access?.why ?? "") && alone.json?.snapshot === undefined,
    `…its capture is skipped, and the verdict says why: ${JSON.stringify(alone.json?.access)}`);
  check(alone.json?.access?.anonymous === "sign-in" && /redirected to a sign-in page/.test(alone.json?.access?.why ?? "")
    && /couldn't draw it on the Mac to attach a snapshot/.test(alone.json?.warning ?? ""),
    `…the look without cookies was sent to /login, and the warning says there is no snapshot: ${alone.json?.warning}`);

  // The Mac app opens: it pings, and draws what it is asked to.
  macApp = fakeMacApp();
  check(Boolean(await until("the fake Mac app's first ping", 10_000, () => macApp!.pinged())), "the fake Mac app's health ping is answered");
  const signedIn = await mcp.call("review_to_front", { summary: "The deployments dashboard, with the new filters", link: siteUrl("/dashboard") });
  const dash = signedIn.json;
  check(dash?.outcome === "filed" && dash?.surfaces?.mac !== "not-running" && macApp.drawn.includes(siteUrl("/dashboard")),
    `with the Mac app running, conch's Mac drew the page (${macApp.drawn.length} drawn), surfaces.mac ${dash?.surfaces?.mac}`);
  check(JSON.stringify([dash?.access?.mac, dash?.access?.anonymous]) === JSON.stringify(["page", "sign-in"]),
    `…access: the Mac, signed in, saw the page; without cookies it was sent to sign in: ${dash?.access?.why}`);
  check(dash?.warning === "The page needs sign-in, so the phone (without the Mac's cookies) would show a login page. conch attached the Mac's snapshot, so the phone shows the page as the Mac saw it.",
    `…warning: ${dash?.warning}`);
  const snapshot: string = dash?.snapshot ?? "";
  check(snapshot.startsWith(`${captures}/`) && existsSync(snapshot) && mode(snapshot) === 0o600, `…snapshot: the Mac's picture, 0600 in conch's capture folder: ${snapshot}`);
  const dashHeld = await until("the snapshot on the row", 10_000, () => {
    const one = held().find((candidate) => candidate.id === dash?.id) as (Held & { snapshot?: { path: string }; access?: { mac: string; anonymous: string } }) | undefined;
    return one?.snapshot ? one : null;
  });
  check(dashHeld?.snapshot?.path === snapshot && dashHeld?.access?.mac === "page" && dashHeld?.access?.anonymous === "sign-in",
    `the published deliverable carries the snapshot and the access the phone and the Mac show: ${JSON.stringify({ snapshot: dashHeld?.snapshot, access: dashHeld?.access })}`);
  check(await fetched(snapshot) === 200, "the phone's /file serves the snapshot (200)");

  // Signed in nowhere: the Mac's picture is of a sign-in page, so nothing is filed as a snapshot and it is deleted.
  const before = new Set(readdirSync(captures));
  const admin = (await mcp.call("review_to_front", { summary: "The admin page", link: siteUrl("/admin") })).json;
  check(JSON.stringify([admin?.access?.mac, admin?.access?.anonymous]) === JSON.stringify(["sign-in", "sign-in"]) && admin?.snapshot === undefined,
    `a page that asked the Mac to sign in too: ${JSON.stringify(admin?.access)}, no snapshot`);
  check(admin?.warning === "The page asked for sign-in on the Mac too, so the user will see a login page. Ask them to sign in once in conch's review pane, or publish a capture/screenshot instead.",
    `…warning: ${admin?.warning}`);
  check(readdirSync(captures).filter((name) => !before.has(name)).length === 0, "…and the Mac's picture of the sign-in page was deleted, not kept");

  // The sweep: a held snapshot is kept however old, a stray capture of the same age is not. Each capture prunes first.
  const monthAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(snapshot, monthAgo, monthAgo);
  const stray = join(captures, "stray-0001.png");
  writeFileSync(stray, png(1, 1));
  chmodSync(stray, 0o600);
  utimesSync(stray, monthAgo, monthAgo);
  const pricing = (await mcp.call("review_to_front", { summary: "The pricing page", link: siteUrl("/pricing") })).json;
  check(JSON.stringify([pricing?.access?.mac, pricing?.access?.anonymous]) === JSON.stringify(["page", "page"]) && pricing?.warning === undefined
    && typeof pricing?.snapshot === "string" && existsSync(pricing.snapshot),
    `a public page: page on both, no warning, and the Mac's snapshot attached: ${JSON.stringify(pricing?.access)}`);
  check(!existsSync(stray) && existsSync(snapshot), "the capture sweep took a month-old stray and kept the month-old snapshot a deliverable holds");

  // review_remove takes the snapshot with the filing.
  const pricingShot: string = pricing?.snapshot ?? "";
  check((await mcp.call("review_remove", { id: pricing?.id })).json?.outcome === "removed", "review_remove takes the pricing page back");
  check(Boolean(await until("its snapshot to go", 10_000, () => !existsSync(pricingShot))) && await fetched(pricingShot) !== 200,
    "…its snapshot is deleted with it, and the phone is no longer served it");
  check(existsSync(snapshot), "…while the dashboard's snapshot stays");

  // An MCP server from before the check doesn't say it waits for it: it is answered once filed, and the snapshot lands
  // on the deliverable afterwards.
  const old = await ask({
    type: "review-published", sessionId, label: "e2e", cwd: project, announce: "older", eventAt: Date.now(), awaitVerdict: true,
    review: { summary: "The dashboard, from an older MCP server", link: siteUrl("/dashboard?from=old") },
  });
  check(old?.kind === "review-filed" && old?.access === undefined && old?.snapshot === undefined,
    `an older MCP server's publication is answered once filed, without the check: ${JSON.stringify(old).slice(0, 160)}`);
  const late = await until("the older publication's snapshot", 10_000, () => {
    const one = held().find((candidate) => candidate.id === old?.filing?.id) as (Held & { snapshot?: { path: string } }) | undefined;
    return one?.snapshot ? one : null;
  });
  check(Boolean(late?.snapshot?.path.startsWith(`${captures}/`)), `…and the snapshot is put on its deliverable once drawn: ${late?.snapshot?.path}`);

  check(siteRequests.length > 0 && siteRequests.every((request) => !request.headers.cookie && !request.headers.authorization),
    `the site saw ${siteRequests.length} requests from conch's own look, none with a cookie or an Authorization header`);
} catch (error) {
  check(false, `the run threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await macApp?.stop();
  site.stop(true);
  mcp.server.stdin.end();
  await stop(mcp.server, "mcp server");
  await stop(daemon, "daemon");
  rmSync(scratch, { recursive: true, force: true });
  if (keep) say(`kept ${root} and ${outside}`);
  else {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
