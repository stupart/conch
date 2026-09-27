/**
 * conch's own Python environment for its natural voices (Kokoro via mlx-audio).
 *
 * Tyler, 2026-09-27: "the voices are all default Mac — what happened there? On
 * my old laptop there was a custom voice for each session", and then: make the
 * fix "bundled with the app so people in the future can just download one
 * thing and it works."
 *
 * What had happened: the voices lived in a `uv tool install` the README told
 * people to type. On the new laptop that tool environment had been built on
 * Apple's Python 3.9 and lacked `loguru` (which mlx-audio 0.2.9 imports without
 * declaring), so the Kokoro import failed — reported as "Model type kokoro not
 * supported" — and the daemon fell back to `say` 53 times without anything on
 * screen saying why. Nothing in that chain was conch's to fix, because nothing
 * in it was conch's.
 *
 * Now it is. The daemon builds the environment itself, from a hashed lock of
 * exactly the set proven working (`voice-requirements.txt`), with a pinned uv
 * the Mac app carries (`Contents/Helpers/uv`, handed over as CONCH_UV), into
 * `~/.cache/conch/voice` — its own Python, its own uv cache, nothing shared
 * with the person's toolchain. It checks that environment at every start, and
 * rebuilds it in the background (bounded) when it is missing or wrong, while
 * `say` speaks. The status is published, so the app can say which it is.
 *
 * The worker's interpreter resolves in this order:
 *   1. CONCH_TTS_WORKER_PYTHON, when set — an explicit choice is never second-guessed;
 *   2. conch's own environment, when it passes the probe against the lock;
 *   3. the legacy `mlx_audio.server` tool's Python, when it can import Kokoro —
 *      so an existing setup keeps speaking while conch builds its own.
 */
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { ManagedTtsWorker, resolveMlxAudioPython, type TtsWorkerProcess } from "./tts-worker.ts";
import lockSource from "./voice-requirements.txt" with { type: "text" };

// MARK: - The lock

/** mlx-audio needs 3.10+: its dsp.py uses `X | Y` types (the 3.9 break of 2026-09-27). */
export const VOICE_PYTHON_FLOOR: readonly [number, number] = [3, 10];

export interface VoiceLockPin {
  /** PEP 503-normalised name. */
  name: string;
  version: string;
  url?: string;
  hashes: number;
}

export interface VoiceLock {
  /** `major.minor` of the uv-managed CPython the lock was resolved for. */
  python: string;
  pins: Map<string, VoiceLockPin>;
  /** Short digest of the lock text: which lock an environment was built from. */
  id: string;
}

export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Parse a `uv pip compile --generate-hashes` lock carrying conch's `# conch-voice-python:` header. */
export function parseVoiceLock(text: string): VoiceLock {
  const python = /^# conch-voice-python: (\d+\.\d+)\s*$/m.exec(text)?.[1];
  if (!python) throw new Error("voice lock has no `# conch-voice-python:` line");
  const pins = new Map<string, VoiceLockPin>();
  let current: VoiceLockPin | null = null;
  for (const line of text.split("\n")) {
    const requirement = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(?:==\s*([^\s\\;]+)|@\s*(\S+))/.exec(line);
    if (requirement) {
      const name = normalizePackageName(requirement[1]!);
      const url = requirement[3];
      // A URL pin's version is the wheel's: en_core_web_sm-3.8.0-py3-none-any.whl -> 3.8.0.
      const version = requirement[2] ?? /\/[A-Za-z0-9_.]+-(\d[^-/]*)-[^/]*\.whl$/.exec(url ?? "")?.[1] ?? "";
      current = { name, version, ...(url ? { url } : {}), hashes: 0 };
      pins.set(name, current);
      continue;
    }
    if (current && /^\s+--hash=sha256:[0-9a-f]{64}/.test(line)) current.hashes++;
  }
  return {
    python,
    pins,
    id: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

export const VOICE_LOCK_TEXT: string = lockSource;
export const VOICE_LOCK: VoiceLock = parseVoiceLock(lockSource);

// MARK: - Where it lives

export interface VoiceEnvPaths {
  root: string;
  /** The environment the worker runs in. */
  env: string;
  python: string;
  /** Built here, then renamed into place: a half-built env is never at `env`. */
  staging: string;
  /** UV_PYTHON_INSTALL_DIR: conch's own CPython, never the system's or the user's uv's. */
  pythonInstallDir: string;
  /** UV_PYTHON_BIN_DIR: where uv would put `python3.12` shims (never ~/.local/bin). */
  pythonBinDir: string;
  /** UV_CACHE_DIR: wheels, kept so a repair needs no second download. */
  cache: string;
  requirements: string;
  /** Written into `env` last: which lock built it, with which Python. */
  record: string;
  /** Which model and voices the last provisioning fetched and proved. */
  model: string;
  failures: string;
  /** The daemon's latest status, for `conch doctor` in another process. */
  status: string;
  log: string;
  /** One provisioner at a time: the daemon and `conch voices setup` share this. */
  lock: string;
}

/** `~/.cache/conch/voice`, beside conch's whisper models; CONCH_VOICE_HOME moves it (tests, the e2e script). */
export function defaultVoiceRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.CONCH_VOICE_HOME || join(conchHome(), ".cache", "conch", "voice");
}

export function voiceEnvPaths(root = defaultVoiceRoot()): VoiceEnvPaths {
  const env = join(root, "env");
  return {
    root,
    env,
    python: join(env, "bin", "python"),
    staging: join(root, "env.building"),
    pythonInstallDir: join(root, "python"),
    pythonBinDir: join(root, "python", "bin"),
    cache: join(root, "uv-cache"),
    requirements: join(root, "requirements.txt"),
    record: join(env, "conch-voice.json"),
    model: join(root, "model.json"),
    failures: join(root, "setup-failures.json"),
    status: join(root, "status.json"),
    log: join(root, "setup.log"),
    lock: join(root, "setup.lock"),
  };
}

// MARK: - Finding uv

export interface UvLocation {
  path: string;
  /** Where it came from, for the log and the status line. */
  source: "CONCH_UV" | "conch.app" | "PATH";
}

export interface FindUvOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  execPath?: string;
  executable?: (path: string) => boolean;
  which?: (name: string) => string | null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The uv conch builds with. CONCH_UV is what the Mac app hands its daemon (its
 * own `Contents/Helpers/uv`); set, it is the only answer. Otherwise the app's
 * helper where the app is installed, one beside a compiled `conch` (the
 * Homebrew tarball ships the two together), and last a uv on PATH — a
 * developer's, which still builds into conch's folder and nowhere else.
 */
export function findConchUv(options: FindUvOptions = {}): UvLocation | null {
  const env = options.env ?? process.env;
  const executable = options.executable ?? isExecutable;
  const explicit = env.CONCH_UV?.trim();
  if (explicit) return executable(explicit) ? { path: explicit, source: "CONCH_UV" } : null;

  const home = options.home ?? conchHome();
  const execDir = dirname(options.execPath ?? process.execPath);
  const helper = (app: string) => join(app, "Contents", "Helpers", "uv");
  for (const candidate of [
    helper("/Applications/conch.app"),
    helper(join(home, "Applications", "conch.app")),
    helper(join(execDir, "conch.app")),
    helper(join(dirname(execDir), "conch.app")),
  ]) {
    if (executable(candidate)) return { path: candidate, source: "conch.app" };
  }
  const onPath = (options.which ?? Bun.which)("uv");
  return onPath && executable(onPath) ? { path: onPath, source: "PATH" } : null;
}

/** MLX runs only on Apple silicon — including under a Rosetta-translated (x64) conch. */
export function isAppleSilicon(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.arch === "arm64") return true;
  try {
    return Bun.spawnSync(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"]).stdout.toString().trim() === "1";
  } catch {
    return false;
  }
}

// MARK: - Running a step

export interface StepResult {
  /** null when the step was killed (timeout or cancellation). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type StepRunner = (
  argv: string[],
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<StepResult>;

export const runStep: StepRunner = async (argv, options) => {
  const child = Bun.spawn(argv, { env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let killed = false;
  const kill = () => {
    killed = true;
    try { child.kill("SIGKILL"); } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  options.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    return { code: killed ? null : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
};

/**
 * The environment every uv step runs in: conch's own directories, only
 * uv-managed Python, no uv config files. Inherited settings that would move
 * any of that (UV_PYTHON*, UV_CACHE_DIR, UV_TOOL_*, a VIRTUAL_ENV, PYTHONPATH…)
 * are dropped; network settings (proxies, certificates, an index mirror) stay.
 */
export function uvEnvironment(
  paths: VoiceEnvPaths,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^UV_(PYTHON|CACHE|TOOL|PROJECT|SYSTEM_PYTHON|NO_CACHE|LINK_MODE|MANAGED_PYTHON|CONFIG_FILE|WORKING_DIR)/.test(key)) continue;
    if (/^(PYTHON(PATH|HOME|STARTUP|USERBASE)|VIRTUAL_ENV|CONDA_PREFIX|CONDA_DEFAULT_ENV)$/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir,
    UV_PYTHON_BIN_DIR: paths.pythonBinDir,
    UV_CACHE_DIR: paths.cache,
    // Only uv-managed CPython, never the system's (the 3.9 break). One switch,
    // not two: uv refuses --managed-python beside UV_PYTHON_PREFERENCE (found
    // by the first real run of scripts/voice-env-e2e.ts).
    UV_MANAGED_PYTHON: "1",
    UV_PYTHON_DOWNLOADS: "automatic",
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    // Never used by these steps; pointed inside conch's folder so no code path
    // can reach the person's own `uv tool` environments.
    UV_TOOL_DIR: join(paths.root, "tools"),
    UV_TOOL_BIN_DIR: join(paths.root, "tools", "bin"),
  };
}

// MARK: - The probe

/**
 * Imports what the worker imports and reports every installed version. Library
 * chatter goes to stderr so stdout carries one JSON line. `-I` ignores the
 * caller's PYTHONPATH and user site; `-B` writes no bytecode, so probing
 * someone else's environment leaves it byte-for-byte as it was.
 */
export const VOICE_PROBE_SCRIPT = String.raw`
import json, sys
out = sys.stdout
sys.stdout = sys.stderr
import importlib.metadata as md
versions = {}
for dist in md.distributions():
    name = dist.metadata["Name"] or ""
    versions[name] = dist.version
failed = None
try:
    import numpy, mlx.core, loguru, misaki, spacy, en_core_web_sm
    import mlx_audio.tts.models.kokoro
except BaseException as error:
    failed = type(error).__name__ + ": " + str(error)
print(json.dumps({"python": "%d.%d.%d" % sys.version_info[:3], "versions": versions, "import_error": failed}), file=out, flush=True)
`;

export interface VoiceProbeReport {
  python: string;
  versions: Record<string, string>;
  import_error: string | null;
}

export type VoiceProbeOutcome = { report: VoiceProbeReport } | { error: string };

export type VoiceProbeVerdict = { ok: true; python: string } | { ok: false; reason: string };

function versionAtLeast(version: string, floor: readonly [number, number]): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major > floor[0] || (major === floor[0] && minor >= floor[1]);
}

/**
 * `exact`: conch's own environment — the lock's Python and every pin, or it is
 * rebuilt. `usable`: someone else's (the legacy tool) — only that Kokoro
 * imports on a new-enough Python, since conch does not own its versions.
 */
export function judgeVoiceProbe(
  outcome: VoiceProbeOutcome,
  mode: "exact" | "usable",
  lock: VoiceLock = VOICE_LOCK,
): VoiceProbeVerdict {
  if ("error" in outcome) return { ok: false, reason: outcome.error };
  const report = outcome.report;
  if (!versionAtLeast(report.python, VOICE_PYTHON_FLOOR)) {
    return { ok: false, reason: `runs Python ${report.python}; Kokoro needs ${VOICE_PYTHON_FLOOR.join(".")}+` };
  }
  if (mode === "exact" && !report.python.startsWith(`${lock.python}.`)) {
    return { ok: false, reason: `runs Python ${report.python}; conch's lock is for ${lock.python}` };
  }
  if (mode === "exact") {
    const installed = new Map(
      Object.entries(report.versions).map(([name, version]) => [normalizePackageName(name), version]),
    );
    const off: string[] = [];
    for (const pin of lock.pins.values()) {
      const have = installed.get(pin.name);
      if (have === undefined) off.push(`${pin.name} missing`);
      else if (have !== pin.version) off.push(`${pin.name} ${have} ≠ ${pin.version}`);
    }
    if (off.length) {
      return {
        ok: false,
        reason: `is off the lock (${off.slice(0, 3).join(", ")}${off.length > 3 ? `, +${off.length - 3} more` : ""})`,
      };
    }
  }
  if (report.import_error) return { ok: false, reason: `cannot import Kokoro (${report.import_error})` };
  return { ok: true, python: report.python };
}

export async function probeVoicePython(
  python: string,
  options: { run?: StepRunner; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VoiceProbeOutcome> {
  if (!existsSync(python)) return { error: "is not set up yet" };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  let result: StepResult;
  try {
    result = await (options.run ?? runStep)([python, "-B", "-I", "-c", VOICE_PROBE_SCRIPT], {
      env,
      // Routinely ~2 s. The first import after a build is far slower — 47 s in the
      // first real run, macOS meeting every native library for the first time.
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      signal: options.signal,
    });
  } catch (error) {
    return { error: `probe could not start (${error instanceof Error ? error.message : String(error)})` };
  }
  if (result.code !== 0) {
    return { error: result.timedOut ? "probe timed out" : `probe exited ${result.code ?? "killed"}: ${lastLines(result.stderr)}` };
  }
  try {
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    const parsed = JSON.parse(line) as Partial<VoiceProbeReport>;
    if (typeof parsed.python !== "string" || typeof parsed.versions !== "object" || parsed.versions === null) {
      return { error: "probe printed an unexpected report" };
    }
    return {
      report: {
        python: parsed.python,
        versions: parsed.versions as Record<string, string>,
        import_error: typeof parsed.import_error === "string" ? parsed.import_error : null,
      },
    };
  } catch {
    return { error: "probe printed no report" };
  }
}

function lastLines(text: string, count = 3): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-count).join(" | ").slice(0, 400) || "no output";
}

// MARK: - Building it

export const VOICE_SETUP_STEPS = 4;
/**
 * Measured by scripts/voice-env-e2e.ts on 2026-09-27: the env is 1.2 GB and its
 * Python 73 MB. The uv cache reads as another 1.0 GB, but it is APFS clones of
 * the env's files — deleting it freed 21 MB — so the disk really holds ~1.3 GB.
 */
export const VOICE_ENV_SIZE_HINT = "about 1.3 GB, once";
/**
 * Free space a build needs before it starts: the env (1.3 GB), its Python and uv's cache headroom while it unpacks, and
 * Kokoro's model (~360 MB) after it. Below this a build fails part way with ENOSPC, so it waits instead, and says so.
 */
export const VOICE_ENV_NEEDS_BYTES = 1_700_000_000;

/** Bytes free on the volume holding `path` (or its nearest existing parent); null when it can't be read. */
export function freeBytesAt(path: string): number | null {
  let at = path;
  for (let i = 0; i < 16; i++) {
    try {
      const stats = statfsSync(at);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = dirname(at);
      if (parent === at) return null;
      at = parent;
    }
  }
  return null;
}

export class VoiceSetupError extends Error {
  constructor(readonly step: string, reason: string) {
    super(`${step} failed: ${reason}`);
    this.name = "VoiceSetupError";
  }
}

export interface BuildVoiceEnvOptions {
  paths: VoiceEnvPaths;
  uv: string;
  lock?: VoiceLock;
  lockText?: string;
  run?: StepRunner;
  /** Called with a person-readable step, `(n/4)`, as each one starts, and which step it is. */
  progress?: (step: string, at: { step: number; steps: number }) => void;
  signal?: AbortSignal;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

function appendLog(paths: VoiceEnvPaths, text: string): void {
  try {
    appendFileSync(paths.log, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * Build conch's environment from scratch: its own CPython, a fresh venv built
 * beside the live one and renamed into place, every package from the hashed
 * lock (compiled to bytecode, so the first import is fast), then the probe
 * against the lock. Throws a VoiceSetupError naming the step and why.
 */
export async function buildVoiceEnv(options: BuildVoiceEnvOptions): Promise<{ python: string }> {
  const { paths, uv } = options;
  const lock = options.lock ?? VOICE_LOCK;
  const run = options.run ?? runStep;
  const env = uvEnvironment(paths, options.baseEnv);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  writeFileSync(paths.requirements, options.lockText ?? VOICE_LOCK_TEXT, { mode: 0o600 });
  appendLog(paths, `\n=== ${new Date().toISOString()} building conch's voice environment (lock ${lock.id}) with ${uv}`);

  const step = async (n: number, label: string, argv: string[], timeoutMs: number): Promise<void> => {
    options.progress?.(`${label} (${n}/${VOICE_SETUP_STEPS})`, { step: n, steps: VOICE_SETUP_STEPS });
    appendLog(paths, `--- ${n}/${VOICE_SETUP_STEPS} ${label}: ${argv.join(" ")}`);
    if (options.signal?.aborted) throw new VoiceSetupError(label, "cancelled");
    let result: StepResult;
    try {
      result = await run(argv, { env, timeoutMs, signal: options.signal });
    } catch (error) {
      throw new VoiceSetupError(label, error instanceof Error ? error.message : String(error));
    }
    appendLog(paths, result.stdout + result.stderr);
    if (result.code === 0) return;
    if (options.signal?.aborted) throw new VoiceSetupError(label, "cancelled");
    throw new VoiceSetupError(
      label,
      result.timedOut
        ? `timed out after ${Math.round(timeoutMs / 60_000)} min`
        : `exit ${result.code ?? "killed"} — ${lastLines(result.stderr || result.stdout)}`,
    );
  };

  await step(1, `installing Python ${lock.python}`, [uv, "python", "install", lock.python, "--no-bin"], 15 * 60_000);
  rmSync(paths.staging, { recursive: true, force: true });
  await step(2, "creating the environment", [
    uv, "venv", paths.staging,
    "--python", lock.python,
    "--relocatable",
    "--no-project",
  ], 5 * 60_000);
  await step(3, `installing Kokoro and its packages (${VOICE_ENV_SIZE_HINT})`, [
    uv, "pip", "sync",
    "--python", join(paths.staging, "bin", "python"),
    "--require-hashes",
    "--compile-bytecode",
    paths.requirements,
  ], 60 * 60_000);

  // Swap in whole. The old env (if any) is set aside first so a crash between
  // the two renames leaves either the old or the new one, never a mixture.
  const retired = `${paths.env}.old-${process.pid}`;
  rmSync(retired, { recursive: true, force: true });
  if (existsSync(paths.env)) renameSync(paths.env, retired);
  renameSync(paths.staging, paths.env);
  rmSync(retired, { recursive: true, force: true });

  options.progress?.(`checking it (4/${VOICE_SETUP_STEPS})`, { step: 4, steps: VOICE_SETUP_STEPS });
  const verdict = judgeVoiceProbe(
    await probeVoicePython(paths.python, { run, signal: options.signal, timeoutMs: 10 * 60_000 }),
    "exact",
    lock,
  );
  appendLog(paths, `--- 4/${VOICE_SETUP_STEPS} probe: ${verdict.ok ? `ok, Python ${verdict.python}` : verdict.reason}`);
  if (!verdict.ok) throw new VoiceSetupError("checking it", `the new environment ${verdict.reason}`);
  writeFileSync(paths.record, JSON.stringify({
    lock: lock.id,
    python: verdict.python,
    uv,
    builtAt: new Date().toISOString(),
  }) + "\n", { mode: 0o600 });
  return { python: verdict.python };
}

// MARK: - The model

/**
 * Fetch the model and every ring voice by doing what the daemon will do: the
 * production worker, loaded, then one short line in each voice. The first
 * announcement is then never a 360 MB download, and "ready" means this Mac has
 * already synthesized every voice through the exact path the daemon uses.
 *
 * Files land in the standard Hugging Face cache (~/.cache/huggingface, or
 * HF_HOME). That is deliberate: it is where mlx-audio has always put Kokoro, so
 * an existing install's model is reused rather than downloaded a second time,
 * the worker needs no extra environment to find it, and huggingface_hub keeps
 * its own locking and integrity checks. The cost: removing ~/.cache/conch
 * leaves the model behind (`conch uninstall --models` says where it is).
 *
 * The worker loads the model once here (~650 MB, for seconds) even in manual
 * mode; that happens once per model, not per start.
 */
export async function prefetchVoiceModel(options: {
  python: string;
  model: string;
  voices: readonly string[];
  speed: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** The worker reads an absent model from the network here: allow for a slow connection. */
  startupTimeoutMs?: number;
  /** Its own stderr file: never the live worker's /tmp/conch-kokoro-worker.err.log. */
  stderrPath: string;
}): Promise<{ voices: string[] }> {
  const outputDir = mkdtempSync(join(tmpdir(), "conch-voice-prefetch-"));
  const worker = new ManagedTtsWorker({
    spawn: (command) => Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: Bun.file(options.stderrPath),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    }) as unknown as TtsWorkerProcess,
    enabled: true,
    model: options.model,
    voices: [...options.voices],
    speed: options.speed,
    python: options.python,
    startupTimeoutMs: options.startupTimeoutMs ?? 30 * 60_000,
    retryDelaysMs: [0],
    periodicRetryMs: 24 * 60 * 60_000,
    outputDir,
    log: options.log ?? (() => {}),
  });
  const abort = () => worker.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (!(await worker.start())) {
      throw new Error(worker.snapshot().lastError ?? "the voice worker did not start");
    }
    const proved: string[] = [];
    for (const voice of options.voices) {
      if (options.signal?.aborted) throw new Error("cancelled");
      const result = await worker.synthesize({ text: "Ready.", voice, speed: options.speed, timeoutMs: 5 * 60_000 });
      try { unlinkSync(result.path); } catch {}
      if (result.samples <= 0) throw new Error(`voice ${voice} produced no audio`);
      proved.push(voice);
    }
    return { voices: proved };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    worker.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
}

interface ModelRecord {
  model: string;
  voices: string[];
  lock: string;
  at: string;
}

export function modelPrefetched(paths: VoiceEnvPaths, model: string, voices: readonly string[], lock = VOICE_LOCK): boolean {
  try {
    const record = JSON.parse(readFileSync(paths.model, "utf8")) as Partial<ModelRecord>;
    return record.model === model
      && record.lock === lock.id
      && Array.isArray(record.voices)
      && voices.every((voice) => record.voices!.includes(voice));
  } catch {
    return false;
  }
}

export function recordModelPrefetched(paths: VoiceEnvPaths, model: string, voices: readonly string[], lock = VOICE_LOCK): void {
  const record: ModelRecord = { model, voices: [...voices], lock: lock.id, at: new Date().toISOString() };
  writeFileSync(paths.model, JSON.stringify(record) + "\n", { mode: 0o600 });
}

// MARK: - Bounded retries, across restarts

export const VOICE_SETUP_MAX_FAILURES = 3;
export const VOICE_SETUP_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/** Before each build in one daemon's life: now, a minute later, five minutes later. Then it stops. */
export const VOICE_SETUP_RETRY_DELAYS_MS: readonly number[] = [0, 60_000, 5 * 60_000];

export interface VoiceSetupFailures {
  lock: string;
  count: number;
  lastError: string;
  at: number;
}

/** Failures of THIS lock in the window. A new lock (a conch upgrade) or a quiet day starts over. */
export function readSetupFailures(paths: VoiceEnvPaths, now = Date.now(), lock = VOICE_LOCK): VoiceSetupFailures | null {
  try {
    const record = JSON.parse(readFileSync(paths.failures, "utf8")) as Partial<VoiceSetupFailures>;
    if (record.lock !== lock.id || typeof record.count !== "number" || typeof record.at !== "number") return null;
    if (now - record.at > VOICE_SETUP_FAILURE_WINDOW_MS) return null;
    return { lock: record.lock, count: record.count, lastError: String(record.lastError ?? ""), at: record.at };
  } catch {
    return null;
  }
}

export function recordSetupFailure(paths: VoiceEnvPaths, error: string, now = Date.now(), lock = VOICE_LOCK): number {
  const count = (readSetupFailures(paths, now, lock)?.count ?? 0) + 1;
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    writeFileSync(paths.failures, JSON.stringify({ lock: lock.id, count, lastError: error, at: now }) + "\n", { mode: 0o600 });
  } catch {}
  return count;
}

export function clearSetupFailures(paths: VoiceEnvPaths): void {
  try { unlinkSync(paths.failures); } catch {}
}

// MARK: - One provisioner at a time

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the setup lock, or learn who holds it. A holder that died leaves a lock that is simply taken over. */
export function acquireSetupLock(paths: VoiceEnvPaths): { release: () => void } | { heldBy: number } {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            if (readFileSync(paths.lock, "utf8").trim() === String(process.pid)) unlinkSync(paths.lock);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(paths.lock, "utf8").trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) return { heldBy: holder };
      try { unlinkSync(paths.lock); } catch {}
    }
  }
  return { heldBy: -1 };
}

// MARK: - The daemon's view

export type NaturalVoicesState = "checking" | "setting-up" | "ready" | "off";
export type VoicePythonSource = "explicit" | "conch" | "legacy";

/** What the published state and the app's Settings show: "Natural voices: <state> (<reason>)". */
export interface NaturalVoicesStatus {
  state: NaturalVoicesState;
  /** Short, for "off (reason)": `CONCH_TTS=say`, `setup failed`, `needs Apple silicon`… */
  reason?: string;
  /** One sentence a person can act on. */
  detail: string;
  source?: VoicePythonSource;
  /**
   * While setting up, which build step (1 to `steps`), so setup's tray says "step 3 of 4" without reading `detail`.
   * Absent outside the build: fetching the voices after it (`stage: "prefetch"`), or another conch building them
   * (`stage: "elsewhere"`).
   */
  step?: number;
  steps?: number;
  stage?: "prefetch" | "elsewhere";
  /** The build is waiting for room: what it needs and what the disk has, in bytes. */
  space?: { needs: number; free: number };
}

export interface VoiceEnvManagerOptions {
  engine: "worker" | "server" | "say";
  /** CONCH_TTS_WORKER_PYTHON: when set, used as-is and nothing is built. */
  explicitPython: string;
  /** The legacy `mlx_audio.server` launcher, whose shebang names its Python. */
  serverBin: string;
  model: string;
  voices: readonly string[];
  speed: number;
  /** Hand the worker its interpreter; null means none yet — speech goes to `say`. */
  usePython: (python: string | null, source: VoicePythonSource | null) => void;
  log: (line: string) => void;
  onStatus?: (status: NaturalVoicesStatus) => void;
  paths?: VoiceEnvPaths;
  lock?: VoiceLock;
  // Seams, all defaulted to the real thing.
  appleSilicon?: () => boolean;
  findUv?: () => UvLocation | null;
  resolveExplicit?: (explicit: string) => string | null;
  resolveLegacy?: () => string | null;
  probe?: (python: string, signal: AbortSignal) => Promise<VoiceProbeOutcome>;
  build?: (uv: string, progress: (step: string, at?: { step: number; steps: number }) => void, signal: AbortSignal) => Promise<void>;
  /** Bytes free where the env is built (`freeBytesAt`); null when unknown, which never blocks a build. */
  freeBytes?: (path: string) => number | null;
  prefetch?: (python: string, signal: AbortSignal) => Promise<void>;
  retryDelaysMs?: readonly number[];
  maxFailures?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  /** How often a finally-failed setup looks for one finished elsewhere (`conch voices setup`). */
  watchMs?: number;
  /** A worker that keeps failing on an env that checks out is re-checked at most this often. */
  recheckMs?: number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "1.7 GB", "900 MB": the way Finder writes them. */
function gigabytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Owns which Python the Kokoro worker runs, and conch's environment behind it:
 * the check at start, the background build when it is missing or wrong, the
 * bounded retries, the model prefetch, and the status line. Everything runs off
 * the daemon's critical path; `say` speaks until a Python is handed over.
 */
export class VoiceEnvManager {
  private status: NaturalVoicesStatus = { state: "checking", detail: "checking conch's voice environment" };
  private source: VoicePythonSource | null = null;
  private python: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private buildsThisRun = 0;
  /** The last failure this run, for when the on-disk record cannot be written (a full disk). */
  private lastBuildError: string | null = null;
  /** The room the last attempt waited for, kept on the status while it gives up. */
  private lastSpace: { needs: number; free: number } | null = null;
  private lastRecheckAt = Number.NEGATIVE_INFINITY;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lifecycle = new AbortController();
  private readonly paths: VoiceEnvPaths;
  private readonly lock: VoiceLock;

  constructor(private readonly options: VoiceEnvManagerOptions) {
    this.paths = options.paths ?? voiceEnvPaths();
    this.lock = options.lock ?? VOICE_LOCK;
  }

  snapshot(): NaturalVoicesStatus {
    return { ...this.status };
  }

  start(): Promise<void> {
    return this.enqueue(() => this.resolve());
  }

  /** Test/diagnostic barrier: every queued check and build has finished. */
  async settled(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
  }

  /**
   * The worker gave up a start burst. A legacy interpreter that cannot start
   * Kokoro is dropped at once (say speaks; conch's own build, if running,
   * takes over when it lands). conch's own is re-probed: broken means rebuilt.
   */
  workerStartFailed(error: string): void {
    if (this.lifecycle.signal.aborted) return;
    if (this.source === "legacy") {
      this.options.log(`natural voices: your mlx-audio install could not start Kokoro (${error}) — using say`);
      this.use(null, null);
      if (this.status.state === "ready") {
        this.setStatus({ state: "off", reason: "mlx-audio failed", detail: `your mlx-audio install could not start Kokoro: ${error}` });
      }
      return;
    }
    if (this.source !== "conch") return;
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastRecheckAt < (this.options.recheckMs ?? 10 * 60_000)) return;
    this.lastRecheckAt = now;
    void this.enqueue(async () => {
      if (this.source !== "conch") return;
      const own = await this.checkOwn();
      if (own.ok) {
        this.options.log(`natural voices: conch's environment checks out; the worker failed for another reason (${error})`);
        return;
      }
      this.options.log(`natural voices: the worker failed to start and conch's environment ${own.reason} — rebuilding`);
      this.use(null, null);
      await this.buildLoop();
    });
  }

  close(): void {
    this.lifecycle.abort();
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work).catch((error) => {
      if (!this.lifecycle.signal.aborted) this.options.log(`natural voices: ${errorText(error)}`);
    });
    this.queue = next;
    return next;
  }

  private setStatus(status: NaturalVoicesStatus): void {
    const source = status.source ?? (status.state === "ready" ? this.source ?? undefined : undefined);
    this.status = { ...status, ...(source ? { source } : {}) };
    try {
      mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
      writeFileSync(this.paths.status, JSON.stringify({ ...this.status, pid: process.pid, at: Date.now() }) + "\n", { mode: 0o600 });
    } catch {}
    try { this.options.onStatus?.(this.snapshot()); } catch {}
  }

  private use(python: string | null, source: VoicePythonSource | null): void {
    if (this.python === python && this.source === source) return;
    this.python = python;
    this.source = source;
    this.options.usePython(python, source);
  }

  private meanwhile(): string {
    return this.source === "legacy"
      ? "using your mlx-audio install until it is ready"
      : "speaking with macOS say until it is ready";
  }

  private async checkOwn(): Promise<VoiceProbeVerdict> {
    const probe = this.options.probe ?? ((python, signal) => probeVoicePython(python, { signal }));
    return judgeVoiceProbe(await probe(this.paths.python, this.lifecycle.signal), "exact", this.lock);
  }

  private async resolve(): Promise<void> {
    const { engine } = this.options;
    if (engine === "say") {
      this.use(null, null);
      this.setStatus({ state: "off", reason: "CONCH_TTS=say", detail: "CONCH_TTS=say — conch speaks with macOS say and sets nothing up" });
      return;
    }
    const explicit = this.options.explicitPython.trim();
    if (explicit) {
      const python = (this.options.resolveExplicit ?? ((value) => resolveMlxAudioPython(value, this.options.serverBin)))(explicit);
      if (python) {
        this.use(python, "explicit");
        this.setStatus({ state: "ready", detail: `your Python, from CONCH_TTS_WORKER_PYTHON (${python})`, source: "explicit" });
      } else {
        this.use(null, null);
        this.setStatus({
          state: "off",
          reason: "CONCH_TTS_WORKER_PYTHON not found",
          detail: `CONCH_TTS_WORKER_PYTHON=${explicit} was not found — voices via say`,
        });
      }
      return;
    }
    if (!(this.options.appleSilicon ?? isAppleSilicon)()) {
      this.use(null, null);
      this.setStatus({ state: "off", reason: "needs Apple silicon", detail: "Kokoro runs on MLX, which needs Apple silicon — voices via say" });
      return;
    }

    this.setStatus({ state: "checking", detail: "checking conch's voice environment" });
    const own = await this.checkOwn();
    if (own.ok) {
      await this.adoptOwn(own.python);
      return;
    }
    this.options.log(`natural voices: conch's environment ${own.reason}`);

    // An existing setup keeps speaking while conch builds its own — but only one
    // that can actually import Kokoro: the old laptop's Python 3.9 tool could not.
    const legacy = (this.options.resolveLegacy ?? (() => resolveMlxAudioPython("", this.options.serverBin)))();
    if (legacy && legacy !== this.paths.python) {
      const probe = this.options.probe ?? ((python, signal) => probeVoicePython(python, { signal }));
      const usable = judgeVoiceProbe(await probe(legacy, this.lifecycle.signal), "usable", this.lock);
      if (usable.ok) {
        this.options.log(`natural voices: using your mlx-audio install (${legacy}) while conch builds its own`);
        this.use(legacy, "legacy");
      } else {
        this.options.log(`natural voices: your mlx-audio install (${legacy}) ${usable.reason} — not using it`);
        this.use(null, null);
      }
    } else {
      this.use(null, null);
    }
    await this.buildLoop();
  }

  /** conch's environment checks out: fetch the model if this model/voice set is new, then hand it over. */
  private async adoptOwn(pythonVersion: string): Promise<void> {
    const { model, voices } = this.options;
    if (!modelPrefetched(this.paths, model, voices, this.lock)) {
      this.setStatus({
        state: "setting-up",
        detail: `downloading and trying the Kokoro voices (~360 MB, once) — ${this.meanwhile()}`,
        stage: "prefetch",
      });
      try {
        const prefetch = this.options.prefetch ?? ((python, signal) => prefetchVoiceModel({
          python, model, voices, speed: this.options.speed, signal, log: this.options.log,
          stderrPath: join(this.paths.root, "prefetch.err.log"),
        }).then(() => {}));
        await prefetch(this.paths.python, this.lifecycle.signal);
        recordModelPrefetched(this.paths, model, voices, this.lock);
        this.options.log(`natural voices: ${model} fetched and every ring voice synthesized once`);
      } catch (error) {
        if (this.lifecycle.signal.aborted) return;
        // Not fatal: the worker fetches what it lacks on first start, as it always has.
        this.options.log(`natural voices: prefetching ${model} failed (${errorText(error)}) — the worker will fetch it on first start`);
      }
    }
    if (this.lifecycle.signal.aborted) return;
    this.use(this.paths.python, "conch");
    this.stopWatching();
    this.setStatus({ state: "ready", detail: `conch's own environment (Python ${pythonVersion})`, source: "conch" });
  }

  private async buildLoop(): Promise<void> {
    const signal = this.lifecycle.signal;
    const delays = this.options.retryDelaysMs ?? VOICE_SETUP_RETRY_DELAYS_MS;
    const maxFailures = this.options.maxFailures ?? VOICE_SETUP_MAX_FAILURES;
    const now = this.options.now ?? Date.now;
    const uv = (this.options.findUv ?? (() => findConchUv()))();
    if (!uv) {
      this.giveUp("no uv", "no uv to build it with — install the conch app (it carries one), or set CONCH_UV");
      return;
    }

    while (!signal.aborted) {
      const failures = readSetupFailures(this.paths, now(), this.lock);
      if (failures && failures.count >= maxFailures) {
        this.giveUp("setup failed", `setup failed ${failures.count} times: ${failures.lastError} — \`conch voices setup\` tries again`);
        return;
      }
      if (this.buildsThisRun >= delays.length) {
        this.giveUp("setup failed", `setup failed: ${failures?.lastError ?? this.lastBuildError ?? "unknown"} — \`conch voices setup\` tries again`);
        return;
      }
      if (!(await (this.options.sleep ?? abortableSleep)(delays[this.buildsThisRun]!, signal))) return;
      this.buildsThisRun++;

      const held = acquireSetupLock(this.paths);
      if ("heldBy" in held) {
        this.setStatus({ state: "setting-up", detail: `being set up by another conch process (pid ${held.heldBy}) — ${this.meanwhile()}`, stage: "elsewhere" });
        while (!signal.aborted && existsSync(this.paths.lock)) {
          if (!(await (this.options.sleep ?? abortableSleep)(5_000, signal))) return;
          const again = acquireSetupLock(this.paths);
          if (!("heldBy" in again)) {
            again.release();
            break;
          }
        }
        this.buildsThisRun--; // someone else's attempt is not one of ours
        const own = await this.checkOwn();
        if (own.ok) {
          await this.adoptOwn(own.python);
          return;
        }
        continue;
      }

      // Room first: a build that runs out of disk half way fails in a way nobody can read. Waiting for room is an
      // attempt like any other, so it is bounded, retried, and said.
      const free = (this.options.freeBytes ?? freeBytesAt)(this.paths.root);
      if (free !== null && free < VOICE_ENV_NEEDS_BYTES) {
        held.release();
        const why = `not enough free space: needs ${gigabytes(VOICE_ENV_NEEDS_BYTES)}, this Mac has ${gigabytes(free)}`;
        this.lastBuildError = why;
        this.lastSpace = { needs: VOICE_ENV_NEEDS_BYTES, free };
        recordSetupFailure(this.paths, why, now(), this.lock);
        this.options.log(`natural voices: ${why} — waiting before trying again`);
        this.setStatus({ state: "setting-up", detail: `${why} — ${this.meanwhile()}`, space: this.lastSpace });
        continue;
      }
      this.lastSpace = null;
      try {
        this.options.log(`natural voices: building conch's environment with ${uv.path} (from ${uv.source}), attempt ${this.buildsThisRun}`);
        const build = this.options.build ?? ((uvPath, progress, abort) => buildVoiceEnv({
          paths: this.paths, uv: uvPath, lock: this.lock, progress, signal: abort,
        }).then(() => {}));
        await build(uv.path, (step, at) => {
          this.options.log(`natural voices: ${step}`);
          this.setStatus({ state: "setting-up", detail: `${step} — ${this.meanwhile()}`, ...(at ? { step: at.step, steps: at.steps } : {}) });
        }, signal);
      } catch (error) {
        held.release();
        if (signal.aborted) return;
        const why = errorText(error);
        this.lastBuildError = why;
        const count = recordSetupFailure(this.paths, why, now(), this.lock);
        this.options.log(`natural voices: setup attempt ${this.buildsThisRun} failed (${count} in the last day): ${why} — see ${this.paths.log}`);
        continue;
      }
      held.release();

      // The build ends with its own probe; this one is the same check the next start makes.
      const own = await this.checkOwn();
      if (!own.ok) {
        this.lastBuildError = `built, but the environment ${own.reason}`;
        recordSetupFailure(this.paths, this.lastBuildError, now(), this.lock);
        continue;
      }
      clearSetupFailures(this.paths);
      this.options.log(`natural voices: conch's environment is built (Python ${own.python})`);
      await this.adoptOwn(own.python);
      return;
    }
  }

  /** Bounded out. Say why, keep any legacy Python that works, and watch for a setup finished elsewhere. */
  private giveUp(reason: string, detail: string): void {
    this.options.log(`natural voices: ${detail}`);
    if (this.source === "legacy" && this.python) {
      this.setStatus({ state: "ready", detail: `your mlx-audio install (${this.python}); conch's own ${detail}`, source: "legacy" });
    } else {
      this.setStatus({ state: "off", reason, detail, ...(this.lastSpace ? { space: this.lastSpace } : {}) });
    }
    this.watchForSetupElsewhere();
  }

  /**
   * Setup's Retry, for voices that gave up: this run's attempts and the day's failure record are forgotten, and the
   * voices are resolved again from the start. Nothing happens while they are ready, or still being set up.
   */
  retry(): boolean {
    if (this.lifecycle.signal.aborted || this.status.state !== "off" || this.status.reason === "needs Apple silicon") return false;
    clearSetupFailures(this.paths);
    this.buildsThisRun = 0;
    this.lastBuildError = null;
    this.lastSpace = null;
    this.stopWatching();
    void this.enqueue(() => this.resolve());
    return true;
  }

  /** `conch voices setup` in a terminal can finish what the daemon gave up on; notice its record. */
  private watchForSetupElsewhere(): void {
    if (this.watchTimer || this.lifecycle.signal.aborted) return;
    const recordStamp = () => {
      try { return statSync(this.paths.record).mtimeMs; } catch { return 0; }
    };
    const seen = recordStamp();
    this.watchTimer = setInterval(() => {
      if (recordStamp() === seen) return;
      this.stopWatching();
      void this.enqueue(async () => {
        const own = await this.checkOwn();
        if (own.ok) await this.adoptOwn(own.python);
      });
    }, this.options.watchMs ?? 30_000);
    this.watchTimer.unref?.();
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }
}

// MARK: - Outside the daemon (`conch doctor`, `conch setup`)

/** The daemon's last published status, if that daemon is still alive. */
export function readPublishedVoiceStatus(paths = voiceEnvPaths()): (NaturalVoicesStatus & { pid: number }) | null {
  try {
    const status = JSON.parse(readFileSync(paths.status, "utf8")) as NaturalVoicesStatus & { pid?: number };
    if (typeof status.pid !== "number" || !pidAlive(status.pid) || typeof status.state !== "string") return null;
    return { ...status, pid: status.pid };
  } catch {
    return null;
  }
}

/** The one line `conch doctor` and `conch setup` print. */
export function describeNaturalVoices(status: NaturalVoicesStatus): string {
  const head = status.state === "ready"
    ? "ready"
    : status.state === "setting-up"
      ? "setting up…"
      : status.state === "checking"
        ? "checking…"
        : `off (${status.reason ?? "see below"})`;
  return `Natural voices: ${head} — ${status.detail}`;
}

/** The environment conch built, as its record says — without running anything. */
export function readVoiceEnvRecord(paths = voiceEnvPaths()): { lock: string; python: string } | null {
  try {
    const record = JSON.parse(readFileSync(paths.record, "utf8")) as { lock?: unknown; python?: unknown };
    return typeof record.lock === "string" && typeof record.python === "string"
      ? { lock: record.lock, python: record.python }
      : null;
  } catch {
    return null;
  }
}

export interface VoiceSetupNowOptions {
  engine: "worker" | "server" | "say";
  explicitPython: string;
  model: string;
  voices: readonly string[];
  speed: number;
  print: (line: string) => void;
  paths?: VoiceEnvPaths;
  findUv?: () => UvLocation | null;
  appleSilicon?: () => boolean;
}

/**
 * `conch voices setup`: the same build the daemon does in the background, in
 * the foreground with its progress printed — for someone who wants it now, or
 * after the daemon's bounded attempts ran out. It does not count against them.
 */
export async function setUpVoicesNow(options: VoiceSetupNowOptions): Promise<boolean> {
  const paths = options.paths ?? voiceEnvPaths();
  const print = options.print;
  if (options.engine === "say") {
    print("Natural voices are off (CONCH_TTS=say) — nothing to set up.");
    return false;
  }
  if (options.engine === "server") {
    print("CONCH_TTS=server uses your own mlx_audio.server — conch sets nothing up in that mode.");
    return false;
  }
  if (options.explicitPython.trim()) {
    print(`CONCH_TTS_WORKER_PYTHON is set (${options.explicitPython.trim()}) — conch uses that Python and builds nothing.`);
    return true;
  }
  if (!(options.appleSilicon ?? isAppleSilicon)()) {
    print("Kokoro runs on MLX, which needs Apple silicon — this Mac keeps the macOS say voice.");
    return false;
  }
  const uv = (options.findUv ?? (() => findConchUv()))();
  if (!uv) {
    print("No uv to build with: install the conch app (it carries one), or point CONCH_UV at a uv binary.");
    return false;
  }
  const held = acquireSetupLock(paths);
  if ("heldBy" in held) {
    print(`conch (pid ${held.heldBy}) is setting up the natural voices right now — \`conch doctor\` shows how far it got.`);
    return false;
  }
  try {
    const own = judgeVoiceProbe(await probeVoicePython(paths.python), "exact");
    if (!own.ok) {
      print(`Setting up conch's voice environment in ${paths.root} (${VOICE_ENV_SIZE_HINT}), with ${uv.path}:`);
      await buildVoiceEnv({ paths, uv: uv.path, progress: (step) => print(`  ${step}…`) });
    }
    if (!modelPrefetched(paths, options.model, options.voices)) {
      print("  downloading the Kokoro model and trying every voice (~360 MB, once)…");
      await prefetchVoiceModel({
        python: paths.python,
        model: options.model,
        voices: options.voices,
        speed: options.speed,
        stderrPath: join(paths.root, "prefetch.err.log"),
      });
      recordModelPrefetched(paths, options.model, options.voices);
    }
    clearSetupFailures(paths);
    print(`✅ Natural voices ready (conch's own environment, ${paths.root}). A running daemon picks them up by itself.`);
    return true;
  } catch (error) {
    print(`❌ Natural voices setup failed: ${errorText(error)}`);
    print(`   The full log is ${paths.log}. conch keeps speaking with macOS say meanwhile.`);
    return false;
  } finally {
    held.release();
  }
}
