#!/usr/bin/env bun
/**
 * Setup's daemon half, end to end: the source daemon in a temporary home, asked what the Mac app's setup window asks
 * (src/setup.ts). Agents are stand-ins on a private PATH (`claude` and `codex` that print what the real ones print and
 * record what they were asked), so connecting writes hooks and a plugin into the temporary home's Claude Code and Codex
 * and nowhere else. It never asks for an install: that runs the agent's real installer. The microphone check runs the daemon's real capture path with a stand-in `sox` that writes
 * a line `say` recorded to a file (never played, never the microphone) and the real whisper, from this checkout's
 * vendored engine and the model already on this Mac (read only). The voice sample goes through `speak` with speech off.
 *
 *   bun scripts/setup-e2e.ts [--keep]
 *
 * Never touches the live daemon, its socket or logs, or the real ~/.claude, ~/.codex, ~/.config/conch: every path the
 * daemon writes is in the temp dir, and it is stopped by its own pid.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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

const vendor = readdirSync(join(repo, "build", "vendor")).find((name) => name.startsWith("engine-") && name.endsWith(process.arch === "arm64" ? "-arm64" : "-x86_64"));
const model = join(homedir(), ".cache", "conch", "models", "ggml-large-v3-turbo-q5_0.bin");
if (!vendor || !existsSync(model)) {
  console.error("needs build/vendor/engine-* (scripts/fetch-engine.sh) and a whisper model at ~/.cache/conch/models (read only)");
  process.exit(2);
}
const engine = join(repo, "build", "vendor", vendor);

// Whatever the real ~/.claude and ~/.codex say before, they must say after: read only, never written.
const realFiles = [join(homedir(), ".claude", "settings.json"), join(homedir(), ".codex", "config.toml"), join(homedir(), ".codex", "hooks.json")];
const stamp = () => realFiles.map((file) => (existsSync(file) ? `${statSync(file).mtimeMs}:${statSync(file).size}` : "absent"));
const before = stamp();

const root = mkdtempSync(join(tmpdir(), "conch-setup-e2e-"));
const home = join(root, "home");
const bin = join(root, "bin");
const claudeDir = join(root, "claude");
for (const dir of [home, bin, claudeDir]) mkdirSync(dir, { recursive: true });
const calls = join(root, "calls.log");

function tool(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}
tool("claude", `case "$1 $2" in
  "--version "*) echo "2.1.280 (Claude Code)";;
  "plugin install") mkdir -p "$CLAUDE_CONFIG_DIR/plugins"; echo '{"plugins":{"conch@conch":[{"scope":"user"}]}}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json";;
esac
exit 0`);
tool("codex", `case "$1 $2" in
  "--version "*) echo "codex-cli 0.156.0";;
  "plugin add") mkdir -p "$CONCH_HOME/.codex"; printf '[plugins."conch@conch-local"]\\nenabled = true\\n' >> "$CONCH_HOME/.codex/config.toml";;
esac
exit 0`);
// The daemon's capture recipe, with a recording standing in for the microphone: the file it's told to write gets the
// line, and it ends as a `trim` would.
const line = join(root, "line.wav");
Bun.spawnSync(["/usr/bin/say", "-o", line, "--data-format=LEI16@16000", "Testing, one, two, three."]);
tool("sox", `out=""; prev=""; for a in "$@"; do if [ "$prev" = "wav" ]; then out="$a"; fi; prev="$a"; done
if [ -n "$out" ]; then cp "${line}" "$out"; sleep 0.4; fi
exit 0`);

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
  CONCH_WHISPER_CLI: join(engine, "whisper-cli"),
  CONCH_WHISPER_SERVER: join(engine, "whisper-server"),
  CONCH_WHISPER_MODEL: model,
  CONCH_VAD_MODEL: join(engine, "ggml-silero-v6.2.0.bin"),
  CONCH_SOX: join(bin, "sox"),
  // Silent: nothing spoken, no bells, no cues, no phone.
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_PHONE: "0",
};

/** One request: every line the daemon writes before it ends the connection, parsed. */
function ask(request: unknown, timeoutMs = 120_000): Promise<Array<Record<string, any>>> {
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
const last = async (request: unknown, timeoutMs?: number) => (await ask(request, timeoutMs)).at(-1)!;

async function until<T>(what: string, timeoutMs: number, probe: () => T | Promise<T>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await Promise.resolve().then(probe).catch(() => null);
    if (value) return value;
    await Bun.sleep(250);
  }
  say(`… gave up waiting for ${what}`);
  return null;
}

const published = (): Record<string, any> | null => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")); } catch { return null; }
};

say(`temp root ${root}`);
const daemon = Bun.spawn([process.execPath, join(repo, "src", "cli.ts"), "daemon"], {
  env, cwd: root, stdin: "ignore",
  stdout: Bun.file(join(root, "daemon.stdout.log")), stderr: Bun.file(join(root, "daemon.stderr.log")),
});
say(`source daemon started, pid ${daemon.pid}`);
const window = Bun.spawn(["/bin/sleep", "600"]);

try {
  check(Boolean(await until("the socket", 30_000, async () => {
    try { return (await last({ kind: "setup-status" }, 10_000)).kind === "setup-status"; } catch { return false; }
  })), "the daemon answers setup-status on its own socket");

  // What setup finds: both agents, from the stand-ins on its PATH, nothing wired yet.
  let status = (await last({ kind: "setup-status" })).agents as Array<Record<string, any>>;
  const claude = () => status.find((agent) => agent.agent === "claude")!;
  const codex = () => status.find((agent) => agent.agent === "codex")!;
  check(claude().found && claude().version === "2.1.280" && !claude().hooksWired && !claude().pluginInstalled && !claude().heard,
    `setup-status: Claude Code ${claude().version}, not wired, not heard (${JSON.stringify(claude())})`);
  check(codex().found && codex().version === "0.156.0" && codex().signedIn === false, `setup-status: Codex ${codex().version}, not signed in`);

  // Connect: hooks and a plugin in the temp Claude Code, with the reply saying what changed.
  const connected = await last({ kind: "setup-connect", agent: "claude" }, 180_000);
  check(connected.kind === "setup-connected" && connected.changed.join(",") === "hooks,plugin" && connected.backup === null,
    `setup-connect claude: ${JSON.stringify({ kind: connected.kind, changed: connected.changed, backup: connected.backup, error: connected.error })}`);
  const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  check(/cli\.ts" hook$/.test(settings.hooks.Stop[0].hooks[0].command), `the temp Claude Code's Stop hook is conch's: ${settings.hooks.Stop[0].hooks[0].command}`);
  const asked = readFileSync(calls, "utf8");
  check(asked.includes("claude plugin marketplace add") && asked.includes("claude plugin install conch@conch"), "the plugin went in through claude's own CLI (the stand-in)");
  status = (await last({ kind: "setup-status" })).agents;
  check(claude().hooksWired && claude().pluginInstalled && !claude().heard, "after connecting: wired, but not green until conch hears from it");

  // A real hook event from a Claude Code window conch knows: the row goes green.
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "sessions", `${window.pid}.json`), JSON.stringify({
    pid: window.pid, sessionId: "e2e-session", cwd: root, kind: "interactive", startedAt: Date.now(), name: "e2e",
  }));
  await ask({ type: "session-start", sessionId: "e2e-session", label: "e2e", cwd: root, pid: window.pid, announce: "", eventAt: Date.now() });
  const heard = await until("Claude Code heard", 20_000, async () => {
    status = (await last({ kind: "setup-status" })).agents;
    return claude().heard ? status : null;
  });
  check(Boolean(heard), "a hook event from its session turns the row green (heard)");
  check(existsSync(join(root, "config", "setup.json")), "…and it is remembered in the temp config's setup.json");

  // Codex, through its own records.
  const codexConnected = await last({ kind: "setup-connect", agent: "codex" }, 180_000);
  check(codexConnected.kind === "setup-connected", `setup-connect codex: ${codexConnected.kind} ${codexConnected.error ?? ""}`);
  status = (await last({ kind: "setup-status" })).agents;
  check(codex().hooksWired && codex().pluginInstalled, "Codex's hooks.json and plugin table, in the temp home");

  // Never `setup-install` here: it runs the agent's real installer in a login shell, where /etc/paths.d puts the real
  // Homebrew ahead of any stand-in (it upgraded this Mac's Codex cask once). Its streaming is tested with an injected
  // runner in first-run-setup.test.ts; the socket's streaming is the microphone check below.

  // A ring voice, through speak (speech off).
  const sample = await last({ kind: "voice-sample", voice: "Emma" }, 30_000);
  check(sample.kind === "voice-sample-done" && sample.voice === "Emma", `voice-sample Emma: ${JSON.stringify(sample)}`);

  // The microphone check: the capture path, the level streamed, whisper's words back.
  const ready = await until("speech recognition ready", 60_000, () => published()?.speechEngine?.state === "ready");
  check(Boolean(ready), `the engine is published ready (${published()?.speechEngine?.detail})`);
  const mic = await ask({ kind: "mic-check", seconds: 4 }, 120_000);
  const levels = mic.filter((line) => line.kind === "mic-level").map((line) => line.level as number);
  const done = mic.at(-1)!;
  check(levels.length > 10 && Math.max(...levels) > 0.3, `mic-check streamed ${levels.length} levels, loudest ${Math.max(...levels).toFixed(2)}`);
  check(done.kind === "mic-check-done" && /testing/i.test(done.heard ?? ""), `…and whisper heard: ${JSON.stringify(done.heard)} (${done.kind}${done.error ? `: ${done.error}` : ""})`);
  check(readdirSync(root).every((name) => !name.startsWith("conch-mic-check-")), "the recording didn't outlive the check");
  const retry = await last({ kind: "setup-retry", what: "speech" });
  check(retry.kind === "setup-ack" && retry.retried === false, "setup-retry on a ready engine does nothing");
  const refused = await last({ kind: "setup-connect", agent: "gemini" });
  check(refused.kind === "setup-error", `a malformed request is refused in words: ${refused.error}`);
} catch (error) {
  failures.push(String(error));
  say(`✗ ${error}`);
} finally {
  window.kill();
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  say(`daemon ${daemon.pid} stopped`);
  check(JSON.stringify(stamp()) === JSON.stringify(before), "the real ~/.claude and ~/.codex are untouched");
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
