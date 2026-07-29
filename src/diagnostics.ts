import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type RecorderExitReason =
  | "natural"
  | "window-kill"
  | "max-kill"
  | "short"
  | "never-started"
  | "disarmed-next"
  | "shutdown"
  | "error";

export type RecorderKillCause = "window" | "max" | "disarmed-next" | "shutdown" | "abort" | null;
export type TranscriptionEngine = "warm" | "cold";

export interface RecorderExitFacts {
  killCause: RecorderKillCause;
  finalBytesAfterExit: number;
  minimumBytes: number;
  error?: string | null;
}

/** Pure disposition classifier: capture cause and post-exit evidence stay separate. */
export function classifyRecorderExit(facts: RecorderExitFacts): RecorderExitReason {
  if (facts.killCause === "shutdown") return "shutdown";
  if (facts.killCause === "disarmed-next") return "disarmed-next";
  if (facts.error) return "error";
  if (facts.finalBytesAfterExit === 0) return "never-started";
  if (facts.finalBytesAfterExit < facts.minimumBytes) return "short";
  if (facts.killCause === "window") return "window-kill";
  if (facts.killCause === "max") return "max-kill";
  return "natural";
}

export interface RecorderDiagnosticRecord {
  type: "recorder";
  id: string;
  tag: string;
  parent: string;
  sequence: number;
  openedAt: string;
  exitedAt: string | null;
  exitReason: RecorderExitReason | null;
  /** Internal causal detail retained when the public reason is e.g. never-started. */
  killCause: RecorderKillCause;
  sizeAtKill: number | null;
  finalBytesAfterExit: number | null;
  engine: TranscriptionEngine | null;
  transcript: string | null;
  error: string | null;
  intent: string | null;
  bufferCountAfterReduction: number | null;
  finalSubmittedPayload: string | null;
  rawPath: string;
}

export type RecorderDiagnosticPatch = Partial<Omit<RecorderDiagnosticRecord, "type" | "id">>;

interface DiagnosticsSessionOptions {
  baseDir?: string;
  pid?: number;
  runstamp?: string;
  announce?: boolean;
}

/**
 * Opt-in diagnostics store. Recorder rows are held mutable in memory, then
 * appended exactly once when their daemon-side intent/payload is known.
 */
export class DiagnosticsSession {
  readonly runDir: string;
  readonly logPath: string;

  private parentCounter = 0;
  private recorderCounter = 0;
  private pending = new Map<string, RecorderDiagnosticRecord>();

  constructor(options: DiagnosticsSessionOptions = {}) {
    const baseDir = options.baseDir ?? "/tmp";
    const pid = options.pid ?? process.pid;
    const runstamp = options.runstamp ?? String(Date.now());
    const stem = `conch-diag-${pid}-${runstamp}`;
    let runDir = join(baseDir, stem);
    for (let suffix = 1; existsSync(runDir); suffix++) runDir = join(baseDir, `${stem}-${suffix}`);

    mkdirSync(runDir, { mode: 0o700 });
    chmodSync(runDir, 0o700);
    this.runDir = runDir;
    this.logPath = join(runDir, "diagnostics.jsonl");

    const header = {
      type: "header",
      warning: "SENSITIVE: this directory retains raw microphone audio and transcripts.",
      cleanup: `Remove this diagnostic run with: rm -rf -- ${runDir}`,
      runDir,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(this.logPath, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    chmodSync(this.logPath, 0o600);

    if (options.announce !== false) {
      console.error(`[conch:diag] ${header.warning}`);
      console.error(`[conch:diag] ${header.cleanup}`);
      console.error(`[conch:diag] structured log: ${this.logPath}`);
    }
  }

  createParent(tag: string): string {
    this.parentCounter++;
    return `${safePart(tag)}-${String(this.parentCounter).padStart(4, "0")}`;
  }

  startRecorder(tag: string, parent: string, sequence: number): RecorderDiagnosticRecord {
    this.recorderCounter++;
    const id = `rec-${String(this.recorderCounter).padStart(4, "0")}`;
    const rawPath = join(this.runDir, `${id}-${safePart(tag)}.raw`);
    const record: RecorderDiagnosticRecord = {
      type: "recorder",
      id,
      tag,
      parent,
      sequence,
      openedAt: new Date().toISOString(),
      exitedAt: null,
      exitReason: null,
      killCause: null,
      sizeAtKill: null,
      finalBytesAfterExit: null,
      engine: null,
      transcript: null,
      error: null,
      intent: null,
      bufferCountAfterReduction: null,
      finalSubmittedPayload: null,
      rawPath,
    };
    this.pending.set(id, record);
    return record;
  }

  update(id: string, patch: RecorderDiagnosticPatch): void {
    const record = this.pending.get(id);
    if (!record) return;
    applyPatch(record, patch);
  }

  emit(id: string, patch: RecorderDiagnosticPatch = {}): void {
    const record = this.pending.get(id);
    if (!record) return;
    applyPatch(record, patch);
    if (!record.exitReason) {
      record.exitReason = "error";
      record.error ??= "Diagnostic record emitted before recorder disposition was finalized";
    }
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
    this.pending.delete(id);
  }

  emitMany(ids: Iterable<string>, patch: RecorderDiagnosticPatch = {}): void {
    for (const id of ids) this.emit(id, patch);
  }

  flushPending(error?: string): void {
    for (const id of [...this.pending.keys()]) {
      const patch: RecorderDiagnosticPatch = {};
      if (error) patch.error = error;
      this.emit(id, patch);
    }
  }
}

export interface RecorderTrace {
  id: string;
  rawPath: string;
}

export function keepRawDiagnosticsEnabled(value: string | undefined): boolean {
  return value === "1";
}

const KEEP_RAW = keepRawDiagnosticsEnabled(process.env.CONCH_KEEP_RAW);
let defaultSession: DiagnosticsSession | null | undefined;

export function recorderDiagnosticsEnabled(): boolean {
  return KEEP_RAW;
}

function getDefaultSession(): DiagnosticsSession | null {
  if (!KEEP_RAW) return null;
  if (defaultSession !== undefined) return defaultSession;
  try {
    defaultSession = new DiagnosticsSession();
  } catch (e) {
    defaultSession = null;
    console.error(`[conch:diag] could not initialize diagnostics: ${formatDiagnosticError(e)}`);
  }
  return defaultSession;
}

export function createRecorderParent(tag: string): string | undefined {
  if (!KEEP_RAW) return undefined;
  try {
    return getDefaultSession()?.createParent(tag);
  } catch {
    return undefined;
  }
}

export function startRecorderTrace(tag: string, parent: string | undefined, sequence: number): RecorderTrace | undefined {
  if (!KEEP_RAW || !parent) return undefined;
  try {
    const record = getDefaultSession()?.startRecorder(tag, parent, sequence);
    return record ? { id: record.id, rawPath: record.rawPath } : undefined;
  } catch {
    return undefined;
  }
}

export function updateRecorderTrace(trace: RecorderTrace | string | undefined, patch: RecorderDiagnosticPatch): void {
  if (!KEEP_RAW) return;
  const id = typeof trace === "string" ? trace : trace?.id;
  if (!id) return;
  try {
    getDefaultSession()?.update(id, patch);
  } catch {}
}

export function emitRecorderTrace(trace: RecorderTrace | string | undefined, patch: RecorderDiagnosticPatch = {}): void {
  if (!KEEP_RAW) return;
  const id = typeof trace === "string" ? trace : trace?.id;
  if (!id) return;
  try {
    getDefaultSession()?.emit(id, patch);
  } catch {}
}

export function emitRecorderTraces(traces: Iterable<string | undefined>, patch: RecorderDiagnosticPatch = {}): void {
  if (!KEEP_RAW) return;
  try {
    const ids = [...traces].filter((id): id is string => Boolean(id));
    getDefaultSession()?.emitMany(ids, patch);
  } catch {}
}

export function flushPendingRecorderTraces(error?: string): void {
  if (!KEEP_RAW) return;
  try {
    getDefaultSession()?.flushPending(error);
  } catch {}
}

export function formatDiagnosticError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function safePart(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "capture";
}

/** Never erase an earlier lifecycle failure when a later stage also fails. */
function applyPatch(record: RecorderDiagnosticRecord, patch: RecorderDiagnosticPatch): void {
  const previousError = record.error;
  Object.assign(record, patch);
  if (previousError && patch.error === null) record.error = previousError;
  if (previousError && patch.error && !previousError.split(" | ").includes(patch.error)) {
    record.error = `${previousError} | ${patch.error}`;
  }
}
