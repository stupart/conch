#!/usr/bin/env bun
/**
 * conch's natural voices heal themselves, end to end. Tyler, 2026-09-28: "Please add the visible thing but also it
 * should 'just work'."
 *
 * A real daemon (`src/cli.ts daemon`), headless, in a temporary home with its own socket and sessions file, building its
 * voice environment in a temp dir with a stand-in uv (scripts/voice-heal-e2e/fake-uv.ts), fetching Kokoro from a local
 * stand-in hub, and running conch's real tts-worker.py on stubs. Then broken each way — offline on a first run, a Metal
 * failure at worker start, macOS changed under it, a library that no longer loads, half the environment deleted while it
 * runs, the model cache damaged, a build killed mid-install, the disk full, the app moved — and every time it has to get
 * back to "ready" by itself, with no Try again. It also runs the real uv once against a dead proxy, to check its words
 * for "offline" are read as offline.
 *
 * Never plays audio (CONCH_SPEAK=0, and `say`/`afplay` on its PATH are stubs that only log), never opens the mic, and
 * never touches the live daemon, its socket or files, conch's real folders, the real Hugging Face cache or any uv of
 * yours: every path is in the temp dir, and every process it stops is one it started, by pid.
 *
 *   bun scripts/voice-heal-e2e.ts [--keep] [--only a,b,…]
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { macosVersion, uvEnvironment, voiceEnvPaths } from "../src/voice-env.ts";
import { classifyVoiceFailure } from "../src/voice-heal.ts";
import { modelRepoDir } from "../src/voice-model-cache.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const repo = resolve(import.meta.dir, "..");
const bun = process.execPath;
const systemPython = Bun.which("python3") ?? "/usr/bin/python3";

const started = performance.now();
const say = (line: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);
const failures: string[] = [];
const results: Array<{ scenario: string; ok: boolean; seconds: number }> = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
  return ok;
};

// MARK: - The temp world

const root = mkdtempSync(join(tmpdir(), "conch-voice-heal-e2e-"));
const home = join(root, "home");
const hooks = join(root, "hooks");
const hf = join(root, "hf");
const stubBin = join(root, "bin");
const voice = join(root, "voice");
const paths = voiceEnvPaths(voice);
let appDir = join(root, "apps", "conch.app");
const uvOf = (app: string) => join(app, "Contents", "Helpers", "uv");
for (const dir of [home, hooks, hf, stubBin, join(appDir, "Contents", "Helpers")]) mkdirSync(dir, { recursive: true });

// Audio, stubbed: anything that tried to speak would only leave a line here.
const audioLog = join(root, "audio-attempts.log");
for (const name of ["say", "afplay"]) {
  writeFileSync(join(stubBin, name), `#!/bin/sh\necho "${name} $*" >> "${audioLog}"\nexit 0\n`);
  chmodSync(join(stubBin, name), 0o755);
}
// The fake app's uv: what the daemon is handed as CONCH_UV, as the Mac app hands its own.
writeFileSync(uvOf(appDir), `#!/bin/sh\nexec "${bun}" "${join(repo, "scripts", "voice-heal-e2e", "fake-uv.ts")}" "$@"\n`);
chmodSync(uvOf(appDir), 0o755);
// The switchboard: how often a waiting heal looks again, and the worker's periodic retry, shortened for the test.
writeFileSync(join(hooks, "watch-ms"), "400\n");
writeFileSync(join(hooks, "worker-retry-ms"), "1500\n");
const setHook = (name: string, value: string | null) => {
  if (value === null) rmSync(join(hooks, name), { force: true });
  else writeFileSync(join(hooks, name), `${value}\n`);
};
for (const dummy of ["whisper.bin", "vad.bin"]) writeFileSync(join(root, dummy), "not a model");

// MARK: - The network: a local stand-in for PyPI, python-build-standalone and the Hugging Face hub

const requests = new Map<string, number>();
function bytes(seed: string, length: number): Uint8Array {
  let state = [...seed].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  return new Uint8Array(length).map(() => (state = (state * 1103515245 + 12345) >>> 0) >>> 24);
}
function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  requests.set(path, (requests.get(path) ?? 0) + 1);
  if (path === "/ping") return new Response("ok");
  if (path.startsWith("/python/") || path.startsWith("/wheels/")) return new Response(bytes(path, 512));
  const model = /^\/[^/]+\/[^/]+\/resolve\/main\/(.+)$/.exec(path);
  if (model) {
    const file = model[1]!;
    if (file === "config.json") return new Response('{"model_type":"kokoro","sample_rate":24000}');
    if (file.endsWith(".safetensors")) return new Response(bytes(file, file.startsWith("voices/") ? 20_000 : 300_000));
  }
  return new Response("not found", { status: 404 });
}
let server: ReturnType<typeof Bun.serve> | null = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
const port = server.port;
const hub = `http://127.0.0.1:${port}`;
const goOffline = () => { server?.stop(true); server = null; };
const goOnline = () => { server ??= Bun.serve({ hostname: "127.0.0.1", port, fetch: answer }); };
const modelRequests = (file: string) => [...requests].filter(([path]) => path.endsWith(`/resolve/main/${file}`)).reduce((sum, [, n]) => sum + n, 0);

// MARK: - The daemon

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const found = probe.port;
  probe.stop(true);
  return found;
}

const logFile = join(root, "daemon.log");
const sessionsFile = join(root, "sessions.json");
const baseEnv: Record<string, string> = {
  PATH: `${stubBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CONCH_HOME: home,
  TMPDIR: `${root}/`,
  CONCH_SOCKET: join(root, "conch.sock"),
  CONCH_CONFIG_DIR: join(root, "config"),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  CODEX_HOME: join(root, "codex"),
  CONCH_LOG_FILE: logFile,
  CONCH_STATE_FILE: join(root, "state.json"),
  CONCH_SESSIONS_FILE: sessionsFile,
  CONCH_REVIEWS_FILE: join(root, "reviews.json"),
  CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
  CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
  CONCH_WHISPER_PORT: String(freePort()),
  CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
  // No speech recognition at all: nothing to download, no whisper-server, no mic.
  CONCH_WHISPER_CLI: join(root, "no-whisper-cli"),
  CONCH_WHISPER_SERVER: join(root, "no-whisper-server"),
  CONCH_WHISPER_MODEL: join(root, "whisper.bin"),
  CONCH_VAD_MODEL: join(root, "vad.bin"),
  CONCH_SOX: join(root, "no-sox"),
  // Silent.
  CONCH_TTS: "worker",
  CONCH_SPEAK: "0",
  CONCH_BELL: "0",
  CONCH_MIC_CUES: "0",
  CONCH_PHONE: "0",
  // The voices, all in the temp dir.
  CONCH_UV: uvOf(appDir),
  CONCH_VOICE_HOME: voice,
  HF_HOME: hf,
  HF_ENDPOINT: hub,
  CONCH_E2E_INDEX: hub,
  CONCH_E2E_SYSTEM_PYTHON: systemPython,
  CONCH_VOICE_NETWORK_PROBE_URL: `${hub}/ping`,
  CONCH_TEST_HOOKS: hooks,
};

let daemon: Subprocess | null = null;
let starts = 0;

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(path);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
  });
}

async function until<T>(timeoutMs: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(100);
  }
  return null;
}

async function startDaemon(extra: Record<string, string> = {}): Promise<void> {
  starts++;
  daemon = Bun.spawn([bun, join(repo, "src", "cli.ts"), "daemon"], {
    env: { ...baseEnv, ...extra },
    cwd: root,
    stdin: "ignore",
    stdout: Bun.file(join(root, `daemon-${starts}.stdout.log`)),
    stderr: Bun.file(join(root, `daemon-${starts}.stderr.log`)),
  });
  const up = await until(30_000, () => socketAnswers(baseEnv.CONCH_SOCKET!));
  check(Boolean(up), `daemon ${daemon.pid} (start ${starts}) answers its own socket`);
}

async function stopDaemon(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
  if (!daemon) return;
  daemon.kill(signal);
  const exited = await Promise.race([daemon.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
  if (!exited) daemon.kill("SIGKILL");
  await daemon.exited;
  daemon = null;
}

interface Voices { state: string; detail: string; healing?: string; waiting?: string; percent?: number; off?: string; problem?: string; reason?: string }
const seen: string[] = [];
function voices(): Voices | null {
  try {
    const status = (JSON.parse(readFileSync(sessionsFile, "utf8")) as { naturalVoices?: Voices }).naturalVoices ?? null;
    if (status) {
      const line = [status.state, status.healing, status.waiting, status.off, status.problem, status.percent !== undefined ? `${status.percent}%` : ""].filter(Boolean).join(" ");
      if (seen.at(-1) !== line) seen.push(line);
    }
    return status;
  } catch {
    return null;
  }
}
const waitVoices = (timeoutMs: number, want: (status: Voices) => boolean) => until(timeoutMs, () => {
  const status = voices();
  return status && want(status) ? status : null;
});
const log = () => { try { return readFileSync(logFile, "utf8"); } catch { return ""; } };
const count = (text: string, needle: string) => text.split(needle).length - 1;
const uvCalls = (kind: string) => { try { return count(readFileSync(join(hooks, "uv-calls.log"), "utf8"), kind); } catch { return 0; } };
const offOrFailed = () => seen.some((line) => line.startsWith("off"));
const failuresRecorded = () => existsSync(paths.failures);

/** The daemon's warm worker: conch's materialized tts-worker script, run from this temp home. */
function workerPids(): number[] {
  const runtime = join(home, ".cache", "conch", "runtime", "tts-worker-");
  return Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="]).stdout.toString().split("\n")
    .filter((line) => line.includes(runtime))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
function killPid(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch {}
}
function siteOf(env: string): string {
  const lib = join(env, "lib");
  return join(lib, readdirSync(lib)[0]!, "site-packages");
}

// MARK: - Scenarios

type Scenario = { name: string; what: string; run: () => Promise<void> };
const scenarios: Scenario[] = [
  {
    name: "first-run-offline",
    what: "a first run with no network: waits quietly, finishes by itself when the network is back",
    run: async () => {
      goOffline();
      await startDaemon();
      const waiting = await waitVoices(60_000, (status) => status.waiting === "network");
      check(waiting?.state === "setting-up" && waiting.healing === "first-run", `offline: published "setting-up, first-run, waiting for the network" (${waiting?.detail})`);
      await Bun.sleep(1_500);
      check(!offOrFailed() && !failuresRecorded(), "offline: never off, nothing counted against it");
      goOnline();
      const ready = await waitVoices(120_000, (status) => status.state === "ready");
      check(ready !== null, `back online: ready by itself, no Try again (${ready?.detail})`);
      check(log().includes("natural voices: the network is back — carrying on"), "…because the daemon saw the network come back");
      check(seen.some((line) => /\d+%/.test(line)), `…saying how far along it was (${seen.filter((line) => /%/.test(line)).slice(0, 4).join(" → ")})`);
      check(uvCalls("python install") >= 2, `…after ${uvCalls("python install")} tries at the first step, the offline ones uncounted`);
      check(Boolean(await until(30_000, () => workerPids().length > 0)), "the warm worker started on conch's own environment");
    },
  },
  {
    name: "metal-at-start",
    what: "a Metal failure at worker start: coming back, retried, ready",
    run: async () => {
      const before = count(log(), "the voice worker is back");
      setHook("worker-fault", "4 [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)");
      for (const pid of workerPids()) killPid(pid);
      const healing = await waitVoices(60_000, (status) => status.state === "setting-up" && status.problem === "gpu");
      check(healing?.healing === "repair", `a failed start burst: "setting-up, repair, gpu" (${healing?.detail})`);
      const ready = await waitVoices(60_000, (status) => status.state === "ready");
      check(ready !== null && count(log(), "the voice worker is back") > before, "…the worker's own retry came up warm: ready again, by itself");
      check(readFileSync(join(hooks, "worker-fault"), "utf8").startsWith("0 "), "…through the real tts-worker.py's test hook (all four faked starts used)");
      setHook("worker-fault", null);
    },
  },
  {
    name: "macos-changed",
    what: "macOS changed under the environment, and the worker fails once: rebuilt at once",
    run: async () => {
      await stopDaemon();
      const record = JSON.parse(readFileSync(paths.record, "utf8")) as { fingerprint: { macos: string } };
      record.fingerprint.macos = "darwin 0.0.0";
      writeFileSync(paths.record, JSON.stringify(record));
      setHook("worker-fault", "4 [metal::Device] Unable to build metal library from source");
      const syncs = uvCalls("pip sync");
      const backs = count(log(), "the voice worker is back");
      await startDaemon();
      check(Boolean(await until(60_000, () => log().includes("macos changed since the environment was built"))), "the daemon noticed macOS changed since the build");
      check(Boolean(await until(90_000, () => uvCalls("pip sync") > syncs)), "…one failed start burst, and the environment was rebuilt at once");
      check(Boolean(await until(90_000, () => count(log(), "the voice worker is back") > backs && voices()?.state === "ready")), "…then the worker came up warm: ready");
      const fingerprint = (JSON.parse(readFileSync(paths.record, "utf8")) as { fingerprint: { macos: string } }).fingerprint;
      check(fingerprint.macos === macosVersion(), `…and the record now says it was proved on ${fingerprint.macos}`);
      setHook("worker-fault", null);
    },
  },
  {
    name: "dylib",
    what: "a library that no longer loads (what a macOS or Python update can do): rebuilt",
    run: async () => {
      await stopDaemon();
      writeFileSync(join(paths.env, ".dylib-broken"), "");
      const syncs = uvCalls("pip sync");
      await startDaemon();
      check(Boolean(await until(90_000, () => uvCalls("pip sync") > syncs && voices()?.state === "ready")), "the probe hit `Library not loaded`; rebuilt; ready");
      check(!existsSync(join(paths.env, ".dylib-broken")), "…the broken environment is gone, replaced whole");
    },
  },
  {
    name: "half-deleted",
    what: "half the environment deleted while it runs, then the worker dies: rebuilt, ready",
    run: async () => {
      check(Boolean(await until(30_000, () => workerPids().length > 0)), "the worker is running");
      const site = siteOf(paths.env);
      const infos = readdirSync(site).filter((name) => name.endsWith(".dist-info"));
      for (const name of infos.slice(0, Math.ceil(infos.length / 2))) rmSync(join(site, name), { recursive: true, force: true });
      rmSync(join(site, "mlx_audio"), { recursive: true, force: true });
      const syncs = uvCalls("pip sync");
      for (const pid of workerPids()) killPid(pid);
      check(Boolean(await until(90_000, () => uvCalls("pip sync") > syncs)), "the worker could not start again (no mlx_audio): the environment was rebuilt");
      check(Boolean(await waitVoices(90_000, (status) => status.state === "ready")) && existsSync(join(siteOf(paths.env), "mlx_audio")), "…ready, whole again");
      check(Boolean(await until(30_000, () => workerPids().length > 0)), "…and the worker is back");
    },
  },
  {
    name: "model-cache",
    what: "Kokoro's cache damaged: verified, and only the broken files fetched again",
    run: async () => {
      await stopDaemon();
      const snapshot = join(modelRepoDir(join(hf, "hub"), "mlx-community/Kokoro-82M-bf16"), "snapshots");
      const commit = join(snapshot, readdirSync(snapshot)[0]!);
      const { realpathSync } = await import("node:fs");
      const weights = realpathSync(join(commit, "kokoro-v1_0.safetensors"));
      const damaged = new Uint8Array(readFileSync(weights));
      damaged[100] = damaged[100]! ^ 0xff;
      writeFileSync(weights, damaged);
      rmSync(realpathSync(join(commit, "voices", "af_heart.safetensors")));
      requests.clear();
      await startDaemon();
      check(Boolean(await until(60_000, () => log().includes("of Kokoro's files were damaged or missing"))), "the check at start found the damaged weights and the missing voice");
      check(Boolean(await waitVoices(90_000, (status) => status.state === "ready")), "…fetched them again: ready");
      const fetched = [...requests.keys()].filter((path) => path.includes("/resolve/main/")).map((path) => path.split("/resolve/main/")[1]).sort();
      check(JSON.stringify(fetched) === JSON.stringify(["kokoro-v1_0.safetensors", "voices/af_heart.safetensors"]), `…and only those: ${fetched.join(", ")}`);
      check(modelRequests("config.json") === 0, "…config.json, sound, was never fetched again");
    },
  },
  {
    name: "killed-mid-install",
    what: "a build killed mid-install: noticed, cleaned up, rebuilt — never counted",
    run: async () => {
      await stopDaemon();
      rmSync(paths.env, { recursive: true, force: true });
      rmSync(join(hooks, "uv.pid"), { force: true });
      setHook("uv-fault", "hang");
      await startDaemon();
      const uvPid = await until(60_000, () => { try { return Number(readFileSync(join(hooks, "uv.pid"), "utf8")); } catch { return null; } });
      check(Boolean(uvPid), `the build is part way through its packages (uv ${uvPid})`);
      await stopDaemon("SIGKILL");
      if (uvPid) killPid(uvPid);
      check(existsSync(paths.staging) && existsSync(paths.lock), "killed: a half-built env.building and a setup lock left behind");
      setHook("uv-fault", null);
      await startDaemon();
      check(Boolean(await waitVoices(90_000, (status) => status.state === "ready")), "restarted: ready, by itself");
      check(log().includes("natural voices: a setup was interrupted (env.building left behind)"), "…having said a setup was interrupted");
      check(!existsSync(paths.staging) && !failuresRecorded(), "…cleaned up, and nothing counted against it");
    },
  },
  {
    name: "disk-full",
    what: "the disk fills up part way: says so, waits, carries on when there's room",
    run: async () => {
      await stopDaemon();
      rmSync(paths.env, { recursive: true, force: true });
      setHook("uv-fault", "enospc");
      setHook("free-bytes", "2000000000");
      await startDaemon();
      const waiting = await waitVoices(60_000, (status) => status.waiting === "space");
      check(waiting?.problem === "no-space", `out of room: "waiting for space" (${waiting?.detail})`);
      check(!existsSync(paths.staging) && !failuresRecorded(), "…the half-built env removed at once, nothing counted");
      setHook("uv-fault", null);
      setHook("free-bytes", "5000000000");
      check(Boolean(await waitVoices(60_000, (status) => status.state === "ready")), "room made: ready, by itself");
      setHook("free-bytes", null);
    },
  },
  {
    name: "app-moved",
    what: "the app moved (its uv at a new path): relinked, nothing rebuilt",
    run: async () => {
      await stopDaemon();
      const moved = join(root, "Applications", "conch.app");
      mkdirSync(join(root, "Applications"), { recursive: true });
      renameSync(appDir, moved);
      appDir = moved;
      const syncs = uvCalls("pip sync");
      await startDaemon({ CONCH_UV: uvOf(appDir) });
      check(Boolean(await waitVoices(60_000, (status) => status.state === "ready")), "ready from the moved app");
      check(log().includes(`conch's uv moved or changed (`) && log().includes(`→ ${uvOf(appDir)}) — relinked`), "…relinked to its new uv");
      check(uvCalls("pip sync") === syncs, "…and nothing rebuilt");
      check((JSON.parse(readFileSync(paths.record, "utf8")) as { uv: string }).uv === uvOf(appDir), "…the record names the new uv");
    },
  },
];

// MARK: - The real uv's words for offline

async function realUvOffline(): Promise<void> {
  const vendored = join(repo, "build", "vendor");
  const dir = existsSync(vendored) ? readdirSync(vendored).find((name) => name.startsWith("uv-")) : undefined;
  const uv = dir ? join(vendored, dir, "uv") : "";
  if (!uv || !existsSync(uv)) {
    say("· the real uv isn't in build/vendor (scripts/fetch-uv.sh): its offline words not checked");
    return;
  }
  const deadProxy = `http://127.0.0.1:${freePort()}`;
  const scratch = voiceEnvPaths(join(root, "real-uv"));
  mkdirSync(scratch.root, { recursive: true });
  const env = uvEnvironment(scratch, { PATH: "/usr/bin:/bin", HOME: home, HTTPS_PROXY: deadProxy, HTTP_PROXY: deadProxy, ALL_PROXY: deadProxy, UV_HTTP_RETRIES: "0" });
  const run = Bun.spawn([uv, "python", "install", "3.12", "--no-bin"], { env, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  const words = stderr.trim().split("\n").slice(0, 6).join(" | ");
  check(code !== 0 && classifyVoiceFailure(words) === "offline", `the real uv, through a dead proxy, exits ${code}: read as offline ("${words.slice(0, 160)}…")`);
}

// MARK: - Run

let exitCode = 0;
try {
  say(`temp root ${root}; stand-in hub ${hub}`);
  await realUvOffline();
  for (const scenario of scenarios) {
    if (only && !only.has(scenario.name)) continue;
    say(`── ${scenario.name}: ${scenario.what}`);
    const before = failures.length;
    const at = performance.now();
    try {
      await scenario.run();
    } catch (error) {
      check(false, `${scenario.name} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    results.push({ scenario: scenario.name, ok: failures.length === before, seconds: Math.round((performance.now() - at) / 1000) });
  }
  check(!existsSync(audioLog), "nothing tried to play a sound (no `say` or `afplay` run)");
  check(existsSync(join(root, "conch-kokoro-worker.err.log")), "the worker's stderr went beside this daemon's log, not the live one's");
} finally {
  await stopDaemon();
  for (const pid of workerPids()) killPid(pid);
  server?.stop(true);
  console.log("\n── statuses the daemon published, in order ──");
  for (const line of seen) console.log(`  ${line}`);
  console.log("\n── scenarios ──");
  for (const result of results) console.log(`  ${result.ok ? "✓" : "✗"} ${result.scenario.padEnd(20)} ${String(result.seconds).padStart(4)}s`);
  exitCode = failures.length ? 1 : 0;
  if (keep || exitCode) say(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
say(failures.length ? `✗ ${failures.length} failed` : "✓ all passed");
process.exit(exitCode);
