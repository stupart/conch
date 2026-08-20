import { existsSync, closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  codexHomeDir,
  codexThreadDbPaths,
  codexThreadLabel,
  openReadOnly,
} from "./codex-threads.ts";

export interface ResumableSession {
  sessionId: string;
  backend: "claude" | "codex";
  label: string;
  cwd: string;
  updatedAt: number;
}

export interface ReadResumableSessionsOptions {
  /** Maximum rows returned after query filtering. Defaults to 200. */
  limit?: number;
  /** Case-insensitive substring match over label and cwd. */
  query?: string;
  /** Conch state redirection. Suppresses both real-home defaults. */
  configDir?: string;
  /** Explicit Codex home, primarily for tests. */
  codexHome?: string;
  /** Explicit Claude home, primarily for tests. */
  claudeHome?: string;
}

export interface ResumableSessionsRead {
  sessions: ResumableSession[];
  /** False when a source could not be read or more candidates remain past limit. */
  complete: boolean;
}

const DEFAULT_LIMIT = 200;
const CLAUDE_HEAD_LINES = 40;
const CLAUDE_HEAD_BYTES = 256 * 1024;

interface ClaudeCandidate {
  backend: "claude";
  sessionId: string;
  path: string;
  updatedAt: number;
}

interface CodexCandidate extends ResumableSession {
  backend: "codex";
}

type Candidate = ClaudeCandidate | CodexCandidate;

interface ClaudeHeadRead {
  session: ResumableSession | null;
  complete: boolean;
}

function redirectedConfigDir(options: ReadResumableSessionsOptions): string | undefined {
  return options.configDir ?? process.env.CONCH_CONFIG_DIR;
}

/** Claude equivalent of codexHomeDir(), including its real-history test guard. */
export function claudeHomeDir(options: ReadResumableSessionsOptions = {}): string | null {
  if (options.claudeHome !== undefined) return options.claudeHome;
  if (redirectedConfigDir(options)) return null;
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function fallbackLabel(cwd: string, sessionId: string): string {
  const candidate = basename(cwd) || cwd || sessionId.slice(0, 8);
  return codexThreadLabel({ title: candidate }) ?? candidate;
}

function readCodexCandidates(
  options: ReadResumableSessionsOptions,
): { candidates: CodexCandidate[]; complete: boolean } {
  const codexHome = codexHomeDir(options);
  if (!codexHome) return { candidates: [], complete: true };
  const { state } = codexThreadDbPaths(codexHome);
  if (!existsSync(state)) return { candidates: [], complete: true };

  let db: ReturnType<typeof openReadOnly> | undefined;
  try {
    db = openReadOnly(state);
    const rows = db.query(
      `SELECT id, cwd, name, agent_nickname, title, updated_at_ms
         FROM threads
        WHERE archived = 0
          AND source IN ('cli', 'vscode')
        ORDER BY updated_at_ms DESC`,
    ).all() as Array<Record<string, unknown>>;
    return {
      complete: true,
      candidates: rows.map((row) => {
        const sessionId = String(row.id ?? "");
        const cwd = String(row.cwd ?? "");
        return {
          sessionId,
          backend: "codex",
          label: codexThreadLabel({
            name: typeof row.name === "string" ? row.name : null,
            agent_nickname: typeof row.agent_nickname === "string" ? row.agent_nickname : null,
            title: typeof row.title === "string" ? row.title : null,
          }) ?? fallbackLabel(cwd, sessionId),
          cwd,
          updatedAt: Math.max(0, Math.trunc(Number(row.updated_at_ms) || 0)),
        };
      }),
    };
  } catch {
    return { candidates: [], complete: false };
  } finally {
    db?.close();
  }
}

function readClaudeCandidates(
  options: ReadResumableSessionsOptions,
): { candidates: ClaudeCandidate[]; complete: boolean } {
  const claudeHome = claudeHomeDir(options);
  if (!claudeHome) return { candidates: [], complete: true };
  const projects = join(claudeHome, "projects");
  if (!existsSync(projects)) return { candidates: [], complete: true };

  const candidates: ClaudeCandidate[] = [];
  let complete = true;
  let projectDirs;
  try {
    projectDirs = readdirSync(projects, { withFileTypes: true });
  } catch {
    return { candidates, complete: false };
  }

  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projects, project.name);
    let files;
    try {
      files = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const sessionId = file.name.slice(0, -".jsonl".length);
      if (!sessionId) continue;
      const path = join(projectPath, file.name);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || !Number.isFinite(stat.mtimeMs)) continue;
        candidates.push({
          backend: "claude",
          sessionId,
          path,
          updatedAt: Math.max(0, Math.trunc(stat.mtimeMs)),
        });
      } catch {
        complete = false;
      }
    }
  }
  return { candidates, complete };
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (
      part !== null
      && typeof part === "object"
      && typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

function userText(record: Record<string, unknown>): string | undefined {
  if (record.type !== "user") return undefined;
  if (typeof record.message === "string") return record.message;
  if (record.message === null || typeof record.message !== "object") return undefined;
  return contentText((record.message as { content?: unknown }).content);
}

function readClaudeSessionHead(candidate: ClaudeCandidate): ClaudeHeadRead {
  let fd: number | undefined;
  try {
    fd = openSync(candidate.path, "r");
    const decoder = new TextDecoder();
    const chunk = Buffer.allocUnsafe(8 * 1024);
    let pending = "";
    let bytesRead = 0;
    let linesRead = 0;
    let cwd: string | undefined;
    let label: string | undefined;
    let entrypoint: string | undefined;
    let reachedEof = false;
    let malformed = false;

    const inspect = (line: string): void => {
      linesRead += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed = true;
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const record = parsed as Record<string, unknown>;
      if (!cwd && typeof record.cwd === "string" && record.cwd.trim()) {
        cwd = record.cwd.trim();
      }
      if (!entrypoint && typeof record.entrypoint === "string") {
        entrypoint = record.entrypoint;
      }
      if (!label) {
        const text = userText(record)?.trim();
        if (text && !text.startsWith("<")) {
          label = codexThreadLabel({ title: text.replace(/\s+/g, " ") });
        }
      }
    };

    while (linesRead < CLAUDE_HEAD_LINES && bytesRead < CLAUDE_HEAD_BYTES) {
      const wanted = Math.min(chunk.length, CLAUDE_HEAD_BYTES - bytesRead);
      const count = readSync(fd, chunk, 0, wanted, null);
      if (count === 0) {
        reachedEof = true;
        pending += decoder.decode();
        if (pending && linesRead < CLAUDE_HEAD_LINES) inspect(pending);
        break;
      }
      bytesRead += count;
      pending += decoder.decode(chunk.subarray(0, count), { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0 && linesRead < CLAUDE_HEAD_LINES) {
        inspect(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (cwd && label) break;
        newline = pending.indexOf("\n");
      }
      if (cwd && label) break;
    }

    if (!cwd) {
      // Claude also leaves tiny title/bridge sidecars with a .jsonl suffix.
      // A valid file that reaches EOF without a cwd is not a resumable
      // transcript. Hitting the read bound first is different: metadata might
      // exist later, so the source is incomplete rather than known-empty.
      return { session: null, complete: reachedEof && !malformed };
    }
    // Headless routines are not sessions you resume. Boaker's cron runs were
    // 15 of the 25 most recent transcripts on this machine, each opening with
    // its own system prompt, so the list filled with rows reading "You are
    // Boaker, Tyler's standing boat-market watcher". This is the rule
    // `isEngageable` already applies to LIVE sessions, and it is conservative
    // in the same direction: only a positively non-cli entrypoint is dropped.
    if (entrypoint && entrypoint !== "cli") {
      return { session: null, complete: true };
    }
    return {
      complete: true,
      session: {
        sessionId: candidate.sessionId,
        backend: "claude",
        label: readClaudeTitle(candidate.path)
          ?? label
          ?? fallbackLabel(cwd, candidate.sessionId),
        cwd,
        updatedAt: candidate.updatedAt,
      },
    };
  } catch {
    return { session: null, complete: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** How much of a transcript's end to read looking for its current title. */
const CLAUDE_TAIL_BYTES = 64 * 1024;

/**
 * The name Claude Code itself shows you, from the END of the transcript.
 *
 * conch was labelling rows with the first thing you ever said in a session, so
 * the resume list did not match `/resume` — Tyler: "The resume names i see in
 * conch are weird - they don't match what i see when i run /resume in the
 * apps". The sessions he recognises are the renamed ones: `conch`, `honeyb`,
 * `arch site`, `dayloop-feature-work`, each showing as an ancient opening
 * sentence instead.
 *
 * Claude Code writes `custom-title` when you rename a session and `ai-title`
 * for the one it generates, and rewrites both as they change — roughly two
 * thousand times each in a long transcript. So the CURRENT value is at the
 * tail, and the tail is the only affordable place to look: the transcript this
 * was traced in is 158MB, its first `custom-title` sits at line 3190, and a
 * 64KB tail read finds both records in 0.06ms.
 *
 * A rename beats a generated title, because it is the name a person chose.
 */
function readClaudeTitle(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const length = Math.min(size, CLAUDE_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    const tail = new TextDecoder().decode(buffer);

    let custom: string | undefined;
    let generated: string | undefined;
    for (const line of tail.split("\n")) {
      // Cheap reject before the parse: most lines are neither, and a 64KB tail
      // of a busy transcript is a few hundred of them.
      if (!line.includes("-title")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // the first line of a tail read is usually a fragment
      }
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      // Last wins: later records are more recent renames.
      if (record.type === "custom-title" && typeof record.customTitle === "string") {
        custom = record.customTitle.trim() || custom;
      } else if (record.type === "ai-title" && typeof record.aiTitle === "string") {
        generated = record.aiTitle.trim() || generated;
      }
    }
    const chosen = custom ?? generated;
    return chosen ? codexThreadLabel({ title: chosen.replace(/\s+/g, " ") }) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function matches(session: ResumableSession, query: string): boolean {
  if (!query) return true;
  return `${session.label}\n${session.cwd}`.toLocaleLowerCase().includes(query);
}

/**
 * Read resumable history from both backends without checking whether a session
 * is currently live. Claude files are statted first and opened lazily in
 * newest-first order, so an unfiltered 200-row request never parses all history.
 */
export function readResumableSessionsResult(
  options: ReadResumableSessionsOptions = {},
): ResumableSessionsRead {
  const limit = normalizedLimit(options.limit);
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const codex = readCodexCandidates(options);
  const claude = readClaudeCandidates(options);
  const candidates: Candidate[] = [...codex.candidates, ...claude.candidates];
  candidates.sort((a, b) =>
    b.updatedAt - a.updatedAt
    || a.backend.localeCompare(b.backend)
    || a.sessionId.localeCompare(b.sessionId)
  );

  let complete = codex.complete && claude.complete;
  const sessions: ResumableSession[] = [];
  let index = 0;
  for (; index < candidates.length && sessions.length < limit; index += 1) {
    const candidate = candidates[index]!;
    const head = candidate.backend === "codex"
      ? { session: candidate, complete: true }
      : readClaudeSessionHead(candidate);
    if (!head.complete) complete = false;
    const { session } = head;
    if (!session) {
      continue;
    }
    if (matches(session, query)) sessions.push(session);
  }
  if (index < candidates.length) complete = false;

  return { sessions, complete };
}

export function readResumableSessions(
  options: ReadResumableSessionsOptions = {},
): ResumableSession[] {
  return readResumableSessionsResult(options).sessions;
}
