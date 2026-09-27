#!/usr/bin/env bun
/**
 * One real, cold, end-to-end provisioning of conch's natural voices, entirely
 * inside a temporary directory, then one line synthesized to a WAV. It never
 * plays audio and never touches conch's real folders, the live daemon's logs,
 * the Hugging Face cache or any uv of yours:
 *
 *   CONCH_HOME, CONCH_VOICE_HOME and HF_HOME all point into the temp dir, and
 *   the worker's stderr goes there too.
 *
 *   bun scripts/voice-env-e2e.ts [--uv <path>] [--keep]
 *
 * --uv defaults to the pinned uv the app embeds (scripts/fetch-uv.sh).
 * --keep leaves the temp dir (about 1.5 GB) for inspection.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const uvArg = args.includes("--uv") ? args[args.indexOf("--uv") + 1] : undefined;

const root = mkdtempSync(join(tmpdir(), "conch-voice-e2e-"));
process.env.CONCH_HOME = join(root, "home");
process.env.CONCH_VOICE_HOME = join(root, "voice");
process.env.HF_HOME = join(root, "hf");
process.env.HF_HUB_DISABLE_PROGRESS_BARS = "1";

// Imported after the environment is set: conchHome() and the voice root are read at call time anyway.
const { buildVoiceEnv, prefetchVoiceModel, voiceEnvPaths, VOICE_LOCK } = await import("../src/voice-env.ts");
const { ManagedTtsWorker } = await import("../src/tts-worker.ts");
const { parseWav } = await import("../src/tts-wav.ts");
const { loadConfig } = await import("../src/config.ts");

const started = performance.now();
const stamp = () => `${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const say = (line: string) => console.log(`${stamp()}  ${line}`);

function du(path: string): string {
  const out = Bun.spawnSync(["du", "-sh", path]).stdout.toString().trim().split(/\s+/)[0];
  return out || "0";
}

let uv = uvArg;
if (!uv) {
  const fetched = Bun.spawnSync(["bash", join(import.meta.dir, "fetch-uv.sh")], { stderr: "inherit" });
  if (fetched.exitCode !== 0) throw new Error("scripts/fetch-uv.sh failed");
  uv = fetched.stdout.toString().trim();
}
const uvVersion = Bun.spawnSync([uv, "--version"]).stdout.toString().trim();
const cfg = loadConfig();
const paths = voiceEnvPaths();
say(`temp root ${root}`);
say(`${uvVersion} at ${uv}; lock ${VOICE_LOCK.id} (${VOICE_LOCK.pins.size} packages, Python ${VOICE_LOCK.python})`);

const timings: Record<string, number> = {};
let stepStart = performance.now();
let stepName = "";
const endStep = () => {
  if (stepName) timings[stepName] = Math.round(performance.now() - stepStart);
};
let exitCode = 0;
try {
  const built = await buildVoiceEnv({
    paths,
    uv,
    progress: (step) => {
      endStep();
      stepName = step;
      stepStart = performance.now();
      say(step);
    },
  });
  endStep();
  stepName = "";
  say(`environment ready: Python ${built.python}`);

  stepStart = performance.now();
  say(`prefetching ${cfg.ttsModel} and synthesizing each of ${cfg.ttsVoices.length} ring voices once`);
  await prefetchVoiceModel({
    python: paths.python,
    model: cfg.ttsModel,
    voices: cfg.ttsVoices,
    speed: cfg.ttsSpeed,
    stderrPath: join(root, "prefetch.err.log"),
    log: (line) => say(`  ${line}`),
  });
  timings["prefetch model + every ring voice"] = Math.round(performance.now() - stepStart);

  stepStart = performance.now();
  const outputDir = mkdtempSync(join(root, "out-"));
  const worker = new ManagedTtsWorker({
    enabled: true,
    model: cfg.ttsModel,
    voices: cfg.ttsVoices,
    speed: cfg.ttsSpeed,
    python: paths.python,
    outputDir,
    retryDelaysMs: [0],
    spawn: (command) => Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(join(root, "worker.err.log")),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    }) as never,
    log: (line) => say(`  ${line}`),
  });
  try {
    if (!(await worker.start())) throw new Error(`worker did not start: ${worker.snapshot().lastError}`);
    timings["warm worker start (model cached)"] = Math.round(performance.now() - stepStart);
    const text = "This is conch, speaking in its own voice, set up by itself.";
    const synthStart = performance.now();
    const result = await worker.synthesize({ text, voice: "bm_george", speed: cfg.ttsSpeed, timeoutMs: 60_000 });
    timings["synthesize one line (bm_george)"] = Math.round(performance.now() - synthStart);
    const wav = join(root, "conch-voice-e2e.wav");
    copyFileSync(result.path, wav);
    const parsed = parseWav(new Uint8Array(readFileSync(wav)));
    if (!parsed) throw new Error("the WAV did not parse");
    say(`WAV ${wav}: ${result.samples} samples at ${result.sampleRate} Hz = ${(result.samples / result.sampleRate).toFixed(2)} s of audio, `
      + `worker latency ${Math.round(result.latencyMs)} ms, peak ${result.peak}, rms ${result.rms}, ${readFileSync(wav).byteLength} bytes`);
  } finally {
    worker.close();
  }

  console.log("\n── timings (ms) ──");
  for (const [name, ms] of Object.entries(timings)) console.log(`${String(ms).padStart(8)}  ${name}`);
  console.log(`${String(Math.round(performance.now() - started)).padStart(8)}  total`);
  console.log("\n── sizes ──");
  for (const [name, path] of [
    ["voice root (env + python + uv cache)", paths.root],
    ["  env", paths.env],
    ["  python (uv-managed CPython)", paths.pythonInstallDir],
    ["  uv cache", paths.cache],
    ["model cache (HF_HOME)", join(root, "hf")],
  ] as const) console.log(`${du(path).padStart(8)}  ${name}`);
} catch (error) {
  exitCode = 1;
  console.error(`\nE2E FAILED at ${stamp()}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error(`setup log: ${paths.log}`);
} finally {
  if (keep || exitCode !== 0) console.log(`\nkept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
