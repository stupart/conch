#!/usr/bin/env bun
/**
 * Setup's practice turn (src/practice.ts), end to end: the source daemon in a temporary home, asked what the Mac app's
 * Try it step asks. Speech and recording are stand-ins on a private PATH, and nothing is audible and no microphone
 * opens:
 *   - `say` records the line it was given and when, sleeps as if speaking, and plays nothing;
 *   - `sox` records when it was started, opens the capture file it's given and writes nothing to it, and waits to be
 *     stopped: the mic window closes on silence;
 *   - whisper-server and whisper-cli are stand-ins too, and the models are empty files: speech recognition reads ready;
 *   - `afplay`, `pbcopy`, `osascript` and `tmux` record any call, so a sound, a paste or a keystroke would show.
 * Before the daemon starts, the script checks that PATH resolves `say` and `afplay` to the stand-ins, and stops if not.
 *
 * It shows the practice session appearing (first row, its line in its conversation, the line spoken before the mic
 * opens), the welcome card held (Ready), a typed answer echoed into its own conversation with nothing typed or pasted
 * anywhere, the card opened, and cleanup: when the app's lease goes away, on practice-stop, and across a daemon killed
 * mid-practice and started again.
 *
 *   bun scripts/practice-e2e.ts [--keep]
 *
 * Never touches the live daemon, its socket or logs (/tmp/conch.sock, /tmp/conch-sessions.json), or the real ~/.claude,
 * ~/.codex, ~/.config/conch: every path the daemon writes is in the temp dir, and each daemon is stopped by its own pid.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

const SESSION = "conch-practice";

// What must be the same after as before: the real agents' settings, and the real home's practice folder. (The live
// daemon and app keep writing ~/.config/conch and /tmp/conch-sessions.json themselves, so those are kept away from by
// construction instead: every CONCH_* path below is in the temp root, and that is checked.)
const watched = [
  join(homedir(), ".claude", "settings.json"),
  join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".codex", "hooks.json"),
  join(homedir(), ".cache", "conch", "practice"),
];
const stamp = () => watched.map((file) => (existsSync(file) ? `${file} ${statSync(file).mtimeMs}:${statSync(file).size}` : `${file} absent`));
const before = stamp();

const root = mkdtempSync(join(tmpdir(), "conch-practice-e2e-"));
const home = join(root, "home");
const bin = join(root, "bin");
const claudeDir = join(root, "claude");
for (const dir of [home, bin, claudeDir]) mkdirSync(dir, { recursive: true });
const calls = join(root, "calls.log");
const pids = join(root, "stub-pids");
const now = `/usr/bin/perl -MTime::HiRes=time -e 'printf "%.3f", time'`;

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/bash\necho "$(${now}) ${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}
// Speaking: a second and a half of nothing, then done.
stub("say", `/bin/sleep 1.5\necho "$(${now}) say-done" >> "${calls}"\nexit 0`);
// The microphone: the capture file sox would open, left empty (silence), until conch stops it.
stub("sox", `echo $$ >> "${pids}"\nprev=""; for a in "$@"; do if [ "$prev" = "raw" ]; then : > "$a"; echo "$a" >> "${join(root, "raw-files")}"; fi; prev="$a"; done\nexec /bin/sleep 120`);
stub("whisper-server", `echo $$ >> "${pids}"\nexec /bin/sleep 120`);
stub("whisper-cli", "exit 1");
for (const name of ["afplay", "pbcopy", "osascript", "tmux"]) stub(name, "exit 0");
// No agent runs, real or otherwise: a call to either would show in the calls log.
for (const name of ["claude", "codex"]) stub(name, "exit 1");
const models = join(root, "models");
mkdirSync(models);
writeFileSync(join(models, "whisper.bin"), "stand-in");
writeFileSync(join(models, "vad.bin"), "stand-in");

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const env: Record<string, string> = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  CONCH_STARTED_BY: "terminal",
  CONCH_SOCKET: join(root, "conch.sock"),
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: claudeDir,
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()),
  CONCH_APP_BUNDLE: join(root, "no-app"),
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  CONCH_WHISPER_CLI: join(bin, "whisper-cli"),
  CONCH_WHISPER_SERVER: join(bin, "whisper-server"),
  CONCH_WHISPER_MODEL: join(models, "whisper.bin"),
  CONCH_VAD_MODEL: join(models, "vad.bin"),
  CONCH_SOX: join(bin, "sox"),
  // The Mac's own voice, through the stand-in `say`; no bell, no cues, no phone, no meeting watch.
  CONCH_TTS: "say",
  CONCH_SPEAK: "1",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_PHONE: "0",
  CONCH_MEETING_AUTOPAUSE: "0",
  CONCH_KEYSTROKE_FALLBACK: "0",
  CONCH_LISTEN_WINDOW_SECS: "2",
  CONCH_VOICE_QA: "0",
};

// Nothing audible, whatever happens next: PATH has to find the stand-ins first.
for (const name of ["say", "afplay", "sox", "pbcopy", "osascript", "tmux", "claude"]) {
  const found = Bun.which(name, { PATH: env.PATH });
  if (found !== join(bin, name)) {
    console.error(`refusing to start: ${name} resolves to ${found}, not the stand-in`);
    process.exit(2);
  }
}
check(true, "PATH resolves say, afplay, sox, pbcopy, osascript, tmux and claude to the stand-ins (nothing can sound, paste, type or run an agent)");
check(env.HOME === home && env.CONCH_HOME === home && !env.PATH.includes("homebrew") && !env.PATH.includes(homedir()),
  "the daemon's HOME is the temp home, and its PATH has no Homebrew and nothing of the real home");
const paths = Object.entries(env).filter(([name, value]) => /^(CONCH_(SOCKET|CONFIG_DIR|LOG_FILE|STATE_FILE|SESSIONS_FILE|REVIEWS_FILE|TELEMETRY_FILE|INJECT_DEBUG_LOG)|CLAUDE_CONFIG_DIR|TMPDIR)$/.test(name) && value);
check(paths.length === 10 && paths.every(([, value]) => value.startsWith(root)),
  "its socket, config, logs, state, sessions and reviews files are all in the temp root, never /tmp/conch.sock or ~/.config/conch");

const published = (): Record<string, any> | null => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")); } catch { return null; }
};
const practiceRow = () => (published()?.rows as Array<Record<string, any>> | undefined)?.find((row) => row.id === SESSION);
const callLines = (): string[] => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
const cardDir = join(home, ".cache", "conch", "practice");

async function until<T>(what: string, timeoutMs: number, probe: () => T | Promise<T>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(probe).catch(() => null);
    if (value) return value;
    await Bun.sleep(100);
  }
  say(`… gave up waiting for ${what}`);
  return null;
}

/** One request: every line before the daemon ends the connection. */
function ask(request: unknown, timeoutMs = 20_000): Promise<Array<Record<string, any>>> {
  return new Promise((done, fail) => {
    const socket = connect(env.CONCH_SOCKET!);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); fail(new Error(`no answer to ${JSON.stringify(request)}`)); }, timeoutMs);
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => {
      clearTimeout(timer);
      socket.end();
      done(data.trim().split("\n").filter(Boolean).map((text) => JSON.parse(text)));
    });
    socket.on("error", (error) => { clearTimeout(timer); fail(error); });
    socket.write(JSON.stringify(request) + "\n");
  });
}

/** A practice-start, as the app opens it: the reply, and the connection held as the lease. */
function lease(): Promise<{ reply: Record<string, any>; socket: Socket; ended: Promise<void> }> {
  return new Promise((done, fail) => {
    const socket = connect(env.CONCH_SOCKET!);
    let data = "";
    const ended = new Promise<void>((resolve) => socket.on("end", () => resolve()));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) done({ reply: JSON.parse(data.split("\n")[0]!), socket, ended });
    });
    socket.on("error", fail);
    socket.write(JSON.stringify({ kind: "practice-start" }) + "\n");
  });
}

function startDaemon(name: string) {
  const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
    env, cwd: root, stdin: "ignore",
    stdout: Bun.file(join(root, `${name}.stdout.log`)), stderr: Bun.file(join(root, `${name}.stderr.log`)),
  });
  say(`source daemon ${name} started, pid ${daemon.pid}`);
  return daemon;
}

async function ready(): Promise<boolean> {
  const answering = await until("the socket", 30_000, async () => (await ask({ kind: "ping" }, 5_000))[0]?.kind === "pong");
  const engine = await until("speech recognition ready", 30_000, () => published()?.speechEngine?.state === "ready");
  return Boolean(answering && engine);
}

async function stopDaemon(daemon: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
  daemon.kill(signal);
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  say(`daemon ${daemon.pid} stopped (${signal})`);
}

say(`temp root ${root}`);
let daemon = startDaemon("first");
try {
  check(await ready(), "the daemon answers its own socket and publishes speech recognition ready (stand-ins)");
  let state = published()!;
  check(state.features?.practice === 1, `it says it can do a practice turn: features ${JSON.stringify(state.features)}`);
  check(!practiceRow() && state.practice === undefined, "no practice session before one is asked for");

  // Start: the app's lease, the session published, the line spoken, then the mic.
  const first = await lease();
  check(first.reply.kind === "practice-started" && first.reply.sessionId === SESSION, `practice-start: ${JSON.stringify(first.reply)}`);
  const appeared = await until("the practice row", 5_000, () => practiceRow());
  check(Boolean(appeared) && published()!.rows[0].id === SESSION, "the practice session is published, first among the rows");
  check(appeared?.backend === "conch" && appeared?.active === true && typeof appeared?.noTerminal === "string", `…conch's own, active, with no terminal (${JSON.stringify({ backend: appeared?.backend, active: appeared?.active })})`);
  const firstItem = published()?.conversations?.[SESSION]?.items?.[0];
  check(firstItem?.kind === "assistant" && /^Hi, I'm conch\./.test(firstItem.text), `its conversation starts with the line: "${firstItem?.text?.slice(0, 40)}…"`);

  const spoken = await until("the line spoken", 10_000, () => callLines().find((line) => line.includes(" say ")));
  check(Boolean(spoken?.includes("Hi, I'm conch. When an agent finishes a turn")), "the line went through the speech path to `say` (the stand-in)");
  const listening = await until("the mic window", 10_000, () => callLines().find((line) => line.includes(" sox ")));
  const saidDone = Number(callLines().find((line) => line.endsWith("say-done"))?.split(" ")[0] ?? NaN);
  const soxAt = Number(listening?.split(" ")[0] ?? NaN);
  check(Number.isFinite(saidDone) && Number.isFinite(soxAt) && soxAt >= saidDone,
    `the mic opened only once the line had finished (say done ${saidDone.toFixed(3)}, sox started ${soxAt.toFixed(3)})`);

  // Nothing is said into the stand-in microphone: the window closes on silence, and the card is held all the same.
  const card = await until("the welcome card", 20_000, () => (practiceRow()?.review ? practiceRow() : null));
  check(card?.status === "waiting" && card.review.summary === "Welcome to conch" && card.review.kind === "page", `Ready: the welcome card is held (${JSON.stringify(card?.review && { summary: card.review.summary, kind: card.review.kind })})`);
  check(existsSync(join(cardDir, "welcome.html")) && card?.review?.link === join(cardDir, "welcome.html"), `…in conch's own folder: ${card?.review?.link}`);
  check(published()?.practice?.stage === "ready" && published()?.practice?.silent === true, `published practice: ${JSON.stringify(published()?.practice)}`);

  // A typed answer from its composer: echoed into its own conversation, reported delivered, typed nowhere.
  const typed = await ask({ type: "inject", sessionId: SESSION, label: "Practice turn", announce: "Show me what you made.", origin: "user", awaitDelivery: true, opId: "e2e-1" });
  check(typed.at(-1)?.kind === "inject-done" && typed.at(-1)?.delivered === true, `the composer's send: ${JSON.stringify(typed.at(-1))}`);
  const echoed = await until("the echo", 5_000, () => published()?.conversations?.[SESSION]?.items?.find((item: any) => item.kind === "user"));
  check(echoed?.text === "Show me what you made.", "…echoed into the practice session's own conversation");
  check(published()?.practice?.heard === "Show me what you made.", "…and published as heard, for the tour's card");
  const touched = callLines().filter((line) => / (pbcopy|osascript|tmux|afplay|claude|codex) /.test(line));
  check(touched.length === 0, `nothing pasted, typed, played or asked of an agent: ${touched.length ? touched.join(" | ") : "no pbcopy, osascript, tmux, afplay, claude or codex"}`);
  const injectLog = existsSync(env.CONCH_INJECT_DEBUG_LOG!) ? readFileSync(env.CONCH_INJECT_DEBUG_LOG!, "utf8") : "";
  check(!injectLog.includes("begin"), "the inject path never began (its step log is empty)");

  // The Ready pill clicked: the card marked looked at, on the practice session.
  const viewed = await ask({ kind: "session-command", sessionId: SESSION, command: "review-viewed", review: card?.review?.id });
  check(viewed.at(-1)?.kind === "session-ack" && viewed.at(-1)?.changed === true, `review-viewed: ${JSON.stringify(viewed.at(-1))}`);
  check(Boolean(await until("viewed", 5_000, () => published()?.practice?.stage === "viewed")), "published practice stage: viewed");

  // The app goes away (its lease): the practice goes with it.
  first.socket.destroy();
  const gone = await until("the practice removed", 5_000, () => (!practiceRow() && published()?.practice === undefined ? true : null));
  check(Boolean(gone), "the app's lease closed: the row, the conversation and the practice block are gone");
  check(!published()?.conversations?.[SESSION], "…its conversation is not published");
  check(!existsSync(cardDir), "…and the card's folder is removed");

  // practice-stop ends it from the daemon's side, lease and all.
  const second = await lease();
  check(second.reply.kind === "practice-started", "started again");
  await until("the row again", 5_000, () => practiceRow());
  const stopped = await ask({ kind: "practice-stop" });
  check(stopped.at(-1)?.kind === "practice-stopped" && stopped.at(-1)?.removed === true, `practice-stop: ${JSON.stringify(stopped.at(-1))}`);
  const leaseEnded = await Promise.race([second.ended.then(() => true), Bun.sleep(5_000).then(() => false)]);
  check(leaseEnded, "…the daemon ended the app's lease");
  check(Boolean(await until("removed", 5_000, () => (!practiceRow() ? true : null))) && !existsSync(cardDir), "…and removed the session and its folder");

  // A crash mid-practice: killed hard with the card on disk, then started again. No ghost.
  const third = await lease();
  check(third.reply.kind === "practice-started", "started a third time");
  await until("the card again", 20_000, () => existsSync(join(cardDir, "welcome.html")));
  check(existsSync(join(cardDir, "welcome.html")), "the card is on disk when the daemon is killed");
  await stopDaemon(daemon, "SIGKILL");
  check(existsSync(join(cardDir, "welcome.html")), "…a daemon killed hard leaves it behind");
  daemon = startDaemon("restarted");
  check(await ready(), "the next daemon starts");
  check(!existsSync(cardDir), "…and empties the practice folder at its start");
  state = published()!;
  check(!practiceRow() && state.practice === undefined, "…and publishes no practice session");
} catch (error) {
  failures.push(String(error));
  say(`✗ ${error}`);
} finally {
  await stopDaemon(daemon);
  // The stand-ins the daemons started (their recorders and whisper-servers), by their own pids.
  if (existsSync(pids)) {
    for (const pid of readFileSync(pids, "utf8").split("\n").map(Number).filter((pid) => pid > 1)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  // The empty capture files the stand-in opened where the daemon asked (sox's own path): the daemon removes its own, and
  // any it didn't get to are removed here, by name.
  const raws = existsSync(join(root, "raw-files")) ? readFileSync(join(root, "raw-files"), "utf8").split("\n").filter(Boolean) : [];
  for (const raw of raws) rmSync(raw, { force: true });
  const log = existsSync(join(root, "daemon.log")) ? readFileSync(join(root, "daemon.log"), "utf8") : "";
  check(!/listen error/.test(log), "each mic window closed on its own silence, not an error");
  check(!/setup: installing|login shell/.test(log), "no installer and no login shell ran");
  check(!existsSync(join(home, ".claude", "settings.json")) && !existsSync(join(claudeDir, "settings.json")), "nothing wrote agent settings, even in the temp home");
  const after = stamp();
  check(JSON.stringify(after) === JSON.stringify(before), "the real ~/.claude, ~/.codex and ~/.cache/conch/practice are untouched");
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
