import { parseWindowKey } from "./window-key.ts";

/**
 * What `conch_sessions` answers: one small entry per session, never the daemon's whole published state.
 *
 * 2026-10-18 review (three weeks of agent transcripts): the tool returned the sessions file as it was, pretty-printed,
 * 272K to 455K characters (features, runtimes, accounts, browser tabs, every conversation, every row's deliverables).
 * Every Claude Code call was too large to show and was saved to a file instead; Codex paid about 2.4M tokens for it,
 * one thread polling it once a minute as a "has it finished?" check. In the 18 Oct fork failure the only error text the
 * agent saw was that oversized result. So the default is a list an agent can read at a glance, `session` narrows it,
 * and `detail: true` gives one session's full row, all of it under `SESSIONS_REPLY_MAX` characters.
 */

/** The most a `conch_sessions` reply may be, as the agent reads it (pretty-printed JSON). */
export const SESSIONS_REPLY_MAX = 20_000;

/** How old the daemon's published state may be and still say which sessions are alive. */
export const PUBLISHED_FRESH_MS = 2 * 60_000;

/** What the daemon marks on a session whose MCP server can't get conch's current tools (mcp-servers.ts). */
export interface PublishedToolsStale {
  missing: string[];
  [key: string]: unknown;
}

export interface CompactSession {
  id: string;
  label: string;
  backend: "claude" | "codex";
  /** working, waiting (on the user, or idle), needs (a question or permission for the user), or null when unknown. */
  status: string | null;
  cwd?: string;
  /** The account profile it runs under, by its label. */
  account?: string;
  /** When its status last changed, ISO 8601. */
  lastActivity?: string;
  /** Whether it is running now, as conch last saw. */
  alive: boolean;
  /** The calling session itself. */
  you?: true;
  /** Subagents running inside it. */
  agents?: number;
  /** Its conch MCP server can't get conch's current tools; restarting the session gives them. */
  toolsStale?: PublishedToolsStale;
}

export interface SessionsView {
  /** Rows as the daemon publishes them (`rows`), or as the registry gives them when it isn't running. */
  rows: readonly unknown[];
  /** When the rows were published (epoch ms); undefined for the registry's own. */
  publishedAt?: number;
  /** Ids the registry this server reads says are running. */
  liveIds?: ReadonlySet<string>;
  /** Labels of account profiles, by id, for a row that names only its account id. */
  accountLabels?: ReadonlyMap<string, string>;
  callerId?: string;
  now: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function backendOf(row: Record<string, unknown>): "claude" | "codex" {
  const execution = isRecord(row.execution) ? row.execution.providerId : undefined;
  return row.backend === "codex" || execution === "codex" ? "codex" : "claude";
}

function iso(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** One row as the compact list says it. */
export function compactSession(row: Record<string, unknown>, view: SessionsView, agents = 0): CompactSession {
  const id = String(row.id);
  const fresh = view.publishedAt !== undefined && view.now - view.publishedAt <= PUBLISHED_FRESH_MS;
  const live = view.liveIds?.has(parseWindowKey(id).sessionId) === true;
  const accountId = text(row.claudeAccountId) ?? text(row.codexAccountId);
  const account = text(row.accountLabel) ?? (accountId ? view.accountLabels?.get(accountId) ?? accountId : undefined);
  const stale = isRecord(row.toolsStale) && Array.isArray(row.toolsStale.missing) ? row.toolsStale as PublishedToolsStale : undefined;
  return {
    id,
    label: text(row.label) ?? id,
    backend: backendOf(row),
    status: typeof row.status === "string" ? row.status : null,
    ...(text(row.cwd) ? { cwd: row.cwd as string } : {}),
    ...(account ? { account } : {}),
    ...(iso(row.at) ? { lastActivity: iso(row.at) } : {}),
    alive: live || fresh,
    ...(view.callerId !== undefined && parseWindowKey(id).sessionId === parseWindowKey(view.callerId).sessionId ? { you: true as const } : {}),
    ...(agents ? { agents } : {}),
    ...(stale ? { toolsStale: stale } : {}),
  };
}

/** Whether a row is the one `query` names: its id, an id prefix of four or more characters, or a word of its label. */
export function rowMatches(row: Record<string, unknown>, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  const id = String(row.id ?? "").toLowerCase();
  if (id === wanted || (wanted.length >= 4 && id.startsWith(wanted))) return true;
  const label = typeof row.label === "string" ? row.label.toLowerCase() : "";
  return label.includes(wanted);
}

const size = (value: unknown) => JSON.stringify(value, null, 2).length;

/** The compact list: top-level sessions, most recently active first, each with its subagents counted, under the cap. */
export function compactSessionList(
  view: SessionsView,
  query: string | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const rows = view.rows.filter(isRecord).filter((row) => typeof row.id === "string");
  const agents = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.parentSessionId === "string") agents.set(row.parentSessionId, (agents.get(row.parentSessionId) ?? 0) + 1);
  }
  const top = rows.filter((row) => typeof row.parentSessionId !== "string");
  const matching = query ? top.filter((row) => rowMatches(row, query)) : top;
  const sessions = matching
    .map((row) => compactSession(row, view, agents.get(String(row.id)) ?? 0))
    .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  const fresh = view.publishedAt === undefined || view.now - view.publishedAt <= PUBLISHED_FRESH_MS;
  const result: Record<string, unknown> = {
    ...extra,
    sessions,
    total: sessions.length,
    ...(query && !sessions.length ? { note: `no session's id or label matches "${query}"; omit session to list them all` } : {}),
    ...(!fresh && view.publishedAt !== undefined
      ? { stale: `conch's published state is ${Math.round((view.now - view.publishedAt) / 60_000)} min old, so the daemon may not be running and alive is only what this session's own registry says` }
      : {}),
    more: "session: an id or part of a label to narrow the list; with detail: true, that one session's full row",
  };
  // Never more than the cap: the least recently active go first, and the reply says how many it left out.
  while (sessions.length && size(result) > SESSIONS_REPLY_MAX) {
    sessions.pop();
    result.truncated = `showing the ${sessions.length} most recently active of ${result.total}; pass session to narrow it`;
  }
  return result;
}

/** One session's full row, cut to the cap: its oldest deliverables go first, then its long texts. */
export function detailedSession(row: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const full: Record<string, unknown> = { ...row };
  const result: Record<string, unknown> = { ...extra, session: full };
  const reviews = Array.isArray(full.reviews) ? [...full.reviews] : undefined;
  const total = reviews?.length ?? 0;
  while (reviews?.length && size(result) > SESSIONS_REPLY_MAX) {
    reviews.shift();
    full.reviews = [...reviews];
    result.trimmed = `showing its ${reviews.length} newest deliverables of ${total}; conch_deliverables lists your own`;
  }
  for (const key of Object.keys(full)) {
    if (size(result) <= SESSIONS_REPLY_MAX) break;
    if (key === "id" || key === "label") continue;
    if (size(full[key]) > 2_000) {
      delete full[key];
      result.trimmed = `${typeof result.trimmed === "string" ? `${result.trimmed}; ` : ""}left out ${key}, too long to show`;
    }
  }
  return result;
}

/** Each row's `toolsStale` in the sessions file's text, by row id: what `conch sessions` prints beside a session. */
export function staleToolsByRow(sessionsFile: string | null): Map<string, PublishedToolsStale> {
  const found = new Map<string, PublishedToolsStale>();
  let parsed: unknown;
  try {
    parsed = sessionsFile === null ? null : JSON.parse(sessionsFile);
  } catch {
    return found;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) return found;
  for (const row of parsed.rows) {
    if (isRecord(row) && typeof row.id === "string" && isRecord(row.toolsStale) && Array.isArray(row.toolsStale.missing)) {
      found.set(row.id, row.toolsStale as PublishedToolsStale);
    }
  }
  return found;
}
