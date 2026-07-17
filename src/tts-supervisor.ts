import {
  awaitProcessWithWatchdog,
  type WatchdogProcess,
  type WatchdogWarning,
} from "./audio-watchdog.ts";

export type TtsSupervisorStatus = "disabled" | "starting" | "ready" | "recovering" | "fallback" | "stopped";
export type TtsOwnership = "none" | "adopted" | "owned";
export type TtsRecoveryReason = "readiness-failed" | "synth-timeout" | "child-exit" | "periodic-probe";

export interface TtsSupervisorSnapshot {
  status: TtsSupervisorStatus;
  ownership: TtsOwnership;
  replacementAttempts: number;
  recovering: boolean;
  periodicArmed: boolean;
}

export interface TtsTimer {
  cancel(): void;
  unref?(): void;
}

export interface TtsSupervisorOptions {
  enabled: boolean;
  probePresence: (signal: AbortSignal) => Promise<boolean>;
  probeReady: (signal: AbortSignal) => Promise<boolean>;
  spawn: () => WatchdogProcess;
  resetReadiness: () => void;
  log?: WatchdogWarning;
  retryDelaysMs?: number[];
  periodicProbeMs?: number;
  deferredProbeMs?: number;
  terminateGraceMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
  schedule?: (callback: () => void, ms: number) => TtsTimer;
  terminate?: (child: WatchdogProcess, signal: AbortSignal) => Promise<void>;
  exclusive?: <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000];
type TtsInspection = "ready" | "unready" | "absent" | "deferred";

/** Convert a probe helper's abort-as-false convention into supervisor deferral. */
export async function requireUncancelledProbe<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const result = await work;
  if (signal.aborted) throw signal.reason ?? new DOMException("TTS probe cancelled", "AbortError");
  return result;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function defaultSchedule(callback: () => void, ms: number): TtsTimer {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer), unref: () => timer.unref?.() };
}

/**
 * Bounded Kokoro lifecycle supervision. Recovery is always background work:
 * callers only enqueue it, while speech immediately remains free to use `say`.
 */
export class TtsSupervisor {
  private status: TtsSupervisorStatus;
  private ownership: TtsOwnership = "none";
  private child: WatchdogProcess | null = null;
  private retiringChild: WatchdogProcess | null = null;
  private childGeneration = 0;
  private replacementAttempts = 0;
  private recovery: Promise<void> | null = null;
  private pendingChildExit = false;
  private timer: TtsTimer | null = null;
  private readonly lifecycle = new AbortController();
  private readonly log: WatchdogWarning;
  private readonly retryDelaysMs: number[];
  private readonly periodicProbeMs: number;
  private readonly deferredProbeMs: number;
  private readonly terminateGraceMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
  private readonly schedule: (callback: () => void, ms: number) => TtsTimer;
  private readonly terminate: (child: WatchdogProcess, signal: AbortSignal) => Promise<void>;
  private readonly exclusive: <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;

  constructor(private readonly options: TtsSupervisorOptions) {
    this.status = options.enabled ? "starting" : "disabled";
    const log = options.log ?? console.warn;
    this.log = (message) => { try { log(message); } catch {} };
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.periodicProbeMs = options.periodicProbeMs ?? 30_000;
    this.deferredProbeMs = options.deferredProbeMs ?? 500;
    this.terminateGraceMs = options.terminateGraceMs ?? 1_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.schedule = options.schedule ?? defaultSchedule;
    this.terminate = options.terminate ?? ((child, signal) => this.terminateChild(child, signal));
    this.exclusive = options.exclusive ?? ((task, signal) => task(signal));
  }

  snapshot(): TtsSupervisorSnapshot {
    return {
      status: this.status,
      ownership: this.ownership,
      replacementAttempts: this.replacementAttempts,
      recovering: this.recovery !== null,
      periodicArmed: this.timer !== null,
    };
  }

  /** Initial bounded canary. Later repair never extends daemon startup/drain. */
  async start(): Promise<boolean> {
    if (!this.options.enabled || this.stopped()) return false;
    this.status = "starting";
    try {
      const initial = await this.inspect();
      if (this.stopped()) return false;
      if (initial === "ready") return true;
      if (initial === "unready") {
        this.enterFallback("adopted kokoro failed readiness; using say while periodic canaries continue");
        return false;
      }
      if (initial === "deferred") {
        this.status = "recovering";
        this.deferRecovery("readiness-failed");
        return false;
      }

      if (this.stopped()) return false;
      const child = this.spawnOwned();
      const ready = await this.probeCurrentChild(child, "kokoro warm and synthesis-ready");
      if (this.stopped()) return false;
      if (ready) return true;
      if (!this.stopped()) {
        this.status = "recovering";
        this.requestRecovery("readiness-failed");
      }
      return false;
    } catch (error) {
      if (!this.stopped()) {
        this.log(`kokoro startup deferred/failed: ${String(error)}`);
        this.status = "recovering";
        this.deferRecovery("readiness-failed");
      }
      return false;
    }
  }

  /** Coalesced, fire-and-forget recovery trigger used by the speech path. */
  requestRecovery(reason: TtsRecoveryReason): void {
    if (!this.options.enabled || this.stopped()) return;
    // Once a bounded burst is exhausted, every ordinary failure stays latched
    // to say. Only the periodic timer may open another bounded burst; otherwise
    // a repeatedly-crashing last child could create an unbounded restart loop.
    if (this.status === "fallback" && reason !== "periodic-probe") {
      this.armPeriodicProbe();
      return;
    }
    if (this.recovery) {
      if (reason === "child-exit") this.pendingChildExit = true;
      return;
    }
    this.clearTimer();
    this.status = "recovering";
    this.log(`kokoro recovery requested: ${reason}`);
    const work = this.recover(reason);
    let tracked!: Promise<void>;
    tracked = work.catch((error) => {
      if (!this.stopped()) {
        this.log(`kokoro recovery deferred: ${String(error)}`);
        this.deferRecovery(reason);
      }
    }).finally(() => {
      if (this.recovery !== tracked) return;
      this.recovery = null;
      const lostReadyChild = this.pendingChildExit && this.status === "ready" && this.ownership === "none";
      this.pendingChildExit = false;
      if (lostReadyChild && !this.stopped()) {
        this.requestRecovery("child-exit");
      }
    });
    this.recovery = tracked;
  }

  /** Test/diagnostic barrier for the currently-running recovery burst only. */
  async settled(): Promise<void> {
    while (this.recovery) await this.recovery;
  }

  close(): void {
    if (this.stopped()) return;
    this.status = "stopped";
    this.lifecycle.abort();
    this.clearTimer();
    this.childGeneration++;
    const children = new Set([this.child, this.retiringChild]);
    this.child = null;
    this.retiringChild = null;
    if (this.ownership === "owned") {
      for (const child of children) {
        if (!child) continue;
        try { child.kill("SIGKILL"); } catch {}
        try { child.unref?.(); } catch {}
      }
    }
    this.ownership = "none";
  }

  private stopped(): boolean {
    return this.status === "stopped" || this.lifecycle.signal.aborted;
  }

  private async recover(reason: TtsRecoveryReason): Promise<void> {
    const inspected = await this.inspect();
    if (inspected === "ready" || this.stopped()) return;
    if (inspected === "deferred") {
      this.deferRecovery(reason);
      return;
    }
    if (reason === "periodic-probe" && inspected === "unready") {
      this.enterFallback("kokoro periodic canary is still failing; continuing to use say");
      return;
    }
    if (this.ownership === "adopted" && inspected === "unready") {
      this.enterFallback("adopted kokoro remains unready; leaving its owner intact and using say");
      return;
    }

    this.replacementAttempts = 0;
    for (const delayMs of this.retryDelaysMs) {
      if (!(await this.sleep(delayMs, this.lifecycle.signal)) || this.stopped()) return;
      this.replacementAttempts++;

      // Re-probe and terminate within one audio-lane critical section. A server
      // that recovered during backoff must not be killed after the canary, and
      // no utterance may enter the server between that canary and termination.
      const boundary = await this.exclusive(async (signal) => {
        const fresh = await this.inspectUnlocked(signal);
        if (fresh === "ready" || fresh === "deferred") return fresh;
        if (fresh === "unready" && this.ownership === "adopted") return fresh;

        const previous = this.retireOwnedChild();
        if (previous) await this.terminate(previous, signal);
        // Invalidate cached readiness before releasing audio exclusivity, so a
        // queued utterance cannot enter a dead server epoch between kill/reset.
        this.options.resetReadiness();
        return "terminated" as const;
      }, this.lifecycle.signal);
      if (this.stopped()) return;
      if (boundary === "ready") return;
      if (boundary === "deferred") {
        this.deferRecovery(reason);
        return;
      }
      if (boundary === "unready") {
        this.enterFallback("replacement kokoro was adopted but is not synthesis-ready; using say");
        return;
      }

      const beforeSpawn = await this.inspect();
      if (beforeSpawn === "ready" || this.stopped()) return;
      if (beforeSpawn === "deferred") {
        this.deferRecovery(reason);
        return;
      }
      if (beforeSpawn === "unready") {
        if (this.ownership === "adopted") {
          // A process appeared while we backed off. It is adopted and must
          // never be killed, even though its canary is currently bad.
          this.enterFallback("replacement kokoro was adopted but is not synthesis-ready; using say");
          return;
        }
        // SIGKILL can settle our watchdog just before the kernel releases the
        // listener. Preserve known-owned identity and retry the presence probe;
        // never misclassify that transient port as an adopted foreign process.
        this.log("terminated kokoro still owns its port; waiting before replacement");
        continue;
      }

      let child: WatchdogProcess;
      try {
        child = this.spawnOwned();
      } catch (error) {
        this.log(`kokoro restart spawn failed: ${String(error)}`);
        continue;
      }
      try {
        if (await this.probeCurrentChild(
          child,
          `kokoro recovered after ${this.replacementAttempts} replacement attempt(s)`,
        )) return;
      } catch (error) {
        if (this.stopped()) return;
        this.log(`kokoro replacement canary deferred: ${String(error)}`);
        this.deferRecovery(reason);
        return;
      }
    }

    this.enterFallback(
      `kokoro did not recover after ${this.replacementAttempts} replacement attempt(s); using say and probing periodically`,
    );
  }

  private async inspect(): Promise<TtsInspection> {
    try {
      const result = await this.exclusive(
        (signal) => this.inspectUnlocked(signal),
        this.lifecycle.signal,
      );
      return result ?? "deferred";
    } catch (error) {
      if (!this.stopped()) this.log(`kokoro probe deferred: ${String(error)}`);
      return "deferred";
    }
  }

  /** Probe while the caller already owns the audio lane. Never nest exclusive(). */
  private async inspectUnlocked(signal: AbortSignal): Promise<TtsInspection> {
    try {
      const present = await requireUncancelledProbe(this.options.probePresence(signal), signal);
      if (this.stopped()) return "deferred";
      if (!present) {
        // A confirmed released port is the safe point to forget a process whose
        // exit promise ignored TERM/SIGKILL. Until then it remains known-owned.
        this.dropRetiringAfterAbsence();
        if (!this.child) this.ownership = "none";
        return "absent";
      }

      if (!this.child && !this.retiringChild && this.ownership === "none") {
        this.ownership = "adopted";
      }
      const ready = await requireUncancelledProbe(this.options.probeReady(signal), signal);
      if (this.stopped()) return "deferred";
      if (!ready) return "unready";

      // A retired owned process can recover or ignore termination. A successful
      // canary proves health, not foreign ownership, so restore its supervision.
      if (!this.child && this.retiringChild && this.ownership === "owned") {
        this.restoreRetiringChild();
      }
      this.markReady(
        this.ownership === "owned"
          ? "owned kokoro is synthesis-ready again"
          : "adopted kokoro is synthesis-ready again",
      );
      return "ready";
    } catch (error) {
      if (!this.stopped()) this.log(`kokoro probe deferred: ${String(error)}`);
      return "deferred";
    }
  }

  private async probeCurrentChild(child: WatchdogProcess, message: string): Promise<boolean> {
    try {
      const ready = await this.exclusive(async (signal) => {
        if (this.child !== child || this.ownership !== "owned") return false;
        return requireUncancelledProbe(this.options.probeReady(signal), signal);
      }, this.lifecycle.signal);
      if (this.stopped() || !ready || this.child !== child) return false;
      this.markReady(message);
      return true;
    } catch (error) {
      if (!this.stopped()) this.log(`kokoro child canary deferred: ${String(error)}`);
      throw error;
    }
  }

  private spawnOwned(): WatchdogProcess {
    if (this.retiringChild) throw new Error("cannot spawn kokoro while a known-owned listener is retiring");
    const child = this.options.spawn();
    this.child = child;
    this.ownership = "owned";
    this.watchCurrentChild(child);
    return child;
  }

  private watchCurrentChild(child: WatchdogProcess): void {
    const generation = ++this.childGeneration;
    void child.exited.then(
      (code) => this.childExited(child, generation, code),
      (error) => this.childExited(child, generation, `error: ${String(error)}`),
    );
  }

  private childExited(child: WatchdogProcess, generation: number, code: unknown): void {
    if (this.stopped() || this.child !== child || this.childGeneration !== generation) return;
    this.child = null;
    this.ownership = "none";
    this.options.resetReadiness();
    this.log(`owned kokoro exited (${String(code)})`);
    this.requestRecovery("child-exit");
  }

  private retireOwnedChild(): WatchdogProcess | null {
    if (this.ownership !== "owned") return null;
    if (this.retiringChild) return this.retiringChild;
    if (!this.child) return null;

    const child = this.child;
    this.child = null;
    this.retiringChild = child;
    this.childGeneration++; // stale the current-child watcher
    void child.exited.then(
      (code) => this.retiringChildExited(child, code),
      (error) => this.retiringChildExited(child, `error: ${String(error)}`),
    );
    return child;
  }

  private restoreRetiringChild(): void {
    const child = this.retiringChild;
    if (!child) return;
    this.retiringChild = null;
    this.child = child;
    this.ownership = "owned";
    this.watchCurrentChild(child);
  }

  private dropRetiringAfterAbsence(): void {
    const child = this.retiringChild;
    if (!child) return;
    this.retiringChild = null;
    try { child.unref?.(); } catch {}
  }

  private retiringChildExited(child: WatchdogProcess, code: unknown): void {
    if (this.stopped() || this.retiringChild !== child) return;
    this.retiringChild = null;
    if (!this.child) this.ownership = "none";
    this.options.resetReadiness();
    this.log(`retiring owned kokoro exited (${String(code)})`);
    // Expected exits are absorbed by an in-flight bounded burst. A fallback
    // remains periodic-only, preventing exit/restart storms after exhaustion.
    if (!this.recovery && this.status === "ready") this.requestRecovery("child-exit");
  }

  private async terminateChild(child: WatchdogProcess, signal: AbortSignal): Promise<void> {
    try { child.kill(); } catch {}
    await awaitProcessWithWatchdog(child, {
      operation: "kokoro shutdown",
      timeoutMs: this.terminateGraceMs,
      signal,
      warn: this.log,
    });
  }

  private markReady(message: string): void {
    if (this.stopped()) return;
    this.status = "ready";
    this.replacementAttempts = 0;
    this.clearTimer();
    this.log(message);
  }

  private enterFallback(message: string): void {
    if (this.stopped()) return;
    this.status = "fallback";
    this.log(message);
    this.armPeriodicProbe();
  }

  private deferRecovery(reason: TtsRecoveryReason): void {
    if (this.stopped()) return;
    this.armTimer(this.deferredProbeMs, () => {
      if (this.recovery) this.deferRecovery(reason);
      else this.requestRecovery(reason);
    });
  }

  private armPeriodicProbe(): void {
    if (this.stopped() || this.timer) return;
    this.armTimer(this.periodicProbeMs, () => {
      if (this.recovery) this.armPeriodicProbe();
      else this.requestRecovery("periodic-probe");
    });
  }

  private armTimer(ms: number, callback: () => void): void {
    this.clearTimer();
    const timer = this.schedule(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      if (!this.stopped()) callback();
    }, ms);
    timer.unref?.();
    this.timer = timer;
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }
}
