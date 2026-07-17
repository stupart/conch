import {
  awaitProcessWithWatchdog,
  type WatchdogProcess,
  type WatchdogWarning,
} from "./audio-watchdog.ts";

export type ServerSupervisorStatus = "disabled" | "starting" | "ready" | "recovering" | "fallback" | "stopped";
export type ServerOwnership = "none" | "adopted" | "owned";
export type ServerLifecycleRecoveryReason = "readiness-failed" | "child-exit" | "periodic-probe";
export type ServerRecoveryReason<RequestReason extends string = never> =
  | ServerLifecycleRecoveryReason
  | RequestReason;

export interface ServerSupervisorSnapshot {
  status: ServerSupervisorStatus;
  ownership: ServerOwnership;
  replacementAttempts: number;
  recovering: boolean;
  periodicArmed: boolean;
}

export interface ServerTimer {
  cancel(): void;
  unref?(): void;
}

/** User-visible nouns/fragments used by the shared lifecycle log messages. */
export interface ServerSupervisorLanguage {
  /** Process/service noun, for example `kokoro` or `whisper-server`. */
  service: string;
  /** Readiness adjective, for example `synthesis-ready` or `transcription-ready`. */
  readiness: string;
  /** Present-participle fallback clause, for example `using say`. */
  fallback: string;
}

export interface ServerSupervisorOptions {
  enabled: boolean;
  language: ServerSupervisorLanguage;
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
  schedule?: (callback: () => void, ms: number) => ServerTimer;
  terminate?: (child: WatchdogProcess, signal: AbortSignal) => Promise<void>;
  exclusive?: <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000];
type ServerInspection = "ready" | "unready" | "absent" | "deferred";

/** Convert a probe helper's abort-as-false convention into supervisor deferral. */
export async function requireUncancelledProbe<T>(
  work: Promise<T>,
  signal: AbortSignal,
  operation = "server probe",
): Promise<T> {
  const result = await work;
  if (signal.aborted) throw signal.reason ?? new DOMException(`${operation} cancelled`, "AbortError");
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

function defaultSchedule(callback: () => void, ms: number): ServerTimer {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer), unref: () => timer.unref?.() };
}

/**
 * Bounded warm-server lifecycle supervision. Recovery is always background
 * work: callers only enqueue it while their fallback remains immediately free.
 */
export class ServerSupervisor<RequestReason extends string = string> {
  private status: ServerSupervisorStatus;
  private ownership: ServerOwnership = "none";
  private child: WatchdogProcess | null = null;
  private retiringChild: WatchdogProcess | null = null;
  private childGeneration = 0;
  private replacementAttempts = 0;
  private recovery: Promise<void> | null = null;
  private pendingChildExit = false;
  private timer: ServerTimer | null = null;
  private readonly lifecycle = new AbortController();
  private readonly log: WatchdogWarning;
  private readonly retryDelaysMs: number[];
  private readonly periodicProbeMs: number;
  private readonly deferredProbeMs: number;
  private readonly terminateGraceMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
  private readonly schedule: (callback: () => void, ms: number) => ServerTimer;
  private readonly terminate: (child: WatchdogProcess, signal: AbortSignal) => Promise<void>;
  private readonly exclusive: <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T>;

  constructor(private readonly options: ServerSupervisorOptions) {
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

  snapshot(): ServerSupervisorSnapshot {
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
        this.enterFallback(
          `adopted ${this.service} failed readiness; ${this.fallback} while periodic canaries continue`,
        );
        return false;
      }
      if (initial === "deferred") {
        this.status = "recovering";
        this.deferRecovery("readiness-failed");
        return false;
      }

      if (this.stopped()) return false;
      const child = this.spawnOwned();
      const ready = await this.probeCurrentChild(child, `${this.service} warm and ${this.readiness}`);
      if (this.stopped()) return false;
      if (ready) return true;
      if (!this.stopped()) {
        this.status = "recovering";
        this.requestRecovery("readiness-failed");
      }
      return false;
    } catch (error) {
      if (!this.stopped()) {
        this.log(`${this.service} startup deferred/failed: ${String(error)}`);
        this.status = "recovering";
        this.deferRecovery("readiness-failed");
      }
      return false;
    }
  }

  /** Coalesced, fire-and-forget recovery trigger used by the speech path. */
  requestRecovery(reason: ServerRecoveryReason<RequestReason>): void {
    if (!this.options.enabled || this.stopped()) return;
    // Once a bounded burst is exhausted, every ordinary failure stays latched
    // to the fallback. Only the periodic timer may open another bounded burst;
    // otherwise a repeatedly-crashing child could create an unbounded loop.
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
    this.log(`${this.service} recovery requested: ${reason}`);
    const work = this.recover(reason);
    let tracked!: Promise<void>;
    tracked = work.catch((error) => {
      if (!this.stopped()) {
        this.log(`${this.service} recovery deferred: ${String(error)}`);
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
    // New requests must fail closed before an owned listener is killed. This
    // is especially important when shutdown retains/drains diagnostic audio.
    try { this.options.resetReadiness(); } catch {}
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

  private get service(): string {
    return this.options.language.service;
  }

  private get readiness(): string {
    return this.options.language.readiness;
  }

  private get fallback(): string {
    return this.options.language.fallback;
  }

  private stopped(): boolean {
    return this.status === "stopped" || this.lifecycle.signal.aborted;
  }

  private async recover(reason: ServerRecoveryReason<RequestReason>): Promise<void> {
    const inspected = await this.inspect();
    if (inspected === "ready" || this.stopped()) return;
    if (inspected === "deferred") {
      this.deferRecovery(reason);
      return;
    }
    if (reason === "periodic-probe" && inspected === "unready") {
      this.enterFallback(`${this.service} periodic canary is still failing; ${this.fallback}`);
      return;
    }
    if (this.ownership === "adopted" && inspected === "unready") {
      this.enterFallback(
        `adopted ${this.service} remains unready; leaving its owner intact and ${this.fallback}`,
      );
      return;
    }

    this.replacementAttempts = 0;
    for (const delayMs of this.retryDelaysMs) {
      if (!(await this.sleep(delayMs, this.lifecycle.signal)) || this.stopped()) return;
      this.replacementAttempts++;

      // Re-probe and terminate within one caller-supplied critical section. A server
      // that recovered during backoff must not be killed after the canary, and
      // no request may enter the server between that canary and termination.
      const boundary = await this.exclusive(async (signal) => {
        const fresh = await this.inspectUnlocked(signal);
        if (fresh === "ready" || fresh === "deferred") return fresh;
        if (fresh === "unready" && this.ownership === "adopted") return fresh;

        const previous = this.retireOwnedChild();
        if (previous) await this.terminate(previous, signal);
        // Invalidate cached readiness before releasing exclusivity, so a queued
        // request cannot enter a dead server epoch between termination and reset.
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
        this.enterFallback(
          `replacement ${this.service} was adopted but is not ${this.readiness}; ${this.fallback}`,
        );
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
          this.enterFallback(
            `replacement ${this.service} was adopted but is not ${this.readiness}; ${this.fallback}`,
          );
          return;
        }
        // SIGKILL can settle our watchdog just before the kernel releases the
        // listener. Preserve known-owned identity and retry the presence probe;
        // never misclassify that transient port as an adopted foreign process.
        this.log(`terminated ${this.service} still owns its port; waiting before replacement`);
        continue;
      }

      let child: WatchdogProcess;
      try {
        child = this.spawnOwned();
      } catch (error) {
        this.log(`${this.service} restart spawn failed: ${String(error)}`);
        continue;
      }
      try {
        if (await this.probeCurrentChild(
          child,
          `${this.service} recovered after ${this.replacementAttempts} replacement attempt(s)`,
        )) return;
      } catch (error) {
        if (this.stopped()) return;
        this.log(`${this.service} replacement canary deferred: ${String(error)}`);
        this.deferRecovery(reason);
        return;
      }
    }

    this.enterFallback(
      `${this.service} did not recover after ${this.replacementAttempts} replacement attempt(s); ${this.fallback} and probing periodically`,
    );
  }

  private async inspect(): Promise<ServerInspection> {
    try {
      const result = await this.exclusive(
        (signal) => this.inspectUnlocked(signal),
        this.lifecycle.signal,
      );
      return result ?? "deferred";
    } catch (error) {
      if (!this.stopped()) this.log(`${this.service} probe deferred: ${String(error)}`);
      return "deferred";
    }
  }

  /** Probe while the caller already owns the server lane. Never nest exclusive(). */
  private async inspectUnlocked(signal: AbortSignal): Promise<ServerInspection> {
    try {
      const present = await requireUncancelledProbe(
        this.options.probePresence(signal),
        signal,
        `${this.service} presence probe`,
      );
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
      const ready = await requireUncancelledProbe(
        this.options.probeReady(signal),
        signal,
        `${this.service} readiness probe`,
      );
      if (this.stopped()) return "deferred";
      if (!ready) return "unready";

      // A retired owned process can recover or ignore termination. A successful
      // canary proves health, not foreign ownership, so restore its supervision.
      if (!this.child && this.retiringChild && this.ownership === "owned") {
        this.restoreRetiringChild();
      }
      this.markReady(
        this.ownership === "owned"
          ? `owned ${this.service} is ${this.readiness} again`
          : `adopted ${this.service} is ${this.readiness} again`,
      );
      return "ready";
    } catch (error) {
      if (!this.stopped()) this.log(`${this.service} probe deferred: ${String(error)}`);
      return "deferred";
    }
  }

  private async probeCurrentChild(child: WatchdogProcess, message: string): Promise<boolean> {
    try {
      const ready = await this.exclusive(async (signal) => {
        if (this.child !== child || this.ownership !== "owned") return false;
        return requireUncancelledProbe(
          this.options.probeReady(signal),
          signal,
          `${this.service} child canary`,
        );
      }, this.lifecycle.signal);
      if (this.stopped() || !ready || this.child !== child) return false;
      this.markReady(message);
      return true;
    } catch (error) {
      if (!this.stopped()) this.log(`${this.service} child canary deferred: ${String(error)}`);
      throw error;
    }
  }

  private spawnOwned(): WatchdogProcess {
    if (this.retiringChild) {
      throw new Error(`cannot spawn ${this.service} while a known-owned listener is retiring`);
    }
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
    this.log(`owned ${this.service} exited (${String(code)})`);
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
    this.log(`retiring owned ${this.service} exited (${String(code)})`);
    // Expected exits are absorbed by an in-flight bounded burst. A fallback
    // remains periodic-only, preventing exit/restart storms after exhaustion.
    if (!this.recovery && this.status === "ready") this.requestRecovery("child-exit");
  }

  private async terminateChild(child: WatchdogProcess, signal: AbortSignal): Promise<void> {
    try { child.kill(); } catch {}
    await awaitProcessWithWatchdog(child, {
      operation: `${this.service} shutdown`,
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

  private deferRecovery(reason: ServerRecoveryReason<RequestReason>): void {
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
