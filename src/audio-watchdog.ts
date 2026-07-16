export const AUDIO_TIMEOUT_FLOOR_MS = 8_000;
export const AUDIO_TIMEOUT_CEILING_MS = 120_000;
export const AUDIO_CHARS_PER_SECOND = 10;

export type WatchdogWarning = (message: string) => void;

export interface WatchdogProcess {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  unref?(): void;
}

export type AudioSpawner = (command: string[]) => WatchdogProcess;

export type WatchdogResult<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" }
  | { status: "timed-out" };

export interface WatchdogOptions {
  operation: string;
  timeoutMs: number;
  /** Original budget to print when this call is using a remaining deadline. */
  warningTimeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: () => void;
  onTimeout?: () => void;
  timeoutAction?: "aborted" | "cancelled" | "killed";
  warn?: WatchdogWarning;
}

/**
 * Speech is budgeted at a conservative ten characters per second. Eight
 * seconds absorbs process/server startup for short phrases; two minutes is the
 * hard upper bound that keeps even a very long read from owning the lane
 * forever.
 */
export function audioTimeoutMs(textOrChars: string | number): number {
  const chars = typeof textOrChars === "string" ? textOrChars.length : textOrChars;
  const scaled = Math.ceil(Math.max(0, chars) / AUDIO_CHARS_PER_SECOND) * 1_000;
  return Math.min(AUDIO_TIMEOUT_CEILING_MS, Math.max(AUDIO_TIMEOUT_FLOOR_MS, scaled));
}

function durationLabel(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(1))}s`;
}

function safely(run: (() => void) | undefined): void {
  try { run?.(); } catch {}
}

/**
 * Race an arbitrary await against cancellation and a hard deadline. Crucially,
 * timeout/cancel settles this wrapper without waiting for the underlying work
 * to acknowledge either signal.
 */
export function awaitWithWatchdog<T>(work: PromiseLike<T>, options: WatchdogOptions): Promise<WatchdogResult<T>> {
  const timeoutMs = Math.max(1, Math.ceil(options.timeoutMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: WatchdogResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      reject(error);
    };
    const cancel = (): void => {
      safely(options.onCancel);
      finish({ status: "cancelled" });
    };

    Promise.resolve(work).then(
      (value) => finish({ status: "completed", value }),
      fail,
    );
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    if (settled) return;
    timer = setTimeout(() => {
      safely(options.onTimeout);
      const action = options.timeoutAction ?? "cancelled";
      safely(() => (options.warn ?? console.warn)(
        `⚠ ${options.operation} timed out after ${durationLabel(options.warningTimeoutMs ?? timeoutMs)} — ${action}, moving on`,
      ));
      finish({ status: "timed-out" });
    }, timeoutMs);
  });
}

/**
 * Make an AbortSignal authoritative even when injected work ignores it. The
 * abandoned promise keeps rejection handlers attached, preventing a late
 * failure from becoming unhandled.
 */
export function awaitWithAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
    Promise.resolve(work).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Kill a child on cancel/timeout, but never await its exit after the deadline. */
export async function awaitProcessWithWatchdog(
  process: WatchdogProcess,
  options: Omit<WatchdogOptions, "onCancel" | "onTimeout" | "timeoutAction">,
): Promise<WatchdogResult<number>> {
  return await awaitWithWatchdog(process.exited, {
    ...options,
    timeoutAction: "killed",
    onCancel: () => {
      try { process.kill("SIGKILL"); } catch {}
      try { process.unref?.(); } catch {}
    },
    onTimeout: () => {
      // A hung audio process is disposable. SIGKILL avoids leaving a child
      // alive after the daemon has deliberately released the audio lane.
      try { process.kill("SIGKILL"); } catch {}
      try { process.unref?.(); } catch {}
    },
  });
}
