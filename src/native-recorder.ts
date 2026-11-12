import { closeSync, fstatSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { CaptureGate, PcmGain, type CaptureGateOptions } from "./capture-gate.ts";
import { DIGITAL_SILENCE_SECS, MICROPHONE_PERMISSION_EXIT_CODE } from "./microphone-helper.ts";

/**
 * One capture through conch Microphone (microphone-helper.ts): the helper's
 * PCM, through the capture gate, into the same file sox wrote, with the same
 * process handle every owner of a recorder already holds (`kill`, `exited`,
 * `pid`), so listen.ts stops, escalates and reaps it as it did sox.
 *
 * The helper writes into a file of its own, not a pipe to the daemon, and the
 * daemon follows that file. sox wrote its capture itself, so a daemon that
 * stalled (the log has caught its event loop blocked for 6s) lost nothing;
 * through a pipe it would: 64KB is two seconds of 16kHz audio, and once it is
 * full the helper's write blocks and it pads the gap with silence, over
 * whatever was said. A file the daemon falls behind on is only read late.
 *
 * `exited` settles only once the capture is whole: the helper has exited, the
 * rest of its file has been read through the gate, and (for a WAV) the header
 * names the length. A capture read the moment `exited` settles has every byte.
 *
 * The helper may relaunch itself as its own responsible process and proxy
 * signals to that copy (seashell's approach, used under launchd). A SIGKILL
 * cannot be forwarded, so it runs in its own process group, an escalation
 * kills the group, and so does its exit, so no copy outlives it (seashell
 * f395929). With nothing reading a pipe, the helper's own way of noticing that
 * conch is gone is its parent watch: it exits once its parent does.
 */
export interface RecorderProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

/** The process Bun hands back, as far as a native recording uses it. */
export interface SpawnedHelper {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals | number): void;
}

/** Starts the helper with its stdout on `stdoutFd`. */
export type HelperSpawner = (argv: string[], stdoutFd: number) => SpawnedHelper;

const spawnHelper: HelperSpawner = (argv, stdoutFd) => Bun.spawn(argv, {
  stdin: "ignore",
  stdout: stdoutFd,
  stderr: "pipe",
  detached: true,
}) as unknown as SpawnedHelper;

export interface NativeRecordingOptions {
  /** conch Microphone and its arguments. */
  argv: string[];
  /** The file the capture is written to (created empty, 0600, before the helper starts). */
  path: string;
  /** Raw PCM behind a gate (a listening capture), or a whole WAV (narration, the mic check). */
  format: { kind: "raw"; gate: CaptureGateOptions } | { kind: "wav"; gainDb?: number };
  /** macOS refused it the microphone (exit 77). */
  onPermissionRefused?: () => void;
  /** The first DIGITAL_SILENCE_SECS of its stream were exact zeros. */
  onDigitalSilence?: () => void;
  spawn?: HelperSpawner;
  /** How often the helper's file is followed. */
  followMs?: number;
}

export interface NativeRecording extends RecorderProcess {
  /** What the helper last wrote to stderr: its reason, when it failed. */
  stderr(): string;
}

const WAV_HEADER_BYTES = 44;
/** Each look at the helper's file: 20ms is one endpointer frame, well under the 100ms watch. */
const FOLLOW_MS = 20;

/** A 16kHz mono PCM16 WAV header for `dataBytes` of samples. */
export function pcmWavHeader(dataBytes: number, sampleRate = 16_000): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return header;
}

export function startNativeRecording(options: NativeRecordingOptions): NativeRecording {
  const streamPath = `${options.path}.stream`;
  const out = openSync(options.path, "w", 0o600);
  const wav = options.format.kind === "wav";
  if (wav) writeSync(out, pcmWavHeader(0));
  let streamWrite: number;
  let streamRead: number;
  try {
    streamWrite = openSync(streamPath, "w", 0o600);
    streamRead = openSync(streamPath, "r");
  } catch (error) {
    closeSync(out);
    rmSync(streamPath, { force: true });
    throw error;
  }
  let proc: SpawnedHelper;
  try {
    proc = (options.spawn ?? spawnHelper)(options.argv, streamWrite);
  } catch (error) {
    for (const fd of [out, streamWrite, streamRead]) closeSync(fd);
    rmSync(streamPath, { force: true });
    throw error;
  }
  // The helper has its own copy of the descriptor now; ours would only keep the file open for writing.
  try { closeSync(streamWrite); } catch {}

  const gate = options.format.kind === "raw" ? new CaptureGate(options.format.gate) : null;
  const wavGain = options.format.kind === "wav" && options.format.gainDb ? new PcmGain(options.format.gainDb) : null;
  let dataBytes = 0;
  let offset = 0;
  let stderrTail = "";
  let silenceJudged = false;
  let samplesSeen = 0;
  let heardNonZero = false;

  const judgeSilence = (chunk: Uint8Array): void => {
    if (silenceJudged) return;
    for (let i = 0; i + 1 < chunk.byteLength && !heardNonZero; i += 2) {
      if (chunk[i] !== 0 || chunk[i + 1] !== 0) heardNonZero = true;
    }
    samplesSeen += chunk.byteLength >> 1;
    if (heardNonZero) silenceJudged = true;
    else if (samplesSeen >= DIGITAL_SILENCE_SECS * 16_000) {
      silenceJudged = true;
      try { options.onDigitalSilence?.(); } catch {}
    }
  };

  const write = (bytes: Uint8Array): void => {
    let at = 0;
    while (at < bytes.byteLength) at += writeSync(out, bytes, at, bytes.byteLength - at);
  };

  /** Read what the helper's file grew by, and pass it on. */
  const follow = (): void => {
    let size: number;
    try {
      size = fstatSync(streamRead).size;
    } catch {
      return;
    }
    while (offset < size) {
      const chunk = new Uint8Array(Math.min(size - offset, 262_144));
      const read = readSync(streamRead, chunk, 0, chunk.byteLength, offset);
      if (read <= 0) break;
      offset += read;
      const piece = read === chunk.byteLength ? chunk : chunk.subarray(0, read);
      judgeSilence(piece);
      if (gate) {
        write(gate.push(piece));
      } else {
        const gained = wavGain ? wavGain.push(piece) : piece;
        write(gained);
        dataBytes += gained.byteLength;
      }
    }
  };
  const timer = setInterval(follow, options.followMs ?? FOLLOW_MS);

  const errors = (async () => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-2_000);
    } catch {}
  })();

  const killGroup = (signal: NodeJS.Signals | number): void => {
    try { process.kill(-proc.pid, signal); } catch {}
    try { proc.kill(signal); } catch {}
  };

  const exited = (async () => {
    const code = await proc.exited;
    clearInterval(timer);
    // Nothing of the group may go on writing, or holding the microphone, once the proxy is gone.
    killGroup("SIGKILL");
    await Promise.race([errors, Bun.sleep(100)]);
    try {
      follow();
      if (wav) {
        const header = pcmWavHeader(dataBytes);
        writeSync(out, header, 0, header.byteLength, 0);
      }
    } finally {
      closeSync(out);
      closeSync(streamRead);
      rmSync(streamPath, { force: true });
    }
    if (code === MICROPHONE_PERMISSION_EXIT_CODE) {
      try { options.onPermissionRefused?.(); } catch {}
    }
    return code;
  })();

  return {
    pid: proc.pid,
    exited,
    kill(signal = "SIGTERM") {
      // SIGINT and SIGTERM reach the copy that records (directly, or through its
      // proxy, which forwards them); only SIGKILL needs the whole group.
      if (signal === "SIGKILL" || signal === 9) killGroup(signal);
      else {
        try { proc.kill(signal); } catch {}
      }
    },
    stderr: () => stderrTail.trim(),
  };
}
