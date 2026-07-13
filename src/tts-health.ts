export type TtsHealthStatus = "starting" | "ready" | "recovering" | "down";

/** A request token. The epoch prevents a dead child's late result from healing its replacement. */
export interface TtsHealthToken {
  epoch: number;
  generation: number;
}

export interface TtsHealthSnapshot {
  status: TtsHealthStatus;
  epoch: number;
  generation: number;
  appliedGeneration: number;
  consecutiveTransportFailures: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastTransportFailureAt: number | null;
}

/**
 * Generation-ordered TTS health. Only transport failures count toward `down`;
 * HTTP and inference failures prove the server was reachable. A reset advances
 * the epoch, making every result from the previous server instance stale.
 */
export class TtsHealthMachine {
  private status: TtsHealthStatus = "starting";
  private epoch = 0;
  private generation = 0;
  private appliedGeneration = 0;
  private consecutiveTransportFailures = 0;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastTransportFailureAt: number | null = null;

  constructor(
    private readonly downAfter = 2,
    private readonly now: () => number = () => performance.now(),
  ) {}

  beginAttempt(): TtsHealthToken {
    this.generation++;
    this.lastAttemptAt = this.now();
    return { epoch: this.epoch, generation: this.generation };
  }

  recordSuccess(token: TtsHealthToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.appliedGeneration = token.generation;
    this.consecutiveTransportFailures = 0;
    this.lastSuccessAt = this.now();
    this.status = "ready";
    return true;
  }

  /** Record headers/body-level evidence without claiming synthesis succeeded. */
  recordReachable(token: TtsHealthToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.appliedGeneration = token.generation;
    this.consecutiveTransportFailures = 0;
    if (this.status !== "ready") this.status = "recovering";
    return true;
  }

  recordTransportFailure(token: TtsHealthToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.appliedGeneration = token.generation;
    this.consecutiveTransportFailures++;
    this.lastTransportFailureAt = this.now();
    this.status = this.consecutiveTransportFailures >= this.downAfter ? "down" : "recovering";
    return true;
  }

  reset(): void {
    this.epoch++;
    this.generation = 0;
    this.appliedGeneration = 0;
    this.consecutiveTransportFailures = 0;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastTransportFailureAt = null;
    this.status = "starting";
  }

  snapshot(): TtsHealthSnapshot {
    return {
      status: this.status,
      epoch: this.epoch,
      generation: this.generation,
      appliedGeneration: this.appliedGeneration,
      consecutiveTransportFailures: this.consecutiveTransportFailures,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastTransportFailureAt: this.lastTransportFailureAt,
    };
  }

  private isCurrent(token: TtsHealthToken): boolean {
    return token.epoch === this.epoch && token.generation > this.appliedGeneration;
  }
}
