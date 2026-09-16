import { RecordsClient, type RecordsIngestionOptions, type RecordsPriorityHints } from "./records-client.ts";
import type { StoredPromptCursor } from "./records-store.ts";
import type { RecordReceipt } from "./records-types.ts";
import { historyError, historyOff, validateHistoryRequest, validateHistoryResponse,
  type HistoryItemRequest, type HistoryPageRequest, type HistoryRequest, type HistoryResponse } from "./history.ts";

export interface RecordsRuntimeClient {
  startIngestion(options: RecordsIngestionOptions): Promise<void>;
  prioritize(hints: RecordsPriorityHints): Promise<void>;
  appendReceipt(receipt: RecordReceipt): Promise<boolean>;
  putPromptCursor(cursor: StoredPromptCursor): Promise<void>;
  historyPage(request: HistoryPageRequest, ownerDeviceId: string): Promise<HistoryResponse>;
  historyItem(request: HistoryItemRequest, ownerDeviceId: string): Promise<HistoryResponse>;
  close(): Promise<void>;
  terminate(): Promise<void>;
  /** True once this worker generation has gone: every later request rejects. */
  readonly failed?: boolean;
}

export interface RecordsRuntimeOptions {
  configDir: string;
  ownerDeviceId: string;
  claudeHome?: string;
  codexHome?: string;
  onError?: (message: string) => void;
  open?: (options: { configDir: string; signal?: AbortSignal }) => Promise<RecordsRuntimeClient>;
  receiptLimit?: number;
  closeTimeoutMs?: number;
}

interface QueuedReceipt {
  receipt: RecordReceipt;
  resolve(value: boolean): void;
}

/** A passive coordinator: constructing it does not open a worker, file, or timer. */
export class RecordsRuntime {
  private enabled = false;
  private closed = false;
  private shutdownExpired = false;
  private startupFailed = false;
  private ingesting = false;
  private client?: RecordsRuntimeClient;
  private opening?: AbortController;
  private stateVersion = 0;
  private transitions: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private hints: RecordsPriorityHints = { live: [] };
  private hintsVersion = 0;
  private hintsSent = -1;
  private hintFlight?: Promise<void>;
  private receiptFlight?: Promise<void>;
  private cursorFlight?: Promise<void>;
  private activeReceipt?: QueuedReceipt;
  private receipts: QueuedReceipt[] = [];
  private historyRequests = 0;
  private restarts = 0;
  private terminated = new WeakSet<RecordsRuntimeClient>();
  /** ponytail: three replacements, then it waits for an explicit enable. Raise it only if
   *  a real crash loop is ever observed recovering on the fourth try. */
  private static readonly restartLimit = 3;
  private readonly receiptLimit: number;
  private readonly closeTimeoutMs: number;

  constructor(private readonly options: RecordsRuntimeOptions) {
    this.receiptLimit = options.receiptLimit ?? 256;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.receiptLimit) || this.receiptLimit < 1
      || !Number.isFinite(this.closeTimeoutMs) || this.closeTimeoutMs < 1) {
      throw new Error("invalid record runtime limits");
    }
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.closed) return this.closing ?? Promise.resolve();
    if (this.enabled === enabled) {
      // Enabling an already-enabled store is the explicit retry: a worker that died after
      // running comes back without restarting the daemon. A startup that never worked is
      // deliberately not retried here — that failure repeats, and repeating it costs a
      // worker every time.
      if (enabled && !this.client && !this.opening && !this.startupFailed) {
        this.restarts = 0;
        this.transitions = this.restart(this.stateVersion);
      }
      return this.transitions;
    }
    this.enabled = enabled;
    const version = ++this.stateVersion;
    this.startupFailed = false;
    if (!enabled && !this.receipts.length && !this.activeReceipt) this.opening?.abort();
    this.transitions = this.transitions.then(async () => {
      if (version !== this.stateVersion) return;
      if (!this.enabled || this.closed) await this.stopClient();
      else if (!this.client) await this.startClient();
    }).catch(() => { this.report("record runtime transition failed"); });
    if (!enabled) this.transitions = this.closeWithDeadline(this.transitions, this.client,
      () => version === this.stateVersion && !this.enabled);
    return this.transitions;
  }

  prioritize(hints: RecordsPriorityHints): void {
    if (this.closed) return;
    const live = hints.live.slice(0, 256);
    const selected = hints.selected && hints.live.find((item) => item.provider === hints.selected!.provider
      && item.nativeId === hints.selected!.nativeId);
    if (selected && !live.includes(selected)) { live.pop(); live.unshift(selected); }
    // Retain routing metadata only, never a caller's mutable snapshot or message content.
    this.hints = {
      ...(hints.selected ? { selected: { provider: hints.selected.provider, nativeId: hints.selected.nativeId } } : {}),
      live: live.map((item) => ({
        provider: item.provider, nativeId: item.nativeId,
        ...(item.path === undefined ? {} : { path: item.path }),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        ...(item.parentNativeId === undefined ? {} : { parentNativeId: item.parentNativeId }),
      })),
    };
    this.hintsVersion++;
    this.pumpHints();
  }

  appendReceipt(receipt: RecordReceipt): Promise<boolean> {
    if (!this.enabled || this.closed || this.startupFailed) return Promise.resolve(false);
    if (this.receipts.length + Number(Boolean(this.activeReceipt)) >= this.receiptLimit) {
      this.report("record receipt queue is full; receipt was not queued");
      return Promise.resolve(false);
    }
    const safe: RecordReceipt = {
      id: receipt.id, sessionId: receipt.sessionId, actionId: receipt.actionId,
      kind: receipt.kind, state: receipt.state, observedAt: receipt.observedAt,
      ...(receipt.attemptId === undefined ? {} : { attemptId: receipt.attemptId }),
      ...(receipt.turnId === undefined ? {} : { turnId: receipt.turnId }),
      ...(receipt.itemId === undefined ? {} : { itemId: receipt.itemId }),
      ...(receipt.details ? { details: {
        ...(receipt.details.code === undefined ? {} : { code: receipt.details.code }),
        ...(receipt.details.reviewId === undefined ? {} : { reviewId: receipt.details.reviewId }),
        ...(receipt.details.surfaceRef === undefined ? {} : { surfaceRef: receipt.details.surfaceRef }),
        ...(receipt.details.characterCount === undefined ? {} : { characterCount: receipt.details.characterCount }),
      } } : {}),
    };
    return new Promise((resolve) => {
      this.receipts.push({ receipt: safe, resolve });
      this.pumpReceipts();
    });
  }

  /**
   * Commit a prompt-count cursor for the next hook process.
   *
   * Fire-and-forget and single-flight: this is a cache in front of a scan, so a
   * cursor dropped because a write is already in the air, or because indexing
   * is not running, costs the next hook bytes and nothing else. It never queues
   * and never makes a caller wait.
   */
  putPromptCursor(cursor: StoredPromptCursor): void {
    const client = this.client;
    if (!this.enabled || this.closed || !this.ingesting || !client || this.cursorFlight) return;
    const flight = client.putPromptCursor(cursor)
      .catch(() => { this.report("prompt cursor could not be stored"); this.detach(client); })
      .finally(() => { if (this.cursorFlight === flight) this.cursorFlight = undefined; });
    this.cursorFlight = flight;
  }

  historyPage(request: HistoryPageRequest): Promise<HistoryResponse> {
    return this.readHistory({ ...request, kind: "history-page" });
  }

  historyItem(request: HistoryItemRequest): Promise<HistoryResponse> {
    return this.readHistory({ ...request, kind: "history-item" });
  }

  private async readHistory(request: HistoryRequest): Promise<HistoryResponse> {
    if (!this.enabled || this.closed) return historyOff();
    const parsed = validateHistoryRequest(request);
    if (!parsed.ok) return historyError("invalid-request", parsed.err);
    const client = this.client;
    if (!client || !this.ingesting) return historyError("unavailable", "history worker is unavailable");
    // Readers cannot grow the worker's RPC queue without bound during a long backfill.
    if (this.historyRequests >= 8) return historyError("busy", "history has too many pending reads; retry shortly");
    this.historyRequests++;
    try {
      const { kind, ...query } = parsed.value;
      const response = kind === "history-page"
        ? await client.historyPage(query as HistoryPageRequest, this.options.ownerDeviceId)
        : await client.historyItem(query as HistoryItemRequest, this.options.ownerDeviceId);
      if (!this.enabled || this.closed) return historyOff();
      if (this.client !== client) return historyError("unavailable", "history worker changed; retry the read");
      const checked = validateHistoryResponse(response);
      if (checked.ok && checked.value.kind !== kind && checked.value.kind !== "history-error" && checked.value.kind !== "history-off") {
        return historyError("unavailable", "history response did not match the request");
      }
      return checked.ok ? checked.value : historyError("response-too-large", "history worker returned an invalid or oversized response");
    } catch {
      this.detach(client);
      return !this.enabled || this.closed ? historyOff() : historyError("unavailable", "history read failed");
    } finally { this.historyRequests--; }
  }

  private report(message: string): void {
    try { this.options.onError?.(message); } catch { /* Diagnostics cannot break the daemon's controls. */ }
  }

  /** Open a replacement, if this state still wants one by the time the queue reaches it. */
  private restart(version: number): Promise<void> {
    return this.transitions.then(async () => {
      if (version !== this.stateVersion || !this.enabled || this.closed || this.client) return;
      await this.startClient();
    }).catch(() => { this.report("record runtime transition failed"); });
  }

  /**
   * Let go of a worker generation that has exited.
   *
   * One crash used to poison the store for the life of the daemon: the client rejected
   * every later request and the runtime went on holding it, so history, receipts and
   * indexing were all off until conch was restarted. Replacement is bounded — a worker
   * that dies four times running is not one a fifth attempt fixes — and an explicit
   * enable clears the budget.
   *
   * Receipts queued against the dead generation resolve false, which is the runtime's
   * existing word for "not known to be stored". They are idempotent by id, so a caller
   * that observes that and writes again cannot duplicate one.
   */
  private detach(client: RecordsRuntimeClient): void {
    if (this.client !== client || client.failed !== true || this.closed) return;
    this.client = undefined;
    this.ingesting = false;
    this.hintFlight = undefined;
    this.receiptFlight = undefined;
    this.hintsSent = -1;
    this.failReceipts();
    this.report("record worker exited");
    if (!this.enabled || this.restarts >= RecordsRuntime.restartLimit) return;
    this.restarts++;
    this.transitions = this.restart(this.stateVersion);
  }

  private async startClient(): Promise<void> {
    const controller = new AbortController();
    this.opening = controller;
    let client: RecordsRuntimeClient;
    let abandoned = false;
    let cancel!: () => void;
    try {
      const pending = (this.options.open ?? RecordsClient.open)({ configDir: this.options.configDir, signal: controller.signal });
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => { abandoned = true; reject(new Error("record worker startup cancelled")); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
      });
      // An opener may finish after cancellation. It never owns a replacement client's state.
      void pending.then((late) => {
        if (abandoned) void this.closeWithDeadline(late.close(), late);
      }, () => {});
      client = await Promise.race([pending, cancelled]);
    } catch {
      if (!controller.signal.aborted) this.report("record worker could not start");
      this.startupFailed = true;
      this.failReceipts();
      return;
    } finally {
      if (cancel) controller.signal.removeEventListener("abort", cancel);
      if (this.opening === controller) this.opening = undefined;
    }
    if (this.closed && this.shutdownExpired) {
      await this.closeWithDeadline(client.close(), client);
      return;
    }
    this.client = client;
    this.hintsSent = -1;
    this.pumpReceipts();
    if (!this.enabled || this.closed) return this.stopClient();
    try {
      await client.startIngestion({
        ownerDeviceId: this.options.ownerDeviceId,
        ...(this.options.claudeHome === undefined ? {} : { claudeHome: this.options.claudeHome }),
        ...(this.options.codexHome === undefined ? {} : { codexHome: this.options.codexHome }),
      });
    } catch {
      if (this.client !== client) return;
      this.report("record ingestion could not start");
      this.startupFailed = true;
      await this.stopClient();
      return;
    }
    if (this.client !== client) return;
    this.ingesting = true;
    if (!this.enabled || this.closed) await this.stopClient();
    else this.pumpHints();
  }

  private pumpHints(): void {
    const client = this.client;
    if (!client || !this.ingesting || !this.enabled || this.closed || this.hintFlight || this.hintsSent === this.hintsVersion) return;
    let flight: Promise<void>;
    let failed = false;
    flight = (async () => {
      while (this.client === client && this.ingesting && this.enabled && !this.closed && this.hintsSent !== this.hintsVersion) {
        const version = this.hintsVersion;
        await client.prioritize(this.hints);
        if (this.client !== client) return;
        this.hintsSent = version;
      }
    })().catch(() => {
      failed = true;
      this.report("record source priorities could not be updated");
      this.detach(client);
    }).finally(() => {
      if (this.hintFlight === flight) {
        this.hintFlight = undefined;
        if (!failed) this.pumpHints();
      }
    });
    this.hintFlight = flight;
  }

  private pumpReceipts(): void {
    const client = this.client;
    if (!client || this.receiptFlight || !this.receipts.length) return;
    let flight: Promise<void>;
    flight = (async () => {
      while (this.client === client && this.receipts.length) {
        const pending = this.receipts.shift()!;
        this.activeReceipt = pending;
        try {
          pending.resolve(await client.appendReceipt(pending.receipt));
        } catch {
          pending.resolve(false);
          this.report("record receipt could not be stored");
          if (this.client === client) this.failReceipts();
          this.detach(client);
          break;
        } finally {
          if (this.activeReceipt === pending) this.activeReceipt = undefined;
        }
      }
    })().finally(() => {
      if (this.receiptFlight === flight) {
        this.receiptFlight = undefined;
        this.pumpReceipts();
      }
    });
    this.receiptFlight = flight;
  }

  private failReceipts(): void {
    this.activeReceipt?.resolve(false);
    for (const pending of this.receipts.splice(0)) pending.resolve(false);
  }

  private async stopClient(): Promise<void> {
    const client = this.client;
    if (!client) {
      if (!this.opening) this.failReceipts();
      return;
    }
    this.ingesting = false;
    const graceful = (async () => {
      while (this.client === client && (this.receipts.length || this.receiptFlight)) {
        this.pumpReceipts();
        await this.receiptFlight;
      }
      await this.hintFlight;
      await client.close();
    })();
    await this.closeWithDeadline(graceful, client);
    if (this.client === client) {
      this.client = undefined;
      this.ingesting = false;
    }
  }

  private async closeWithDeadline(work: Promise<void>, client?: RecordsRuntimeClient, current: () => boolean = () => true): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("record close timeout");
    try {
      const outcome = await Promise.race([
        work,
        new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), this.closeTimeoutMs); }),
      ]);
      if (outcome !== timedOut) return;
      if (!current()) return;
      this.report("record shutdown timed out; pending receipt outcomes are unknown");
    } catch {
      if (!current()) return;
      this.report("record worker could not close cleanly");
    } finally {
      clearTimeout(timer);
    }
    const terminating = client ?? this.client;
    if (!client || this.client === client) {
      if (this.closed) this.shutdownExpired = true;
      this.opening?.abort();
      this.failReceipts();
      this.client = undefined;
      this.ingesting = false;
      this.activeReceipt = undefined;
      this.receiptFlight = undefined;
      this.hintFlight = undefined;
    }
    if (terminating && !this.terminated.has(terminating)) {
      this.terminated.add(terminating);
      void terminating.terminate().catch(() => { this.report("record worker termination failed"); });
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.enabled = false;
    this.stateVersion++;
    if (!this.receipts.length && !this.activeReceipt) this.opening?.abort();
    const graceful = this.transitions.then(() => this.stopClient());
    this.closing = this.closeWithDeadline(graceful, this.client);
    return this.closing;
  }
}
