#!/usr/bin/env bun
/**
 * Moving a running session off a retired Claude profile, end to end (src/retired-profile.ts): this checkout's daemon,
 * a fake Claude Code that keeps its conversation where the real one does, and the restart conch's app asks for.
 *
 *   1. A session runs in a second profile ("Blueprint"), in conch's background host, and writes a turn.
 *   2. The profile is retired. conch no longer offers it, and lists its conversation as Default's.
 *   3. Restart, as the session menu sends it. Expected: it comes back in Default, its conversation brought across
 *      whole (the turn it wrote included), the next turn written in Default, and the retired folder still holding
 *      everything it had.
 *
 *   bun scripts/one-account-e2e.ts [--keep]
 *
 * Nothing real is touched, as in restore-e2e.ts: a temporary HOME, CONCH_CONFIG_DIR, CLAUDE_CONFIG_DIR and socket, and
 * a tmux server of its own in a temporary TMUX_TMPDIR with $TMUX unset. That server is never killed: once its sessions
 * have ended it is told, by its own socket's full path, that it may exit when empty (conch keeps its server up with
 * `exit-empty off`), and it does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const TMUX = "/Applications/conch.app/Contents/Helpers/tmux";
const say = (line: string) => console.log(line);

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

function send(socket: string, message: Record<string, unknown>, ms = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    const done = () => {
      try { resolve(JSON.parse(reply.trim().split("\n")[0] ?? "")); } catch { resolve(reply); }
    };
    client.on("data", (data) => { reply += data.toString(); if (reply.includes("\n")) { client.destroy(); done(); } });
    client.on("end", done);
    client.on("error", reject);
    setTimeout(() => { client.destroy(); done(); }, ms);
  });
}

/**
 * Claude Code as far as conch can tell: a binary named claude (conch checks the process's executable before it presses
 * a key), `auth status`, `--resume <id>` finding the conversation under its profile's projects/ or giving up, a turn
 * appended to it, the registry entry, and two Ctrl-Ds to leave.
 */
const FAKE_CLAUDE = `
import { appendFileSync, mkdirSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] && !args[0].startsWith("-")) {
  if (args[0] === "auth") console.log(JSON.stringify({ loggedIn: true, email: "e2e@example.com" }));
  process.exit(0);
}
const dir = process.env.CLAUDE_CONFIG_DIR ?? "";
const at = args.indexOf("--resume");
const id = at >= 0 ? args[at + 1] : crypto.randomUUID();
appendFileSync(process.env.E2E_LAUNCHES, process.pid + " " + dir + " " + args.join(" ") + "\\n");
let transcript;
try {
  for (const project of readdirSync(join(dir, "projects"))) {
    if (readdirSync(join(dir, "projects", project)).includes(id + ".jsonl")) transcript = join(dir, "projects", project, id + ".jsonl");
  }
} catch {}
if (!transcript) { console.log("No conversation found with session ID: " + id); process.exit(1); }
appendFileSync(transcript, JSON.stringify({ type: "user", sessionId: id, cwd: process.cwd(), message: { content: "a turn in " + dir } }) + "\\n");
mkdirSync(join(dir, "sessions"), { recursive: true });
const registry = join(dir, "sessions", process.pid + ".json");
writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", name: "e2e-" + id.slice(0, 8) }));
const buffer = Buffer.alloc(1024);
for (let ends = 0; ends < 2;) { try { if (readSync(0, buffer) === 0) ends++; } catch { break; } }
rmSync(registry, { force: true });
process.exit(0);
`;

// A short /tmp path, as a unix socket path must fit sockaddr_un; its real one, as conch names profile folders by it.
const root = realpathSync(mkdtempSync(join("/tmp", "conch-oa-")));
const home = join(root, "home");
const claudeDir = join(root, "claude");
const conchDir = join(root, "config");
const blueprint = join(conchDir, "claude", "bp");
const bin = join(root, "bin");
const none = join(root, "none");
const work = join(root, "work");
const tmuxDir = join(root, "tmux");
for (const dir of [home, claudeDir, blueprint, bin, none, work, tmuxDir]) mkdirSync(dir, { recursive: true });
const source = join(root, "fake-claude.ts");
writeFileSync(source, FAKE_CLAUDE);
const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", join(bin, "claude")], { stdout: "pipe", stderr: "pipe" });
if (built.exitCode !== 0) throw new Error(`could not build the fake claude: ${built.stderr.toString()}`);
writeFileSync(join(home, ".zprofile"), `export PATH="${bin}:$PATH"\n`);
const launches = join(root, "launches.log");
writeFileSync(launches, "");
const socket = join(root, "conch.sock");
const tmuxSocket = `e2e-oa-${process.pid}`;
const env: Record<string, string> = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home, CONCH_HOME: home, TMPDIR: `${root}/`, TMUX_TMPDIR: tmuxDir,
  CONCH_TMUX: TMUX, CONCH_TMUX_SOCKET: tmuxSocket, CONCH_STARTED_BY: "app", CONCH_SOCKET: socket,
  CONCH_CONFIG_DIR: conchDir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(root, "codex"),
  CONCH_LOG_FILE: join(root, "daemon.log"), CONCH_STATE_FILE: join(root, "state.json"), CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"), CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"), CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()), CONCH_APP_BUNDLE: join(root, "no-app"), CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  CONCH_WHISPER_CLI: join(none, "whisper-cli"), CONCH_WHISPER_SERVER: join(none, "whisper-server"), CONCH_WHISPER_MODEL: join(none, "model.bin"),
  CONCH_VAD_MODEL: join(none, "vad.bin"), CONCH_SOX: join(none, "sox"), CONCH_TTS: "say", CONCH_SPEAK: "0", CONCH_BELL: "0",
  CONCH_MIC_CUES: "0", CONCH_PHONE: "0", E2E_LAUNCHES: launches,
};
if ("TMUX" in env || !env.TMUX_TMPDIR!.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");

const ID = crypto.randomUUID();
const project = work.replace(/[^A-Za-z0-9]/g, "-");
const original = JSON.stringify({ type: "user", sessionId: ID, cwd: work, message: { content: "the first turn, in Blueprint" } }) + "\n";
mkdirSync(join(blueprint, "projects", project), { recursive: true });
writeFileSync(join(blueprint, "projects", project, `${ID}.jsonl`), original);
const registry = (retired: boolean) => writeFileSync(join(conchDir, "claude-accounts.json"),
  JSON.stringify([{ id: "bp", label: "Blueprint", configDir: blueprint, ...(retired ? { retired: true } : {}) }]));
registry(false);

const published = () => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")); } catch { return null; }
};
const launchesOf = () => readFileSync(launches, "utf8").trim().split("\n").filter(Boolean);
const pids = () => launchesOf().map((line) => Number(line.split(" ")[0]));
const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], { env, cwd: work, stdout: "ignore", stderr: "ignore" });
let failed = false;
try {
  await until("the daemon's socket", () => existsSync(socket));
  const started = await send(socket, { kind: "session-start", backend: "claude", host: "background", cwd: work, resumeSessionId: ID, claudeAccountId: "bp", trustFolder: true }, 30_000);
  if (started?.kind !== "session-started") throw new Error(`the first start: ${JSON.stringify(started)}`);
  const first = await until("it running in Blueprint", () => launchesOf()[0]);
  if (!first.includes(` ${blueprint} `)) throw new Error(`started outside Blueprint: ${first}`);
  await until("its row, on Blueprint", () => published()?.rows?.find((row: any) => row.id === ID && row.claudeAccountId === "bp"));
  say("  a session runs in Blueprint, in conch's background host, and wrote a turn there");

  registry(true);
  const accounts = await send(socket, { kind: "claude-accounts", action: "list" }, 15_000);
  const offered = accounts?.accounts?.map((one: any) => one.label);
  if (JSON.stringify(offered) !== JSON.stringify(["Default"])) throw new Error(`offered after retiring: ${JSON.stringify(accounts)}`);
  const resumable = await send(socket, { kind: "resumable", limit: 20 }, 15_000);
  const listed = resumable?.sessions?.filter((one: any) => one.sessionId === ID);
  if (listed?.length !== 1 || listed[0].claudeAccountId !== "default") throw new Error(`listed after retiring: ${JSON.stringify(resumable)}`);
  const twice = await send(socket, { kind: "session-start", backend: "claude", host: "background", cwd: work, resumeSessionId: ID, claudeAccountId: "default", trustFolder: true }, 15_000);
  if (!JSON.stringify(twice).includes("already running") || launchesOf().length !== 1) throw new Error(`resumed as Default's while running in Blueprint: ${JSON.stringify(twice)}`);
  say("  retired: only Default is offered, its conversation is listed once, as Default's, and isn't started twice while it runs");

  const restarted = await send(socket, { kind: "session-close", sessionId: ID, restart: true }, 60_000);
  if (restarted?.kind !== "session-closed" && restarted?.restarted !== true) throw new Error(`the restart: ${JSON.stringify(restarted)}`);
  const second = await until("it running again", () => launchesOf()[1]);
  if (!second.includes(` ${claudeDir} `) || !second.includes(`--resume ${ID}`)) throw new Error(`restarted as: ${second}`);
  await until("its row, on Default", () => published()?.rows?.find((row: any) => row.id === ID && (row.claudeAccountId ?? "default") === "default"));
  const moved = readFileSync(join(claudeDir, "projects", project, `${ID}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line).message.content);
  const expected = ["the first turn, in Blueprint", `a turn in ${blueprint}`, `a turn in ${claudeDir}`];
  if (JSON.stringify(moved) !== JSON.stringify(expected)) throw new Error(`Default's copy: ${JSON.stringify(moved)}`);
  const left = readFileSync(join(blueprint, "projects", project, `${ID}.jsonl`), "utf8").trim().split("\n").length;
  if (left !== 2) throw new Error(`the retired folder's copy has ${left} lines`);
  const log = readFileSync(env.CONCH_LOG_FILE!, "utf8");
  if (!log.includes(`brought conversation ${ID} across from the retired "Blueprint" profile to "Default"`)) throw new Error("the daemon's log doesn't say it brought the conversation across");
  say("  restarted from conch: back in Default, its whole conversation brought across and going on there; Blueprint's copy kept");
  say("  ✓ moved off a retired profile");
} catch (error) {
  failed = true;
  say(`  ✗ ${(error as Error).message}`);
  say(`    launches: ${launchesOf().join(" | ")}`);
} finally {
  daemon.kill("SIGKILL");
  // The fakes are this test's own processes. With them gone its server has no sessions, and exits once let.
  for (const pid of pids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await Bun.sleep(500);
  const own = join(tmuxDir, `tmux-${process.getuid?.() ?? 501}`, tmuxSocket);
  if (existsSync(own)) Bun.spawnSync([TMUX, "-S", own, "set-option", "-g", "exit-empty", "on"], { env, stdout: "ignore", stderr: "ignore" });
  if (!keep) rmSync(root, { recursive: true, force: true });
  else say(`  kept ${root}`);
}
process.exit(failed ? 1 : 0);
