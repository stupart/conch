#!/usr/bin/env bun
/**
 * A session "In conch", end to end, against a real daemon from this checkout and a real tmux, with nothing shared with
 * a running conch or anyone's tmux: a temporary home, its own socket and sessions file, and conch's tmux server under a
 * throwaway label (`tmux -L conch-embed-test-<pid>`, its socket under the temporary folder).
 *
 *   bun scripts/embed-terminal-e2e.ts [--keep]
 *
 * The agent is never run. The daemon's login shell is replaced (CONCH_SESSION_SHELL) by one that records the command
 * conch gave it and runs a fake TUI instead of evaluating it. The fake is a copy of bun named `claude` — so the process
 * conch binds, closes and reads is a `claude` — that registers itself as Claude Code does, draws a prompt, and writes
 * what is submitted to its transcript.
 *
 * It checks: `session-start` with `host: "conch"` starts the session in conch's server with a login shell, in the
 * folder, with the start flags; the row is published with where it runs; a message is delivered by send-keys (one
 * line, then one across lines, as a paste), with no osascript, no clipboard and no Terminal, and `conch parity --no-app`
 * says PASS; a client attached as the Mac app attaches (`-f ignore-size`) sends Shift-Enter through as CSI u; the daemon
 * is restarted and adopts the session again from tmux alone, and a message still lands; `session-close` ends it with
 * Ctrl-D through send-keys. Then the throwaway server is killed by name.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { connect } from "node:net";
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

const tmuxBin = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find((path) => existsSync(path)) ?? Bun.which("tmux");
if (!tmuxBin) {
  console.log("tmux isn't installed: nothing to run against");
  process.exit(0);
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

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// A short /tmp path: a unix socket path must fit sockaddr_un.
const root = realpathSync(mkdtempSync(join("/tmp", "conch-embed-")));
const home = join(root, "home");
const claude = join(root, "claude");
const project = join(root, "project");
const bin = join(root, "bin");
const none = join(root, "none");
for (const dir of [home, join(claude, "sessions"), join(claude, "projects", "-embed-e2e"), project, bin, none]) mkdirSync(dir, { recursive: true });
if (join(root, "conch.sock") === "/tmp/conch.sock") throw new Error("refusing the live socket");

const label = `conch-embed-test-${process.pid}`;
const tmuxEnv = { ...process.env, TMUX_TMPDIR: root } as Record<string, string>;
delete tmuxEnv.TMUX;
const tmux = (...args: string[]) => Bun.spawnSync([tmuxBin, "-L", label, ...args], { env: tmuxEnv, stdout: "pipe", stderr: "pipe" });

// Stand-ins that record every call and do nothing: nothing can speak, paste, script another app, or reach the user's
// own tmux (conch's own server is reached through CONCH_TMUX, an absolute path).
const calls = join(root, "calls.log");
for (const name of ["say", "afplay", "sox", "pbcopy", "pbpaste", "osascript", "tmux", "open"]) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${name === "tmux" ? "exit 1" : "exit 0"}\n`);
  chmodSync(path, 0o755);
}
const callLines = (): string[] => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);

// The fake agent: bun, copied under the agent's name, running the fake TUI.
const fakeClaude = join(bin, "claude");
copyFileSync(process.execPath, fakeClaude);
chmodSync(fakeClaude, 0o755);

const SESSION = "e2e0cafe-0000-4000-8000-0000000e2e01";
const transcript = join(claude, "projects", "-embed-e2e", `${SESSION}.jsonl`);
const shellRecord = join(root, "shell.json");
const keysLog = join(root, "keys.log");
const tui = join(root, "fake-tui.ts");
writeFileSync(tui, String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
// What conch's login shell was asked to run, and where: recorded, never evaluated.
writeFileSync(${JSON.stringify(shellRecord)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(),
  env: { PATH: process.env.PATH, TERM: process.env.TERM, COLORTERM: process.env.COLORTERM, TMUX: process.env.TMUX ? "set" : "", CONCH_SOCKET: process.env.CONCH_SOCKET ?? "" },
}));
// Registered as Claude Code registers a window.
writeFileSync(${JSON.stringify(join(claude, "sessions"))} + "/" + process.pid + ".json", JSON.stringify({
  pid: process.pid, sessionId: ${JSON.stringify(SESSION)}, cwd: process.cwd(), startedAt: Date.now(), kind: "interactive", entrypoint: "cli", status: "idle", name: "embed-e2e",
}));
const record = (entry) => appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n");
record({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Ready." }] } });
const E = "\x1b";
let history = [];
let buffer = "";
let lastCtrlD = 0;
function draw() {
  let out = E + "[H" + E + "[2J";
  out += "✻ Welcome to Claude Code!\r\n\r\n";
  for (const line of history.slice(-12)) out += line + "\r\n";
  out += "\r\n" + "─".repeat(50) + "\r\n";
  out += buffer.split("\n").map((row, i) => (i ? "  " : "> ") + row).join("\r\n") + "\r\n";
  out += "─".repeat(50);
  process.stdout.write(out);
}
function submit() {
  const text = buffer;
  buffer = "";
  if (!text) return draw();
  text.split("\n").forEach((row, i) => history.push((i ? "  " : "> ") + row));
  history.push("● On it.");
  record({ type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
  record({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } });
  draw();
}
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  appendFileSync(${JSON.stringify(keysLog)}, Buffer.from(chunk).toString("hex").replace(/(..)/g, "$1 ").trim() + "\n");
  let s = Buffer.from(chunk).toString("utf8");
  while (s.length) {
    if (s.startsWith(E + "[200~")) {
      const end = s.indexOf(E + "[201~");
      const pasted = s.slice(6, end < 0 ? s.length : end);
      buffer += pasted.replace(/\r\n?/g, "\n");
      s = end < 0 ? "" : s.slice(end + 6);
    } else if (s.startsWith(E + "[13;2u")) { buffer += "\n"; s = s.slice(7); }
    else if (s[0] === "\r") { submit(); s = s.slice(1); }
    else if (s[0] === "\x15") { buffer = ""; s = s.slice(1); }
    else if (s[0] === "\x04") {
      if (!buffer && Date.now() - lastCtrlD < 800) process.exit(0);
      lastCtrlD = Date.now(); s = s.slice(1);
    }
    else if (s[0] === E) { s = s.slice(1); }
    else { buffer += s[0]; s = s.slice(1); }
  }
  draw();
});
draw();
`);
// The login shell's stand-in: the command conch gives it is an argument to the fake, which records it and never runs it.
const fakeShell = join(root, "fake-shell.sh");
writeFileSync(fakeShell, `#!/bin/sh\nexec '${fakeClaude}' '${tui}' "$@"\n`);
chmodSync(fakeShell, 0o755);

const env: Record<string, string> = {
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  TMUX_TMPDIR: root,
  CONCH_TMUX: tmuxBin,
  CONCH_TMUX_SOCKET: label,
  CONCH_SESSION_SHELL: fakeShell,
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
};
check(Bun.which("claude", { PATH: env.PATH }) === fakeClaude && !env.PATH.includes("homebrew"),
  "PATH finds the fake `claude` and no Homebrew: no real agent can be reached");

const published = (): Record<string, any> | null => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")); } catch { return null; }
};
const row = () => (published()?.rows as Array<Record<string, any>> | undefined)?.find((candidate) => candidate.id === SESSION);

function ask(request: unknown, timeoutMs = 30_000): Promise<Array<Record<string, any>>> {
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

function startDaemon(name: string) {
  const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
    env, cwd: root, stdin: "ignore",
    stdout: Bun.file(join(root, `${name}.stdout.log`)), stderr: Bun.file(join(root, `${name}.stderr.log`)),
  });
  say(`daemon ${name} started, pid ${daemon.pid}`);
  return daemon;
}
async function stopDaemon(daemon: ReturnType<typeof Bun.spawn>): Promise<void> {
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  say(`daemon ${daemon.pid} stopped`);
}
const answering = () => until("the socket", 30_000, async () => existsSync(env.CONCH_SOCKET!) && (await ask({ kind: "get-config" }, 5_000)).at(-1)?.kind === "config-snapshot");

async function parity(tag: string): Promise<{ code: number; last: string }> {
  const run = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "parity", SESSION.slice(0, 13), "--no-app", "--out", join(root, `parity-${tag}.png`)], {
    env: { ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout] = await Promise.all([run.exited, new Response(run.stdout).text()]);
  const last = stdout.trim().split("\n").at(-1) ?? "";
  say(`  parity: ${last}`);
  return { code, last };
}

/** Send as the Mac app's composer does, and wait for the daemon to say how it went. */
async function deliver(text: string, opId: string) {
  const before = callLines().length;
  const lines = await ask({ type: "inject", sessionId: SESSION, label: "embed-e2e", announce: text, origin: "user", awaitDelivery: true, opId });
  const done = lines.find((line) => line.kind === "inject-done");
  const touched = callLines().slice(before).filter((line) => /^(osascript|pbcopy|tmux) /.test(line));
  return { done, touched };
}

const MESSAGE = "Embedded terminal check: this went in by send-keys, and nothing came to the front.";
const MULTILINE = "Second message,\nacross two lines, as one paste.";
const AFTER_RESTART = "Third message, after the daemon restarted and adopted the session again.";

let daemon: ReturnType<typeof Bun.spawn> | null = null;
let panePid = 0;
try {
  daemon = startDaemon("first");
  check(Boolean(await answering()), "the daemon answers its own socket");

  // Start it In conch, as the New session sheet does.
  const reply = (await ask({ kind: "session-start", backend: "claude", cwd: project, host: "conch", options: { model: "opus" } })).at(-1);
  check(reply?.kind === "session-started" && reply.host === "conch", `session-start In conch: ${JSON.stringify(reply)}`);
  const hosted = reply?.hosted as { tmux: string; socket: string; session: string; pane: string } | undefined;
  check(Boolean(hosted) && hosted!.tmux === tmuxBin && hosted!.socket === join(root, `tmux-${process.getuid!()}`, label),
    `…in conch's own server, the throwaway one: ${hosted?.socket} (${hosted?.session}, ${hosted?.pane})`);
  const shell = await until("the fake agent", 10_000, () => existsSync(shellRecord) ? JSON.parse(readFileSync(shellRecord, "utf8")) : null);
  check(JSON.stringify(shell?.argv) === JSON.stringify(["-l", "-i", "-c", `cd -- '${project}' && exec claude --model 'opus'`]),
    `the login shell was asked for Terminal's command, with the start flags: ${JSON.stringify(shell?.argv)}`);
  check(shell?.cwd === project, `…in the folder: ${shell?.cwd}`);
  check(shell?.env?.COLORTERM === "truecolor" && shell?.env?.TMUX === "set" && shell?.env?.CONCH_SOCKET === "" && shell?.env?.PATH === "/usr/bin:/bin:/usr/sbin:/sbin",
    `…with Terminal's environment, not the daemon's: ${JSON.stringify(shell?.env)}`);
  panePid = Number(tmux("display-message", "-p", "-t", `=${hosted?.session}`, "#{pane_pid}").stdout.toString().trim());
  const options = tmux("show-options", "-s", "extended-keys").stdout.toString().trim();
  check(options === "extended-keys always" && tmux("show-options", "-g", "status").stdout.toString().trim() === "status off",
    `conch's options are on its server: ${options}, status off`);

  const adopted = await until("the hosted row", 8_000, () => (row()?.hosted ? row() : null));
  check(adopted?.hosted?.session === hosted?.session && adopted?.hosted?.pane === hosted?.pane && adopted?.revealable === true,
    `the row is published, and says where it runs: ${JSON.stringify(adopted?.hosted)}`);

  // One line: send-keys, then Enter.
  const first = await deliver(MESSAGE, "e2e-1");
  check(first.done?.delivered === true, `delivered: ${JSON.stringify(first.done)}`);
  check(first.touched.length === 0, `…with no osascript, no clipboard, and not the user's tmux: ${first.touched.join(" | ") || "none"}`);
  const debug = readFileSync(env.CONCH_INJECT_DEBUG_LOG!, "utf8");
  check(debug.includes(`findTmuxPane -> ${hosted?.pane} (-L ${label})`) && debug.includes("tmux send-keys exit=0") && debug.includes("tmux Enter exit=0"),
    "…by send-keys into the pane on conch's server (the inject step log)");
  const landed = await until("the message in the conversation", 15_000, () =>
    published()?.conversations?.[SESSION]?.items?.some((item: any) => item.kind === "user" && item.text === MESSAGE));
  check(Boolean(landed), "it reached the agent, which wrote it to its transcript");
  const pass = await parity("one-line");
  check(pass.code === 0 && pass.last.startsWith("PASS ") && pass.last.includes("[tmux %"), `conch parity --no-app: ${pass.last}`);

  // Across lines: one paste from a tmux buffer, then Enter.
  const second = await deliver(MULTILINE, "e2e-2");
  check(second.done?.delivered === true && second.touched.length === 0, `a message across lines, delivered: ${JSON.stringify(second.done)}`);
  check(readFileSync(env.CONCH_INJECT_DEBUG_LOG!, "utf8").includes("tmux paste-buffer exit=0"), "…as a paste from a tmux buffer");
  check(readFileSync(transcript, "utf8").includes(JSON.stringify(MULTILINE)), "…and it arrived whole, both lines");

  // The Mac app's client: attached exactly as the app attaches, it sends Shift-Enter through as CSI u.
  const client = String.raw`
import os, pty, sys, time, fcntl, termios, struct, select
tmux, sock, session = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execv(tmux, [tmux, "-u", "-S", sock, "attach-session", "-f", "ignore-size", "-t", "=" + session])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: os.read(fd, 65536)
            except OSError: return
drain(1.0)
os.write(fd, b"\x1b[13;2u")
drain(1.0)
os.kill(pid, 15)
`;
  const clientPath = join(root, "client.py");
  writeFileSync(clientPath, client);
  const attached = Bun.spawnSync(["/usr/bin/python3", clientPath, tmuxBin, hosted!.socket, hosted!.session], { env: tmuxEnv, stdout: "pipe", stderr: "pipe" });
  check(attached.exitCode === 0, `a client attached as the app attaches (-f ignore-size): exit ${attached.exitCode} ${attached.stderr.toString().trim()}`);
  check(readFileSync(keysLog, "utf8").includes("1b 5b 31 33 3b 32 75"), "…and Shift-Enter reached the agent as CSI u (ESC [13;2u), a newline, not a send");
  // Clear the fake's input line of that newline, so the next send starts clean.
  tmux("send-keys", "-t", hosted!.pane, "C-u");

  // The daemon restarts; the session doesn't. The new daemon adopts it from tmux alone.
  await stopDaemon(daemon);
  daemon = null;
  check(tmux("has-session", "-t", `=${hosted!.session}`).exitCode === 0 && (() => { try { process.kill(panePid, 0); return true; } catch { return false; } })(),
    `with no daemon at all, the session is still running in conch's tmux (pid ${panePid})`);
  writeFileSync(env.CONCH_SESSIONS_FILE!, "{}");
  daemon = startDaemon("second");
  check(Boolean(await answering()), "the new daemon answers");
  const readopted = await until("the row adopted again", 8_000, () => (row()?.hosted ? row() : null));
  check(readopted?.hosted?.session === hosted!.session && readopted?.hosted?.pane === hosted!.pane,
    `it adopts the session again, from tmux alone: ${JSON.stringify(readopted?.hosted)}`);
  check(readFileSync(env.CONCH_LOG_FILE!, "utf8").includes(`in conch's tmux: "`), "…and says so in its log");
  const third = await deliver(AFTER_RESTART, "e2e-3");
  check(third.done?.delivered === true && third.touched.length === 0, `a message after the restart, delivered: ${JSON.stringify(third.done)}`);
  const again = await parity("after-restart");
  check(again.code === 0 && again.last.startsWith("PASS "), `conch parity --no-app after the restart: ${again.last}`);

  // Closing it from conch: Ctrl-D through send-keys; the agent leaves, and its tmux session with it.
  const closed = (await ask({ kind: "session-close", sessionId: SESSION })).at(-1);
  check(closed?.kind === "session-closed", `session-close: ${JSON.stringify(closed)}`);
  const gone = await until("the session to end", 10_000, () => tmux("has-session", "-t", `=${hosted!.session}`).exitCode !== 0);
  check(Boolean(gone) && (() => { try { process.kill(panePid, 0); return false; } catch { return true; } })(),
    "…the agent exited cleanly and its tmux session ended");
  check(callLines().filter((line) => line.startsWith("osascript ")).length === 0, `osascript was never run: ${callLines().filter((line) => line.startsWith("osascript ")).length} calls`);
} finally {
  if (daemon) await stopDaemon(daemon);
  const killed = tmux("kill-server");
  say(`tmux -L ${label} kill-server: exit ${killed.exitCode} (${killed.exitCode === 0 ? "it was still running" : "it had already gone"})`);
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
