import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  migrateVoiceOverride,
  type VoiceOverrideOptions,
} from "./speak.ts";
import {
  findCodexTranscript,
  readCodexSessions,
  type CodexSessionRegistryOptions,
} from "./codex-sessions.ts";

const LABELS_FILE = join(homedir(), ".config/conch/labels.json");
const MAX_SESSION_LABEL_LENGTH = 40;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface LabelOverrideOptions {
  /** Injectable so tests and alternate front-ends never need to touch the real home directory. */
  labelsPath?: string;
}

export interface RenameSessionLabelOptions extends LabelOverrideOptions, VoiceOverrideOptions {}
export interface SessionLookupOptions extends LabelOverrideOptions, CodexSessionRegistryOptions {}

export interface SessionInfo {
  sessionId: string;
  /** Session implementation; absent on legacy Claude registry projections. */
  backend?: "claude" | "codex";
  name?: string;
  cwd?: string;
  pid?: number;
  /** Claude Code's own live state: "busy" | "idle" | "shell" (authoritative for working-vs-waiting). */
  status?: string;
  /** epoch-ms the status was last set — compared against a latched panel state to pick the newer truth. */
  statusUpdatedAt?: number;
  /** "interactive" for a human-driven TUI; other kinds (headless/sdk) can't be talked to. */
  kind?: string;
  /** "cli" for a real terminal session; "sdk-cli" etc. are headless routines. */
  entrypoint?: string;
}

/**
 * A session a voice loop can actually engage — a top-level interactive CLI session.
 * Excludes headless/sdk-cli routines (e.g. boatker's cron runs) that would otherwise
 * get announced + open the mic. Conservative: a session is only dropped when we can
 * positively identify it as non-interactive, so older registries (missing the fields)
 * still pass.
 */
export function isEngageable(info: Pick<SessionInfo, "kind" | "entrypoint">): boolean {
  if (info.kind && info.kind !== "interactive") return false;
  if (info.entrypoint && info.entrypoint !== "cli") return false;
  return true;
}

/**
 * Look up a live session in Claude Code's registry (~/.claude/sessions/<pid>.json).
 * Gives us the /rename-able session name and the CLI pid for pane targeting.
 */
export async function findSession(claudeDir: string, sessionId: string): Promise<SessionInfo | null> {
  const dir = join(claudeDir, "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const entry = await Bun.file(join(dir, f)).json();
      if (entry.sessionId === sessionId) {
        return toInfo(entry);
      }
    } catch {
      // stale or mid-write registry file; skip
    }
  }
  return null;
}

/** Project a raw registry JSON entry onto SessionInfo (keeps the fields conch actually uses). */
function toInfo(entry: any, backend?: SessionInfo["backend"]): SessionInfo {
  return {
    sessionId: entry.sessionId,
    ...(backend ? { backend } : {}),
    name: entry.name,
    cwd: entry.cwd,
    pid: entry.pid,
    status: entry.status,
    statusUpdatedAt: typeof entry.statusUpdatedAt === "number"
      ? entry.statusUpdatedAt
      : backend === "codex" && typeof entry.updatedAt === "number"
        ? entry.updatedAt
        : undefined,
    kind: entry.kind,
    entrypoint: entry.entrypoint,
  };
}

function labelOverridePath(options: LabelOverrideOptions): string {
  return options.labelsPath ?? LABELS_FILE;
}

/** Canonical persisted form: printable, trimmed, non-empty, and dashboard-sized. */
export function normalizeSessionLabel(label: string): string {
  const printable = label.replace(CONTROL_CHARS, "").trim();
  const capped = Array.from(printable).slice(0, MAX_SESSION_LABEL_LENGTH).join("").trim();
  if (!capped) throw new Error("Session label cannot be empty");
  return capped;
}

/** Read conch-owned labels; Claude's frequently rewritten registry remains read-only. */
export function labelOverrides(options: LabelOverrideOptions = {}): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(labelOverridePath(options), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Array<[string, string]> = [];
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!sessionId || typeof value !== "string") continue;
      try {
        entries.push([sessionId, normalizeSessionLabel(value)]);
      } catch {}
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function writeLabelOverrides(
  overrides: Readonly<Record<string, string>>,
  options: LabelOverrideOptions,
): void {
  const path = labelOverridePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.labels.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(overrides, null, 2) + "\n", "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
  }
}

/** Persist one session-id-keyed display label without modifying Claude's registry. */
export function setLabelOverride(
  sessionId: string,
  label: string,
  options: LabelOverrideOptions = {},
): string {
  const id = sessionId.trim();
  if (!id || id.replace(CONTROL_CHARS, "") !== id) {
    throw new Error("Session id cannot be empty or contain control characters");
  }
  const canonical = normalizeSessionLabel(label);
  const map = new Map(Object.entries(labelOverrides(options)));
  map.set(id, canonical);
  writeLabelOverrides(Object.fromEntries(map), options);
  return canonical;
}

/**
 * The one rename operation for UI/CLI callers: persist the canonical label and
 * carry its label-keyed voice pin along. If the voice write fails, restore the
 * previous label map so callers never report a half-completed rename.
 */
export function renameSessionLabel(
  sessionId: string,
  oldLabel: string,
  newLabel: string,
  options: RenameSessionLabelOptions = {},
): { label: string; voiceMigrated: boolean } {
  const canonical = normalizeSessionLabel(newLabel);
  const originalLabels = labelOverrides(options);
  setLabelOverride(sessionId, canonical, options);
  try {
    return {
      label: canonical,
      voiceMigrated: migrateVoiceOverride(oldLabel, canonical, options),
    };
  } catch (error) {
    writeLabelOverrides(originalLabels, options);
    throw error;
  }
}

/** Session label precedence: conch override, registry name, then project folder. */
export function sessionLabel(
  info: SessionInfo | null,
  cwd: string | undefined,
  options: LabelOverrideOptions = {},
): string {
  if (info?.sessionId) {
    const overrides = labelOverrides(options);
    const override = Object.hasOwn(overrides, info.sessionId)
      ? overrides[info.sessionId]
      : undefined;
    if (override) return override;
  }
  if (info?.name) return info.name;
  const dir = cwd ?? info?.cwd ?? process.cwd();
  return dir.split("/").filter(Boolean).pop() ?? "claude";
}

/**
 * A single read of the session registry.
 *  - `infos`: engageable (top-level interactive CLI) sessions, for the panel + wake.
 *  - `liveIds`: EVERY live sessionId (engageable or not, plus ids salvaged from a
 *    torn mid-write file), for liveness/"has this closed?" checks.
 *  - `complete`: false if any file was unreadable/unparseable — callers deciding
 *    "closed" or pruning latches must NOT treat an absence as authoritative.
 */
export interface RegistrySnapshot {
  infos: SessionInfo[];
  liveIds: Set<string>;
  complete: boolean;
}

/**
 * True only when a complete registry read positively lacks this session.
 * A missing/incomplete snapshot or empty id is uncertain, so it must fail open.
 */
export function sessionGoneFromSnapshot(
  snap: RegistrySnapshot | null,
  sessionId: string,
): boolean {
  if (!sessionId || !snap || !snap.complete) return false;
  return !snap.liveIds.has(sessionId);
}

/**
 * Read both live-session registries once. Returns `null` only when neither
 * source can be enumerated (total uncertainty). A torn/unparseable individual
 * file sets `complete = false`; Claude ids are salvaged from torn files so a
 * live session is never mistaken for closed.
 */
export async function registrySnapshot(
  claudeDir: string,
  options: CodexSessionRegistryOptions = {},
): Promise<RegistrySnapshot | null> {
  const dir = join(claudeDir, "sessions");
  let files: string[] = [];
  let claudeAvailable = true;
  let claudeMissing = false;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    claudeAvailable = false;
    claudeMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const infos: SessionInfo[] = [];
  const liveIds = new Set<string>();
  let complete = claudeAvailable || claudeMissing;
  for (const f of files) {
    const raw = await Bun.file(join(dir, f)).text().catch(() => null);
    if (raw == null) {
      complete = false;
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(raw);
    } catch {
      // torn mid-write file — Claude rewrites <pid>.json on every status change,
      // and the Stop hook fires at that same moment, so this race is real. Salvage
      // the id so a live session is never dropped as "closed".
      complete = false;
      const m = raw.match(/"sessionId"\s*:\s*"([^"]+)"/);
      if (m) liveIds.add(m[1]);
      continue;
    }
    if (!entry.sessionId) continue;
    liveIds.add(entry.sessionId);
    if (isEngageable(entry)) infos.push(toInfo(entry));
  }

  const codex = readCodexSessions(options);
  for (const entry of codex.entries) {
    liveIds.add(entry.sessionId);
    infos.push(toInfo(entry, "codex"));
  }
  if (!codex.complete) complete = false;

  // No readable source at all retains the legacy "total uncertainty" result.
  // A readable Codex registry can still supply useful sessions when Claude's
  // directory is absent. ENOENT is known-empty; other Claude read failures
  // make the combined liveness view incomplete.
  if (!claudeAvailable && !codex.available) return null;
  return { infos, liveIds, complete };
}

/** All engageable (top-level interactive CLI) live sessions from the registry. */
export async function listSessions(
  claudeDir: string,
  options: CodexSessionRegistryOptions = {},
): Promise<SessionInfo[]> {
  return (await registrySnapshot(claudeDir, options))?.infos ?? [];
}

/** Match an exact id, then conch overrides, registry names, and project folders. */
export async function findSessionByName(
  claudeDir: string,
  query: string,
  options: SessionLookupOptions = {},
): Promise<SessionInfo | null> {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  const sessions = await listSessions(claudeDir, options);
  const overrides = labelOverrides(options);
  const overrideFor = (session: SessionInfo): string | undefined => {
    return Object.hasOwn(overrides, session.sessionId)
      ? overrides[session.sessionId]
      : undefined;
  };
  return (
    sessions.find((s) => s.sessionId.toLowerCase() === q) ??
    sessions.find((s) => overrideFor(s)?.toLowerCase() === q) ??
    sessions.find((s) => s.name?.toLowerCase() === q) ??
    sessions.find((s) => s.name?.toLowerCase().includes(q)) ??
    sessions.find((s) => (s.cwd ?? "").split("/").pop()?.toLowerCase() === q) ??
    null
  );
}

/** Find by the spoken form, retrying without spaces ("day loop" -> "dayloop"). */
export async function findSessionBySpokenName(
  claudeDir: string,
  query: string,
  options: SessionLookupOptions = {},
): Promise<SessionInfo | null> {
  const direct = await findSessionByName(claudeDir, query, options);
  if (direct) return direct;
  const collapsed = query.replace(/\s+/g, "");
  return collapsed === query
    ? null
    : findSessionByName(claudeDir, collapsed, options);
}

/** Locate a Claude project transcript, then fall back to Codex's owned registry path. */
export function findTranscript(
  claudeDir: string,
  sessionId: string,
  options: CodexSessionRegistryOptions = {},
): string | undefined {
  const projects = join(claudeDir, "projects");
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      try {
        statSync(candidate);
        return candidate;
      } catch {}
    }
  } catch {}
  return findCodexTranscript(sessionId, options);
}
