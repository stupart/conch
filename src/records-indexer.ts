import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { RecordsDiscovery, recordsCandidate, recordsRoots, type RecordsCandidate } from "./records-discovery.ts";
import { inspectRecordSource, SOURCE_PROBE_BYTES } from "./records-source.ts";
import { recordKey, type RecordProvider, type RecordSession } from "./records-types.ts";
import type { RecordStore } from "./records-store.ts";

export interface RecordsIndexerOptions {
  ownerDeviceId: string;
  claudeHome?: string;
  codexHome?: string;
  batchBytes?: number;
  batchLines?: number;
  maxRecordBytes?: number;
  pollMs?: number;
  reconcileMs?: number;
}
interface SessionReference { provider: RecordProvider; nativeId: string }
export interface RecordsPriorityHints {
  selected?: SessionReference;
  live: (SessionReference & { path?: string; cwd?: string; parentNativeId?: string })[];
}
export interface RecordsIndexerStatus {
  running: boolean; queued: number; bufferedBytes: number; ticks: number;
  bytesRead: number; linesIndexed: number; filesVisited: number; discoveryErrors: number;
  lastError?: string;
}
interface Job { id: string; session: RecordSession; path: string; device: string; inode: string }
interface Buffered { id: string; from: number; bytes: Buffer; size: number; modifiedMs: number }
const referenceKey = (ref: SessionReference) => recordKey(ref.provider, ref.nativeId);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "record-index-error";

/** The worker owns this scheduler. Neither construction nor hints start a scan. */
export class RecordsIndexer {
  private discovery: RecordsDiscovery;
  private jobs = new Map<string, Job>();
  private polling = new Map<string, { job: Job; at: number }>();
  private hints: RecordsPriorityHints = { live: [] };
  private live = new Set<string>();
  private livePaths: RecordsPriorityHints["live"] = [];
  private recovery: { sessionId?: string; after?: string }[] = [{}];
  private buffered?: Buffered;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private nextReconcile = 0;
  private foregroundBatches = 0;
  private counters = { ticks: 0, bytesRead: 0, linesIndexed: 0, filesVisited: 0, discoveryErrors: 0 };
  private lastError?: string;
  private readonly batchBytes: number;
  private readonly batchLines: number;
  private readonly maxRecordBytes: number;
  private readonly pollMs: number;
  private readonly reconcileMs: number;

  constructor(private store: RecordStore, private options: RecordsIndexerOptions) {
    this.batchBytes = options.batchBytes ?? 256 * 1024;
    this.batchLines = options.batchLines ?? 256;
    this.maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
    this.pollMs = options.pollMs ?? 1000;
    this.reconcileMs = options.reconcileMs ?? 30_000;
    if (!options.ownerDeviceId || ![this.batchBytes, this.batchLines, this.maxRecordBytes, this.pollMs, this.reconcileMs]
      .every((value) => Number.isSafeInteger(value) && value > 0)
      || this.batchBytes <= SOURCE_PROBE_BYTES * 2 || this.maxRecordBytes < this.batchBytes) {
      throw new Error("invalid record indexer limits");
    }
    this.discovery = new RecordsDiscovery(recordsRoots(options));
    this.nextReconcile = Date.now() + this.reconcileMs;
  }

  start(): void {
    if (this.running) return;
    if (this.discovery.done) { this.discovery.reset(); this.recovery = [{}]; }
    this.running = true;
    this.schedule(0);
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      try { await this.tick(); } catch (error) { this.lastError = errorCode(error); }
      if (this.running) this.schedule(this.jobs.size || !this.discovery.done || this.recovery.length ? 0 : this.pollMs);
    }, delay);
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flight;
    this.discovery.close();
    this.jobs.clear();
    this.polling.clear();
    this.buffered = undefined;
  }
  prioritize(hints: RecordsPriorityHints): void {
    this.hints = { ...hints, live: hints.live.slice(0, 256) };
    this.live = new Set(this.hints.live.map(referenceKey));
    const selected = hints.selected && referenceKey(hints.selected);
    this.livePaths = this.hints.live.filter((hint) => hint.path)
      .sort((a, b) => Number(referenceKey(b) === selected) - Number(referenceKey(a) === selected));
    if (hints.selected) {
      const sessionId = recordKey(this.options.ownerDeviceId, hints.selected.provider, hints.selected.nativeId);
      if (!this.recovery.some((entry) => entry.sessionId === sessionId)) this.recovery.unshift({ sessionId });
    }
  }
  status(): RecordsIndexerStatus {
    return { running: this.running, queued: this.jobs.size, bufferedBytes: this.buffered?.bytes.length ?? 0,
      ...this.counters, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  tick(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = Promise.resolve().then(() => this.step()).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private priority(job: Job): number {
    const key = referenceKey(job.session);
    return this.hints.selected && referenceKey(this.hints.selected) === key ? 0 : this.live.has(key) ? 1 : 2;
  }
  private enqueue(job: Job): void {
    if (this.jobs.size >= 256 && !this.jobs.has(job.id)) {
      const displaced = [...this.jobs.values()].find((entry) => this.priority(entry) > this.priority(job));
      if (!displaced) return;
      this.jobs.delete(displaced.id);
    }
    this.jobs.set(job.id, job);
  }
  private register(candidate: RecordsCandidate, cwd?: string): void {
    const session: RecordSession = {
      id: recordKey(this.options.ownerDeviceId, candidate.provider, candidate.nativeId),
      ownerDeviceId: this.options.ownerDeviceId, provider: candidate.provider, nativeId: candidate.nativeId,
      ...(candidate.parentNativeId ? { parentNativeId: candidate.parentNativeId } : {}), ...(cwd ? { cwd } : {}),
    };
    const id = recordKey(session.id, "source", candidate.device, candidate.inode);
    this.store.registerSource(session, { id, path: candidate.path, device: candidate.device, inode: candidate.inode });
    this.enqueue({ id, session, path: candidate.path, device: candidate.device, inode: candidate.inode });
  }
  private refill(): void {
    for (const [id, entry] of this.polling) {
      if (this.priority(entry.job) === 2) this.polling.delete(id);
      else if (entry.at <= Date.now()) { this.polling.delete(id); this.enqueue(entry.job); }
    }
    const hint = this.livePaths.shift();
    if (hint?.path) {
      for (const root of this.discovery.roots) {
        if (root.provider !== hint.provider) continue;
        try {
          const candidate = recordsCandidate(root, hint.path);
          if (candidate?.nativeId === hint.nativeId) { this.register(candidate, hint.cwd); break; }
        } catch { this.counters.discoveryErrors++; }
      }
    }
    if (this.jobs.size >= 224 && !this.recovery[0]?.sessionId) return;
    const recovery = this.recovery[0];
    if (recovery) {
      const page = this.store.sourcePage({ ...recovery, limit: 32 });
      for (const { source, session } of page) this.enqueue({
        id: source.id, session, path: source.path, device: source.device, inode: source.inode,
      });
      if (page.length < 32) this.recovery.shift();
      else recovery.after = page.at(-1)!.source.id;
    }
    if (this.jobs.size >= 224) return;
    const discovered = this.discovery.next();
    this.counters.filesVisited += discovered.entries;
    this.counters.discoveryErrors += discovered.errors;
    if (discovered.candidate) this.register(discovered.candidate);
  }
  private step(): void {
    this.counters.ticks++;
    if (Date.now() >= this.nextReconcile && this.discovery.done && !this.recovery.length) {
      this.nextReconcile = Date.now() + this.reconcileMs;
      this.discovery.reset();
      this.recovery.push({});
    }
    this.refill();
    const ordered = [...this.jobs.values()].sort((a, b) => this.priority(a) - this.priority(b));
    const continuation = this.buffered && this.jobs.get(this.buffered.id);
    // Finish one bounded large record before aging changes the buffer owner. A newly
    // selected/live source can still preempt a lower-priority partial record.
    const background = !continuation && this.foregroundBatches >= 8 ? ordered.find((job) => this.priority(job) === 2) : undefined;
    const job = continuation && (!ordered[0] || this.priority(continuation) <= this.priority(ordered[0]))
      ? continuation : background ?? ordered[0];
    if (!job) return;
    this.jobs.delete(job.id);
    this.foregroundBatches = this.priority(job) < 2 ? this.foregroundBatches + 1 : 0;
    this.read(job);
  }
  private read(job: Job): void {
    let fd: number | undefined;
    try {
      const root = this.discovery.roots.find((entry) => entry.provider === job.session.provider
        && recordsCandidate(entry, job.path)?.nativeId === job.session.nativeId);
      if (!root) {
        this.store.setCoverage(job.id, { status: "error", error: "source-outside-roots" });
        if (this.buffered?.id === job.id) this.buffered = undefined;
        return;
      }
      fd = openSync(job.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const observed = fstatSync(fd);
      if (!observed.isFile() || String(observed.dev) !== job.device || String(observed.ino) !== job.inode) {
        if (this.buffered?.id === job.id) this.buffered = undefined;
        this.store.setCoverage(job.id, { status: "missing", error: "source-identity-changed" });
        if (this.discovery.done) this.discovery.reset();
        return;
      }
      const previous = this.store.source(job.id)!;
      const range = (offset: number, length: number): Buffer => {
        const bytes = Buffer.alloc(length);
        const count = readSync(fd!, bytes, 0, length, offset);
        this.counters.bytesRead += count;
        return bytes.subarray(0, count);
      };
      const prefix = range(0, Math.min(SOURCE_PROBE_BYTES, observed.size));
      const checkpointLength = Math.min(SOURCE_PROBE_BYTES, previous.offset, observed.size);
      const checkpoint = range(Math.max(0, previous.offset - checkpointLength), checkpointLength);
      const source = {
        id: job.id, expected: { generation: previous.generation, offset: previous.offset },
        path: job.path, device: job.device, inode: job.inode, size: observed.size, modifiedMs: observed.mtimeMs,
        prefix, checkpoint, from: previous.offset, bytes: new Uint8Array(),
      };
      const plan = inspectRecordSource(previous, source);
      const pending = plan.change === "append" && this.buffered?.id === job.id && this.buffered.from === plan.from
        && observed.size >= this.buffered.from + this.buffered.bytes.length
        && (observed.size > this.buffered.size || observed.mtimeMs === this.buffered.modifiedMs)
        && (this.buffered.from !== 0 || prefix.subarray(0, Math.min(prefix.length, this.buffered.bytes.length))
          .equals(this.buffered.bytes.subarray(0, Math.min(prefix.length, this.buffered.bytes.length))))
        ? this.buffered.bytes : Buffer.alloc(0);
      const from = plan.from + pending.length;
      const wanted = Math.max(0, Math.min(this.batchBytes - prefix.length - checkpoint.length,
        observed.size - from, this.maxRecordBytes - pending.length));
      const bytes = Buffer.concat([pending, range(from, wanted)]);
      const after = fstatSync(fd);
      if (after.size < observed.size || (after.size === observed.size && after.mtimeMs !== observed.mtimeMs)) {
        if (this.buffered?.id === job.id) this.buffered = undefined;
        this.store.setCoverage(job.id, { status: "queued", error: "source-changed-during-read" });
        this.enqueue(job);
        return;
      }
      let boundary = 0;
      let lines = 0;
      for (let index = 0; index < bytes.length && lines < this.batchLines; index++) {
        if (bytes[index] === 10) { boundary = index + 1; lines++; }
      }
      if (!boundary && bytes.length) {
        if (plan.change === "rewrite") {
          // Invalidate stale records now, even when the replacement has no complete line.
          this.store.ingest({ session: job.session, source: { ...source, from: 0, bytes: new Uint8Array() } });
          this.recovery.unshift({ sessionId: job.session.id });
        }
        // Partial envelopes exist only in this bounded worker buffer. If a higher
        // priority source needs it, the displaced source rereads its committed cursor.
        const oversized = bytes.length >= this.maxRecordBytes;
        this.buffered = oversized ? undefined : { id: job.id, from: plan.from, bytes, size: observed.size, modifiedMs: observed.mtimeMs };
        this.store.setCoverage(job.id, { status: oversized ? "oversized" : "partial", ...(oversized ? { error: "record-size-limit" } : {}) });
        if (!oversized && from + wanted < observed.size) this.enqueue(job);
        else if (this.priority(job) < 2) this.polling.set(job.id, { job, at: Date.now() + this.pollMs });
        return;
      }
      if (job.session.provider === "codex" && plan.from === 0 && boundary) {
        try {
          const first = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString("utf8"));
          if (first.type === "session_meta" && typeof first.payload?.id === "string"
            && first.payload.id !== job.session.nativeId) {
            this.store.setCoverage(job.id, { status: "error", error: "session-identity-mismatch" });
            if (this.buffered?.id === job.id) this.buffered = undefined;
            return;
          }
        } catch { /* The normalizer records malformed complete lines without storing their contents. */ }
      }
      // One complete record may exceed the usual batch size, but never maxRecordBytes.
      this.store.setCoverage(job.id, { status: "indexing" });
      const result = this.store.ingest({ session: job.session, source: { ...source, from: plan.from, bytes: bytes.subarray(0, boundary) } });
      if (this.buffered?.id === job.id) this.buffered = undefined;
      this.counters.linesIndexed += result.lines;
      const complete = result.source.offset === observed.size;
      this.store.setCoverage(job.id, { status: complete ? "complete" : "queued" });
      if (!complete || after.size > observed.size) this.enqueue(job);
      else if (this.priority(job) < 2) this.polling.set(job.id, { job, at: Date.now() + this.pollMs });
      if (result.change === "rewrite") {
        this.recovery.unshift({ sessionId: job.session.id });
        this.buffered = undefined;
      }
    } catch (error) {
      const code = errorCode(error);
      this.lastError = code;
      if (this.buffered?.id === job.id) this.buffered = undefined;
      this.store.setCoverage(job.id, { status: code === "ENOENT" ? "missing" : "error", error: code });
      if (this.priority(job) < 2) this.polling.set(job.id, { job, at: Date.now() + this.pollMs });
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
