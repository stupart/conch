/**
 * One mutual-exclusion lane for authoritative and preview transcription.
 * Final jobs always queue. A preview may enter only when its caller's final
 * worker is idle and this lane is empty; once admitted, a later final waits.
 */
export class TranscriptionGate {
  readonly #finalWorkerIdle: () => boolean;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(finalWorkerIdle: () => boolean) {
    this.#finalWorkerIdle = finalWorkerIdle;
  }

  runFinal<T>(task: () => Promise<T>): Promise<T> {
    return this.#enqueue(task);
  }

  tryRunPartial<T>(task: () => Promise<T>): Promise<T> | undefined {
    if (!this.#finalWorkerIdle() || this.#pending > 0) return undefined;
    return this.#enqueue(task);
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.#pending++;
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => {
        this.#pending--;
      },
      () => {
        this.#pending--;
      },
    );
    return run;
  }
}
