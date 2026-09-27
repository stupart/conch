import { Worker } from "node:worker_threads";

/**
 * The daemon's event loop, watched from another thread.
 *
 * Everything the daemon does runs on one thread. On 2026-09-28 a synchronous loop held it for eight minutes: 152%
 * CPU, a socket that accepted connections and never answered them, SIGTERM ignored (its handler is JavaScript too),
 * and a log whose last line was an unrelated whisper-server unload. Nothing inside the daemon could say what it was
 * stuck in, because saying anything needs the thread that was stuck. It took a `sample` and a symbolised Bun build to
 * find it.
 *
 * So a worker thread watches. The main thread bumps a counter in shared memory every `heartbeatMs`, from a timer: a
 * timer only fires when the loop is turning. It also writes a short breadcrumb there — what it is about to run, set
 * by `breadcrumb()` at the timers, handlers and build steps that could hold it. When the counter stops for `stallMs`,
 * the worker appends a line to the daemon log with how long and the breadcrumb, again every `repeatMs` while it
 * lasts, and once more when the loop comes back. The worker writes the log itself; that is the point.
 *
 * Cost: one timer tick a second on the main thread, one wake a second in the worker (a blocking wait, not an event
 * loop), and a few nanoseconds per breadcrumb (a UTF-8 copy into shared memory): measured at under 0.05 s of CPU a
 * minute, idle, the worker's start included. The worker is unref'd and never keeps the daemon alive, and an error in
 * it is swallowed: a watchdog that can take the daemon down is worse than none.
 */

export const LOOP_HEARTBEAT_MS = 1_000;
export const LOOP_CHECK_MS = 1_000;
export const LOOP_STALL_MS = 5_000;
export const LOOP_REPEAT_MS = 10_000;
/** Longer breadcrumbs are cut, at a character boundary. */
export const BREADCRUMB_MAX_BYTES = 192;

// Shared memory: eight Int32 slots, then the breadcrumb's bytes.
const BEAT = 0; // bumped by the main thread's heartbeat timer
const SEQ = 1; // odd while the breadcrumb is being written (a seqlock)
const LENGTH = 2; // the breadcrumb's length in bytes
const LABEL_BEAT = 3; // BEAT when the breadcrumb was written: how stale it is
const STOP = 4; // set, and notified, to end the worker's wait
const SLOTS = 8;
const HEADER_BYTES = SLOTS * 4;

export interface LoopWatchdogOptions {
  /** The daemon log (`LOG_FILE`): where the worker appends its lines. */
  logPath: string;
  heartbeatMs?: number;
  checkMs?: number;
  stallMs?: number;
  repeatMs?: number;
}

export interface LoopWatchdog {
  /** Say what the main thread is about to run. */
  mark(label: string): void;
  /** Stop the heartbeat and the worker. */
  stop(): void;
}

let active: LoopWatchdog | null = null;

/**
 * Say what the main thread is about to run, so a stall can be named. Cheap enough for every timer and handler:
 * nothing without a watchdog, a UTF-8 copy into shared memory with one.
 */
export function breadcrumb(label: string): void {
  active?.mark(label);
}

/**
 * The worker, as source: evaluated in its own thread (`eval: true`), so the compiled daemon (`bun build --compile`,
 * one entrypoint) carries it with no second file to find. Plain JavaScript, and it must never throw into the daemon.
 */
const WORKER_SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const { appendFileSync } = require("node:fs");
const { shared, logPath, checkMs, stallMs, repeatMs, heartbeatMs } = workerData;
const control = new Int32Array(shared, 0, ${SLOTS});
const bytes = new Uint8Array(shared, ${HEADER_BYTES});
const decoder = new TextDecoder();

function stamp() {
  const now = new Date();
  return "[conch " + (now.getMonth() + 1) + "/" + now.getDate() + " " + now.toTimeString().slice(0, 8) + "]";
}
function write(message) {
  try { appendFileSync(logPath, stamp() + " " + message + "\n", { mode: 0o600 }); } catch {}
}
function crumb() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = Atomics.load(control, ${SEQ});
    if (before & 1) continue;
    const length = Atomics.load(control, ${LENGTH});
    const text = decoder.decode(bytes.slice(0, length));
    const beat = Atomics.load(control, ${LABEL_BEAT});
    if (Atomics.load(control, ${SEQ}) === before) return { text, beat };
  }
  return null;
}
function seconds(ms) { return (ms / 1000).toFixed(1) + "s"; }
function describe(beatAtStall) {
  const read = crumb();
  if (!read || !read.text) return "no breadcrumb set";
  const beats = Math.max(0, beatAtStall - read.beat);
  const age = beats === 0
    ? "set in the last " + seconds(heartbeatMs) + " before it stopped"
    : "set about " + seconds(beats * heartbeatMs) + " before it stopped";
  return "last breadcrumb: " + JSON.stringify(read.text) + " (" + age + ")";
}

let lastBeat = Atomics.load(control, ${BEAT});
let lastBeatSeenAt = performance.now();
let lastTickAt = lastBeatSeenAt;
let stalled = false;
let nextReportAt = 0;
// What the loop was in when it stopped, read then: once it is back it writes new breadcrumbs.
let stalledIn = "";

function tick() {
  try {
    const now = performance.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    const beat = Atomics.load(control, ${BEAT});
    if (beat !== lastBeat) {
      if (stalled) write("event loop recovered after ~" + seconds(now - lastBeatSeenAt) + " blocked — " + stalledIn);
      lastBeat = beat;
      lastBeatSeenAt = now;
      stalled = false;
      return;
    }
    // This thread did not run either: the Mac slept, or the whole process was stopped. That is not the loop
    // being held, so the clock starts again from here.
    if (gap > checkMs * 3) {
      lastBeatSeenAt = now;
      return;
    }
    const blocked = now - lastBeatSeenAt;
    if (!stalled && blocked >= stallMs) {
      stalled = true;
      nextReportAt = now + repeatMs;
      stalledIn = describe(lastBeat);
      write("event loop blocked: no heartbeat for " + seconds(blocked) + " (one is due every " + seconds(heartbeatMs) + ") — " + stalledIn);
    } else if (stalled && now >= nextReportAt) {
      nextReportAt = now + repeatMs;
      write("event loop still blocked: no heartbeat for " + seconds(blocked) + " — " + describe(lastBeat));
    }
  } catch {}
}

// A blocking wait, not a timer: this thread has nothing else to do, and a wait costs less than a turn of an event loop.
while (Atomics.wait(control, ${STOP}, 0, checkMs) !== "not-equal" && Atomics.load(control, ${STOP}) === 0) tick();
`;

/** Start watching this thread's event loop. One per process; a second call replaces the first. */
export function startLoopWatchdog(options: LoopWatchdogOptions): LoopWatchdog {
  active?.stop();
  const heartbeatMs = options.heartbeatMs ?? LOOP_HEARTBEAT_MS;
  const shared = new SharedArrayBuffer(HEADER_BYTES + BREADCRUMB_MAX_BYTES);
  const control = new Int32Array(shared, 0, SLOTS);
  const label = new Uint8Array(shared, HEADER_BYTES, BREADCRUMB_MAX_BYTES);
  const encoder = new TextEncoder();

  let worker: Worker | null = null;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        shared,
        logPath: options.logPath,
        heartbeatMs,
        checkMs: options.checkMs ?? LOOP_CHECK_MS,
        stallMs: options.stallMs ?? LOOP_STALL_MS,
        repeatMs: options.repeatMs ?? LOOP_REPEAT_MS,
      },
    });
    worker.on("error", () => {});
    worker.unref();
  } catch {
    worker = null;
  }
  const heartbeat = setInterval(() => Atomics.add(control, BEAT, 1), heartbeatMs);
  heartbeat.unref?.();

  const watchdog: LoopWatchdog = {
    mark(text: string): void {
      Atomics.add(control, SEQ, 1);
      const { written } = encoder.encodeInto(text, label);
      Atomics.store(control, LENGTH, written);
      Atomics.store(control, LABEL_BEAT, Atomics.load(control, BEAT));
      Atomics.add(control, SEQ, 1);
    },
    stop(): void {
      clearInterval(heartbeat);
      Atomics.store(control, STOP, 1);
      Atomics.notify(control, STOP);
      if (active === watchdog) active = null;
      const running = worker;
      worker = null;
      void running?.terminate().catch(() => {});
    },
  };
  active = watchdog;
  return watchdog;
}

/** `CONCH_LOOP_WATCHDOG=0` turns it off; anything else, or nothing, leaves it on. */
export function loopWatchdogEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CONCH_LOOP_WATCHDOG?.trim() !== "0";
}
