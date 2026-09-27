#!/usr/bin/env bun
/**
 * A built conch.app, run the way a downloaded one runs: its own daemon
 * (Contents/Helpers/conch-daemon) in a temporary home, with the bare PATH a
 * Finder-launched app gets — no Homebrew, no checkout, no bun — and the engine
 * it carries. Checks that the daemon answers its socket, publishes the speech
 * engine as coming from the app, warms the bundled whisper-server, and that the
 * bundled whisper transcribes a line `say` wrote to a file. Never plays audio,
 * never opens the microphone, never touches the live daemon, its socket, its
 * logs or conch's real folders: every path the daemon writes is in the temp
 * dir, and the daemon is stopped by its own pid.
 *
 *   bun scripts/app-bundle-e2e.ts <conch.app> [--model <ggml model>] [--keep]
 *
 * --model  an existing whisper model to use (read-only). Without it, the
 *          daemon does a real first run: it downloads the pinned 574 MB model
 *          into the temp home, verified by sha256, and reports progress.
 * --keep   leave the temp dir for inspection.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const app = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : "";
if (!app || !existsSync(join(app, "Contents", "Helpers", "conch-daemon"))) {
  console.error("usage: bun scripts/app-bundle-e2e.ts <conch.app> [--model <path>] [--keep]");
  process.exit(2);
}
const keep = args.includes("--keep");
const model = args.includes("--model") ? resolve(args[args.indexOf("--model") + 1]!) : "";

const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const root = mkdtempSync(join(tmpdir(), "conch-app-e2e-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const helpers = join(app, "Contents", "Helpers");
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

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
  });
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | Promise<T>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(250);
  }
  say(`… gave up waiting for ${what} after ${Math.round(timeoutMs / 1000)}s`);
  return null;
}

const whisperPort = freePort();
const env: Record<string, string> = {
  // What a Finder-launched app hands its daemon, minus Homebrew: nothing but the system.
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  CONCH_APP_BUNDLE: app,
  CONCH_STARTED_BY: "app",
  CONCH_SOCKET: join(root, "conch.sock"),
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"),
  CONCH_LOG_FILE: join(root, "daemon.log"),
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: join(root, "sessions.json"),
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(whisperPort),
  // Hermetic: no seashell tree (a seashell checkout or formula on this Mac
  // would lend its model and turn a first run into a second one).
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  // Silent: no voices to build, nothing spoken, no bells, no mic cues.
  CONCH_TTS: "say",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_PHONE: "0",
  ...(model ? { CONCH_WHISPER_MODEL: model } : {}),
};

say(`app ${app}`);
say(`temp root ${root}; whisper-server port ${whisperPort}`);
const daemon = Bun.spawn([join(helpers, "conch-daemon"), "daemon"], {
  env,
  cwd: root,
  stdin: "ignore",
  stdout: Bun.file(join(root, "daemon.stdout.log")),
  stderr: Bun.file(join(root, "daemon.stderr.log")),
});
say(`bundled daemon started, pid ${daemon.pid}`);

type Published = { speechEngine?: { state: string; detail: string; progress?: { bytes: number; total: number }; parts: Record<string, { source: string; path: string }>; daemon: { version: string; path: string } } };
const published = (): Published | null => {
  try { return JSON.parse(readFileSync(env.CONCH_SESSIONS_FILE!, "utf8")) as Published; } catch { return null; }
};

try {
  check(Boolean(await until("the socket", 30_000, () => socketAnswers(env.CONCH_SOCKET!))), `the daemon answers its socket (${env.CONCH_SOCKET})`);
  const settings = Bun.spawnSync([join(helpers, "conch-daemon"), "get", "listen-window"], { env, stdout: "pipe", stderr: "pipe" });
  const answer = settings.stdout.toString().trim();
  // `get` asks the live daemon (get-config); it says "daemon-down" when it had to read the file instead.
  check(settings.exitCode === 0 && !answer.includes("daemon-down"), `a CLI round trip over that socket: \`conch get listen-window\` → ${answer || settings.stderr.toString().trim()}`);

  if (!model) {
    let lastPercent = -10;
    let sawDownloading = false;
    const landed = await until("the first-run model download", 30 * 60_000, () => {
      const engine = published()?.speechEngine;
      if (engine?.state === "downloading") sawDownloading = true;
      if (engine?.state === "downloading" && engine.progress) {
        const percent = Math.floor((engine.progress.bytes / engine.progress.total) * 100);
        if (percent >= lastPercent + 10) { lastPercent = percent; say(`  downloading: ${percent}% (${engine.detail})`); }
      }
      return engine?.state === "ready" || engine?.state === "off" ? engine : null;
    });
    check(sawDownloading, "first run: the daemon published `downloading`, with progress, while it fetched");
    check(landed?.state === "ready", `first run: the daemon downloaded the whisper model and verified it (${landed?.detail})`);
    const fetched = join(home, ".cache", "conch", "models", "ggml-large-v3-turbo-q5_0.bin");
    const digest = existsSync(fetched) ? new Bun.CryptoHasher("sha256").update(await Bun.file(fetched).bytes()).digest("hex") : "";
    check(digest === "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", `the model on disk is the pinned bytes (${fetched})`);
  }

  const engine = (await until("the published engine status", 30_000, () => {
    const status = published()?.speechEngine;
    return status?.state === "ready" ? status : null;
  }))!;
  check(engine?.state === "ready", `published: ${engine ? `Speech engine: ${engine.state} — ${engine.detail}` : "no speechEngine"}`);
  if (engine) {
    for (const part of ["whisper", "server", "vad", "capture"]) {
      check(engine.parts[part]?.source === "conch.app" && engine.parts[part]!.path.startsWith(app), `${part} resolved from the app: ${engine.parts[part]?.path}`);
    }
    check(engine.daemon.path === join(helpers, "conch-daemon"), `the publishing daemon is the bundled one (${engine.daemon.path}, conch ${engine.daemon.version})`);
  }

  const wav = join(root, "line.wav");
  // Written to a file, never played.
  Bun.spawnSync(["/usr/bin/say", "-o", wav, "--data-format=LEI16@16000", "The quick brown fox jumps over the lazy dog."]);
  check(existsSync(wav), "`say -o` wrote a 16 kHz test WAV (not played)");

  const warm = await until("the bundled whisper-server", 120_000, async () => {
    try {
      const form = new FormData();
      form.append("file", new Blob([await Bun.file(wav).arrayBuffer()], { type: "audio/wav" }), "line.wav");
      form.append("response_format", "json");
      const response = await fetch(`http://127.0.0.1:${whisperPort}/inference`, { method: "POST", body: form });
      return response.ok ? ((await response.json()) as { text: string }).text.trim() : null;
    } catch {
      return null;
    }
  });
  check(/quick brown fox/i.test(warm ?? ""), `the bundled whisper-server (warm, Metal) heard: "${warm}"`);
  const serverCommand = Bun.spawnSync(["/bin/ps", "-axo", "command="]).stdout.toString().split("\n").find((line) => line.includes(`--port ${whisperPort}`)) ?? "";
  check(serverCommand.startsWith(join(helpers, "whisper-server")), `…and it is the app's own: ${serverCommand.split(" -m ")[0]}`);

  const modelPath = model || join(home, ".cache", "conch", "models", "ggml-large-v3-turbo-q5_0.bin");
  const cold = Bun.spawnSync([
    join(helpers, "whisper-cli"), "-m", modelPath, "-vm", join(app, "Contents", "Resources", "models", "ggml-silero-v6.2.0.bin"),
    "--vad", "--vad-speech-pad-ms", "300", "-f", wav, "-l", "en", "-t", "6", "-nt", "-np", "-mc", "0",
  ], { stdout: "pipe", stderr: "pipe" });
  const coldText = cold.stdout.toString().trim();
  check(cold.exitCode === 0 && /quick brown fox/i.test(coldText), `the bundled whisper-cli (cold, conch's exact invocation) heard: "${coldText}"`);

  // The capture recipe, on a file instead of the microphone: the same format and effects.
  const raw = join(root, "capture.raw");
  const sox = Bun.spawnSync([
    join(helpers, "sox"), "-q", wav, "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", raw,
    "gain", "6", "silence", "-l", "1", "0.15", "2%", "1", "2.0", "2%",
  ], { stderr: "pipe" });
  check(sox.exitCode === 0 && existsSync(raw) && Bun.file(raw).size > 16_000, `the bundled sox runs conch's capture recipe (gain, silence) on a file: ${existsSync(raw) ? Bun.file(raw).size : 0} bytes of 16 kHz PCM`);
  const drivers = Bun.spawnSync([join(helpers, "sox"), "-h"]).stdout.toString();
  check(drivers.includes("AUDIO DEVICE DRIVERS: coreaudio"), "…with the CoreAudio driver `-d` opens (the microphone itself needs a human)");
} finally {
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  say(`daemon ${daemon.pid} stopped`);
  const leftover = Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((line) => line.includes(`--port ${whisperPort}`));
  check(leftover.length === 0, "its whisper-server went with it");
  if (keep) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(failures.length ? 1 : 0);
