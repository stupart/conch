import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { breadcrumb } from "./loop-watchdog.ts";

/**
 * conch's speech engine is seashell's: sox captures the microphone, whisper.cpp
 * (whisper-cli, and the warm whisper-server) transcribes it with Metal, and the
 * Silero VAD model trims the silence. Tyler: "we built our audio capture on
 * seashell because we made such a great transcription tool — don't go stripping
 * that out and replacing with Apple defaults."
 *
 * conch.app carries the engine (scripts/embed-engine.sh builds the pinned
 * whisper.cpp and a trimmed sox into Contents/Helpers and puts the VAD model in
 * Contents/Resources/models), so a downloaded conch needs nothing installed.
 * The whisper model is 574 MB — too big to ship inside the app — so the daemon
 * fetches it on first run, pinned by sha256, and says so while it does.
 *
 * Every part resolves in the same order, so the setups that already work keep
 * working: an explicit setting (the CONCH_* path variables), then the app's own
 * copy, then a seashell install (a checkout, or seashell's Homebrew formula,
 * which lays out the same tree), then Homebrew, then — for the models — the
 * copies conch downloaded into ~/.cache/conch/models.
 */

export interface PinnedModel {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  label: string;
}

/** The same pins seashell's installer and formula verify (the publishers' LFS object ids). */
export const WHISPER_MODEL: PinnedModel = {
  file: "ggml-large-v3-turbo-q5_0.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  bytes: 574_041_195,
  label: "whisper large-v3-turbo",
};

export const VAD_MODEL: PinnedModel = {
  file: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
  bytes: 885_098,
  label: "silero VAD",
};

/**
 * Where a part came from: an explicit CONCH_* path, the app's own copy, a
 * seashell install, Homebrew, PATH, conch's own download, or nowhere yet.
 */
export type EngineSource = "explicit" | "conch.app" | "seashell" | "homebrew" | "PATH" | "conch" | "missing";

export interface EnginePart {
  path: string;
  source: EngineSource;
  found: boolean;
}

export interface SpeechEngine {
  whisperCli: EnginePart;
  whisperServer: EnginePart;
  whisperModel: EnginePart;
  vadModel: EnginePart;
  sox: EnginePart;
}

export interface ResolveEngineOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  execPath?: string;
  /** Is this an executable file? (binaries) */
  executable?: (path: string) => boolean;
  /** Is this a file? (models) */
  file?: (path: string) => boolean;
  which?: (name: string) => string | null;
  /** Homebrew prefixes, Apple silicon's first. */
  brewPrefixes?: readonly string[];
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const BREW_PREFIXES: readonly string[] = ["/opt/homebrew", "/usr/local"];

/** Where conch downloads the models it has to fetch itself. */
export function conchModelsDir(home = conchHome()): string {
  return join(home, ".cache", "conch", "models");
}

/**
 * The conch.app bundles whose helpers this process may use, in order.
 *
 * CONCH_APP_BUNDLE is what the Mac app hands its daemon (DaemonHost.swift) —
 * set, it is the only answer, so a daemon run from a checkout still uses the
 * engine of the app that launched it and never another copy's. Otherwise the
 * app this executable sits inside (the bundled daemon is
 * `Contents/Helpers/conch-daemon`), the installed app, and one beside a
 * compiled `conch` — the Homebrew tarball ships the two together.
 */
export function conchAppCandidates(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = conchHome(),
  execPath = process.execPath,
): string[] {
  const explicit = env.CONCH_APP_BUNDLE?.trim();
  if (explicit) return [explicit];
  const candidates: string[] = [];
  const inside = /^(.*\.app)\/Contents\/(?:Helpers|MacOS|Resources)\/[^/]+$/.exec(execPath);
  if (inside) candidates.push(inside[1]!);
  const execDir = dirname(execPath);
  candidates.push(
    "/Applications/conch.app",
    join(home, "Applications", "conch.app"),
    join(execDir, "conch.app"),
    join(dirname(execDir), "conch.app"),
  );
  return [...new Set(candidates)];
}

/**
 * Seashell's trees: the original checkout at ~/whisper-cli, then seashell's
 * Homebrew formula, whose libexec is the same layout — `whisper.cpp/build/bin`,
 * `models`, `whisper.cpp/models` — so a Mac with seashell installed reuses its
 * 574 MB model instead of downloading a second copy. CONCH_SEASHELL_ROOT names
 * the one tree to use, and replaces both.
 */
export function seashellRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = conchHome(),
  brewPrefixes: readonly string[] = BREW_PREFIXES,
): string[] {
  const explicit = env.CONCH_SEASHELL_ROOT?.trim();
  if (explicit) return [explicit];
  return [
    join(home, "whisper-cli"),
    ...brewPrefixes.map((prefix) => join(prefix, "opt", "seashell", "libexec")),
  ];
}

function first(
  candidates: ReadonlyArray<readonly [string, EngineSource]>,
  ok: (path: string) => boolean,
  missing: string,
): EnginePart {
  for (const [path, source] of candidates) {
    if (ok(path)) return { path, source, found: true };
  }
  return { path: missing, source: "missing", found: false };
}

/**
 * Every part of the engine, resolved: explicit, then the app, then seashell,
 * then Homebrew (then PATH for sox, and conch's own downloads for the models).
 * An explicit path is taken as-is even when it is missing — that is a setting
 * to fix, not one to silently route around. A part found nowhere gets the path
 * conch would use (a model's download destination, Homebrew's binary), so the
 * doctor has something concrete to name.
 */
export function resolveSpeechEngine(options: ResolveEngineOptions = {}): SpeechEngine {
  const env = options.env ?? process.env;
  const home = options.home ?? conchHome();
  const executable = options.executable ?? isExecutableFile;
  const file = options.file ?? isFile;
  const brew = options.brewPrefixes ?? BREW_PREFIXES;
  const apps = conchAppCandidates(env, home, options.execPath ?? process.execPath);
  const seashell = seashellRoots(env, home, brew);
  const models = conchModelsDir(home);

  const explicit = (name: string, ok: (path: string) => boolean): EnginePart | null => {
    const value = env[name]?.trim();
    return value ? { path: value, source: "explicit", found: ok(value) } : null;
  };

  const binary = (name: string, envName: string): EnginePart =>
    explicit(envName, executable) ?? first([
      ...apps.map((app) => [join(app, "Contents", "Helpers", name), "conch.app"] as const),
      ...seashell.map((root) => [join(root, "whisper.cpp", "build", "bin", name), "seashell"] as const),
      ...brew.map((prefix) => [join(prefix, "bin", name), "homebrew"] as const),
    ], executable, join(brew[0] ?? "/opt/homebrew", "bin", name));

  const whisperModel = explicit("CONCH_WHISPER_MODEL", file) ?? first([
    ...seashell.map((root) => [join(root, "models", WHISPER_MODEL.file), "seashell"] as const),
    [join(models, WHISPER_MODEL.file), "conch"] as const,
  ], file, join(models, WHISPER_MODEL.file));

  const vadModel = explicit("CONCH_VAD_MODEL", file) ?? first([
    ...apps.map((app) => [join(app, "Contents", "Resources", "models", VAD_MODEL.file), "conch.app"] as const),
    ...seashell.map((root) => [join(root, "whisper.cpp", "models", VAD_MODEL.file), "seashell"] as const),
    [join(models, VAD_MODEL.file), "conch"] as const,
  ], file, join(models, VAD_MODEL.file));

  // seashell captures with Homebrew's sox itself (its formula depends on it),
  // so there is no seashell tier here: the app's sox, then Homebrew's, then PATH.
  let sox = explicit("CONCH_SOX", executable) ?? first([
    ...apps.map((app) => [join(app, "Contents", "Helpers", "sox"), "conch.app"] as const),
    ...brew.map((prefix) => [join(prefix, "bin", "sox"), "homebrew"] as const),
  ], executable, "sox");
  if (!sox.found && sox.source === "missing") {
    const onPath = (options.which ?? Bun.which)("sox");
    // Bare "sox" is what conch always spawned: found on PATH at spawn time, or not at all.
    if (onPath && executable(onPath)) sox = { path: onPath, source: "PATH", found: true };
  }

  return {
    whisperCli: binary("whisper-cli", "CONCH_WHISPER_CLI"),
    whisperServer: binary("whisper-server", "CONCH_WHISPER_SERVER"),
    whisperModel,
    vadModel,
    sox,
  };
}

// MARK: - Fetching a pinned model

export interface FetchModelOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
  /** No bytes for this long ends the attempt (a stalled connection is a failure, not a hang). */
  stallMs?: number;
}

export class ModelFetchError extends Error {}

async function hashFile(path: string, hasher: Bun.CryptoHasher): Promise<void> {
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
}

/**
 * Download a pinned model to `dest`: into `dest.part`, resumed with a Range
 * request when a previous attempt left one, hashed as it lands, and moved into
 * place only when every byte matches the pin. A wrong size or digest removes
 * the partial and throws — the model is never trusted on presence alone.
 */
export async function fetchPinnedModel(model: PinnedModel, dest: string, options: FetchModelOptions = {}): Promise<void> {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  let have = 0;
  if (isFile(part)) {
    const size = statSync(part).size;
    if (size > 0 && size < model.bytes) have = size;
    else rmSync(part, { force: true });
  }

  const stall = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
  const stallMs = options.stallMs ?? 60_000;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => clearTimeout(stallTimer);
  const arm = () => {
    disarm();
    stallTimer = setTimeout(() => stall.abort(new ModelFetchError(`no data for ${Math.round(stallMs / 1000)}s`)), stallMs);
    (stallTimer as { unref?: () => void }).unref?.();
  };

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    arm();
    const response = await (options.fetch ?? fetch)(model.url, {
      signal,
      ...(have ? { headers: { Range: `bytes=${have}-` } } : {}),
    });
    if (!response.ok) throw new ModelFetchError(`HTTP ${response.status}`);
    if (!response.body) throw new ModelFetchError("empty response");
    const resumed = have > 0 && response.status === 206;
    if (resumed && !(response.headers.get("content-range") ?? "").startsWith(`bytes ${have}-`)) {
      rmSync(part, { force: true });
      throw new ModelFetchError(`the server resumed from the wrong place (${response.headers.get("content-range")})`);
    }
    const hasher = new Bun.CryptoHasher("sha256");
    if (resumed) {
      disarm(); // hashing what is already on disk is not the network stalling
      await hashFile(part, hasher);
      arm();
    } else {
      have = 0; // a fresh start, whether nothing was there or the server ignored the Range
    }
    handle = await open(part, resumed ? "a" : "w", 0o600);
    let bytes = have;
    options.onProgress?.(bytes, model.bytes);
    for await (const chunk of response.body) {
      arm();
      if (bytes + chunk.byteLength > model.bytes) throw new ModelFetchError(`more than the pinned ${model.bytes} bytes`);
      await handle.write(chunk);
      hasher.update(chunk);
      bytes += chunk.byteLength;
      options.onProgress?.(bytes, model.bytes);
    }
    await handle.close();
    handle = null;
    verifyAndPlace(model, part, dest, hasher);
  } catch (error) {
    const reason = stall.signal.aborted ? stall.signal.reason : error;
    throw reason instanceof Error ? reason : new ModelFetchError(String(reason));
  } finally {
    disarm();
    if (handle) await handle.close().catch(() => {});
  }
}

function verifyAndPlace(model: PinnedModel, part: string, dest: string, hasher: Bun.CryptoHasher): void {
  const size = statSync(part).size;
  const digest = hasher.digest("hex");
  if (size !== model.bytes || digest !== model.sha256) {
    rmSync(part, { force: true });
    throw new ModelFetchError(
      size !== model.bytes
        ? `size ${size} is not the pinned ${model.bytes} bytes`
        : `sha256 ${digest} is not the pinned ${model.sha256}`,
    );
  }
  renameSync(part, dest); // same directory: atomic, never a half-written model at `dest`
}

// MARK: - Bounded retries, across restarts

export const MODEL_FETCH_MAX_FAILURES = 3;
export const MODEL_FETCH_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
/** Before each attempt in one daemon's life: now, a minute later, five minutes later. Then it stops. */
export const MODEL_FETCH_RETRY_DELAYS_MS: readonly number[] = [0, 60_000, 5 * 60_000];

interface FailureRecord {
  count: number;
  lastError: string;
  at: number;
}

/** Failures of THIS pin in the window; a new pin (a conch upgrade) or a quiet day starts over. */
export function readFetchFailures(path: string, sha256: string, now = Date.now()): FailureRecord | null {
  try {
    const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<FailureRecord>>;
    const record = all[sha256];
    if (!record || typeof record.count !== "number" || typeof record.at !== "number") return null;
    if (now - record.at > MODEL_FETCH_FAILURE_WINDOW_MS) return null;
    return { count: record.count, lastError: String(record.lastError ?? ""), at: record.at };
  } catch {
    return null;
  }
}

function writeFailures(path: string, mutate: (all: Record<string, FailureRecord>) => void): void {
  let all: Record<string, FailureRecord> = {};
  try { all = JSON.parse(readFileSync(path, "utf8")); } catch {}
  mutate(all);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all) + "\n", { mode: 0o600 });
  } catch {}
}

export function recordFetchFailure(path: string, sha256: string, error: string, now = Date.now()): number {
  const count = (readFetchFailures(path, sha256, now)?.count ?? 0) + 1;
  writeFailures(path, (all) => { all[sha256] = { count, lastError: error, at: now }; });
  return count;
}

export function clearFetchFailures(path: string, sha256: string): void {
  writeFailures(path, (all) => { delete all[sha256]; });
}

/** Why a download stopped, when it is one of the two a person can do something about. */
export type FetchProblem = { kind: "offline" } | { kind: "no-space"; needs: number; free: number };

/**
 * A failed attempt's error, as setup says it: the Mac is offline (the connection never came up, or dropped and stalled),
 * the disk is full, or neither (a server error, a checksum). Only the words decide it, so an unknown error stays unknown.
 */
export function classifyFetchFailure(message: string): FetchProblem["kind"] | null {
  if (/ENOSPC|no space left|not enough free space/i.test(message)) return "no-space";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|unable to connect|network|socket connection was closed|stalled|fetch failed/i.test(message)) {
    return "offline";
  }
  return null;
}

/** Bytes free on the volume holding `path` or its nearest existing parent; null when it can't be read. */
export function freeBytesNear(path: string): number | null {
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

/** Room kept beside a model's own bytes, so the download never takes the disk to its last megabyte. */
export const MODEL_FETCH_HEADROOM_BYTES = 200_000_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One fetcher per model file — the daemon's and `conch setup`'s must not write the same `.part`. */
export function acquireFetchLock(dest: string): { release: () => void } | { heldBy: number } {
  const lock = `${dest}.lock`;
  mkdirSync(dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) return { heldBy: holder };
      try { unlinkSync(lock); } catch {}
    }
  }
  return { heldBy: -1 };
}

// MARK: - The daemon's view

export type SpeechEngineState = "checking" | "downloading" | "ready" | "off";

export interface SpeechEngineStatus {
  state: SpeechEngineState;
  /** Short, for "off (reason)": `no whisper`, `no sox`, `download failed`… */
  reason?: string;
  /** One sentence a person can act on. */
  detail: string;
  /** While a model downloads: bytes so far of the pinned total. Kept while a failed attempt waits to try again. */
  progress?: { bytes: number; total: number };
  /** What stopped the last attempt, when it is offline or out of room: setup says it in those words. */
  problem?: FetchProblem;
  /** While waiting to try again: when (epoch ms). */
  retryAt?: number;
  /** Where each part came from, for Settings, onboarding and the doctor. */
  parts: {
    whisper: { source: EngineSource; path: string };
    server: { source: EngineSource; path: string };
    model: { source: EngineSource; path: string };
    vad: { source: EngineSource; path: string };
    capture: { source: EngineSource; path: string };
    /** Optional: sessions in tmux get pane injection; everything else is typed or pasted. */
    tmux: { found: boolean; path?: string };
  };
  /** The daemon publishing this — the app's bundled one, a checkout, or Homebrew's. */
  daemon: { version: string; path: string };
}

export interface SpeechEngineManagerOptions {
  engine: SpeechEngine;
  daemon: { version: string; path: string };
  log: (line: string) => void;
  onStatus?: (status: SpeechEngineStatus) => void;
  /** Written with our pid so `conch doctor` can read a live daemon's view. */
  statusPath?: string;
  failuresPath?: string;
  whisperModel?: PinnedModel;
  vadModel?: PinnedModel;
  tmux?: () => string | null;
  fetchModel?: (model: PinnedModel, dest: string, options: FetchModelOptions) => Promise<void>;
  retryDelaysMs?: readonly number[];
  maxFailures?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  /** How often a gave-up fetch looks for a model placed elsewhere (`conch setup`). */
  watchMs?: number;
  /** Minimum gap between two progress publications. */
  progressEveryMs?: number;
  /** Bytes free beside a model's destination (`freeBytesNear`); null when unknown, which never blocks a download. */
  freeBytes?: (path: string) => number | null;
}

export function speechEngineStatusPath(home = conchHome()): string {
  return join(home, ".cache", "conch", "speech-engine.json");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
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

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Owns the engine's readiness: says where every part came from, fetches the
 * models the app cannot carry (bounded, resumable, pinned), and tells the
 * daemon when whisper-server can load. Runs off the critical path — the
 * socket, hooks and speech are live while a first-run download is under way.
 */
export class SpeechEngineManager {
  private status: SpeechEngineStatus;
  private queue: Promise<void> = Promise.resolve();
  private attemptsThisRun = new Map<string, number>();
  private lastProgressAt = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private readyWaiters: Array<(ready: boolean) => void> = [];
  /** What stopped the last attempt, when it is offline or out of room (`classifyFetchFailure`). */
  private lastProblem: FetchProblem | null = null;
  private settledReady: boolean | null = null;
  private readonly lifecycle = new AbortController();
  private readonly whisperPin: PinnedModel;
  private readonly vadPin: PinnedModel;

  constructor(private readonly options: SpeechEngineManagerOptions) {
    this.whisperPin = options.whisperModel ?? WHISPER_MODEL;
    this.vadPin = options.vadModel ?? VAD_MODEL;
    this.status = this.compose({ state: "checking", detail: "checking the speech engine" });
  }

  snapshot(): SpeechEngineStatus {
    return structuredClone(this.status);
  }

  start(): Promise<void> {
    return this.enqueue(() => this.resolve());
  }

  /** True once whisper-server can load (the model and VAD are in place); false if conch gave up or stopped. */
  modelReady(): Promise<boolean> {
    if (this.settledReady !== null) return Promise.resolve(this.settledReady);
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  async settled(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
  }

  close(): void {
    this.lifecycle.abort();
    this.stopWatching();
    this.settleReady(false);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work).catch((error) => {
      if (!this.lifecycle.signal.aborted) this.options.log(`speech engine: ${errorText(error)}`);
    });
    this.queue = next;
    return next;
  }

  private settleReady(ready: boolean): void {
    if (this.settledReady !== null) return;
    this.settledReady = ready;
    for (const waiter of this.readyWaiters.splice(0)) waiter(ready);
  }

  private compose(head: Pick<SpeechEngineStatus, "state" | "detail"> & Partial<Pick<SpeechEngineStatus, "reason" | "progress" | "problem" | "retryAt">>): SpeechEngineStatus {
    const engine = this.options.engine;
    const tmux = (this.options.tmux ?? (() => Bun.which("tmux")))();
    return {
      state: head.state,
      ...(head.reason ? { reason: head.reason } : {}),
      detail: head.detail,
      ...(head.progress ? { progress: head.progress } : {}),
      ...(head.problem ? { problem: head.problem } : {}),
      ...(head.retryAt ? { retryAt: head.retryAt } : {}),
      parts: {
        whisper: { source: engine.whisperCli.source, path: engine.whisperCli.path },
        server: { source: engine.whisperServer.source, path: engine.whisperServer.path },
        model: { source: engine.whisperModel.source, path: engine.whisperModel.path },
        vad: { source: engine.vadModel.source, path: engine.vadModel.path },
        capture: { source: engine.sox.source, path: engine.sox.path },
        tmux: tmux ? { found: true, path: tmux } : { found: false },
      },
      daemon: { ...this.options.daemon },
    };
  }

  private setStatus(head: Parameters<SpeechEngineManager["compose"]>[0]): void {
    breadcrumb(`speech engine: ${head.state}`);
    this.status = this.compose(head);
    if (this.options.statusPath) {
      try {
        mkdirSync(dirname(this.options.statusPath), { recursive: true });
        writeFileSync(this.options.statusPath, JSON.stringify({ ...this.status, pid: process.pid, at: Date.now() }) + "\n", { mode: 0o600 });
      } catch {}
    }
    try { this.options.onStatus?.(this.snapshot()); } catch {}
  }

  /** The one sentence for "ready": where the words are heard and read. */
  private readyDetail(): string {
    const engine = this.options.engine;
    const from = (part: EnginePart) => (part.source === "conch.app" ? "the app" : part.source === "conch" ? "conch's download" : part.source);
    return `whisper from ${from(engine.whisperCli)}, model from ${from(engine.whisperModel)}, capture from ${from(engine.sox)}`;
  }

  private async resolve(): Promise<void> {
    const engine = this.options.engine;
    this.setStatus({ state: "checking", detail: "checking the speech engine" });

    // A model conch may fetch: never an explicit path (a setting to fix), and
    // only the one conch downloads into its own folder.
    const fetchable = (part: EnginePart) => !part.found && part.source === "missing";
    for (const [part, name] of [[engine.whisperModel, "CONCH_WHISPER_MODEL"], [engine.vadModel, "CONCH_VAD_MODEL"]] as const) {
      if (!part.found && part.source === "explicit") {
        this.giveUp(`${name} not found`, `${name}=${part.path} was not found — fix the setting or unset it`, false);
        return;
      }
    }

    for (const [part, pin] of [[engine.vadModel, this.vadPin], [engine.whisperModel, this.whisperPin]] as const) {
      if (!fetchable(part)) continue;
      const fetched = await this.fetchLoop(pin, part.path);
      if (this.lifecycle.signal.aborted) return;
      if (!fetched) return; // gave up, said why, and watches for it to appear
      part.found = true;
      part.source = "conch";
    }

    if (!engine.whisperCli.found && !engine.whisperServer.found) {
      this.giveUp("no whisper", "no whisper-cli or whisper-server — the conch app carries seashell's engine; or set CONCH_WHISPER_CLI", false);
      return;
    }
    this.settleReady(true);
    if (!engine.sox.found) {
      this.setStatus({
        state: "off",
        reason: "no sox",
        detail: "no sox to capture the microphone — the conch app carries one; or set CONCH_SOX",
      });
      return;
    }
    this.setStatus({ state: "ready", detail: this.readyDetail() });
  }

  /** Fetch one pinned model into conch's folder: bounded, across restarts, one fetcher at a time. */
  private async fetchLoop(pin: PinnedModel, dest: string): Promise<boolean> {
    const signal = this.lifecycle.signal;
    const delays = this.options.retryDelaysMs ?? MODEL_FETCH_RETRY_DELAYS_MS;
    const maxFailures = this.options.maxFailures ?? MODEL_FETCH_MAX_FAILURES;
    const now = this.options.now ?? Date.now;
    const failuresPath = this.options.failuresPath ?? join(dirname(dest), "fetch-failures.json");
    const sleep = this.options.sleep ?? abortableSleep;
    const size = `${megabytes(pin.bytes)}, once`;

    while (!signal.aborted) {
      if (isFile(dest)) return true;
      const failures = readFetchFailures(failuresPath, pin.sha256, now());
      if (failures && failures.count >= maxFailures) {
        this.giveUp("download failed", `the ${pin.label} model failed to download ${failures.count} times (${failures.lastError}) — \`conch setup\` tries again`, true, dest);
        return false;
      }
      const attempts = this.attemptsThisRun.get(pin.sha256) ?? 0;
      if (attempts >= delays.length) {
        this.giveUp("download failed", `the ${pin.label} model failed to download (${failures?.lastError ?? "unknown"}) — \`conch setup\` tries again`, true, dest);
        return false;
      }
      if (attempts > 0) {
        // What the last attempt got, so the bar holds its place while it waits, and why it stopped when that is one a
        // person can act on.
        const partial = partBytes(dest);
        this.setStatus({
          state: "downloading",
          detail: `retrying the ${pin.label} model (${size}) in ${Math.round(delays[attempts]! / 1000)}s — ${failures?.lastError ?? "the last attempt failed"}`,
          ...(partial > 0 ? { progress: { bytes: partial, total: pin.bytes } } : {}),
          ...(this.lastProblem ? { problem: this.lastProblem } : {}),
          retryAt: now() + delays[attempts]!,
        });
      }
      if (!(await sleep(delays[attempts]!, signal))) return false;
      this.attemptsThisRun.set(pin.sha256, attempts + 1);

      const held = acquireFetchLock(dest);
      if ("heldBy" in held) {
        this.setStatus({ state: "downloading", detail: `the ${pin.label} model (${size}) is being downloaded by another conch process (pid ${held.heldBy})` });
        while (!signal.aborted && existsSync(`${dest}.lock`) && !isFile(dest)) {
          if (!(await sleep(5_000, signal))) return false;
          const again = acquireFetchLock(dest);
          if (!("heldBy" in again)) {
            again.release();
            break;
          }
        }
        this.attemptsThisRun.set(pin.sha256, attempts); // someone else's attempt is not one of ours
        continue;
      }

      this.options.log(`speech engine: downloading the ${pin.label} model (${size}) to ${dest}, attempt ${attempts + 1}`);
      this.lastProgressAt = 0;
      const resumed = partBytes(dest);
      this.setStatus({ state: "downloading", detail: `downloading the ${pin.label} model (${size})`, progress: { bytes: resumed, total: pin.bytes } });
      // Room first: a download that fills the disk fails at the end, having taken everything on the way.
      const needs = pin.bytes - resumed + MODEL_FETCH_HEADROOM_BYTES;
      const free = (this.options.freeBytes ?? freeBytesNear)(dirname(dest));
      try {
        if (free !== null && free < needs) {
          this.lastProblem = { kind: "no-space", needs, free };
          throw new Error(`not enough free space: needs ${megabytes(needs)}, this Mac has ${megabytes(free)}`);
        }
        await (this.options.fetchModel ?? fetchPinnedModel)(pin, dest, {
          signal,
          onProgress: (bytes, total) => this.progress(pin, size, bytes, total),
        });
      } catch (error) {
        held.release();
        if (signal.aborted) return false;
        const why = errorText(error);
        const kind = classifyFetchFailure(why);
        if (kind === "offline") this.lastProblem = { kind };
        else if (kind === "no-space") this.lastProblem = { kind, needs, free: free ?? 0 };
        else this.lastProblem = null;
        const count = recordFetchFailure(failuresPath, pin.sha256, why, now());
        this.options.log(`speech engine: downloading the ${pin.label} model failed (${count} in the last day): ${why}`);
        continue;
      }
      held.release();
      this.lastProblem = null;
      clearFetchFailures(failuresPath, pin.sha256);
      this.options.log(`speech engine: the ${pin.label} model is in place (sha256 verified)`);
      return true;
    }
    return false;
  }

  private progress(pin: PinnedModel, size: string, bytes: number, total: number): void {
    const at = (this.options.now ?? Date.now)();
    if (bytes < total && at - this.lastProgressAt < (this.options.progressEveryMs ?? 2_000)) return;
    this.lastProgressAt = at;
    this.setStatus({ state: "downloading", detail: `downloading the ${pin.label} model (${size})`, progress: { bytes, total } });
  }

  /** Bounded out: say why, and — for a model — notice one placed by `conch setup` in a terminal. */
  private giveUp(reason: string, detail: string, watch: boolean, dest?: string): void {
    this.options.log(`speech engine: ${detail}`);
    this.setStatus({ state: "off", reason, detail, ...(this.lastProblem ? { problem: this.lastProblem } : {}) });
    if (!watch || !dest) {
      this.settleReady(false);
      return;
    }
    if (this.watchTimer || this.lifecycle.signal.aborted) return;
    this.watchTimer = setInterval(() => {
      if (!isFile(dest)) return;
      this.stopWatching();
      this.attemptsThisRun.clear();
      void this.enqueue(() => this.resolve());
    }, this.options.watchMs ?? 30_000);
    (this.watchTimer as { unref?: () => void }).unref?.();
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * Setup's Retry, for a download that gave up: this run's attempts and the day's failure record are forgotten, and the
   * engine is resolved again, resuming any `.part` on disk. Nothing happens unless it gave up on a download.
   */
  retry(): boolean {
    if (this.lifecycle.signal.aborted || this.status.state !== "off" || this.status.reason !== "download failed") return false;
    for (const [part, pin] of [[this.options.engine.vadModel, this.vadPin], [this.options.engine.whisperModel, this.whisperPin]] as const) {
      clearFetchFailures(this.options.failuresPath ?? join(dirname(part.path), "fetch-failures.json"), pin.sha256);
    }
    this.attemptsThisRun.clear();
    this.lastProblem = null;
    this.stopWatching();
    void this.enqueue(() => this.resolve());
    return true;
  }
}

/** Bytes a resumable download already has in its `.part`. */
function partBytes(dest: string): number {
  try { return statSync(`${dest}.part`).size; } catch { return 0; }
}

// MARK: - Outside the daemon (`conch doctor`)

/** The daemon's last published engine status, if that daemon is still alive. */
export function readPublishedEngineStatus(path = speechEngineStatusPath()): (SpeechEngineStatus & { pid: number }) | null {
  try {
    const status = JSON.parse(readFileSync(path, "utf8")) as SpeechEngineStatus & { pid?: number };
    if (typeof status.pid !== "number" || !pidAlive(status.pid) || typeof status.state !== "string") return null;
    return { ...status, pid: status.pid };
  } catch {
    return null;
  }
}

/** "Speech engine: ready — …", the line `conch doctor` prints and Settings mirrors. */
export function describeSpeechEngine(status: Pick<SpeechEngineStatus, "state" | "reason" | "detail" | "progress">): string {
  const head = status.state === "ready"
    ? "ready"
    : status.state === "downloading"
      ? `downloading…${status.progress?.total ? ` ${Math.floor((status.progress.bytes / status.progress.total) * 100)}%` : ""}`
      : status.state === "checking"
        ? "checking…"
        : `off (${status.reason ?? "see below"})`;
  return `Speech engine: ${head} — ${status.detail}`;
}
