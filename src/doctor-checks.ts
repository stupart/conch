import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { processAlive, readIdentity, type DaemonIdentity } from "./daemon-identity.ts";
import { readState } from "./daemon-state.ts";
import { speakCancellable } from "./speak.ts";
import { readWhisperRecord, type WhisperSpawnRecord } from "./whisper-orphan.ts";
import type { AudioSpawner, WatchdogProcess } from "./audio-watchdog.ts";

export const MICROPHONE_PROBE_DURATION_MS = 300;
export const TTS_PROBE_WORD = "Ready.";

const MICROPHONE_PROBE_TIMEOUT_MS = 3_000;
const TTS_PROBE_TIMEOUT_MS = 5_000;

export interface DoctorProbeResult {
  /** Live probes are advisory: callers should display this, not use it as the doctor's exit status. */
  ok: boolean;
  label: "microphone" | "TTS" | "agents" | "conch" | "whisper-server" | "kokoro";
  message: string;
  action?: string;
}

export interface WhisperServerProbeDeps {
  /** Does anything answer on the port? */
  listening?: (port: number) => Promise<boolean>;
  record?: () => WhisperSpawnRecord | null;
  alive?: (pid: number) => boolean;
}

/**
 * Which whisper-server state a person is looking at (D2): warm and owned by a
 * live conch daemon, warm but adopted (someone else's, never killed), or not
 * listening while its daemon is up — idle-unloaded, or still warming. Read
 * from outside the daemon: the port, plus the spawn record D3 leaves behind.
 * Always informational; none of these is a fault.
 */
export async function checkWhisperServer(cfg: Config, deps: WhisperServerProbeDeps = {}): Promise<DoctorProbeResult> {
  const label = "whisper-server" as const;
  const port = cfg.whisperPort;
  if (!port) return { ok: true, label, message: "whisper-server: off (CONCH_WHISPER_PORT=0) — cold cli only" };
  const listening = await (deps.listening ?? defaultListening)(port);
  const record = (deps.record ?? readWhisperRecord)();
  const alive = deps.alive ?? processAlive;
  const daemon = record && record.port === port && alive(record.daemonPid) ? record.daemonPid : null;
  const owned = daemon !== null && alive(record!.pid);
  if (listening) {
    return {
      ok: true,
      label,
      message: owned
        ? `whisper-server: warm on :${port} (owned by conch daemon ${daemon})`
        : `whisper-server: warm on :${port} (adopted — not started by a live conch daemon; never killed)`,
    };
  }
  return {
    ok: true,
    label,
    message: daemon
      ? cfg.whisperIdleUnloadMins
        ? `whisper-server: unloaded — daemon ${daemon} is up but nothing listens on :${port} (idle for ${cfg.whisperIdleUnloadMins} min, or still warming); it reloads when a mic is about to open`
        : `whisper-server: not listening on :${port} — daemon ${daemon} is up (still warming, or on the cold cli); whisper-idle-unload is 0, so it was not unloaded`
      : `whisper-server: not listening on :${port} — starts with the daemon`,
  };
}

export interface KokoroProbeDeps {
  daemon?: () => DaemonIdentity | null;
  /** The pid of the Kokoro worker a live daemon owns, or null. */
  workerPid?: (daemonPid: number) => number | null;
  listening?: (port: number) => Promise<boolean>;
  paused?: () => boolean;
}

/**
 * Which Kokoro state a person is looking at (D1): warm, unloaded because the
 * daemon is in manual mode, or not loaded (still warming, or voices via say).
 * Read from outside the daemon: the worker is the daemon's child, and manual
 * mode is the one boolean in the state file. Always informational.
 */
export async function checkKokoro(cfg: Config, deps: KokoroProbeDeps = {}): Promise<DoctorProbeResult> {
  const label = "kokoro" as const;
  if (cfg.ttsEngine === "say") return { ok: true, label, message: "kokoro: off (CONCH_TTS=say) — voices via say" };
  if (cfg.ttsEngine === "server" && !cfg.ttsPort) {
    return { ok: true, label, message: "kokoro: off (CONCH_TTS_PORT=0) — voices via say" };
  }
  const daemon = (deps.daemon ?? readIdentity)();
  if (cfg.ttsEngine === "server") {
    if (await (deps.listening ?? defaultListening)(cfg.ttsPort)) {
      return { ok: true, label, message: `kokoro: warm on :${cfg.ttsPort} (legacy server)` };
    }
  } else if (daemon) {
    const pid = (deps.workerPid ?? findKokoroWorker)(daemon.pid);
    if (pid) return { ok: true, label, message: `kokoro: warm (worker pid ${pid}, owned by conch daemon ${daemon.pid})` };
  }
  if (!daemon) return { ok: true, label, message: "kokoro: not loaded — starts with the daemon" };
  const paused = (deps.paused ?? (() => readState().paused))();
  return {
    ok: true,
    label,
    message: paused
      ? `kokoro: unloaded — daemon ${daemon.pid} is in manual mode; reloads in auto mode`
      : `kokoro: not loaded — daemon ${daemon.pid} is in auto mode (still warming, or voices via say)`,
  };
}

/** The daemon's own child running the materialized worker script, by ppid. */
function findKokoroWorker(daemonPid: number): number | null {
  const ps = Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,command="]);
  for (const line of ps.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === daemonPid && /\/tts-worker-[0-9a-f]+\.py(\s|$)/.test(match[3]!)) {
      return Number(match[1]);
    }
  }
  return null;
}

async function defaultListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

export interface MicrophoneCapture {
  pcm: Uint8Array;
}

export type MicrophoneCaptureRunner = (
  durationMs: number,
) => Promise<MicrophoneCapture>;

export interface MicrophoneProbeOptions {
  capture?: MicrophoneCaptureRunner;
  durationMs?: number;
}

export type TtsProbeRunner = (
  cfg: Config,
  word: string,
  timeoutMs: number,
) => Promise<void>;

export interface TtsProbeOptions {
  speak?: TtsProbeRunner;
  word?: string;
  timeoutMs?: number;
}

const MICROPHONE_PERMISSION_ACTION =
  "Grant access in System Settings › Privacy & Security › Microphone, then run `conch doctor` again.";

const TTS_FAILURE_ACTION =
  "Check the selected sound output and volume, run `conch setup`, then run `conch doctor` again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The exact finite SoX recording used by the live doctor probe. */
export function microphoneProbeCommand(durationMs = MICROPHONE_PROBE_DURATION_MS): string[] {
  const seconds = Math.max(1, durationMs) / 1_000;
  return [
    "sox", "-d", "-q",
    "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
    "-",
    "trim", "0", String(seconds),
  ];
}

/** Raw capture is mono signed 16-bit PCM. Ignore an impossible trailing partial sample. */
export function pcm16HasNonZeroSample(pcm: Uint8Array): boolean {
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    if (pcm[offset] !== 0 || pcm[offset + 1] !== 0) return true;
  }
  return false;
}

async function captureMicrophoneWithSox(durationMs: number): Promise<MicrophoneCapture> {
  const process = Bun.spawn(microphoneProbeCommand(durationMs), {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { process.kill("SIGKILL"); } catch {}
    try { process.unref(); } catch {}
  }, Math.max(MICROPHONE_PROBE_TIMEOUT_MS, durationMs + 1_000));

  try {
    const [exitCode, pcmBuffer, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
    ]);
    if (timedOut) throw new Error("SoX microphone capture timed out");
    if (exitCode !== 0) {
      const detail = stderr.trim();
      throw new Error(`SoX exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return { pcm: new Uint8Array(pcmBuffer) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Record just long enough to distinguish a real input stream from the all-zero
 * stream seen when microphone access is unavailable. A quiet room still has a
 * nonzero hardware noise floor; this deliberately does not impose a loudness
 * threshold.
 */
export async function checkMicrophone(
  options: MicrophoneProbeOptions = {},
): Promise<DoctorProbeResult> {
  const durationMs = options.durationMs ?? MICROPHONE_PROBE_DURATION_MS;
  try {
    const { pcm } = await (options.capture ?? captureMicrophoneWithSox)(durationMs);
    if (!pcm16HasNonZeroSample(pcm)) {
      return {
        ok: false,
        label: "microphone",
        message: "microphone capture was all zeros — likely a microphone-permission problem.",
        action: MICROPHONE_PERMISSION_ACTION,
      };
    }
    return {
      ok: true,
      label: "microphone",
      message: `microphone captured non-zero audio (${durationMs}ms)`,
    };
  } catch (error) {
    return {
      ok: false,
      label: "microphone",
      message: `microphone live check failed: ${errorMessage(error)}`,
      action: MICROPHONE_PERMISSION_ACTION,
    };
  }
}

function checkedAudioSpawner(): AudioSpawner {
  return (command: string[]): WatchdogProcess => {
    const process = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
    const exited = Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]).then(([exitCode, stderr]) => {
      if (exitCode !== 0) {
        const detail = stderr.trim();
        throw new Error(`${command[0] ?? "audio command"} exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
      }
      return exitCode;
    });
    return {
      exited,
      kill: (signal) => process.kill(signal),
      unref: () => process.unref(),
    };
  };
}

async function speakThroughConfiguredPath(cfg: Config, word: string, timeoutMs: number): Promise<void> {
  const warnings: string[] = [];
  const utterance = speakCancellable(
    { ...cfg, speak: true },
    word,
    "doctor",
    {
      spawnAudio: checkedAudioSpawner(),
      timeoutForText: () => timeoutMs,
      warn: (warning) => warnings.push(warning),
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    utterance.done.then(
      () => ({ kind: "done" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.kind === "timeout") {
    utterance.cancel();
    throw new Error(`configured TTS path timed out after ${timeoutMs}ms`);
  }
  if (outcome.kind === "error") throw outcome.error;
  if (warnings.length > 0) throw new Error(warnings.join("; "));
}

/** Speak one word through the same configured path used by conch at runtime. */
export async function checkTts(
  cfg: Config,
  options: TtsProbeOptions = {},
): Promise<DoctorProbeResult> {
  const word = options.word ?? TTS_PROBE_WORD;
  const timeoutMs = options.timeoutMs ?? TTS_PROBE_TIMEOUT_MS;
  try {
    await (options.speak ?? speakThroughConfiguredPath)(cfg, word, timeoutMs);
    return {
      ok: true,
      label: "TTS",
      message: `TTS spoke “${word}”`,
    };
  } catch (error) {
    return {
      ok: false,
      label: "TTS",
      message: `TTS live check failed: ${errorMessage(error)}`,
      action: TTS_FAILURE_ACTION,
    };
  }
}

/** One ready-to-print advisory line; intentionally uses a warning, never a fatal cross. */
/**
 * Which `claude` and `codex` conch will actually launch, and whether that is
 * the same one you get in a terminal.
 *
 * These can differ, silently. The daemon runs under the Mac app, which inherits
 * a GUI environment rather than a login shell — so PATH order is not the one
 * you see. On this machine a Homebrew cask sits ahead of an npm install in the
 * interactive shell, and conch resolves the npm one: measured five minor
 * versions apart for Codex and sixty-nine patch versions for Claude Code.
 *
 * That matters more than it sounds. A session started from conch is then not
 * the same program as one started by hand — different features, different
 * bugs, different prompts — and nothing anywhere says so. Tyler noticed only
 * because one of them asked to be updated.
 *
 * Advisory, like the other probes: conch does not get to decide which install
 * someone meant to use.
 */
export async function checkAgentBinaries(
  run: (argv: string[]) => Promise<{ stdout: string; ok: boolean }> = defaultRun,
  // Injected alongside `run`, not called directly. With `Bun.which` inline the
  // tests could stub the shell side but had to read the HOST for what conch
  // resolves, so their expected answer depended on where `claude` happened to
  // be installed — and CI, which has no claude at all, had never been green.
  which: (agent: string) => string | null = (agent) => Bun.which(agent),
): Promise<DoctorProbeResult> {
  const lines: string[] = [];
  let divergent = false;

  for (const agent of ["claude", "codex"] as const) {
    const mine = (await run(["/bin/sh", "-lc", `command -v ${agent}`])).stdout.trim();
    const shell = (await run(["/bin/zsh", "-lc", `command -v ${agent}`])).stdout.trim();
    const used = which(agent) ?? "";
    if (!used) {
      lines.push(`${agent}: not on conch's PATH`);
      divergent = true;
      continue;
    }
    const version = (await run([used, "--version"])).stdout.trim().split("\n")[0] ?? "";
    // The interactive shell is the comparison that matters: it is what the
    // person means by "the one I use".
    const theirs = shell || mine;
    if (theirs && theirs !== used) {
      const theirVersion = (await run([theirs, "--version"])).stdout.trim().split("\n")[0] ?? "";
      lines.push(`${agent}: conch runs ${version} (${used})`);
      lines.push(`${" ".repeat(agent.length)}  your shell runs ${theirVersion} (${theirs})`);
      divergent = true;
    } else {
      lines.push(`${agent}: ${version}`);
    }
  }

  return {
    ok: !divergent,
    label: "agents",
    message: lines.join("\n  "),
    ...(divergent
      ? {
        action: "conch and your shell resolve different installs. Remove the one "
          + "you do not want, or reorder PATH, so a session started from conch is "
          + "the same program as one you start by hand.",
      }
      : {}),
  };
}

/**
 * Every `conch` on PATH, in PATH order. Two is the from-source trap: a brew
 * binary plus a `bun link`ed checkout, so the app and the daemon end up on
 * different versions and nothing says so. Advisory, like the agents check.
 */
export function checkConchBinaries(
  path: string = process.env.PATH ?? "",
  isExecutable: (file: string) => boolean = defaultIsExecutable,
): DoctorProbeResult {
  const found: string[] = [];
  // ponytail: dedupes repeated PATH dirs, not symlinks to one file; resolve realpath if two aliases ever warn.
  for (const dir of new Set(path.split(":").filter(Boolean))) {
    const candidate = join(dir, "conch");
    if (isExecutable(candidate)) found.push(candidate);
  }
  if (found.length < 2) {
    return { ok: true, label: "conch", message: `conch: ${found[0] ?? "not on PATH"}` };
  }
  return {
    ok: false,
    label: "conch",
    message: `conch: ${found.length} on PATH — ${found.join(", ")} (the first wins)`,
    action: "Pick one install per machine: remove the one you do not want, or reorder "
      + "PATH, so the app and the daemon run the same version.",
  };
}

function defaultIsExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultRun(argv: string[]): Promise<{ stdout: string; ok: boolean }> {
  try {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(child.stdout).text();
    return { stdout, ok: (await child.exited) === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

export function formatDoctorProbe(result: DoctorProbeResult): string {
  return `${result.ok ? "✅" : "⚠️"} ${result.message}${result.action ? ` ${result.action}` : ""}`;
}
