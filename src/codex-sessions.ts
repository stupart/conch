import { dirname, join } from "node:path";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DEFAULT_CONCH_CONFIG_DIR } from "./settings.ts";

export type CodexSessionStatus = "busy" | "idle";

/** The conch-owned live-session record written by `conch codex-hook`. */
export interface CodexSessionEntry {
  sessionId: string;
  cwd: string;
  pid: number;
  status: CodexSessionStatus;
  updatedAt: number;
  transcriptPath: string;
}

export interface CodexSessionUpdate extends Omit<CodexSessionEntry, "transcriptPath"> {
  transcriptPath?: string;
}

export interface CodexSessionRegistryOptions {
  /** Injectable so tests and alternate front-ends never need to touch the real home directory. */
  configDir?: string;
  /** Injectable process probe; the default is `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
}

export interface CodexSessionRegistryRead {
  entries: CodexSessionEntry[];
  /** False when an individual registry file could not be read or parsed. */
  complete: boolean;
  /** Whether the codex-sessions directory exists and could be enumerated. */
  available: boolean;
}

/** Resolve at call time so tests and hook subprocesses honor CONCH_CONFIG_DIR. */
export function codexConfigDir(options: CodexSessionRegistryOptions = {}): string {
  return options.configDir
    ?? process.env.CONCH_CONFIG_DIR
    ?? DEFAULT_CONCH_CONFIG_DIR;
}

export function codexSessionsDir(options: CodexSessionRegistryOptions = {}): string {
  return join(codexConfigDir(options), "codex-sessions");
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validEntry(value: unknown): value is CodexSessionEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<CodexSessionEntry>;
  return typeof entry.sessionId === "string"
    && typeof entry.cwd === "string"
    && Number.isSafeInteger(entry.pid)
    && (entry.pid ?? 0) > 0
    && (entry.status === "busy" || entry.status === "idle")
    && typeof entry.updatedAt === "number"
    && Number.isFinite(entry.updatedAt)
    && typeof entry.transcriptPath === "string";
}

function readExisting(path: string): CodexSessionEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomically create/update `<configDir>/codex-sessions/<pid>.json`.
 * A hook payload may omit transcript_path, so preserve the path already known
 * for the same session and otherwise persist an explicit empty string.
 */
export function writeCodexSession(
  update: CodexSessionUpdate,
  options: CodexSessionRegistryOptions = {},
): CodexSessionEntry {
  if (!Number.isSafeInteger(update.pid) || update.pid <= 0) {
    throw new Error("Codex session pid must be a positive safe integer");
  }
  const dir = codexSessionsDir(options);
  const path = join(dir, `${update.pid}.json`);
  const previous = readExisting(path);
  const entry: CodexSessionEntry = {
    ...update,
    transcriptPath: update.transcriptPath
      || (previous?.sessionId === update.sessionId ? previous.transcriptPath : ""),
  };
  if (!validEntry(entry)) throw new Error("Invalid Codex session registry entry");

  mkdirSync(dir, { recursive: true });
  const temp = join(
    dirname(path),
    `.${update.pid}.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(entry, null, 2) + "\n", "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
  }
  return entry;
}

/**
 * Read live Codex sessions and prune records whose owning CLI pid is gone.
 * Malformed/torn files are retained and make the read incomplete so callers
 * never interpret their missing id as authoritative.
 */
export function readCodexSessions(
  options: CodexSessionRegistryOptions = {},
): CodexSessionRegistryRead {
  const dir = codexSessionsDir(options);
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    return {
      entries: [],
      complete: (error as NodeJS.ErrnoException).code === "ENOENT",
      available: false,
    };
  }

  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const entries: CodexSessionEntry[] = [];
  let complete = true;
  for (const file of files) {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      complete = false;
      continue;
    }
    if (!validEntry(parsed)) {
      complete = false;
      continue;
    }
    if (!isPidAlive(parsed.pid)) {
      try {
        unlinkSync(path);
      } catch {
        complete = false;
      }
      continue;
    }
    entries.push(parsed);
  }
  return { entries, complete, available: true };
}

export function findCodexSession(
  sessionId: string,
  options: CodexSessionRegistryOptions = {},
): CodexSessionEntry | null {
  return readCodexSessions(options).entries.find((entry) => entry.sessionId === sessionId) ?? null;
}

export function findCodexTranscript(
  sessionId: string,
  options: CodexSessionRegistryOptions = {},
): string | undefined {
  return findCodexSession(sessionId, options)?.transcriptPath || undefined;
}
