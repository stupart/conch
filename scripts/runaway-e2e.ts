#!/usr/bin/env bun
/**
 * The runaway guards, end to end (`src/runaway.ts`, docs/runaway-guards.md): this checkout's daemon, in a sandbox,
 * given something that keeps failing.
 *
 *   whisper    A whisper-server that comes up, answers, and dies two seconds later, every time. Expected: the first
 *              start and five restarts, then the breaker trips, the log says so once, the published state carries
 *              the trip for the Mac app, and nothing is spawned for the rest of the run. Before the guards each start
 *              that answered reset the supervisor's burst, so it was restarted every few seconds, forever.
 *   ceiling    A daemon whose process ceiling is 0, so every spawn it tries is refused. Expected: it stays up and keeps
 *              answering on its socket, says once that it stopped starting processes, and publishes that too.
 *
 *   bun scripts/runaway-e2e.ts [--keep]
 *
 * Nothing real is touched. The daemon gets a temporary HOME, CONCH_CONFIG_DIR, CLAUDE_CONFIG_DIR, socket, log and
 * state files, and a TMUX_TMPDIR of its own with $TMUX unset, as scripts/restore-e2e.ts does. It starts no session,
 * so no tmux server is started; the run checks that, and never kills a tmux server of any kind.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const say = (line: string) => console.log(line);

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

/** The app's own health ping: a line back means the daemon's loop is turning. */
function ping(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(socket, () => client.write(JSON.stringify({ kind: "ping", from: "runaway-e2e" }) + "\n"));
    client.on("data", (data) => { client.destroy(); resolve(data.toString().includes("\n")); });
    client.on("error", () => resolve(false));
    setTimeout(() => { client.destroy(); resolve(false); }, 3_000);
  });
}

/**
 * Says when it starts, answers the supervisor's canary (`GET /`, then a `POST /inference`), and dies two seconds later:
 * a server that loads, works, and falls over, every time. That reset the supervisor's burst on every start, so it was
 * restarted every few seconds for as long as the daemon lived.
 */
const FLAPPING_WHISPER = `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.E2E_WHISPER_STARTS, process.pid + "\\n");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) =>
  new URL(request.url).pathname === "/inference" ? Response.json({ text: "" }) : new Response("whisper") });
setTimeout(() => process.exit(1), 2_000);
`;

type Scenario = "whisper" | "ceiling";

async function run(scenario: Scenario): Promise<void> {
  say(`── ${scenario} ──`);
  // A short /tmp path: a unix socket path must fit sockaddr_un.
  const root = mkdtempSync(join("/tmp", `conch-rg-${scenario}-`));
  const home = join(root, "home");
  const none = join(root, "none");
  const fakes = join(root, "fakes");
  const work = join(root, "work");
  const tmuxDir = join(root, "tmux");
  for (const dir of [home, none, fakes, work, tmuxDir]) mkdirSync(dir, { recursive: true });
  const whisperServer = join(fakes, "whisper-server");
  writeFileSync(whisperServer, FLAPPING_WHISPER);
  chmodSync(whisperServer, 0o755);
  const whisperCli = join(fakes, "whisper-cli");
  writeFileSync(whisperCli, "#!/bin/bash\nexit 1\n");
  chmodSync(whisperCli, 0o755);
  // Explicit model paths that exist, so the engine is "ready" and fetches nothing.
  writeFileSync(join(fakes, "model.bin"), "");
  writeFileSync(join(fakes, "vad.bin"), "");
  const starts = join(root, "whisper-starts.log");
  writeFileSync(starts, "");
  const socket = join(root, "conch.sock");
  const log = join(root, "daemon.log");
  const sessionsFile = join(root, "sessions.json");
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CONCH_HOME: home,
    TMPDIR: `${root}/`,
    TMUX_TMPDIR: tmuxDir,
    CONCH_TMUX: "/Applications/conch.app/Contents/Helpers/tmux",
    CONCH_TMUX_SOCKET: `e2e-rg-${process.pid}`,
    CONCH_STARTED_BY: "app",
    CONCH_SOCKET: socket,
    CONCH_CONFIG_DIR: join(root, "config"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    CONCH_LOG_FILE: log,
    CONCH_STATE_FILE: join(root, "state.json"),
    CONCH_SESSIONS_FILE: sessionsFile,
    CONCH_REVIEWS_FILE: join(root, "reviews.json"),
    CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
    CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
    CONCH_WHISPER_PORT: String(freePort()),
    CONCH_APP_BUNDLE: join(root, "no-app"),
    CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
    CONCH_WHISPER_CLI: whisperCli,
    CONCH_WHISPER_SERVER: whisperServer,
    CONCH_WHISPER_MODEL: join(fakes, "model.bin"),
    CONCH_VAD_MODEL: join(fakes, "vad.bin"),
    CONCH_SOX: join(none, "sox"),
    CONCH_TTS: "say",
    CONCH_SPEAK: "0",
    CONCH_BELL: "0",
    CONCH_MIC_CUES: "0",
    CONCH_PHONE: "0",
    E2E_WHISPER_STARTS: starts,
    ...(scenario === "ceiling" ? { CONCH_CHILD_CEILING: "0" } : {}),
  };
  if ("TMUX" in env || !env.TMUX_TMPDIR.startsWith(root)) throw new Error("refusing: tmux would not be this test's own");
  const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
    env, cwd: work, stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(daemon.stderr).text();
  const logText = () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
  const published = () => { try { return JSON.parse(readFileSync(sessionsFile, "utf8")); } catch { return null; } };
  const whisperStarts = () => readFileSync(starts, "utf8").split("\n").filter(Boolean).length;
  let exited: number | null = null;
  void daemon.exited.then((code) => { exited = code; });
  try {
    await until("the daemon's socket", () => existsSync(socket));
    if (scenario === "whisper") {
      const tripped = await until("the whisper-server breaker to trip", () =>
        logText().split("\n").find((line) => line.includes("runaway guard: stopped restarting the speech engine (whisper-server)")));
      say(`  ${tripped.replace(/^\[conch [^\]]+\] /, "")}`);
      const atTrip = whisperStarts();
      if (atTrip !== 6) throw new Error(`whisper-server started ${atTrip} times by the trip, not 1 + 5`);
      const trip = await until("the trip published for the Mac app", () =>
        (published()?.guards ?? []).find((guard: { name: string }) => guard.name === "whisper-server"));
      say(`  published: ${trip.what}, ${trip.why}, tries again in ${Math.round((trip.retryAt - Date.now()) / 60_000)} min`);
      // Before the guards, the next canary (30 s) opened another burst of three, and every 30 s after.
      say("  waiting 40 s for a canary that must not restart it…");
      await Bun.sleep(40_000);
      if (whisperStarts() !== atTrip) throw new Error(`whisper-server was started again after the trip (${whisperStarts()} starts)`);
      const lines = logText().split("\n").filter((line) => line.includes("runaway guard:")).length;
      if (lines !== 1) throw new Error(`the trip was logged ${lines} times, not once`);
      say(`  ✓ ${atTrip} starts in all, none after the trip, said once`);
    } else {
      const refused = await until("the ceiling's note", () =>
        logText().split("\n").find((line) => line.includes("runaway guard: stopped starting more processes")));
      say(`  ${refused.replace(/^\[conch [^\]]+\] /, "")}`);
      await until("the ceiling published for the Mac app", () =>
        (published()?.guards ?? []).find((guard: { name: string }) => guard.name === "processes"));
      say("  published; checking it lives on with every spawn refused…");
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(2_000);
        if (exited !== null) throw new Error(`the daemon exited (${exited}) with its spawns refused`);
        if (!(await ping(socket))) throw new Error("the daemon stopped answering with its spawns refused");
      }
      if (whisperStarts() !== 0) throw new Error(`something was spawned past a ceiling of 0 (${whisperStarts()} whisper starts)`);
      const lines = logText().split("\n").filter((line) => line.includes("runaway guard: stopped starting more processes")).length;
      if (lines !== 1) throw new Error(`the ceiling was logged ${lines} times, not once`);
      say("  ✓ nothing spawned, alive and answering for 20 s, said once");
    }
    // tmux makes its folder (`tmux-<uid>`) for any client; a server would leave its socket in it.
    const servers = readdirSync(tmuxDir).flatMap((folder) => readdirSync(join(tmuxDir, folder)));
    if (servers.length) throw new Error(`a tmux server was started in the sandbox (${servers.join(", ")})`);
  } catch (error) {
    if (exited !== null) say(`  the daemon exited ${exited}; its stderr: ${(await stderr).slice(-2_000)}`);
    say(`  its log ends: ${logText().split("\n").slice(-15).join("\n    ")}`);
    throw error;
  } finally {
    daemon.kill("SIGKILL");
    await daemon.exited;
    if (!keep) rmSync(root, { recursive: true, force: true });
    else say(`  kept ${root}`);
  }
}

let failed = false;
for (const scenario of (process.env.E2E_ONLY ? [process.env.E2E_ONLY] : ["whisper", "ceiling"]) as Scenario[]) {
  try {
    await run(scenario);
  } catch (error) {
    failed = true;
    say(`  ✗ ${scenario}: ${(error as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
