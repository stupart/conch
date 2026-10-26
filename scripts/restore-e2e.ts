#!/usr/bin/env bun
/**
 * Sessions come back after the Mac restarts, end to end (`src/restart-recovery.ts`): this checkout's daemon, a
 * fake Claude Code that registers the way the real one does, and a restart played by killing everything and
 * starting the daemon again under another boot (`CONCH_BOOT_TIME`).
 *
 *   died        The Mac went down with conch running (the daemon is SIGKILLed, the sessions with it, their registry
 *               files left behind as a real kill leaves them). Expected: both come back, as background sessions,
 *               resuming their own conversations, and the app is told.
 *   power-off   The Mac told the app it was shutting down; the sessions ended first (Terminal quitting before conch),
 *               then conch stopped cleanly. Expected: both come back.
 *   quit        conch was quit before the restart. Expected: nothing starts by itself; both are offered, and Bring
 *               them back starts them.
 *
 *   bun scripts/restore-e2e.ts [--keep]
 *
 * Nothing real is touched. The daemon gets a temporary HOME, CONCH_CONFIG_DIR, CLAUDE_CONFIG_DIR and socket, and its
 * tmux servers live in a temporary TMUX_TMPDIR under a socket name of their own, with $TMUX unset: on 2026-10-02 a
 * `tmux kill-server` run from inside a conch session followed $TMUX to the user's real server and ended every
 * background session they had. This script refuses to run unless both servers it could reach are its own.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function send(socket: string, message: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socket, () => client.write(JSON.stringify(message) + "\n"));
    let reply = "";
    client.on("data", (data) => { reply += data.toString(); });
    client.on("end", () => resolve(reply));
    client.on("error", reject);
    setTimeout(() => { client.destroy(); resolve(reply); }, 5_000);
  });
}

/** Registers as Claude Code does (`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`), says how it was started, and waits. */
const FAKE_CLAUDE = `#!/bin/bash
id=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && id="$a"; prev="$a"; done
[ -z "$id" ] && id=$(uuidgen | tr 'A-Z' 'a-z')
mkdir -p "$CLAUDE_CONFIG_DIR/sessions"
echo "$$ $*" >> "$E2E_LAUNCHES"
reg="$CLAUDE_CONFIG_DIR/sessions/$$.json"
printf '{"pid":%d,"sessionId":"%s","cwd":"%s","startedAt":%d,"kind":"interactive","entrypoint":"cli","status":"idle","name":"e2e-%s"}' \\
  $$ "$id" "$PWD" $(($(date +%s)*1000)) "\${id:0:8}" > "$reg"
trap 'rm -f "$reg"; exit 0' TERM INT HUP
while :; do sleep 1; done
`;

type Scenario = "died" | "power-off" | "quit";

async function run(scenario: Scenario): Promise<void> {
  say(`── ${scenario} ──`);
  // A short /tmp path: a unix socket path must fit sockaddr_un.
  const root = mkdtempSync(join("/tmp", `conch-rs-${scenario}-`));
  const home = join(root, "home");
  const claudeDir = join(root, "claude");
  const bin = join(root, "bin");
  const none = join(root, "none");
  const work = join(root, "work");
  const tmuxDir = join(root, "tmux");
  for (const dir of [home, claudeDir, bin, none, work, tmuxDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  // A background session runs through a login shell, where macOS's path_helper reorders PATH; the fake goes first
  // there the way a person's own profile puts their claude first. Never the real one.
  writeFileSync(join(home, ".zprofile"), `export PATH="${bin}:$PATH"\n`);
  const launches = join(root, "launches.log");
  writeFileSync(launches, "");
  const socket = join(root, "conch.sock");
  const tmuxSocket = `e2e-${process.pid}`;
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
    E2E_LAUNCHES: launches,
  };
  // Never the user's servers: no $TMUX to follow, and both sockets this tmux could reach are under this root.
  const tmuxEnv = { ...env };
  if ("TMUX" in tmuxEnv || !env.TMUX_TMPDIR.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");
  const tmux = (...args: string[]) => Bun.spawnSync([TMUX, ...args], { env: tmuxEnv, stdout: "pipe", stderr: "pipe" });

  const daemonArgv = [process.execPath, join(repo, "src", "cli.ts"), "daemon"];
  const startDaemon = (boot: number) => Bun.spawn(daemonArgv, {
    env: { ...env, CONCH_BOOT_TIME: String(boot) }, cwd: work, stdout: "ignore", stderr: "ignore",
  });
  const ledger = () => {
    try { return JSON.parse(readFileSync(join(root, "config", "running-sessions.json"), "utf8")); } catch { return null; }
  };
  const published = () => {
    try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE, "utf8")); } catch { return null; }
  };
  const launchesOf = (id: string) => readFileSync(launches, "utf8").split("\n").filter((line) => line.includes(`--resume ${id}`));
  /** Started again after the restart: a launch by a process that isn't one of the originals. */
  let originals = new Set<string>();
  const resumedFrom = (id: string) => launchesOf(id).filter((line) => !originals.has(line.split(" ")[0]!));
  /** Its registry entry names a process that is alive: listed because it runs, not because a file was left. */
  const runningAgain = (id: string) => {
    try {
      for (const name of readdirSync(join(claudeDir, "sessions"))) {
        const entry = JSON.parse(readFileSync(join(claudeDir, "sessions", name), "utf8"));
        if (entry.sessionId !== id || originals.has(String(entry.pid))) continue;
        try { process.kill(entry.pid, 0); return true; } catch {}
      }
    } catch {}
    return false;
  };

  const ids: string[] = [crypto.randomUUID(), crypto.randomUUID()];
  const BOOT_BEFORE = 1_790_000_000;
  const BOOT_AFTER = BOOT_BEFORE + 4 * 60 * 60;
  let daemon = startDaemon(BOOT_BEFORE);
  // Two sessions in "Terminal": plain processes, in no tmux pane.
  const terminals = ids.map((id) => Bun.spawn(["/bin/bash", join(bin, "claude"), "--resume", id], {
    env: { ...env }, cwd: work, stdout: "ignore", stderr: "ignore",
  }));
  try {
    await until("the daemon's socket", () => existsSync(socket));
    await until("both started", () => ids.every((id) => launchesOf(id).length === 1));
    originals = new Set(ids.map((id) => launchesOf(id)[0]!.split(" ")[0]!));
    await until("both sessions in the ledger", () => {
      const records = ledger()?.records ?? [];
      return ids.every((id) => records.some((record: { conversationId: string }) => record.conversationId === id));
    });
    say("  the ledger has both sessions, with how to start them again");

    if (scenario === "power-off") {
      await send(socket, { kind: "system-power-off" });
      await until("the power-off noted", () => ledger()?.poweringOffAt !== undefined);
      // Terminal quits before conch does: the sessions end while conch is still looking.
      for (const terminal of terminals) terminal.kill("SIGTERM");
      await Bun.sleep(4_000);
      daemon.kill("SIGTERM");
      await daemon.exited;
    } else if (scenario === "quit") {
      daemon.kill("SIGTERM");
      await daemon.exited;
      for (const terminal of terminals) terminal.kill("SIGTERM");
    } else {
      // The Mac died: everything at once, no clean stop, registry files left behind.
      daemon.kill("SIGKILL");
      for (const terminal of terminals) terminal.kill("SIGKILL");
      await daemon.exited;
    }
    await Promise.all(terminals.map((terminal) => terminal.exited));
    const stored = ledger();
    say(`  down: stopped cleanly=${stored?.stoppedAt !== undefined}, power-off noted=${stored?.poweringOffAt !== undefined}`);

    // The Mac starts again.
    daemon = startDaemon(BOOT_AFTER);
    await until("the daemon's socket", () => existsSync(socket));
    if (scenario === "quit") {
      const offered = await until("both offered", () => {
        const restore = published()?.restore;
        return restore?.offered?.length === 2 ? restore : undefined;
      });
      await Bun.sleep(3_000);
      if (ids.some((id) => resumedFrom(id).length)) throw new Error("a session started though conch was quit before the restart");
      say(`  offered, not started: ${offered.offered.map((s: { label: string }) => s.label).join(", ")}`);
      await send(socket, { kind: "restore-sessions", accept: true });
    }
    await until("both resumed", () => ids.every((id) => resumedFrom(id).length > 0));
    // As background sessions, on conch's own (test) server.
    const panes = await until("both in conch's background server", () => {
      const listing = tmux("-L", tmuxSocket, "list-panes", "-a", "-F", "#{session_name} #{pane_pid}");
      const rows = listing.stdout.toString().trim().split("\n").filter((row) => /^conch-[0-9a-f-]{36} \d+$/.test(row));
      return rows.length >= 2 ? rows : undefined;
    });
    const restore = await until("the app told", () => {
      const notice = published()?.restore;
      return notice?.restored?.length === 2 ? notice : undefined;
    });
    await until("both running and listed again", () => {
      const rows = published()?.rows ?? [];
      return ids.every((id) => runningAgain(id) && rows.some((row: { id: string }) => row.id === id)) || undefined;
    });
    say(`  brought back as background sessions (${panes.length} panes), listed again, and the app told: ${restore.restored.map((s: { label: string }) => s.label).join(", ")}`);
    for (const id of ids) {
      if (resumedFrom(id).length !== 1) throw new Error(`${id} was started ${resumedFrom(id).length} times`);
    }
    // Named as the list names them, never by a conversation id.
    if (restore.restored.some((s: { label: string }) => ids.includes(s.label))) throw new Error("the notice names a session by its conversation id");
    say(`  ✓ ${scenario}`);
  } finally {
    daemon.kill("SIGKILL");
    for (const terminal of terminals) terminal.kill("SIGKILL");
    // Only the test's own server, by its own socket name. Never a bare kill-server.
    tmux("-L", tmuxSocket, "kill-server");
    if (!keep) rmSync(root, { recursive: true, force: true });
    else say(`  kept ${root}`);
  }
}

let failed = false;
for (const scenario of (process.env.E2E_ONLY ? [process.env.E2E_ONLY] : ["died", "power-off", "quit"]) as Scenario[]) {
  try {
    await run(scenario);
  } catch (error) {
    failed = true;
    say(`  ✗ ${scenario}: ${(error as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
