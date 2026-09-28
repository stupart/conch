#!/usr/bin/env bun
/**
 * `conch parity`, end to end against a real daemon from this checkout and a real tmux: a temporary home, its own
 * socket, its own sessions file, and a tmux server of its own (`tmux -L conch-parity-<pid>`, under the temporary
 * folder), nothing shared with a running conch or anyone's tmux. A fake TUI in that server draws a Claude Code-like
 * frame with a message in it; the session is registered at the pane's process, with a transcript whose newest prompt is
 * that message, so the daemon publishes it in conch's conversation. `conch parity --no-app` must say PASS; then the TUI
 * clears its screen and scrollback, redraws without the message, and it must say FAIL.
 *
 *   bun scripts/parity-e2e.ts [--keep]
 *
 * Never plays audio, never opens the microphone, never asks the Mac app for anything (`--no-app`), never types into
 * any pane, and stops its daemon and its tmux server by name and pid.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const keep = process.argv.includes("--keep");
const repo = join(import.meta.dir, "..");
const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

const tmuxBin = Bun.which("tmux");
if (!tmuxBin) {
  console.log("tmux isn't installed: nothing to run against");
  process.exit(0);
}

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
    await Bun.sleep(100);
  }
  say(`… gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

// A short /tmp path: a unix socket path must fit sockaddr_un.
const root = mkdtempSync(join("/tmp", "conch-parity-"));
const home = join(root, "home");
const claude = join(root, "claude");
const project = join(root, "project");
const none = join(root, "none");
for (const dir of [home, join(claude, "sessions"), join(claude, "projects", "-parity-e2e"), project, none]) mkdirSync(dir, { recursive: true });
if (join(root, "conch.sock") === "/tmp/conch.sock") throw new Error("refusing the live socket");

// tmux of our own: a label no one else uses, its socket folder inside the temporary root.
const label = `conch-parity-${process.pid}`;
const tmuxEnv = { ...process.env, TMUX_TMPDIR: root } as Record<string, string>;
delete tmuxEnv.TMUX;
const tmux = (...args: string[]) => Bun.spawnSync([tmuxBin, "-L", label, ...args], { env: tmuxEnv, stdout: "pipe", stderr: "pipe" });

const MESSAGE = "Parity check from the e2e: make the strip's Terminal a button that brings the session's own window forward, and keep the mirror behind Debug.";

// The fake TUI: a Claude Code-like frame, the message hard-wrapped at 50 columns under its prompt, a word of it
// coloured; SIGUSR1 clears the screen and the scrollback and draws the frame again without the message.
const tui = join(root, "fake-tui.ts");
writeFileSync(tui, String.raw`
const message = ${JSON.stringify(MESSAGE)};
const E = "\x1b";
const orange = E + "[38;2;215;119;87m";
function draw(withMessage) {
  let out = E + "[H" + E + "[2J" + E + "[3J";
  out += orange + "╭" + "─".repeat(48) + "╮" + E + "[39m\r\n";
  out += orange + "│" + E + "[39m " + orange + "✻" + E + "[39m Welcome to " + E + "[1mClaude Code" + E + "[0m!" + " ".repeat(26) + orange + "│" + E + "[39m\r\n";
  out += orange + "╰" + "─".repeat(48) + "╯" + E + "[39m\r\n\r\n";
  for (let n = 0; n < 30; n++) out += E + "[2mearlier output " + n + E + "[0m\r\n";
  if (withMessage) {
    const rows = message.match(/.{1,50}/g);
    rows.forEach((row, index) => {
      out += E + "[38;2;153;153;153m" + (index === 0 ? ">" : " ") + E + "[39m " + row.replace("Terminal", E + "[1;38;5;75mTermi" + E + "[22mnal" + E + "[39m") + "\r\n";
    });
    out += "\r\n" + E + "[38;5;244m●" + E + "[39m On it.\r\n";
  } else {
    out += E + "[38;5;244m●" + E + "[39m (cleared)\r\n";
  }
  out += "\r\n" + E + "[38;2;153;153;153m╭" + "─".repeat(48) + "╮" + E + "[39m\r\n";
  out += E + "[38;2;153;153;153m│" + E + "[39m > " + E + "[7m " + E + "[0m" + " ".repeat(44) + E + "[38;2;153;153;153m│" + E + "[39m\r\n";
  out += E + "[38;2;153;153;153m╰" + "─".repeat(48) + "╯" + E + "[39m";
  process.stdout.write(out);
}
process.on("SIGUSR1", () => draw(false));
draw(true);
setInterval(() => {}, 60_000);
`);

const sessionId = "e2e0cafe-0000-4000-8000-00000000fa11";
const env: Record<string, string> = {
  PATH: `${join(tmuxBin, "..")}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  CONCH_SOCKET: join(root, "conch.sock"),
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: claude,
  CODEX_HOME: join(root, "codex"),
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()),
  CONCH_APP_BUNDLE: join(none, "no-app"),
  // An engine that isn't there: nothing downloads, nothing listens.
  CONCH_SEASHELL_ROOT: join(none, "no-seashell"),
  CONCH_WHISPER_MODEL: join(none, "model.bin"),
  CONCH_WHISPER_CLI: join(none, "whisper-cli"),
  CONCH_WHISPER_SERVER: join(none, "whisper-server"),
  CONCH_VAD_MODEL: join(none, "vad.bin"),
  CONCH_SOX: join(none, "sox"),
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_RECORDS_ENABLED: "0",
  CONCH_PHONE: "0",
  TMUX_TMPDIR: root,
};

let daemon: ReturnType<typeof Bun.spawn> | null = null;
try {
  const created = tmux("new-session", "-d", "-s", "parity", "-x", "80", "-y", "24", `exec ${process.execPath} ${tui}`);
  check(created.exitCode === 0, `a tmux server of its own: -L ${label} ${created.stderr.toString().trim()}`);
  const socketPath = tmux("display-message", "-p", "#{socket_path}").stdout.toString().trim();
  const serverPid = tmux("display-message", "-p", "#{pid}").stdout.toString().trim();
  const panePid = Number(tmux("display-message", "-p", "-t", "parity", "#{pane_pid}").stdout.toString().trim());
  check(socketPath.startsWith(`${realpathSync(root)}/`) && panePid > 1, `its socket is under the temporary root (${socketPath}); the TUI is pid ${panePid}`);
  // The daemon's plain `tmux` reaches this server, and only it, the way a tmux client inside it would.
  env.TMUX = `${socketPath},${serverPid},0`;
  const drawn = await until("the TUI's frame", 10_000, () => tmux("capture-pane", "-p", "-t", "parity").stdout.toString().includes("On it."));
  check(Boolean(drawn), "the fake TUI drew its frame, the message in it");

  // The session: registered at the pane's process, as Claude Code registers a window, with its transcript.
  writeFileSync(join(claude, "sessions", `${panePid}.json`), JSON.stringify({
    pid: panePid, sessionId, cwd: project, startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", name: "parity-e2e",
  }));
  writeFileSync(join(claude, "projects", "-parity-e2e", `${sessionId}.jsonl`), [
    { type: "user", message: { role: "user", content: MESSAGE }, promptSource: "typed", origin: { kind: "human" }, timestamp: new Date().toISOString() },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] }, timestamp: new Date().toISOString() },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
    env,
    cwd: root,
    stdin: "ignore",
    stdout: Bun.file(join(root, "daemon.stdout.log")),
    stderr: Bun.file(join(root, "daemon.stderr.log")),
  });
  say(`temp root ${root}; daemon pid ${daemon.pid}`);

  type Published = { rows?: Array<{ id: string; label: string }>; conversations?: Record<string, { items: Array<{ kind: string; text: string }> }> };
  const published = await until("the session and its conversation", 45_000, () => {
    const state = JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")) as Published;
    const row = state.rows?.find((candidate) => candidate.id === sessionId);
    const said = state.conversations?.[sessionId]?.items.some((item) => item.kind === "user" && item.text === MESSAGE);
    return row && said ? row : null;
  });
  check(Boolean(published), `the daemon publishes the session ("${published?.label}") with the message in conch's conversation`);

  const parity = async (out: string) => {
    const run = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "parity", sessionId.slice(0, 13), "--no-app", "--out", out], {
      env: { PATH: env.PATH!, HOME: home, CONCH_HOME: home, CONCH_SOCKET: env.CONCH_SOCKET!, CONCH_SESSIONS_FILE: env.CONCH_SESSIONS_FILE!, CONCH_CONFIG_DIR: env.CONCH_CONFIG_DIR!, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: env.CODEX_HOME! },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    for (const line of stderr.trim().split("\n").filter(Boolean)) say(`  stderr: ${line}`);
    for (const line of stdout.trim().split("\n").filter(Boolean)) say(`  stdout: ${line}`);
    return { code, lines: stdout.trim().split("\n") };
  };

  const pass = await parity(join(root, "parity-pass.png"));
  check(pass.code === 0 && pass.lines.at(-1)!.startsWith("PASS "), `PASS, exit ${pass.code}`);
  check(pass.lines.at(-1)!.includes("[tmux %"), "…read from the tmux pane");
  check(existsSync(join(root, "parity-pass.png")), "…and the picture is written where it was asked");

  // The message goes: the TUI clears its screen and scrollback, tmux's history too, and draws again without it.
  process.kill(panePid, "SIGUSR1");
  tmux("clear-history", "-t", "parity");
  const cleared = await until("the cleared frame", 10_000, () => tmux("capture-pane", "-p", "-S", "-", "-t", "parity").stdout.toString().includes("(cleared)"));
  const kept = tmux("capture-pane", "-p", "-J", "-S", "-", "-t", "parity").stdout.toString();
  check(Boolean(cleared) && !kept.includes("Parity check from the e2e"), "the text is gone from the screen and the scrollback");

  const fail = await parity(join(root, "parity-fail.png"));
  check(fail.code === 1 && fail.lines.at(-1)!.startsWith("FAIL "), `FAIL, exit ${fail.code}`);

  if (keep) {
    for (const name of ["parity-pass.png", "parity-fail.png"]) {
      if (existsSync(join(root, name))) copyFileSync(join(root, name), join(root, `kept-${name}`));
    }
  }
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!exited) daemon.kill("SIGKILL");
    say(`daemon ${daemon.pid} stopped`);
  }
  const killed = tmux("kill-server");
  say(`tmux -L ${label} kill-server: exit ${killed.exitCode}`);
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
