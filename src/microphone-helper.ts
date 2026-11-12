import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { conchHome } from "./home.ts";

/**
 * conch Microphone: the recorder conch captures with, whose permission it
 * records under, and when it uses sox instead.
 *
 * 2026-11-11, Tyler: "does it mess with my audio or mic and make it crackle or
 * anything? does it have the latest from seashell?" sox's CoreAudio driver
 * (SoX 14.4.2 coreaudio.c) sets the input device's IO buffer size
 * (kAudioDevicePropertyBufferSize) every time a capture opens, through the
 * deprecated AudioDevice API, and keeps what it reads in a ring of 8,192
 * floats, 85ms of 48kHz stereo, printing "unhandled buffer overrun. Data
 * discarded." when its effects chain falls behind. It does not change the
 * sample rate: that code is `#if 0` in 14.4.2, whatever its "did not accept %d
 * sample rate" message suggests (docs/daemon-side-effects.md found the same in
 * libsox's disassembly on 2026-09-11).
 *
 * Seashell had already left sox for a native recorder, and conch now builds
 * that recorder from seashell's source (scripts/sync-microphone.sh, seashell
 * df772e3 native/macos-microphone.swift): AVAudioEngine taps the input at the
 * device's own format and rate, seashell's own downmix averages the channels
 * that carry sound (never AVAudioConverter's, which gives digital zeros for the
 * built-in mic's three discrete channels: seashell 007e29f and df772e3), one
 * resampler makes 16kHz Int16, and the engine is rebuilt when the default
 * input changes, its configuration changes or it stops delivering for 3s. It
 * writes no device property: the binary imports only
 * AudioObjectAdd/RemovePropertyListenerBlock from CoreAudio. Its stdout is what
 * sox wrote, mono s16le at 16kHz; its reasons go to stderr; 77 means macOS has
 * not allowed it the microphone.
 *
 * Whose permission it records under. A daemon the app or a terminal started
 * runs the app's own helper with `--no-disclaim`, so it answers to whoever
 * conch's recorder always answered to: conch.app (docs/architecture.md, "One
 * grant, to conch.app, for every permission", probed 2026-09-27), or that
 * terminal. Nothing new is asked for, Settings › Permissions stays true, and
 * every app update runs its own build of the helper. What changes is that a
 * refused permission is no longer silence: the helper asks AVFoundation first
 * and exits 77, and the capture fails saying so, where sox recorded thirty
 * seconds of zeros that nothing reported.
 *
 * A daemon launchd started answers to bun, which has no audio-input
 * entitlement, so macOS hands any recorder under it silence: the case that
 * moved seashell's background recorder off sox. There the helper relaunches
 * itself as its own responsible process (seashell's approach) and holds its
 * own permission as "conch Microphone". macOS ties that grant to the binary it
 * was given for, so conch keeps one installed copy at a stable path and
 * replaces it only when its protocol number changes (`prepareMicrophoneHelper`,
 * after seashell src/runtime-host.ts `prepareRuntimeHelper`), and asks for it
 * once when the daemon starts rather than in the middle of a reply (seashell
 * 7b4a557). Seashell's own copy is never used: a seashell release replaces it.
 *
 * sox stays as the fallback, as seashell keeps it (SEASHELL_MICROPHONE_RECORDER
 * =sox): the `recorder` setting chooses it outright, an app without the helper
 * uses it, and a helper that hands back exact digital zeros (capture-gate.ts)
 * sends captures to sox for a while. A refused permission does not: sox
 * answers to the same app, and would only record the silence unnoticed.
 */

/** The installed copy's name: macOS lists it under Privacy & Security › Microphone. */
export const MICROPHONE_HELPER_NAME = "conch Microphone";
export const MICROPHONE_HELPER_IDENTIFIER = "ai.blueprintstudio.conch.microphone";
/** The helper's exit status when macOS Microphone access is off for it. */
export const MICROPHONE_PERMISSION_EXIT_CODE = 77;
/** A stream of exact zeros this long is a microphone macOS is not letting through. */
export const DIGITAL_SILENCE_SECS = 2;
/** After digital silence, sox records for this long before conch Microphone is tried again. */
export const DIGITAL_SILENCE_COOLOFF_MS = 10 * 60_000;
export const NATIVE_SAMPLE_RATE_ARGS = ["--sample-rate", "16000"] as const;

export type RecorderPreference = "native" | "sox";
export type MicrophoneAuthorization = "authorized" | "denied" | "restricted" | "notDetermined" | "unknown";

/** Where conch keeps its one installed copy. */
export function microphoneRuntimeDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = conchHome(),
): string {
  // A test or a preview must never replace the copy macOS gave the permission to.
  return resolve(env.CONCH_MICROPHONE_RUNTIME_DIR?.trim() || join(home, "Library", "Application Support", "conch", "Runtime"));
}

/** The protocol in a helper's embedded Info.plist, or undefined when it is not conch Microphone. */
export function embeddedHelperProtocol(path: string): number | undefined {
  try {
    if (statSync(path).size > 32 * 1024 * 1024) return undefined;
    const text = readFileSync(path).toString("latin1");
    const start = text.indexOf("<plist");
    const end = text.indexOf("</plist>", start);
    if (start < 0 || end < 0) return undefined;
    const plist = text.slice(start, end + 8);
    if (!plist.includes(`<string>${MICROPHONE_HELPER_IDENTIFIER}</string>`)) return undefined;
    const version = /<key>ConchHelperProtocol<\/key>\s*<string>(\d+)<\/string>/.exec(plist)?.[1];
    return version === undefined ? undefined : Number(version);
  } catch {
    return undefined;
  }
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function existing(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwned(path: string, directory: boolean): void {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) {
    throw new Error(`${path} must be a ${directory ? "directory" : "file"}, not a link`);
  }
  if (process.getuid && value.uid !== process.getuid()) throw new Error(`${path} must belong to you`);
  if (!directory && value.nlink !== 1) throw new Error(`${path} must be an independent file`);
}

/**
 * The installed copy of conch Microphone, made from `source` (the app's
 * Contents/Helpers/conch-microphone) when there is none, or when the source
 * speaks a different protocol. A rebuilt app with the same protocol keeps the
 * copy macOS already allowed, even though its bytes differ: replacing it would
 * ask for the microphone again.
 */
export function prepareMicrophoneHelper(source: string, directory = microphoneRuntimeDir()): string {
  const path = join(directory, MICROPHONE_HELPER_NAME);
  const resolvedSource = realpathSync(source);
  const sourceInfo = statSync(resolvedSource);
  if (!sourceInfo.isFile() || (sourceInfo.mode & 0o111) === 0) throw new Error(`${source} is not an executable file`);
  const sourceProtocol = embeddedHelperProtocol(resolvedSource);
  if (sourceProtocol === undefined) throw new Error(`${source} is not conch Microphone (no ConchHelperProtocol)`);
  if (existing(directory)) assertOwned(directory, true);
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existing(path)) {
    assertOwned(path, false);
    if (statSync(path).size === sourceInfo.size && digest(path) === digest(resolvedSource)) return path;
    if (embeddedHelperProtocol(path) === sourceProtocol) return path;
  }
  const temporary = join(directory, `.conch-microphone-${randomUUID()}.tmp`);
  try {
    copyFileSync(resolvedSource, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o700);
    if (existing(path)) assertOwned(path, false);
    renameSync(temporary, path);
    return path;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** `conch-microphone --status` prints `{"authorization":"authorized",…}`. */
export function parseMicrophoneStatus(stdout: string): MicrophoneAuthorization {
  try {
    const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const value = (JSON.parse(line) as { authorization?: unknown }).authorization;
    return value === "authorized" || value === "denied" || value === "restricted" || value === "notDetermined" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

export interface HelperRun {
  code: number | null;
  stdout: string;
}

export type HelperRunner = (argv: string[], timeoutMs: number, signal: AbortSignal) => Promise<HelperRun>;

const runHelper: HelperRunner = async (argv, timeoutMs, signal) => {
  // Its own process group: the helper relaunches itself, and a timeout has to
  // reach that copy too (seashell f395929).
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", detached: true });
  const stop = () => {
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
  };
  const timer = setTimeout(stop, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
};

export type RecorderChoice =
  | { kind: "native"; path: string; args: readonly string[] }
  | { kind: "sox"; why: string };

/**
 * Whose permission the helper records under: the process that started the
 * daemon ("attributed": the app or a terminal, with `--no-disclaim`), or its
 * own ("own": under launchd, from the installed copy).
 */
export type MicrophoneAttribution = "attributed" | "own";

export function microphoneAttribution(startedBy: "app" | "terminal" | "launchd"): MicrophoneAttribution {
  return startedBy === "launchd" ? "own" : "attributed";
}

export interface MicrophoneRecordersOptions {
  run?: HelperRunner;
  prepare?: (source: string) => string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MicrophoneRecordersSnapshot {
  source: string | null;
  path: string | null;
  attribution: MicrophoneAttribution;
  authorization: MicrophoneAuthorization;
  silentUntil: number | null;
  error: string | null;
}

/**
 * Which recorder the next capture uses. `choose` is synchronous, as every
 * capture's spawn is; what is learned from the helper (its permission, a
 * refusal, digital zeros) arrives asynchronously and only changes the next
 * capture, never one in flight.
 */
export class MicrophoneRecorders {
  #run: HelperRunner;
  #prepare: (source: string) => string;
  #now: () => number;
  #log: (line: string) => void;
  #source: string | null = null;
  #path: string | null = null;
  #attribution: MicrophoneAttribution = "attributed";
  #error: string | null = null;
  #authorization: MicrophoneAuthorization = "unknown";
  #silentUntil: number | null = null;
  #lastChoice = "";
  #refusalSaid = false;
  #lifecycle = new AbortController();

  constructor(options: MicrophoneRecordersOptions = {}) {
    this.#run = options.run ?? runHelper;
    this.#prepare = options.prepare ?? ((source) => prepareMicrophoneHelper(source));
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  setLog(log: (line: string) => void): void {
    this.#log = log;
  }

  /** Shutdown: a status check or a permission question in flight goes with the daemon. */
  close(): void {
    this.#lifecycle.abort();
    this.#lifecycle = new AbortController();
  }

  /**
   * The daemon, once it owns the socket. Attributed: the app's helper, as it
   * is, and a look at the permission for the log (the app owns asking for it,
   * Permissions.swift). Its own: the installed copy, and an undecided
   * permission asked for now, while the person has just started conch.
   */
  async start(source: string | null, attribution: MicrophoneAttribution = "attributed"): Promise<void> {
    this.#source = source;
    this.#attribution = attribution;
    this.#path = null;
    this.#error = null;
    this.#authorization = "unknown";
    this.#silentUntil = null;
    this.#refusalSaid = false;
    if (!source) return;
    if (attribution === "own") {
      try {
        this.#path = this.#prepare(source);
      } catch (error) {
        this.#error = error instanceof Error ? error.message : String(error);
        this.#log(`conch Microphone could not be installed (${this.#error}) — capturing with sox`);
        return;
      }
    } else {
      this.#path = source;
    }
    await this.#check();
    if (attribution === "own" && (this.#authorization as MicrophoneAuthorization) === "notDetermined") await this.#request();
  }

  snapshot(): MicrophoneRecordersSnapshot {
    return {
      source: this.#source,
      path: this.#path,
      attribution: this.#attribution,
      authorization: this.#authorization,
      silentUntil: this.#silentUntil,
      error: this.#error,
    };
  }

  /** `--no-disclaim` keeps the helper answering to the daemon's own responsible app. */
  get args(): readonly string[] {
    return this.#attribution === "attributed" ? [...NATIVE_SAMPLE_RATE_ARGS, "--no-disclaim"] : NATIVE_SAMPLE_RATE_ARGS;
  }

  /** The switch to flip when macOS refuses: conch's own, or conch Microphone's. */
  get permissionName(): string {
    return this.#attribution === "attributed" ? "conch" : MICROPHONE_HELPER_NAME;
  }

  choose(cfg: { recorder?: RecorderPreference }): RecorderChoice {
    const choice = this.#decide(cfg.recorder ?? "native");
    const said = choice.kind === "native" ? `native:${choice.path}` : `sox:${choice.why}`;
    if (said !== this.#lastChoice) {
      this.#lastChoice = said;
      this.#log(choice.kind === "native"
        ? `capturing with conch Microphone (${choice.path}${this.#attribution === "attributed" ? ", under the app's Microphone permission" : ", under its own Microphone permission"})`
        : `capturing with sox — ${choice.why}`);
    }
    return choice;
  }

  #decide(preference: RecorderPreference): RecorderChoice {
    if (preference === "sox") return { kind: "sox", why: "the recorder setting is sox" };
    if (!this.#path) {
      return { kind: "sox", why: this.#error ? `conch Microphone could not be installed: ${this.#error}` : "no conch Microphone in this conch.app" };
    }
    if (this.#silentUntil !== null) {
      if (this.#now() < this.#silentUntil) return { kind: "sox", why: "conch Microphone recorded digital silence" };
      this.#silentUntil = null;
    }
    return { kind: "native", path: this.#path, args: this.args };
  }

  /** A native capture exited 77: macOS has not allowed it the microphone. Said once until it is allowed. */
  reportPermissionRefused(): void {
    this.#authorization = "denied";
    if (this.#refusalSaid) return;
    this.#refusalSaid = true;
    this.#log(`Microphone access is off for ${this.permissionName} — conch hears nothing until it is allowed in System Settings › Privacy & Security › Microphone`);
  }

  /** A native capture's first DIGITAL_SILENCE_SECS were exact zeros. */
  reportDigitalSilence(): void {
    if (this.#silentUntil !== null && this.#now() < this.#silentUntil) return;
    this.#silentUntil = this.#now() + DIGITAL_SILENCE_COOLOFF_MS;
    this.#log(`conch Microphone recorded digital silence (macOS is not letting it hear) — capturing with sox for ${DIGITAL_SILENCE_COOLOFF_MS / 60_000} min`);
  }

  async #check(): Promise<void> {
    if (!this.#path) return;
    const argv = [this.#path, "--status", ...(this.#attribution === "attributed" ? ["--no-disclaim"] : [])];
    try {
      this.#learn(parseMicrophoneStatus((await this.#run(argv, 5_000, this.#lifecycle.signal)).stdout));
    } catch {
      this.#learn("unknown");
    }
  }

  async #request(): Promise<void> {
    if (!this.#path) return;
    this.#log("conch Microphone has not been allowed the microphone yet — macOS asks once now");
    try {
      // The question stays on screen until it is answered; give up waiting after a while, not on the answer.
      const result = await this.#run([this.#path, "--request-permission"], 10 * 60_000, this.#lifecycle.signal);
      this.#learn(parseMicrophoneStatus(result.stdout));
    } catch {
      this.#learn("unknown");
    }
  }

  #learn(authorization: MicrophoneAuthorization): void {
    this.#authorization = authorization;
    if (authorization === "denied" || authorization === "restricted") {
      this.#refusalSaid = true;
      this.#log(`Microphone access is ${authorization} for ${this.permissionName} — conch hears nothing until it is allowed in System Settings › Privacy & Security › Microphone`);
    }
  }
}

export const microphoneRecorders = new MicrophoneRecorders();
