export interface SessionReconcilerOptions<T> {
  read(): Promise<T>;
  reconcile(snapshot: T): void;
  render(snapshot: T, current: () => boolean): Promise<void>;
  onError(error: unknown): void;
}

/** One registry read at a time; newer requests invalidate it and share one trailing read. */
export class SessionReconciler<T> {
  #version = 0;
  #running: Promise<void> | undefined;
  #closed = false;
  constructor(private readonly options: SessionReconcilerOptions<T>) {}

  /** Accept and invalidate together, before the daemon applies the newer event. */
  accept<E>(order: { accept(event: E): boolean }, event: E): boolean {
    if (!order.accept(event)) return false;
    void this.request();
    return true;
  }

  request(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#version++;
    return this.#running ??= Promise.resolve().then(async () => {
      try {
        while (!this.#closed) {
          const version = this.#version;
          const current = () => !this.#closed && version === this.#version;
          try {
            const snapshot = await this.options.read();
            // A hook may have changed the ledger while discovery awaited I/O.
            if (current()) {
              this.options.reconcile(snapshot);
              await this.options.render(snapshot, current);
            }
          } catch (error) {
            this.options.onError(error);
          }
          if (version === this.#version) break;
        }
      } finally {
        this.#running = undefined;
      }
    });
  }

  close(): void {
    this.#closed = true;
    this.#version++;
  }
}
