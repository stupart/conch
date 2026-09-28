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
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { ManagedTtsWorker, resolveMlxAudioPython, type TtsWorkerProcess } from "./tts-worker.ts";
import { CONCH_VERSION } from "./version.ts";
import {
  budgetReset,
  classifyVoiceFailure,
  countFailure,
  countsAgainstBudget,
  decideVoiceHeal,
  diskFreedSince,
  healPercent,
  unsupportedReason,
  voiceHealEpoch,
  type VoiceFailureKind,
  type VoiceHealAction,
  type VoiceHealBudget,
  type VoiceHealDecision,
  type VoiceHealObservation,
  type VoiceWorkerTrouble,
} from "./voice-heal.ts";
import type { ModelCacheCheck } from "./voice-model-cache.ts";
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
  /** Written the first time conch's own voices were ready: after that, healing says "coming back", not "setting up". */
  ready: string;
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
    ready: join(root, "ready-once"),
  };
}

// MARK: - Finding uv

export interface UvLocation {
  path: string;
  /** Where it came from, for the log and the status line. */
  source: "CONCH_UV" | "conch.app" | "record" | "PATH";
}

export interface FindUvOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  execPath?: string;
  executable?: (path: string) => boolean;
  which?: (name: string) => string | null;
  /** The uv the environment was last built with (its record): still there, it is the next best after an app. */
  remembered?: string | null;
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
 * own `Contents/Helpers/uv`), and wins while it is there. Gone (the app was
 * moved or replaced while this daemon ran), the search goes on rather than
 * giving up: the app's helper where the app is installed, one beside a compiled
 * `conch` (the Homebrew tarball ships the two together), the uv the environment
 * was last built with, and last a uv on PATH — a developer's, which still
 * builds into conch's folder and nowhere else.
 */
export function findConchUv(options: FindUvOptions = {}): UvLocation | null {
  const env = options.env ?? process.env;
  const executable = options.executable ?? isExecutable;
  const explicit = env.CONCH_UV?.trim();
  if (explicit && executable(explicit)) return { path: explicit, source: "CONCH_UV" };

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
  if (options.remembered && executable(options.remembered)) return { path: options.remembered, source: "record" };
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

/**
 * `CONCH_TEST_HOOKS=<dir>`: the end-to-end test's switchboard (scripts/voice-heal-e2e.ts). Unset — always, outside that
 * test — every hook is inert. `<dir>/free-bytes` stands in for the disk's free space; the worker reads `<dir>/worker-fault`
 * (src/tts-worker.py).
 */
export function voiceTestHooks(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return env.CONCH_TEST_HOOKS?.trim() || null;
}

/**
 * One of the e2e test's figures (`<hooks>/<name>`), or null — always null unless CONCH_TEST_HOOKS is set. `free-bytes`
 * (the disk), `watch-ms` (how often a waiting heal looks again), `worker-retry-ms` (the worker's periodic retry).
 */
export function voiceTestFigure(name: string, env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const hooks = voiceTestHooks(env);
  if (!hooks) return null;
  try {
    const value = Number(readFileSync(join(hooks, name), "utf8").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Free bytes where the environment is built, or what the e2e test's hook says the disk has. */
export function voiceFreeBytes(path: string, env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  return voiceTestFigure("free-bytes", env) ?? freeBytesAt(path);
}

/** Is the network there: any answer from a cheap HEAD request. CONCH_VOICE_NETWORK_PROBE_URL moves it (the e2e test). */
export async function probeNetwork(signal?: AbortSignal, env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  const url = env.CONCH_VOICE_NETWORK_PROBE_URL?.trim() || "https://pypi.org/simple/";
  try {
    const timeout = AbortSignal.timeout(5_000);
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Packages uv has unpacked into conch's cache so far: how far the package step has got. */
export function packagesUnpacked(paths: VoiceEnvPaths): number {
  let count = 0;
  try {
    for (const name of readdirSync(paths.cache)) {
      if (!name.startsWith("archive-")) continue;
      try { count += readdirSync(join(paths.cache, name)).length; } catch {}
    }
  } catch {}
  return count;
}

// MARK: - What an environment was built on

/** What an environment depends on outside itself: macOS, the interpreter, and the uv that built it. */
export interface VoiceFingerprint {
  macos: string;
  uv: string | null;
  python: string | null;
}

/** A file as it is now: where it really is, its size and when it last changed. Null when it isn't there. */
export function fileIdentity(path: string): string | null {
  try {
    const real = realpathSync(path);
    const stats = statSync(real);
    return `${real}:${stats.size}:${Math.round(stats.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** The Darwin release moves with every macOS update, security ones included. */
export function macosVersion(): string {
  return `${process.platform} ${release()}`;
}

export function voiceFingerprint(paths: VoiceEnvPaths, uv: string | null): VoiceFingerprint {
  return { macos: macosVersion(), uv: uv ? fileIdentity(uv) : null, python: fileIdentity(paths.python) };
}

/** What changed since the environment was built: macOS, its interpreter, or the uv (the app moved or was updated). */
export function fingerprintDrift(recorded: VoiceFingerprint | undefined, now: VoiceFingerprint): Array<"macos" | "uv" | "python"> {
  if (!recorded) return [];
  const drift: Array<"macos" | "uv" | "python"> = [];
  if (recorded.macos !== now.macos) drift.push("macos");
  if (recorded.python !== now.python) drift.push("python");
  if (now.uv !== null && recorded.uv !== now.uv) drift.push("uv");
  return drift;
}

// MARK: - What a killed build leaves behind

/** A build killed part way leaves its half-built env beside the live one, or an old one set aside mid-swap. */
export function buildLeftovers(paths: VoiceEnvPaths): string[] {
  const found: string[] = [];
  if (existsSync(paths.staging)) found.push(paths.staging);
  try {
    for (const name of readdirSync(paths.root)) if (name.startsWith("env.old-")) found.push(join(paths.root, name));
  } catch {}
  return found;
}

/** Remove them. Only ever with the setup lock held: another process's build in progress looks the same. */
export function cleanBuildLeftovers(paths: VoiceEnvPaths): string[] {
  const found = buildLeftovers(paths);
  for (const path of found) rmSync(path, { recursive: true, force: true });
  return found;
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
  // A build killed part way (the Mac slept, conch quit, the disk filled) left its half: gone before this one starts.
  const leftovers = cleanBuildLeftovers(paths);
  if (leftovers.length) appendLog(paths, `--- cleaned up after an interrupted build: ${leftovers.join(", ")}`);

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

  let swapped = false;
  try {
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
  swapped = true;
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
    fingerprint: voiceFingerprint(paths, uv),
  }) + "\n", { mode: 0o600 });
  return { python: verdict.python };
  } finally {
    // A step that failed leaves nothing half built behind: a full disk gets its room back at once.
    if (!swapped) rmSync(paths.staging, { recursive: true, force: true });
  }
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

/** The model record goes when the files it vouched for turn out damaged or gone. */
export function forgetModelPrefetched(paths: VoiceEnvPaths): void {
  try { unlinkSync(paths.model); } catch {}
}

// MARK: - Bounded retries, across restarts

/** The count of failed attempts (voice-heal.ts decides by it): one record, whose epoch says what it was counted against. */
export function readSetupFailures(paths: VoiceEnvPaths): VoiceHealBudget | null {
  try {
    const record = JSON.parse(readFileSync(paths.failures, "utf8")) as Partial<VoiceHealBudget>;
    if (
      typeof record.epoch !== "string" || typeof record.count !== "number"
      || typeof record.at !== "number" || typeof record.nextAt !== "number"
    ) return null;
    return {
      epoch: record.epoch,
      count: record.count,
      lastError: String(record.lastError ?? ""),
      kind: (record.kind ?? "other") as VoiceFailureKind,
      at: record.at,
      nextAt: record.nextAt,
      cooldowns: typeof record.cooldowns === "number" ? record.cooldowns : 0,
      free: typeof record.free === "number" ? record.free : null,
    };
  } catch {
    return null;
  }
}

export function writeSetupFailures(paths: VoiceEnvPaths, budget: VoiceHealBudget): void {
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    writeFileSync(paths.failures, JSON.stringify(budget) + "\n", { mode: 0o600 });
  } catch {}
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

/** A lock its holder hasn't touched for this long is stale even if the pid is alive: pids are reused. */
export const VOICE_SETUP_LOCK_STALE_MS = 10 * 60_000;
const VOICE_SETUP_LOCK_HEARTBEAT_MS = 60_000;

/** Who holds the setup lock, when it is another live process that has touched it lately. */
export function peekSetupLock(paths: VoiceEnvPaths, now = Date.now()): number | null {
  try {
    const holder = Number.parseInt(readFileSync(paths.lock, "utf8").trim(), 10);
    const fresh = now - statSync(paths.lock).mtimeMs < VOICE_SETUP_LOCK_STALE_MS;
    return Number.isInteger(holder) && holder > 0 && holder !== process.pid && fresh && pidAlive(holder) ? holder : null;
  } catch {
    return null;
  }
}

/**
 * Take the setup lock, or learn who holds it. A holder that died, or stopped touching it (its pid since reused by
 * something else), leaves a lock that is simply taken over; the holder touches it every minute while it builds.
 */
export function acquireSetupLock(paths: VoiceEnvPaths): { release: () => void } | { heldBy: number } {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(paths.lock, now, now);
        } catch {}
      }, VOICE_SETUP_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return {
        release: () => {
          clearInterval(heartbeat);
          try {
            if (readFileSync(paths.lock, "utf8").trim() === String(process.pid)) unlinkSync(paths.lock);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = peekSetupLock(paths);
      if (holder !== null) return { heldBy: holder };
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
  /** Waiting for room: what it needs and what the disk has, in bytes. */
  space?: { needs: number; free: number };
  /**
   * Setting up, the app's quiet line: the first setup on this Mac ("Setting up natural voices… 60%"), or voices that
   * worked coming back ("Natural voices are coming back").
   */
  healing?: "first-run" | "repair";
  /** Setting up: 0–99 across the whole of it (the build, then the voices' download). */
  percent?: number;
  /** Setting up, and waiting before the next try: for the network, for room, or a quick retry's delay. */
  waiting?: "network" | "space" | "retry";
  /** When it tries again by itself (epoch ms): after a quick retry's delay, or a cool-down. */
  retryAt?: number;
  /** Off, and why: a choice (CONCH_TTS=say, your own Python), a limit of this Mac, or self-healing that ran out. */
  off?: "choice" | "unsupported" | "failed";
  /** What went wrong last, by kind (voice-heal.ts), for the app's plain words. */
  problem?: VoiceFailureKind;
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
  /** Bytes free where the env is built (`voiceFreeBytes`); null when unknown, which never blocks a build. */
  freeBytes?: (path: string) => number | null;
  prefetch?: (python: string, signal: AbortSignal) => Promise<void>;
  /**
   * Kokoro's files in the Hugging Face cache, checked and repaired (voice-model-cache.ts); `force` after the worker
   * failed on the model itself. Absent, the model record alone decides.
   */
  verifyModel?: (repair: boolean, signal: AbortSignal, force?: boolean) => Promise<ModelCacheCheck>;
  /** Bytes of the model on disk so far, for the percentage. */
  modelBytes?: () => number;
  /** Packages uv has unpacked so far, for the percentage. */
  packagesUnpacked?: () => number;
  /** Is the network there (`probeNetwork`). */
  probeNetwork?: (signal: AbortSignal) => Promise<boolean>;
  /** What the environment depends on now (`voiceFingerprint`). */
  fingerprint?: (uv: string | null) => VoiceFingerprint;
  /** conch's version: an update starts the count of failed attempts over. */
  conchVersion?: string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  /** How often a resting heal looks for what it waits on: the network, room, the uv, a setup finished elsewhere. */
  watchMs?: number;
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

/** Roughly Kokoro-82M-bf16 and the ring's voices, for the download's percentage. */
export const VOICE_MODEL_BYTES_HINT = 360_000_000;
/** Heal turns in one go before it rests and looks again later: a guard, never reached in practice. */
const MAX_HEAL_TURNS = 64;

type RestReason = Extract<VoiceHealAction, { kind: "rest" }>["for"];

/**
 * Owns which Python the Kokoro worker runs, and conch's environment behind it, and heals both by itself: the check at
 * start, the background build when the environment is missing or wrong, the model verified and re-fetched, a worker
 * that keeps failing retried and rebuilt for, waits for the network and for room, bounded attempts that start over when
 * something changes — and the status line through all of it. voice-heal.ts decides; this observes and acts. Everything
 * runs off the daemon's critical path; `say` speaks until a Python is handed over.
 */
export class VoiceEnvManager {
  private status: NaturalVoicesStatus = { state: "checking", detail: "checking conch's voice environment" };
  private source: VoicePythonSource | null = null;
  private python: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly lifecycle = new AbortController();
  /** Aborted to cut a quick retry's wait short: Try again, or a worker that just failed. */
  private wake = new AbortController();
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private restFor: RestReason | null = null;
  private healQueued = false;
  private readonly paths: VoiceEnvPaths;
  private readonly lock: VoiceLock;

  // What the heal knows between turns.
  private budget: VoiceHealBudget | null | undefined = undefined;
  private last: { kind: VoiceFailureKind; error: string; at: number } | null = null;
  private network: "online" | "offline" | "unknown" = "unknown";
  private networkReturned = false;
  private freeAfterNoSpace: number | null = null;
  private unsupported: string | null = null;
  private worker: VoiceWorkerTrouble | null = null;
  private suspect = false;
  private envVerdict: VoiceProbeVerdict | null = null;
  private modelOk: boolean | null = null;
  /** The worker failed on the model itself: the next check may remove even what it can't otherwise be sure of. */
  private modelSuspect = false;
  private legacyChecked = false;
  private gpuRebuilt = false;
  /** GPU failures of the voices' download (which runs the worker) this run: the second rebuilds the environment once. */
  private fetchGpuFailures = 0;
  private interruptedInARow = 0;
  /** The clock never runs behind a wait that finished (an injected sleep returns at once). */
  private floor = 0;
  /** This heal included a build: the percentage gives it the first 80. */
  private withBuild = false;

  constructor(private readonly options: VoiceEnvManagerOptions) {
    this.paths = options.paths ?? voiceEnvPaths();
    this.lock = options.lock ?? VOICE_LOCK;
  }

  snapshot(): NaturalVoicesStatus {
    return { ...this.status };
  }

  start(): Promise<void> {
    return this.enqueue(() => this.heal());
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
   * The worker gave up a start burst (its own four attempts). A legacy interpreter that cannot start Kokoro is dropped
   * at once. On conch's own, what failed decides: a broken environment is rebuilt, damaged model files re-fetched, no
   * network waited for, a limit of this Mac said; a GPU or unknown failure is retried by the worker, the environment
   * rebuilt after three bursts (at once when macOS or the interpreter changed under it), and after that counted.
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
    const kind = classifyVoiceFailure(error);
    const previous = this.worker;
    this.worker = { kind, error, bursts: (previous?.bursts ?? 0) + 1, rebuilt: previous?.rebuilt ?? false, parked: false };
    switch (kind) {
      case "model":
        this.modelOk = null;
        this.modelSuspect = true;
        break;
      case "env":
        this.envVerdict = null;
        break;
      case "offline":
        this.last = { kind, error, at: this.clock() };
        this.network = "offline";
        this.modelOk = null;
        break;
      case "unsupported":
        this.unsupported = unsupportedReason(error);
        break;
      default:
        // Once an episode, the environment is checked again: a probe is cheap, a wrong guess is not.
        if (this.worker.bursts === 1) this.envVerdict = null;
    }
    this.options.log(`natural voices: the voice worker failed to start (${kind}, ${this.worker.bursts} in a row): ${error}`);
    this.kick();
  }

  /** The worker is warm on conch's environment: whatever it was healing from is over. */
  workerReady(): void {
    if (this.lifecycle.signal.aborted || this.source !== "conch") return;
    const was = this.worker;
    this.worker = null;
    this.interruptedInARow = 0;
    this.gpuRebuilt = false;
    // It works on this macOS with this interpreter: that is now what it was built on.
    this.recordFingerprint(true);
    this.suspect = false;
    if (was) {
      this.options.log("natural voices: the voice worker is back");
      this.clearBudget();
    }
    if (this.status.state !== "ready" && this.envVerdict?.ok) {
      this.setStatus({ state: "ready", detail: `conch's own environment (Python ${this.envVerdict.python})`, source: "conch" });
    }
  }

  close(): void {
    this.lifecycle.abort();
    this.stopResting();
  }

  /**
   * Try again (setup's Retry, the app's notice): the count of failed attempts and whatever is being waited on are
   * forgotten, and the voices are healed again from the start. Nothing happens while they are ready, while a step is
   * running, or for a choice or Intel.
   */
  retry(): boolean {
    if (this.lifecycle.signal.aborted) return false;
    const status = this.status;
    if (status.state === "ready" || status.state === "checking") return false;
    if (status.off === "choice" || status.reason === "needs Apple silicon") return false;
    if (status.state === "setting-up" && !status.waiting && status.stage !== "elsewhere" && !this.restFor) return false;
    this.clearBudget();
    this.last = null;
    this.network = "unknown";
    this.freeAfterNoSpace = null;
    this.unsupported = null;
    this.floor = 0;
    if (this.worker) this.worker = { ...this.worker, bursts: 0, parked: false };
    this.options.log("natural voices: trying again (Try again)");
    this.wake.abort();
    this.kick();
    return true;
  }

  // MARK: The loop

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work).catch((error) => {
      if (!this.lifecycle.signal.aborted) this.options.log(`natural voices: ${errorText(error)}`);
    });
    this.queue = next;
    return next;
  }

  /** Heal again now: once, however many things asked. */
  private kick(): void {
    this.stopResting();
    if (this.healQueued || this.lifecycle.signal.aborted) return;
    this.healQueued = true;
    void this.enqueue(() => this.heal());
  }

  private clock(): number {
    return Math.max((this.options.now ?? Date.now)(), this.floor);
  }

  private async heal(): Promise<void> {
    this.healQueued = false;
    this.stopResting();
    if (this.lifecycle.signal.aborted) return;
    const { engine } = this.options;
    if (engine === "say") {
      this.use(null, null);
      this.setStatus({ state: "off", off: "choice", reason: "CONCH_TTS=say", detail: "CONCH_TTS=say — conch speaks with macOS say and sets nothing up" });
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
          off: "choice",
          reason: "CONCH_TTS_WORKER_PYTHON not found",
          detail: `CONCH_TTS_WORKER_PYTHON=${explicit} was not found — voices via say`,
        });
      }
      return;
    }
    if (!(this.options.appleSilicon ?? isAppleSilicon)()) {
      this.use(null, null);
      this.setStatus({
        state: "off",
        off: "unsupported",
        reason: "needs Apple silicon",
        problem: "unsupported",
        detail: "Kokoro runs on MLX, which needs Apple silicon — voices via say",
      });
      return;
    }
    // A build that was killed part way, with nobody building now: said, cleaned up by the next build, never counted.
    const leftovers = buildLeftovers(this.paths);
    if (leftovers.length && peekSetupLock(this.paths) === null && this.last?.kind !== "interrupted") {
      this.options.log(`natural voices: a setup was interrupted (${leftovers.map((path) => path.slice(this.paths.root.length + 1)).join(", ")} left behind) — cleaning up and starting it again`);
      this.last = { kind: "interrupted", error: "a setup was interrupted", at: this.clock() };
      // Gone now, under the lock, whether or not a build follows: an environment set aside mid-swap is a gigabyte.
      const held = acquireSetupLock(this.paths);
      if (!("heldBy" in held)) {
        cleanBuildLeftovers(this.paths);
        held.release();
      }
    }

    for (let turn = 0; turn < MAX_HEAL_TURNS; turn++) {
      if (this.lifecycle.signal.aborted) return;
      const observed = await this.observe();
      if (this.lifecycle.signal.aborted) return;
      const decision = decideVoiceHeal(observed);
      if (!(await this.act(decision, observed))) return;
    }
    this.options.log("natural voices: no settled answer after many steps — looking again in ten minutes");
    this.startResting("cooldown", this.clock() + 10 * 60_000);
  }

  private findUv(): UvLocation | null {
    return (this.options.findUv ?? (() => findConchUv({ remembered: readVoiceEnvRecord(this.paths)?.uv ?? null })))();
  }

  private freeBytes(): number | null {
    return (this.options.freeBytes ?? ((path) => voiceFreeBytes(path)))(this.paths.root);
  }

  private epoch(uv: UvLocation | null): string {
    return voiceHealEpoch({
      lock: this.lock.id,
      conch: this.options.conchVersion ?? CONCH_VERSION,
      uv: uv ? fileIdentity(uv.path) ?? uv.path : "none",
      macos: macosVersion(),
    });
  }

  private async observe(): Promise<VoiceHealObservation> {
    const uv = this.findUv();
    const free = this.freeBytes();
    if (this.budget === undefined) this.budget = readSetupFailures(this.paths);
    const reset = budgetReset(this.budget, { epoch: this.epoch(uv), free, networkReturned: this.networkReturned });
    this.networkReturned = false;
    if (reset) {
      this.options.log(`natural voices: the count of failed attempts starts over — ${reset}`);
      this.clearBudget();
    }
    if (!this.envVerdict) this.envVerdict = await this.checkOwn(uv);
    if (!this.envVerdict.ok) {
      this.options.log(`natural voices: conch's environment ${this.envVerdict.reason}`);
      if (!this.legacyChecked) await this.tryLegacy();
    }
    const model = this.envVerdict.ok ? ((await this.modelReady()) ? "ok" as const : "missing" as const) : "missing" as const;
    return {
      now: this.clock(),
      everReady: existsSync(this.paths.ready) || existsSync(this.paths.model),
      legacy: this.source === "legacy",
      unsupported: this.unsupported,
      uv: uv !== null,
      heldElsewhere: peekSetupLock(this.paths),
      env: this.envVerdict.ok ? { ok: true } : { ok: false, reason: this.envVerdict.reason },
      model,
      worker: this.worker,
      suspect: this.suspect,
      last: this.last,
      network: this.network,
      free,
      needs: VOICE_ENV_NEEDS_BYTES,
      freeAfterNoSpace: this.freeAfterNoSpace,
      budget: this.budget ?? null,
    };
  }

  /** Do what was decided. True: look again at once. False: this heal is over (ready, or resting on a watch). */
  private async act(decision: VoiceHealDecision, observed: VoiceHealObservation): Promise<boolean> {
    const action = decision.action;
    switch (action.kind) {
      case "adopt":
        this.adopt(decision);
        return false;
      case "build":
        return this.runBuild(decision);
      case "fetch-model":
        return this.runFetch(decision);
      case "park-worker": {
        const worker = this.worker!;
        this.options.log(`natural voices: the voice worker kept failing after a rebuild (${worker.error}) — setting it aside`);
        this.countFailure(worker.error, worker.kind === "env" ? "other" : worker.kind);
        this.worker = { ...worker, bursts: 0, parked: true };
        this.use(null, null);
        return true;
      }
      case "retry-worker":
        this.worker = { ...this.worker!, bursts: 0, parked: false };
        this.use(this.paths.python, "conch");
        this.setStatus(decision.status);
        return false;
      case "delay": {
        this.setStatus(decision.status);
        const slept = await this.sleep(action.until - observed.now);
        if (slept === "aborted") return false;
        if (slept === "slept") this.floor = Math.max(this.floor, action.until);
        return true;
      }
      case "rest":
        this.rest(decision, action.for, action.until);
        return false;
    }
  }

  private async sleep(ms: number): Promise<"slept" | "woken" | "aborted"> {
    if (this.wake.signal.aborted) this.wake = new AbortController();
    const wake = this.wake;
    const signal = AbortSignal.any([this.lifecycle.signal, wake.signal]);
    const slept = await (this.options.sleep ?? abortableSleep)(Math.max(0, ms), signal);
    if (this.lifecycle.signal.aborted) return "aborted";
    if (!slept || wake.signal.aborted) {
      this.wake = new AbortController();
      return "woken";
    }
    return "slept";
  }

  private meanwhile(): string {
    return this.source === "legacy"
      ? "using your mlx-audio install until it is ready"
      : "speaking with macOS say until it is ready";
  }

  private healing(): "first-run" | "repair" {
    return existsSync(this.paths.ready) || existsSync(this.paths.model) ? "repair" : "first-run";
  }

  private adopt(decision: VoiceHealDecision): void {
    this.use(this.paths.python, "conch");
    this.stopResting();
    if (decision.status.state !== "ready") {
      // The environment and model check out; the worker is retrying by itself.
      this.setStatus(decision.status);
      return;
    }
    this.last = null;
    this.interruptedInARow = 0;
    this.withBuild = false;
    this.clearBudget();
    try {
      mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
      if (!existsSync(this.paths.ready)) writeFileSync(this.paths.ready, new Date().toISOString() + "\n", { mode: 0o600 });
    } catch {}
    const python = this.envVerdict?.ok ? this.envVerdict.python : "?";
    this.setStatus({ state: "ready", detail: `conch's own environment (Python ${python})`, source: "conch" });
  }

  private async runBuild(decision: VoiceHealDecision): Promise<boolean> {
    const signal = this.lifecycle.signal;
    const uv = this.findUv();
    if (!uv) return true;
    const held = acquireSetupLock(this.paths);
    if ("heldBy" in held) return true;
    if (this.source !== "legacy") this.use(null, null);
    this.withBuild = true;
    const unpacked = this.options.packagesUnpacked ?? (() => packagesUnpacked(this.paths));
    const before = unpacked();
    let step = 1;
    let label = "setting up conch's voice environment";
    let published = "";
    const publish = () => {
      const percent = healPercent({
        withBuild: true,
        phase: "build",
        step,
        packages: { done: unpacked(), total: this.lock.pins.size },
      });
      // Only what moved: every status is a new published state, on the Mac and the phone.
      const key = `${step}|${label}|${percent}`;
      if (key === published) return;
      published = key;
      this.setStatus({
        ...decision.status,
        detail: `${label} — ${this.meanwhile()}`,
        step,
        steps: VOICE_SETUP_STEPS,
        percent,
      });
    };
    const ticker = setInterval(() => { if (step === 3) publish(); }, 2_000);
    ticker.unref?.();
    try {
      this.options.log(`natural voices: building conch's environment with ${uv.path} (from ${uv.source})`);
      const build = this.options.build ?? ((uvPath, progress, abort) => buildVoiceEnv({
        paths: this.paths, uv: uvPath, lock: this.lock, progress, signal: abort,
      }).then(() => {}));
      await build(uv.path, (words, at) => {
        this.options.log(`natural voices: ${words}`);
        if (at) step = at.step;
        label = words;
        publish();
      }, signal);
    } catch (error) {
      clearInterval(ticker);
      held.release();
      if (signal.aborted) return false;
      await this.failed(errorText(error), "setup", unpacked() > before);
      return true;
    }
    clearInterval(ticker);
    held.release();
    this.options.log("natural voices: conch's environment is built");
    this.envVerdict = null;
    this.last = null;
    this.suspect = false;
    if (this.worker) {
      // Built for a worker that kept failing: it gets one more go on the new one, and if it fails that too it is set aside.
      this.worker = { ...this.worker, bursts: 0, rebuilt: true };
    } else {
      this.clearBudget();
    }
    return true;
  }

  private async runFetch(decision: VoiceHealDecision): Promise<boolean> {
    const signal = this.lifecycle.signal;
    const { model, voices } = this.options;
    const bytes = this.options.modelBytes ?? (() => 0);
    const before = bytes();
    const withBuild = this.withBuild;
    let published = -1;
    const publish = () => {
      const percent = healPercent({ withBuild, phase: "model", model: { bytes: bytes(), total: VOICE_MODEL_BYTES_HINT } });
      if (percent === published) return;
      published = percent;
      this.setStatus({ ...decision.status, percent });
    };
    publish();
    const ticker = setInterval(publish, 2_000);
    ticker.unref?.();
    try {
      const prefetch = this.options.prefetch ?? ((python, abort) => prefetchVoiceModel({
        python, model, voices, speed: this.options.speed, signal: abort, log: this.options.log,
        stderrPath: join(this.paths.root, "prefetch.err.log"),
      }).then(() => {}));
      await prefetch(this.paths.python, signal);
    } catch (error) {
      clearInterval(ticker);
      if (signal.aborted) return false;
      this.modelOk = null;
      await this.failed(errorText(error), "the voices' download", bytes() > before);
      return true;
    }
    clearInterval(ticker);
    recordModelPrefetched(this.paths, model, voices, this.lock);
    this.modelOk = true;
    this.last = null;
    this.options.log(`natural voices: ${model} fetched and every ring voice synthesized once`);
    return true;
  }

  /** A step failed: what kind decides what happens next (voice-heal.ts), and only some kinds are counted. */
  private async failed(text: string, what: string, progressed: boolean): Promise<void> {
    let kind = classifyVoiceFailure(text);
    // An unknown failure while the network is down is the network's.
    if (kind === "other" && !(await (this.options.probeNetwork ?? ((signal) => probeNetwork(signal)))(this.lifecycle.signal))) kind = "offline";
    // An attempt that got further than the last one isn't a failure to count: a slow connection, a Mac that slept.
    if (progressed && (kind === "other" || kind === "interrupted")) kind = "interrupted";
    if (kind === "interrupted" && ++this.interruptedInARow > 3) kind = "other";
    const now = this.clock();
    this.last = { kind, error: text, at: now };
    this.options.log(`natural voices: ${what} failed (${kind}): ${text} — see ${this.paths.log}`);
    switch (kind) {
      case "offline":
        this.network = "offline";
        return;
      case "no-space":
        rmSync(this.paths.staging, { recursive: true, force: true });
        this.freeAfterNoSpace = this.freeBytes();
        return;
      case "unsupported":
        this.unsupported = unsupportedReason(text);
        return;
      case "interrupted":
        return;
      case "env":
        // The voices' download found the environment broken (it runs the worker): rebuild it.
        this.envVerdict = { ok: false, reason: `failed in use (${text})` };
        break;
      case "gpu":
        // A GPU failure on the first run: after the second, the environment is rebuilt once before it is counted out.
        if (!this.gpuRebuilt && ++this.fetchGpuFailures >= 2) {
          this.gpuRebuilt = true;
          this.envVerdict = { ok: false, reason: `failed on the GPU twice (${text}) — rebuilding once` };
        }
        break;
    }
    if (countsAgainstBudget(kind)) this.countFailure(text, kind);
  }

  private countFailure(error: string, kind: VoiceFailureKind): void {
    const uv = this.findUv();
    this.budget = countFailure(this.budget ?? null, { error, kind, now: this.clock(), epoch: this.epoch(uv), free: this.freeBytes() });
    writeSetupFailures(this.paths, this.budget);
  }

  private clearBudget(): void {
    this.budget = null;
    clearSetupFailures(this.paths);
  }

  // MARK: Resting

  private rest(decision: VoiceHealDecision, reason: RestReason, until?: number): void {
    const status = decision.status;
    if (reason === "unsupported") {
      this.use(null, null);
      this.setStatus(status);
      return;
    }
    if ((reason === "cooldown" || reason === "uv") && this.source === "legacy" && this.python) {
      // conch's own couldn't be built, but the person's mlx-audio install still speaks.
      this.setStatus({ state: "ready", detail: `your mlx-audio install (${this.python}); conch's own ${status.detail}`, source: "legacy" });
    } else {
      if (reason === "cooldown" || reason === "uv") this.use(null, null);
      this.setStatus(status);
    }
    this.startResting(reason, until);
  }

  private startResting(reason: RestReason, until?: number): void {
    this.stopResting();
    if (this.lifecycle.signal.aborted) return;
    this.restFor = reason;
    const recordStamp = () => {
      try { return statSync(this.paths.record).mtimeMs; } catch { return 0; }
    };
    const seenRecord = recordStamp();
    const seenFree = this.freeBytes();
    let ticks = 0;
    let busy = false;
    const tick = async () => {
      if (busy || this.healQueued || this.lifecycle.signal.aborted) return;
      busy = true;
      try {
        ticks++;
        const now = this.clock();
        const free = this.freeBytes();
        switch (reason) {
          case "network": {
            // Every tick, and anyway every ten minutes in case the probe's host is what's blocked.
            if (await this.networkUp()) {
              this.options.log("natural voices: the network is back — carrying on");
              this.network = "online";
              this.networkReturned = true;
              this.kick();
            } else if (ticks % 20 === 0) {
              this.kick();
            }
            return;
          }
          case "space":
            if ((until !== undefined && now >= until) || (free !== null && seenFree !== null && free - seenFree >= 64_000_000)) {
              this.options.log("natural voices: there's more room now — carrying on");
              this.kick();
            }
            return;
          case "elsewhere":
            if (peekSetupLock(this.paths) === null) this.kick();
            return;
          case "uv":
            if (this.findUv()) this.kick();
            return;
          case "cooldown":
            if (until !== undefined && now >= until) this.kick();
            else if (recordStamp() !== seenRecord) this.kick(); // `conch voices setup` finished it elsewhere
            else if (diskFreedSince(this.budget ?? null, free)) this.kick();
            else if (ticks % 10 === 0) {
              const up = await this.networkUp();
              if (!up) this.network = "offline";
              else if (this.network === "offline") {
                this.network = "online";
                this.networkReturned = true;
                this.kick();
              }
            }
            return;
          case "unsupported":
            return;
        }
      } finally {
        busy = false;
      }
    };
    this.restTimer = setInterval(() => void tick(), this.options.watchMs ?? 30_000);
    this.restTimer.unref?.();
  }

  private stopResting(): void {
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
    this.restFor = null;
  }

  private networkUp(): Promise<boolean> {
    return (this.options.probeNetwork ?? ((signal) => probeNetwork(signal)))(this.lifecycle.signal);
  }

  // MARK: Observing

  private setStatus(status: NaturalVoicesStatus): void {
    const source = status.source ?? (status.state === "ready" ? this.source ?? undefined : undefined);
    const next: NaturalVoicesStatus = { ...status, ...(source ? { source } : {}) };
    if (next.healing === undefined && next.state === "setting-up") next.healing = this.healing();
    this.status = next;
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

  private async checkOwn(uv: UvLocation | null): Promise<VoiceProbeVerdict> {
    const probe = this.options.probe ?? ((python, signal) => probeVoicePython(python, { signal }));
    const verdict = judgeVoiceProbe(await probe(this.paths.python, this.lifecycle.signal), "exact", this.lock);
    if (verdict.ok) this.checkFingerprint(uv);
    return verdict;
  }

  /**
   * The environment checks out; did anything it depends on change since it was built? A uv that moved or changed (the
   * app was moved or updated) is relinked, nothing rebuilt. A macOS or interpreter that changed makes a failing worker
   * rebuild at once, rather than after three bursts.
   */
  private checkFingerprint(uv: UvLocation | null): void {
    const record = readVoiceEnvRecord(this.paths);
    if (!record) return;
    const now = (this.options.fingerprint ?? ((path) => voiceFingerprint(this.paths, path)))(uv?.path ?? null);
    if (!record.fingerprint) {
      this.recordFingerprint(false, now, uv?.path ?? null);
      return;
    }
    const drift = fingerprintDrift(record.fingerprint, now);
    if (drift.includes("uv")) {
      this.options.log(`natural voices: conch's uv moved or changed (${record.uv ?? "?"} → ${uv?.path ?? "?"}) — relinked; the environment itself checks out`);
      this.recordFingerprint(false, { ...record.fingerprint, uv: now.uv }, uv?.path ?? null);
    }
    if (drift.includes("macos") || drift.includes("python")) {
      if (!this.suspect) this.options.log(`natural voices: ${drift.filter((part) => part !== "uv").join(" and ")} changed since the environment was built — a failing worker rebuilds it at once`);
      this.suspect = true;
    }
  }

  /** Write what the environment depends on into its record: all of it once proved (`full`), else just what is given. */
  private recordFingerprint(full: boolean, fingerprint?: VoiceFingerprint, uv?: string | null): void {
    try {
      const record = JSON.parse(readFileSync(this.paths.record, "utf8")) as Record<string, unknown>;
      const uvPath = uv ?? (typeof record.uv === "string" ? record.uv : null);
      const next = full ? voiceFingerprint(this.paths, uvPath) : fingerprint ?? voiceFingerprint(this.paths, uvPath);
      writeFileSync(this.paths.record, JSON.stringify({ ...record, ...(uvPath ? { uv: uvPath } : {}), fingerprint: next }) + "\n", { mode: 0o600 });
    } catch {}
  }

  /** An existing mlx-audio install keeps speaking while conch builds its own — only one that can import Kokoro. */
  private async tryLegacy(): Promise<void> {
    this.legacyChecked = true;
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
  }

  /** Kokoro's model for this voice set: fetched and proved once, and its files still sound (checked, and repaired). */
  private async modelReady(): Promise<boolean> {
    if (this.modelOk !== null) return this.modelOk;
    const recorded = modelPrefetched(this.paths, this.options.model, this.options.voices, this.lock);
    if (!this.options.verifyModel) {
      this.modelOk = recorded;
      return recorded;
    }
    try {
      const check = await this.options.verifyModel(true, this.lifecycle.signal, this.modelSuspect);
      this.modelSuspect = false;
      if (check.unverifiable) {
        this.options.log("natural voices: every large Kokoro file failed its hash at once — more likely a cache named another way than all of them damaged; left as it is");
      }
      if (check.broken.length) {
        this.options.log(`natural voices: ${check.broken.length} of Kokoro's files were damaged or missing (${check.broken.slice(0, 3).join(", ")}) — removed; fetching only those again`);
      }
      if (!check.ok && recorded) forgetModelPrefetched(this.paths);
      this.modelOk = recorded && check.ok;
    } catch (error) {
      if (this.lifecycle.signal.aborted) return false;
      this.options.log(`natural voices: couldn't check Kokoro's files (${errorText(error)}) — trusting the record`);
      this.modelOk = recorded;
    }
    return this.modelOk;
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
      ? `setting up…${status.percent !== undefined ? ` ${status.percent}%` : ""}`
      : status.state === "checking"
        ? "checking…"
        : `off (${status.reason ?? "see below"})`;
  return `Natural voices: ${head} — ${status.detail}`;
}

/** The environment conch built, as its record says — without running anything. */
export function readVoiceEnvRecord(paths = voiceEnvPaths()): { lock: string; python: string; uv?: string; fingerprint?: VoiceFingerprint } | null {
  try {
    const record = JSON.parse(readFileSync(paths.record, "utf8")) as { lock?: unknown; python?: unknown; uv?: unknown; fingerprint?: unknown };
    if (typeof record.lock !== "string" || typeof record.python !== "string") return null;
    const fingerprint = record.fingerprint as Partial<VoiceFingerprint> | undefined;
    return {
      lock: record.lock,
      python: record.python,
      ...(typeof record.uv === "string" ? { uv: record.uv } : {}),
      ...(fingerprint && typeof fingerprint.macos === "string"
        ? { fingerprint: { macos: fingerprint.macos, uv: fingerprint.uv ?? null, python: fingerprint.python ?? null } }
        : {}),
    };
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
