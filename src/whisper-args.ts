import { availableParallelism } from "node:os";

/**
 * The whisper.cpp arguments the warm server and the cold CLI share, so the two
 * paths cannot drift apart: the VAD that decides what whisper hears, and the
 * threads and device it runs on. Both follow seashell, conch's source for its
 * engine (same whisper.cpp revision, same models).
 */

/**
 * Silero VAD, with whisper.cpp's 250ms shortest speech lowered to 100ms
 * (seashell 007e29f, src/speech-gate.ts: its defaults lost 3.2% of short
 * replies such as "okay"; these lost none of 12,116 words). With `--vad`
 * whisper hears only what Silero calls speech, and the replies conch exists
 * for are short. Measured here on 12 synthetic one-word replies, quick and
 * quiet (0.15–0.2s: "go", "no", "okay", "wait"…) through conch's model: 8 came
 * back empty at 250ms, none at 100ms (11 right, "send" heard as "Sent." either
 * way); 12 noise-only and click clips gave no text at either. The 300ms of
 * padding stays: it is what keeps a soft first or last word.
 */
export function whisperVadArgs(vadModel: string): string[] {
  return ["-vm", vadModel, "--vad", "--vad-speech-pad-ms", "300", "--vad-min-speech-duration-ms", "100"];
}

/** More whisper.cpp threads than this stop paying off (seashell 3ad4765). */
const MAX_THREADS = 8;

export interface TranscriptionHardware {
  appleSilicon: boolean;
  /** Apple silicon's cores other than efficiency cores; every physical core on Intel. */
  performanceCores: number;
}

export type SysctlReader = (names: readonly string[]) => Readonly<Record<string, string>>;

const readSysctl: SysctlReader = (names) => {
  try {
    // Unknown names (perflevels on Intel) print an error and leave the rest intact.
    const result = Bun.spawnSync(["/usr/sbin/sysctl", ...names], { stdout: "pipe", stderr: "ignore", timeout: 2_000 });
    const values: Record<string, string> = {};
    for (const line of result.stdout.toString().split("\n")) {
      const separator = line.indexOf(": ");
      if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 2).trim();
    }
    return values;
  } catch {
    return {};
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The cores whisper should use (seashell 3ad4765, src/local-asr-profile.ts).
 * conch asked for 6 threads everywhere: on an M1 or M3 with four performance
 * cores that put work on efficiency cores, and on a dual-core Intel Mac it
 * oversubscribed. Apple silicon numbers its core types from fastest down —
 * M1–M4 report Performance and Efficiency, M5 Super and Performance — so every
 * type but Efficiency counts. Intel cores are all alike: physical ones count.
 */
export function readTranscriptionHardware(read: SysctlReader = readSysctl): TranscriptionHardware {
  const levels = Array.from({ length: 4 }, (_, level) => [`hw.perflevel${level}.name`, `hw.perflevel${level}.physicalcpu`]).flat();
  const values = read(["hw.optional.arm64", "hw.physicalcpu", "hw.nperflevels", ...levels]);
  const appleSilicon = values["hw.optional.arm64"] === "1";
  const levelCount = Math.min(4, positiveInteger(values["hw.nperflevels"]) ?? 0);
  const fastCores = Array.from({ length: levelCount }, (_, level) => level)
    .filter((level) => level === 0 || (values[`hw.perflevel${level}.name`] !== undefined
      && values[`hw.perflevel${level}.name`] !== "Efficiency"))
    .reduce((total, level) => total + (positiveInteger(values[`hw.perflevel${level}.physicalcpu`]) ?? 0), 0);
  return {
    appleSilicon,
    performanceCores: (appleSilicon && fastCores) || positiveInteger(values["hw.physicalcpu"]) || availableParallelism(),
  };
}

let hardware: TranscriptionHardware | undefined;
/** Read once per process: the hardware does not change while conch runs. */
export function transcriptionHardware(): TranscriptionHardware {
  return hardware ??= readTranscriptionHardware();
}

export function whisperThreads(hw: TranscriptionHardware = transcriptionHardware()): number {
  return Math.max(1, Math.min(MAX_THREADS, hw.performanceCores));
}

/**
 * Threads, and the CPU instead of Metal when Metal is not to be trusted:
 * always on Intel, whose GPUs whisper.cpp's Metal backend does not target, and
 * after a Metal run has failed (seashell 3ad4765).
 */
export function whisperComputeArgs(options: { cpu?: boolean; hardware?: TranscriptionHardware } = {}): string[] {
  const hw = options.hardware ?? transcriptionHardware();
  return ["-t", String(whisperThreads(hw)), ...(options.cpu || !hw.appleSilicon ? ["-ng"] : [])];
}

/**
 * A whisper-server that died of a crash rather than being stopped: a fault
 * signal, or the shell-style status for one. Metal is the likeliest cause on a
 * warm server that was running, so the next one runs on the CPU (seashell
 * 3ad4765 restarts its live server with `-ng` on a signal or exit 139).
 */
const CRASH_SIGNALS = new Set(["SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT", "SIGFPE", "SIGTRAP"]);
const CRASH_STATUSES = new Set([132, 133, 134, 135, 136, 138, 139]);

export function whisperCrashed(exit: { exitCode: number | null; signalCode?: string | null }): boolean {
  return (exit.signalCode != null && CRASH_SIGNALS.has(exit.signalCode))
    || (exit.exitCode != null && CRASH_STATUSES.has(exit.exitCode));
}
