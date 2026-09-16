import { Worker } from "node:worker_threads";
import { conchHome } from "./home.ts";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { RecordStore } from "./records-store.ts";
import type { RecordsIndexerOptions, RecordsIndexerStatus, RecordsPriorityHints } from "./records-indexer.ts";

export type RecordsIngestionOptions = RecordsIndexerOptions;
export type { RecordsPriorityHints, RecordsIndexerStatus } from "./records-indexer.ts";
type StoreMethod = "ingest" | "source" | "appendReceipt" | "receipts" | "reindex" | "counts" | "historyPage" | "historyItem" | "putPromptCursor" | "close";
type RecordOperations = Pick<RecordStore, StoreMethod> & {
  startIngestion(options: RecordsIngestionOptions): void;
  prioritize(hints: RecordsPriorityHints): void;
  ingestionStatus(): RecordsIndexerStatus | undefined;
};
type RecordMethod = keyof RecordOperations;
type RecordArguments<K extends RecordMethod> = K extends "ingest"
  ? [Parameters<RecordStore["ingest"]>[0]] : Parameters<RecordOperations[K]>;
export type RecordsRequest = {
  [K in RecordMethod]: { id: number; method: K; args: RecordArguments<K> }
}[RecordMethod];
export type RecordsReply =
  | { kind: "ready" }
  | { kind: "fatal"; error: string }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: string };

/** SQLite and normalization stay on one worker; callers never send SQL. */
export class RecordsClient {
  private nextId = 1;
  private closing?: Promise<void>;
  private failure?: Error;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private ready: Promise<void>;
  private worker: Worker;
  private termination?: Promise<void>;

  private constructor(configDir: string) {
    this.worker = new Worker(new URL("./records-worker.ts", import.meta.url), { workerData: { configDir } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.on("message", (reply: RecordsReply) => {
        if (reply.kind === "ready") return resolve();
        if (reply.kind === "fatal") {
          const error = new Error(reply.error);
          this.fail(error);
          reject(error);
          return;
        }
        const request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        if (reply.kind === "error") request.reject(new Error(reply.error));
        else request.resolve(reply.value);
      });
      this.worker.on("error", (error: Error) => {
        this.fail(error);
        reject(error);
      });
      this.worker.on("exit", (code) => {
        const error = new Error(`record worker exited (${code})`);
        this.fail(error);
        reject(error);
      });
    });
  }

  static async open(options: { configDir: string; signal?: AbortSignal }): Promise<RecordsClient> {
    if (options.signal?.aborted) throw new Error("record worker startup cancelled");
    const client = new RecordsClient(options.configDir);
    const abort = () => { void client.terminate().catch(() => {}); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await client.ready;
      if (options.signal?.aborted) throw new Error("record worker startup cancelled");
      return client;
    } catch (error) {
      await client.terminate();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }

  private request<K extends RecordMethod>(method: K, ...args: RecordArguments<K>): Promise<ReturnType<RecordOperations[K]>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && method !== "close") return Promise.reject(new Error("record store is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as ReturnType<RecordOperations[K]>), reject });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  ingest(input: Parameters<RecordStore["ingest"]>[0]) { return this.request("ingest", input); }
  source(...args: Parameters<RecordStore["source"]>) { return this.request("source", ...args); }
  appendReceipt(...args: Parameters<RecordStore["appendReceipt"]>) { return this.request("appendReceipt", ...args); }
  receipts(...args: Parameters<RecordStore["receipts"]>) { return this.request("receipts", ...args); }
  reindex(...args: Parameters<RecordStore["reindex"]>) { return this.request("reindex", ...args); }
  counts() { return this.request("counts"); }
  putPromptCursor(...args: Parameters<RecordStore["putPromptCursor"]>) { return this.request("putPromptCursor", ...args); }
  historyPage(...args: Parameters<RecordStore["historyPage"]>) { return this.request("historyPage", ...args); }
  historyItem(...args: Parameters<RecordStore["historyItem"]>) { return this.request("historyItem", ...args); }
  startIngestion(options: RecordsIngestionOptions) { return this.request("startIngestion", options); }
  prioritize(hints: RecordsPriorityHints) { return this.request("prioritize", hints); }
  ingestionStatus() { return this.request("ingestionStatus"); }

  terminate(): Promise<void> {
    this.fail(new Error("record worker terminated"));
    this.termination ??= this.worker.terminate().then(() => {});
    return this.termination;
  }

  close(): Promise<void> {
    // Messages are FIFO: earlier writes finish before SQLite closes.
    this.closing ??= this.request("close").finally(async () => { await this.terminate(); });
    return this.closing;
  }
}

export async function openRecordsIfEnabled(
  config: Pick<Config, "recordsEnabled">,
  options: { configDir?: string } = {},
): Promise<RecordsClient | null> {
  if (!config.recordsEnabled) return null;
  const configDir = options.configDir ?? process.env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch");
  return RecordsClient.open({ configDir });
}
