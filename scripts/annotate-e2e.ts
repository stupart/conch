#!/usr/bin/env bun
/**
 * Annotate, end to end (docs/annotate.md): this checkout's daemon and this checkout's Mac app, against each other and
 * nothing else. Three sessions (a stand-in `claude` that writes down every line typed into it) run in the daemon's own
 * tmux server and each publish a deliverable through the MCP tool's own handler: a live page served from here, a
 * picture, and a folder pointing at its README. The app, launched as a harness (`CONCH_HARNESS`, AnnotateHarness.swift),
 * walks the journey in its real pane — a hover, a click on an element, words selected, a box and a spot on a picture,
 * words in a document, an edit, a removal, the page changed and reloaded under its notes, Send — photographing each step
 * light and dark, and the script checks what reached each session: one message, its frames in agent ink's words, its
 * pictures on disk. Then the page's session ends, and Send is refused with the notes kept.
 *
 *   bun scripts/annotate-e2e.ts [--app <conch-mac.app>] [--shots <dir>] [--keep]
 *
 * Build the app first, into the worktree (never /Applications), under a bundle id of its own, so its preferences are
 * never conch's (the window it remembers, the session it shows):
 *   xcodebuild -project mac-app/conch-mac.xcodeproj -scheme conch-mac -configuration Debug -destination 'platform=macOS' \
 *     -derivedDataPath build/harness.noindex CODE_SIGNING_ALLOWED=NO PRODUCT_BUNDLE_IDENTIFIER=ai.blueprintstudio.conch.harness -quiet build
 *
 * Nothing real is touched: the daemon gets a temporary HOME, config, Claude folder, socket and sessions file; its tmux
 * server is its own (TMUX_TMPDIR in the temp root, its own socket name, $TMUX unset), and is stopped by that name alone;
 * the harness app has preferences of its own (deleted afterwards), answers only its own request folder
 * (`DebugSnapshot.answersRequests`), shows no floating panels, and is stopped by its own pid. The daemon's clipboard,
 * AppleScript and sound commands are stand-ins that record any call. Nothing plays audio, opens the microphone, downloads
 * a model or touches the clipboard.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createMcpToolHandlers, defaultMcpDependencies, dispatchJsonRpc } from "../src/mcp.ts";

const repo = resolve(import.meta.dir, "..");
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const keep = process.argv.includes("--keep");
const app = resolve(argument("--app") ?? join(repo, "build/harness.noindex/Build/Products/Debug/conch-mac.app"));
const shots = resolve(argument("--shots") ?? "/tmp/annotate-shots");
const TMUX = "/Applications/conch.app/Contents/Helpers/tmux";

const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

if (!existsSync(join(app, "Contents/MacOS/conch-mac"))) {
  console.error(`no app at ${app}: build it first (see the header)`);
  process.exit(2);
}
if (app.startsWith("/Applications/")) {
  console.error("refusing: the harness is this checkout's build, never the installed conch");
  process.exit(2);
}
const HARNESS_ID = "ai.blueprintstudio.conch.harness";
const bundleId = Bun.spawnSync(["/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", join(app, "Contents/Info.plist")]).stdout.toString().trim();
if (bundleId !== HARNESS_ID) {
  console.error(`refusing: the app is ${bundleId}; build it as ${HARNESS_ID} (see the header) so it never shares conch's preferences`);
  process.exit(2);
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    let value: T | undefined | null | false = undefined;
    try { value = await probe(); } catch {}
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

function socketSend(socket: string, message: Record<string, unknown>): Promise<string> {
  return new Promise((done, fail) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    client.on("data", (data) => { reply += data.toString(); });
    client.on("end", () => done(reply));
    client.on("error", fail);
    setTimeout(() => { client.destroy(); done(reply); }, 20_000);
  });
}

// ── The sandbox ──────────────────────────────────────────────────────────────────────────────────────────────────────
// A short /tmp path: a unix socket path must fit sockaddr_un.
const root = mkdtempSync("/tmp/conch-ann-");
const home = join(root, "home");
const claudeDir = join(root, "claude");
const bin = join(root, "bin");
const none = join(root, "none");
const work = join(root, "work");
const tmuxDir = join(root, "tmux");
const harness = join(root, "harness");
const received = join(root, "received");
const annotations = join(root, "annotations");
for (const dir of [home, claudeDir, bin, none, work, tmuxDir, harness, received, annotations, shots]) mkdirSync(dir, { recursive: true });
for (const old of readdirSync(shots)) if (old.endsWith(".png")) rmSync(join(shots, old));

/**
 * The stand-in session: registers as Claude Code does (`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`), keeps a transcript
 * where Claude Code keeps one, and for every message typed into it (lines that arrive together) writes the message down
 * twice — in `received/<id>.log` for this script, and as a user entry in its transcript, which is how the daemon knows a
 * send was taken (delivery-evidence.ts). It never answers.
 */
const FAKE_CLAUDE = String.raw`#!${process.execPath}
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const id = crypto.randomUUID();
const config = process.env.CLAUDE_CONFIG_DIR;
mkdirSync(join(config, "sessions"), { recursive: true });
const registry = join(config, "sessions", process.pid + ".json");
writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", name: "e2e-" + id.slice(0, 8) }));
const folder = join(config, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(folder, { recursive: true });
const transcript = join(folder, id + ".jsonl");
const entry = (type, content) => appendFileSync(transcript, JSON.stringify({ type, uuid: crypto.randomUUID(), sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content } }) + "\n");
entry("assistant", [{ type: "text", text: "Ready." }]);
const end = () => { try { rmSync(registry); } catch {} process.exit(0); };
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, end);
console.log("fake claude " + id + " ready");
let held = [];
let timer;
const take = () => {
  const text = held.join("\n");
  held = [];
  appendFileSync(join(process.env.E2E_RECEIVED, id + ".log"), text + "\n\u0000\n");
  entry("user", text);
};
for await (const line of console) {
  held.push(line);
  clearTimeout(timer);
  timer = setTimeout(take, 400);
}
end();
`;
writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
chmodSync(join(bin, "claude"), 0o755);
// Nothing the daemon does may reach the real clipboard or another app: these stand-ins record any call and do nothing.
const calls = join(root, "calls.log");
for (const name of ["pbcopy", "pbpaste", "osascript", "afplay", "say"]) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\ncat > /dev/null 2>&1 || true\nexit 0\n`);
  chmodSync(join(bin, name), 0o755);
}
// A background session runs through a login shell, where path_helper reorders PATH: the stand-in goes first there.
writeFileSync(join(home, ".zprofile"), `export PATH="${bin}:$PATH"\n`);

const socket = join(root, "conch.sock");
const tmuxSocket = `ann-${process.pid}`;
const env: Record<string, string> = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  TMUX_TMPDIR: tmuxDir,
  CONCH_TMUX: TMUX,
  CONCH_TMUX_SOCKET: tmuxSocket,
  CONCH_STARTED_BY: "app",
  CONCH_SOCKET: socket,
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: claudeDir,
  CODEX_HOME: join(root, "codex"),
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()),
  CONCH_APP_BUNDLE: join(root, "no-app"),
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  CONCH_WHISPER_CLI: join(none, "whisper-cli"),
  CONCH_WHISPER_SERVER: join(none, "whisper-server"),
  CONCH_WHISPER_MODEL: join(none, "model.bin"),
  CONCH_VAD_MODEL: join(none, "vad.bin"),
  CONCH_SOX: join(none, "sox"),
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_PHONE: "0",
  CONCH_RECORDS_ENABLED: "0",
  E2E_RECEIVED: received,
};
// Never the user's tmux: no $TMUX to follow, and the only server this tmux can reach is under this root.
if ("TMUX" in env || !env.TMUX_TMPDIR!.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");
const tmux = (...args: string[]) => Bun.spawnSync([TMUX, "-L", tmuxSocket, ...args], { env, stdout: "pipe", stderr: "pipe" });

// ── What the sessions publish ──────────────────────────────────────────────────────────────────────────────────────
/** The page, served live: version 2 drops the Team plan, as the agent's next change would. */
let pageVersion = 1;
const landing = (version: number) => `<!doctype html><html><head><meta charset="utf-8"><title>Tidewater · Ship with fewer meetings</title><style>
  :root { color-scheme: light; } * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; color: #14212b; background: #f6f8f7; }
  nav { display: flex; align-items: center; gap: 28px; padding: 18px 48px; background: #fff; border-bottom: 1px solid #e3e9e6; }
  nav .logo { font-weight: 700; font-size: 18px; letter-spacing: -0.01em; margin-right: auto; }
  nav a { color: #45545e; text-decoration: none; font-size: 14px; }
  .hero { padding: 64px 48px 40px; max-width: 980px; }
  .hero h1 { font-size: 46px; line-height: 1.08; letter-spacing: -0.02em; margin: 0 0 16px; }
  .hero p.lede { font-size: 19px; color: #45545e; max-width: 620px; margin: 0 0 28px; }
  .cta { display: inline-block; padding: 12px 20px; border-radius: 10px; font-weight: 600; text-decoration: none; margin-right: 10px; }
  .cta.primary { background: #0f6e5f; color: #fff; } .cta.ghost { color: #0f6e5f; border: 1px solid #b8d4cc; }
  #pricing { display: flex; gap: 18px; padding: 8px 48px 64px; }
  .card { flex: 1; background: #fff; border: 1px solid #e3e9e6; border-radius: 14px; padding: 22px; }
  .card h3 { margin: 0 0 6px; font-size: 17px; } .card .price { font-size: 30px; font-weight: 700; margin: 0 0 10px; }
  .card p { margin: 0; color: #5a6a73; font-size: 14px; }
</style></head><body>
<nav><span class="logo">Tidewater</span><a href="#product">Product</a><a href="#pricing">Pricing</a><a href="#docs">Docs</a></nav>
<section class="hero">
  <h1 id="headline">Ship with fewer meetings and calmer weeks for the whole team</h1>
  <p class="lede">Tidewater turns every standup into a two-minute written update,
    so your team spends the morning building.</p>
  <a class="cta primary" href="https://tidewater.example/signup">Start free trial</a><a class="cta ghost" href="#demo">Watch the demo</a>
</section>
<section id="pricing">
  <div class="card"><h3>Solo</h3><div class="price">$0</div><p>One workspace, unlimited updates.</p></div>
  ${version === 1 ? `<div class="card"><h3>Team</h3><div class="price">$12</div><p>Per person, per month. Shared threads.</p></div>` : ""}
  <div class="card" data-testid="plan-pro"><h3>Pro</h3><div class="price">$29</div><p>SSO, audit log, priority support.</p></div>
</section>
</body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(landing(pageVersion), { headers: { "content-type": "text/html; charset=utf-8" } }) });
const page = `http://127.0.0.1:${server.port}/`;

mkdirSync(join(work, "shots"), { recursive: true });
copyFileSync(join(repo, "docs/images/conch-mac.png"), join(work, "shots", "conch-window.png"));
const module = join(work, "module");
mkdirSync(join(module, "src"), { recursive: true });
writeFileSync(join(module, "README.md"), `# Tidewater sync

The service that turns standups into written updates.

## Running it

Install the dependencies, then run npm run dev to start the server on port 5173.
Open the page and sign in with the demo account.

## Configuration

Set \`TIDEWATER_TOKEN\` before starting. Later, run npm run dev again after changing it.
`);
writeFileSync(join(module, "src", "server.ts"), "export const port = 5173;\n");

// ── The daemon and three sessions ───────────────────────────────────────────────────────────────────────────────────
const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
  env, cwd: work, stdout: Bun.file(join(root, "daemon.stdout.log")), stderr: Bun.file(join(root, "daemon.stderr.log")),
});
say(`temp root ${root}; daemon ${daemon.pid}; page ${page}`);

type Review = { summary: string; link?: string; kind?: string; id?: string };
type Row = { id: string; label: string; review?: Review };
const published = (): { rows?: Row[] } | null => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")); } catch { return null; }
};
const registry = (): Array<{ pid: number; sessionId: string }> => {
  try {
    return readdirSync(join(claudeDir, "sessions")).map((name) => JSON.parse(readFileSync(join(claudeDir, "sessions", name), "utf8")));
  } catch { return []; }
};
const log = (id: string): string => {
  try { return readFileSync(join(received, `${id}.log`), "utf8"); } catch { return ""; }
};
/** The annotate messages a session was sent, each whole: what else was typed into it (`/rename …`) left out. */
const messages = (id: string): string[] => log(id).split("\n\u0000\n").map((each) => each.trim()).filter((each) => each.includes("[annotate]"));

let appPid: number | undefined;
/** On a failure, what the app showed and held then: a picture and its state, beside the others. */
let lastLook: (() => Promise<void>) | undefined;
try {
  await until("the daemon's socket", () => existsSync(socket));
  const sessions: Array<{ pid: number; id: string; name: string }> = [];
  for (const name of ["landing page", "hero shot", "sync docs"]) {
    const before = new Set(registry().map((entry) => entry.sessionId));
    const reply = await socketSend(socket, { kind: "session-start", backend: "claude", host: "background", cwd: work, trustFolder: true });
    if (!reply.includes("session-started")) throw new Error(`session-start: ${reply}`);
    const entry = await until(`${name} to register`, () => registry().find((each) => !before.has(each.sessionId)));
    await until(`${name} listed`, () => published()?.rows?.some((row) => row.id === entry.sessionId));
    sessions.push({ pid: entry.pid, id: entry.sessionId, name });
  }
  say(`three background sessions on tmux -L ${tmuxSocket}: ${sessions.map((s) => s.id.slice(0, 8)).join(", ")}`);

  // Each publishes as itself: the MCP tool's handlers, their caller the session's own process.
  let rpc = 0;
  const call = async (pid: number, name: string, args: Record<string, unknown>) => {
    const handlers = createMcpToolHandlers(
      { claudeDir, socketPath: socket, sessionsPath: env.CONCH_SESSIONS_FILE! },
      { ...defaultMcpDependencies, parentPid: () => pid },
    );
    const response = await dispatchJsonRpc({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }, handlers);
    const result = (response as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
    if (result?.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
    return result?.content?.[0]?.text ?? "";
  };
  const [pageSession, pictureSession, folderSession] = sessions as [typeof sessions[0], typeof sessions[0], typeof sessions[0]];
  for (const session of sessions) await call(session.pid, "conch_rename", { session: session.id, label: session.name });
  await call(pageSession.pid, "review_to_front", { summary: "The Tidewater landing page", link: page, kind: "url" });
  await call(pictureSession.pid, "review_to_front", { summary: "conch's window, as it looks now", link: join(work, "shots", "conch-window.png") });
  await call(folderSession.pid, "review_to_front", { summary: "The sync service's README", link: module, focus: ["README.md"] });
  const rows = await until("three deliverables and labels", () => {
    const all = published()?.rows ?? [];
    const ours = sessions.map((session) => all.find((row) => row.id === session.id));
    return ours.every((row, index) => row?.review && row.label === sessions[index]!.name) ? (ours as Row[]) : undefined;
  });
  check(true, `published: ${rows.map((row) => `${row.label} → ${row.review!.kind ?? "?"}`).join(", ")}`);
  const pictureLink = rows[1]!.review!.link!;
  const folderLink = rows[2]!.review!.link!;

  // ── The harness ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Set up already, as far as the app can tell from this config: no welcome over the window.
  mkdirSync(env.CONCH_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(env.CONCH_CONFIG_DIR!, "onboarding.json"),
    JSON.stringify({ phone: { declined: [], stage: "waiting" }, returning: false, finished: true, version: 1, step: "welcome", marks: {}, putAway: true, reopening: false }));
  const open = Bun.spawnSync(["/usr/bin/open", "-n", "-g", "-a", app,
    "--env", `CONCH_HARNESS=${harness}`, "--env", `CONCH_SOCKET=${socket}`, "--env", `CONCH_STATE_FILE=${env.CONCH_SESSIONS_FILE}`,
    "--env", `CONCH_LOG_FILE=${env.CONCH_LOG_FILE}`, "--env", `CONCH_ANNOTATIONS_DIR=${annotations}`, "--env", `CONCH_CONFIG_DIR=${env.CONCH_CONFIG_DIR}`,
    "--args", "-conch.showConversation", "NO", "-conch.showControlBar", "NO", "-conch.showReplyLine", "NO", "-conch.overlays", "NO",
  ]);
  if (open.exitCode !== 0) throw new Error(`open: ${open.stderr.toString()}`);
  const executable = join(app, "Contents/MacOS/conch-mac");
  appPid = await until("the harness app", () => {
    const listed = Bun.spawnSync(["/usr/bin/pgrep", "-f", executable]).stdout.toString().trim().split("\n").filter(Boolean).map(Number);
    return listed.length === 1 ? listed[0] : undefined;
  });
  say(`harness app ${appPid} (${executable})`);

  let seq = 0;
  type Result = { seq: number; ok: boolean; error?: string; state?: any; path?: string; value?: string; window?: { number: number } };
  const ask = async (request: Record<string, unknown>): Promise<Result> => {
    const n = ++seq;
    writeFileSync(join(harness, "request.json.tmp"), JSON.stringify({ seq: n, ...request }));
    Bun.spawnSync(["/bin/mv", join(harness, "request.json.tmp"), join(harness, "request.json")]);
    const result = await until(`the app to do ${request.do}`, () => {
      try {
        const read = JSON.parse(readFileSync(join(harness, "result.json"), "utf8")) as Result;
        return read.seq === n ? read : undefined;
      } catch { return undefined; }
    }, 20_000);
    if (!result.ok) throw new Error(`${request.do}: ${result.error}`);
    return result;
  };
  const state = async () => (await ask({ do: "state" })).state;
  const settle = () => Bun.sleep(700);
  let shotCount = 0;
  const shoot = async (name: string) => {
    await settle();
    const path = join(shots, `${String(++shotCount).padStart(2, "0")}-${name}.png`);
    await ask({ do: "shot", path });
    say(`  📷 ${path}`);
    return path;
  };

  lastLook = async () => {
    const path = join(shots, "failure.png");
    const looked = await ask({ do: "shot", path }).catch(() => undefined);
    const held = await ask({ do: "state" }).catch(() => undefined);
    say(`  what the app showed: ${looked ? path : "no picture"}; held ${JSON.stringify(held?.state)}; windows ${JSON.stringify((held as any)?.windows)}`);
  };
  await until("the app's window", async () => (await ask({ do: "open" })).window, 30_000);
  await ask({ do: "window", width: 1320, height: 840 });
  await ask({ do: "appearance", dark: false });

  // ── 1. A page ─────────────────────────────────────────────────────────────────────────────────────────────────────
  say("── a page: an element, words, another element, an edit, the page changed and reloaded, Send");
  await ask({ do: "select", session: pageSession.id });
  await ask({ do: "stage", mode: "sideBySide" });
  await until("the page in the pane", async () => { const s = await state(); return s?.kind === "page" && s?.place?.startsWith(page) ? s : undefined; });
  await shoot("page-open");
  await ask({ do: "annotate", on: true });
  check((await state()).annotating === true, "Annotate is on for the page");
  await shoot("page-annotating");
  await ask({ do: "hover", selector: "a.cta.primary" });
  await until("the hover outline", async () => (await state())?.hover);
  await shoot("page-hover");
  await ask({ do: "click", selector: "a.cta.primary" });
  const one = await until("a note pinned to the button", async () => { const s = await state(); return s?.draft?.picture ? s.draft : undefined; });
  check(one.frame === '{selector: "a.cta.primary"}', `a click pinned a note to ${one.frame}, with its picture`);
  await ask({ do: "type", text: "Make this the biggest thing above the fold" });
  await shoot("page-note");
  await ask({ do: "save" });
  await ask({ do: "words", selector: ".lede" });
  const two = await until("a note on the words", async () => (await state())?.draft);
  check(two.frame.startsWith("{quote: ") && !two.frame.includes("\\n"), `selected words became one line: ${two.frame}`);
  await ask({ do: "type", text: "Too long. Five words at most." });
  await ask({ do: "save" });
  await ask({ do: "click", selector: "#pricing .card:nth-of-type(2)" });
  const three = await until("a note on the Team plan", async () => { const s = await state(); return s?.draft?.picture ? s.draft : undefined; });
  check(three.frame === '{selector: "div.card:nth-of-type(2)"}', `the Team plan's card: ${three.frame}`);
  await ask({ do: "type", text: "Highlight this plan" });
  await ask({ do: "save" });
  await ask({ do: "annotate", on: false });
  await shoot("page-three-notes");
  await ask({ do: "list", open: true });
  await shoot("page-list");
  await ask({ do: "list", open: false });
  await ask({ do: "edit", n: 1 });
  await ask({ do: "type", text: "Make this the biggest thing above the fold, and green" });
  await shoot("page-edit");
  await ask({ do: "save" });
  let s = await state();
  check(s.notes.length === 3 && s.notes[0].words.endsWith("and green"), "edited in place: note 1 keeps its number with its new words");

  // The agent's next change drops the Team plan, and the page reloads under the notes.
  pageVersion = 2;
  await ask({ do: "reload" });
  s = await until("note 3 missing after the reload", async () => { const t = await state(); return t?.notes?.[2]?.found === false && t?.notes?.[0]?.found === true ? t : undefined; });
  check(s.notes[2].found === false && s.notes[0].placed && s.notes[1].placed, "after a reload notes 1 and 2 are found again; note 3's element is gone");
  await shoot("page-reloaded-missing");

  await ask({ do: "send" });
  const pageMessage = await until("the page's session to receive the notes", () => messages(pageSession.id)[0]);
  await shoot("page-sent");
  const pageLines = pageMessage.trim().split("\n");
  check(pageLines[0]!.startsWith(annotations) && pageLines[0]!.endsWith("/overview.png"), `the message opens with the overview: ${pageLines[0]}`);
  check(pageLines[1] === `[annotate] Tyler left 3 notes on your deliverable "The Tidewater landing page" (${page}).`, pageLines[1]!);
  check(pageMessage.includes('1. {selector: "a.cta.primary"}, the <a> "Start free trial": "Make this the biggest thing above the fold, and green"'), "note 1: its selector, element and edited words");
  check(pageMessage.includes('2. {quote: "Tidewater turns every standup into a two-minute written update,"} (selected: "Tidewater turns every standup into a two-minute written update, so your team spends the morning building."): "Too long. Five words at most."'),
    "note 2: the quote is one line of the selected words, all of them alongside");
  check(pageMessage.includes('3. {selector: "div.card:nth-of-type(2)"}, the <div> "Team $12 Per person, per month. Shared threads.": "Highlight this plan" (not on the page when sent: it changed after this was pinned)'),
    "note 3: still sent, saying its element was gone");
  const pictures = [...pageMessage.matchAll(/Picture: (\S+\.png)/g)].map((match) => match[1]!);
  check(pictures.length === 3 && pictures.every((path) => existsSync(path) && statSync(path).size > 1_000), `each note's picture is on disk: ${pictures.map((p) => p.split("/").pop()).join(", ")}`);
  const json = JSON.parse(readFileSync(pageMessage.match(/JSON: (\S+notes\.json)/)![1]!, "utf8"));
  check(json.notes.length === 3 && json.notes[0].frame.selector === "a.cta.primary" && json.notes[0].element.attributes.href === "https://tidewater.example/signup" && json.notes[2].found === false,
    "notes.json has each frame, the element's attributes and what was found");
  s = await state();
  check(s.notes.length === 0 && s.annotating === false && /Sent to landing page/.test(s.notice ?? ""), `the pins cleared and the tray says "${s.notice}"`);

  // ── 2. A picture ──────────────────────────────────────────────────────────────────────────────────────────────────
  say("── a picture: a box and a spot");
  await ask({ do: "select", session: pictureSession.id });
  await ask({ do: "stage", mode: "sideBySide" });
  await until("the picture in the pane", async () => (await state())?.kind === "picture");
  await ask({ do: "annotate", on: true });
  await ask({ do: "drag", from: [0.06, 0.2], to: [0.3, 0.62], hold: true });
  await shoot("picture-dragging");
  await ask({ do: "drag", from: [0.06, 0.2], to: [0.3, 0.62] });
  const box = await until("the box's note", async () => { const t = await state(); return t?.draft?.picture ? t.draft : undefined; });
  check(box.frame === `{image: ${JSON.stringify(pictureLink)}}`, `a box on the picture: ${box.frame}`);
  await ask({ do: "type", text: "The sidebar's rows are too tight here" });
  await shoot("picture-note");
  await ask({ do: "save" });
  await ask({ do: "drag", from: [0.82, 0.09], to: [0.82, 0.09] });
  await until("the spot's note", async () => (await state())?.draft?.picture);
  await ask({ do: "type", text: "Put the session's name here" });
  await ask({ do: "save" });
  await shoot("picture-two-notes");
  await ask({ do: "send" });
  const pictureMessage = await until("the picture's session to receive the notes", () => messages(pictureSession.id)[0]);
  check(new RegExp(`1\\. \\{image: ${JSON.stringify(pictureLink).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\} rect \\[0\\.060, 0\\.200, 0\\.240, 0\\.420\\]: "The sidebar's rows are too tight here"`).test(pictureMessage),
    "the box: its image and its rect in fractions, as a mark takes them");
  check(pictureMessage.includes("} at [0.820, 0.090]: \"Put the session's name here\""), "the spot: its fractions");
  check(pictureMessage.includes("The picture with the notes numbered:"), "the overview is the picture with the notes on it");

  // ── 3. A folder's file ────────────────────────────────────────────────────────────────────────────────────────────
  say("── a folder: words in its README");
  await ask({ do: "select", session: folderSession.id });
  await ask({ do: "stage", mode: "sideBySide" });
  await until("the README in the folder's pane", async () => { const t = await state(); return t?.kind === "document" && t?.place?.endsWith("README.md") ? t : undefined; });
  await ask({ do: "annotate", on: true });
  await shoot("folder-annotating");
  await ask({ do: "doc-select", text: "run npm run dev to start the server" });
  await until("the words' note", async () => (await state())?.draft);
  await ask({ do: "type", text: "It's bun now: bun run dev" });
  await shoot("folder-note");
  await ask({ do: "save" });
  await ask({ do: "send" });
  const folderMessage = await until("the folder's session to receive the note", () => messages(folderSession.id)[0]);
  const readme = join(folderLink, "README.md");
  check(folderMessage.startsWith(`[annotate] Tyler left 1 note on your deliverable "The sync service's README" (${folderLink}).`), "a document has no overview: the message opens with what it is");
  check(folderMessage.includes(`1. {quote: "run npm run dev to start the server"} in ${readme}: "It's bun now: bun run dev"`), "the note names its quote and the file in the folder");

  // ── 4. Dark ───────────────────────────────────────────────────────────────────────────────────────────────────────
  say("── dark");
  await ask({ do: "appearance", dark: true });
  await ask({ do: "select", session: pageSession.id });
  await ask({ do: "stage", mode: "sideBySide" });
  await until("the page again", async () => (await state())?.kind === "page");
  await ask({ do: "annotate", on: true });
  await ask({ do: "hover", selector: "a.cta.ghost" });
  await until("the hover outline", async () => (await state())?.hover);
  await shoot("dark-page-hover");
  await ask({ do: "click", selector: "#headline" });
  await until("a note on the headline", async () => (await state())?.draft?.picture);
  await ask({ do: "type", text: "Shorter: Ship with fewer meetings" });
  await shoot("dark-page-note");
  await ask({ do: "save" });
  await ask({ do: "click", selector: "[data-testid=plan-pro]" });
  await ask({ do: "type", text: "Pro should be the one highlighted now" });
  await ask({ do: "save" });
  await ask({ do: "list", open: true });
  await shoot("dark-page-list");
  await ask({ do: "list", open: false });

  // ── 5. The session ends ───────────────────────────────────────────────────────────────────────────────────────────
  say("── the page's session ends with notes waiting");
  const before = messages(pageSession.id).length;
  process.kill(pageSession.pid, "SIGTERM");
  // The daemon lists it no longer, and its deliverable goes with it: the pane moves on.
  await until("the session's row to go", () => !published()?.rows?.some((row) => row.id === pageSession.id), 60_000);
  check(true, "the page's session ended: its row, and the deliverable with it, left conch's list");
  await ask({ do: "select", session: pictureSession.id });
  s = await until("the next deliverable to say the notes weren't sent", async () => {
    const t = await state();
    return /landing page ended with 2 notes you hadn't sent/.test(t?.notice ?? "") ? t : undefined;
  });
  await shoot("dark-session-ended");
  await Bun.sleep(1_500);
  check(messages(pageSession.id).length === before, `nothing was sent to the ended session, and the next pane says "${s.notice}" with Copy and Discard`);
  await ask({ do: "discard" });
  s = await state();
  check(s.notice === null, "Discard lets them go");
  await ask({ do: "appearance", dark: false });
  const touched = existsSync(calls) ? readFileSync(calls, "utf8").trim() : "";
  check(touched === "", `nothing reached the clipboard or another app: ${touched || "no pbcopy, pbpaste, osascript, afplay or say"}`);
  const daemonLog = readFileSync(env.CONCH_LOG_FILE!, "utf8");
  const confirmed = daemonLog.split("\n").filter((line) => /injected into ".*" via tmux — confirmed sent/.test(line));
  check(confirmed.length === 3 && !daemonLog.includes("NOT confirmed"), `each of the 3 Sends was confirmed by its session's own transcript (${confirmed.length} confirmed)`);
} catch (error) {
  failures.push((error as Error).message);
  say(`✗ ${(error as Error).message}`);
  await lastLook?.();
} finally {
  if (appPid) {
    // Our own instance only: the pid pgrep found for this build's executable.
    try { process.kill(appPid, "SIGTERM"); } catch {}
  }
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  // Only the test's own server, by its own socket name. Never a bare kill-server.
  tmux("kill-server");
  server.stop(true);
  Bun.spawnSync(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-u", app]);
  // The harness's own preferences, never conch's: the bundle id was checked above.
  Bun.spawnSync(["/usr/bin/defaults", "delete", HARNESS_ID]);
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed:\n  ${failures.join("\n  ")}` : `✓ all passed; pictures in ${shots}`);
process.exit(failures.length ? 1 : 0);
