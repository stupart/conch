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
 * Never plays audio, never opens the microphone, never downloads a model (the engine paths point at nothing), no phone
 * transport, and every process it stops is one it started, by pid.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  name: "Remove Jaidon from blueprintstudio.ai",
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
  const description: string = listed.result?.tools?.find((tool: { name: string }) => tool.name === "review_to_front")?.description ?? "";
  check(description.includes("surfaces") && description.includes("copiedFrom"), "review_to_front's description says what surfaces and copiedFrom are");

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
  check(second.json?.relabel?.label === "Remove Jaidon from blueprintstudio.ai" && /conch_rename/.test(second.json?.relabel?.hint ?? ""),
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
} catch (error) {
  check(false, `the run threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
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
