import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * One line per MCP tool call, so how agents actually use conch's tools — which they reach for, which they get wrong,
 * which fail and how slowly — is a file to summarise (`conch mcp-usage`) rather than a hunt through every agent's
 * transcripts. Until 2026-10-19 the only record of a call was the calling agent's own transcript.
 *
 * What a line keeps: when, which tool, which session and backend, how long, how it ended, the argument NAMES and the
 * error, trimmed. Never an argument's value: arguments carry the user's words, page text, URLs and the odd secret, and
 * an error that echoes one has it replaced by the argument's name before it is written.
 *
 * Recording is best effort, like telemetry.ts: nothing here may throw into, or wait inside, a tool call.
 */

export type McpCallOutcome = "ok" | "input-error" | "refused" | "failed";
export const MCP_CALL_OUTCOMES: readonly McpCallOutcome[] = ["ok", "input-error", "refused", "failed"];
export type McpBackend = "claude" | "codex";

export interface McpCallRecord {
  /** Epoch ms when the call arrived. */
  ts: number;
  tool: string;
  /** The calling conch session, when conch could tell. */
  session?: string;
  backend?: McpBackend;
  ms: number;
  outcome: McpCallOutcome;
  /** The error the agent was shown, scrubbed and trimmed (`cleanCallError`). */
  error?: string;
  /** The argument names the call passed, sorted: which knobs agents turn, never what they set them to. */
  args?: string[];
}

/** What `dispatchJsonRpc` hands its observer about one call; the arguments only so their values can be scrubbed. */
export interface McpCallObservation {
  ts: number;
  tool: string;
  ms: number;
  outcome: McpCallOutcome;
  error?: string;
  arguments?: unknown;
  /** The call's `params._meta`: a Codex client names its thread there. */
  meta?: unknown;
}

export interface McpCaller {
  session?: string;
  backend?: McpBackend;
}

/** Beside the daemon's other durable files; the suite points it at its own root (test/preload.ts). */
export function mcpUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONCH_MCP_USAGE_FILE || join(env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "mcp-usage.jsonl");
}

// ~40k calls a file at ~200 bytes a line, and one rotation kept: weeks of a busy Mac in 16 MB.
export const MCP_USAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_ERROR_MAX = 300;
const ARG_NAMES_MAX = 16;
const TOOL_NAME_MAX = 64;

/**
 * A call's error as it may be written: whatever an argument held replaced by `<name>`, anything token-shaped redacted,
 * the home folder shortened, whitespace collapsed, and at most MCP_ERROR_MAX characters. Many of conch's refusals quote
 * what they were given ("no live session matching …", "url … is not an .html page"), and the file is shared when
 * tuning, so the scrub is by value, not by trusting each message.
 */
export function cleanCallError(
  message: string,
  argumentsValue?: unknown,
  home: string = conchHome(),
  vocabulary: ReadonlySet<string> = new Set(),
): string {
  let text = message;
  for (const [value, name] of argumentStrings(argumentsValue)) {
    // A value that is one of the tools' own words (an enum, an argument name) is the message's word too, not the user's.
    if (!vocabulary.has(value)) text = text.split(value).join(`<${name}>`);
  }
  text = text
    // Bearer tokens, API keys, JWTs, long runs with digits in them: nothing an error needs to say.
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(token|api[_-]?key|secret|password|passwd|cookie)\s*[=:]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|glpat)[-_][A-Za-z0-9_-]{8,}/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted>")
    // 40+: a uuid (36) stays readable, a sha1 or an access token does not.
    .replace(/(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}/g, "<redacted>");
  if (home && home !== "/") text = text.split(home).join("~");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MCP_ERROR_MAX ? `${text.slice(0, MCP_ERROR_MAX - 1)}…` : text;
}

/** Every string an argument holds (3+ characters, longest first so a value inside another is not split), with its name. */
function argumentStrings(value: unknown): Array<[string, string]> {
  const found = new Map<string, string>();
  const walk = (node: unknown, name: string, depth: number) => {
    if (found.size >= 64 || depth > 4) return;
    if (typeof node === "string") {
      for (const variant of [node, node.trim()]) if (variant.length >= 3 && !found.has(variant)) found.set(variant, name);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, name, depth + 1);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) walk(child, depth ? name : safeName(key), depth + 1);
    }
  };
  walk(value, "arg", 0);
  return [...found].sort(([a], [b]) => b.length - a.length);
}

/** An argument name as written: agent-chosen, so only identifier characters, and short. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40) || "_";
}

/** The names of the arguments a call passed, sorted, or undefined for none. */
export function argumentNames(argumentsValue: unknown): string[] | undefined {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return undefined;
  const names = Object.keys(argumentsValue).slice(0, ARG_NAMES_MAX).map(safeName).sort();
  return names.length ? names : undefined;
}

/** The line written for an observation, given who called. */
export function mcpCallRecord(
  call: McpCallObservation,
  caller: McpCaller = {},
  vocabulary?: ReadonlySet<string>,
): McpCallRecord {
  const args = argumentNames(call.arguments);
  return {
    ts: call.ts,
    tool: safeName(call.tool).slice(0, TOOL_NAME_MAX),
    ...(caller.session ? { session: caller.session } : {}),
    ...(caller.backend ? { backend: caller.backend } : {}),
    ms: Math.max(0, Math.round(call.ms)),
    outcome: call.outcome,
    ...(call.error ? { error: cleanCallError(call.error, call.arguments, conchHome(), vocabulary) } : {}),
    ...(args ? { args } : {}),
  };
}

/** Append one record: owner-only, rotated past MCP_USAGE_MAX_BYTES, and silent about every failure. */
export function appendMcpCall(record: McpCallRecord, path: string = mcpUsagePath(), maxBytes = MCP_USAGE_MAX_BYTES): void {
  try {
    let stat: Stats | undefined;
    try { stat = statSync(path); } catch { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    if (stat && stat.size > maxBytes) {
      renameSync(path, `${path}.1`);
      stat = undefined;
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // `mode` applies only to a file this call created; one that was there already is narrowed once.
    if (stat && stat.mode & 0o077) chmodSync(path, 0o600);
  } catch {}
}

export interface McpCallLogOptions {
  path?: string;
  /** Who is calling, resolved after the call has been answered; absent or failing, the line has no session. */
  caller?(meta: unknown): Promise<McpCaller>;
  /** The backend the client said it is at `initialize`, for a call whose session conch could not tell. */
  backendHint?(): McpBackend | undefined;
  append?(record: McpCallRecord, path: string): void;
  /** Words an argument may hold that are the tools' own, left in an error (`mcpToolVocabulary`). */
  vocabulary?: ReadonlySet<string>;
}

/**
 * The MCP server's recorder. `observe` returns at once and the rest waits for the next turn of the event loop, after
 * the response has been written: the caller resolved, the line written (~20 µs, measured 2026-10-19), so a slow
 * registry read or a full disk costs the agent nothing. `flush` is for tests and for a server about to exit.
 */
export class McpCallLog {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: McpCallLogOptions = {}) {}

  observe = (call: McpCallObservation): void => {
    const work = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      let caller: McpCaller = {};
      try { caller = (await this.options.caller?.(call.meta)) ?? {}; } catch {}
      if (!caller.backend) {
        const hint = this.options.backendHint?.();
        if (hint) caller = { ...caller, backend: hint };
      }
      (this.options.append ?? appendMcpCall)(mcpCallRecord(call, caller, this.options.vocabulary), this.options.path ?? mcpUsagePath());
    })().catch(() => {}).finally(() => this.pending.delete(work));
    this.pending.add(work);
  };

  /** Every line still being written, or `timeoutMs`, whichever is first: a stuck registry read never holds an exit. */
  async flush(timeoutMs = 2_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      while (this.pending.size) {
        if (await Promise.race([Promise.all([...this.pending]).then(() => false), late.then(() => true)])) return;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The backend a client's `initialize` names itself as (`clientInfo.name`: "claude-code", "codex-mcp-client"). */
export function backendOfClient(name: unknown): McpBackend | undefined {
  if (typeof name !== "string") return undefined;
  if (/codex/i.test(name)) return "codex";
  if (/claude/i.test(name)) return "claude";
  return undefined;
}

// ---- the summary: `conch mcp-usage` ----

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** `--since`: a span back from now (90m, 24h, 7d, 2w) or a date; null when it is neither. */
export function parseSince(value: string, now = Date.now()): number | null {
  const span = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (span) return now - Number(span[1]) * UNIT_MS[span[2]!.toLowerCase()]!;
  const at = Date.parse(value);
  return Number.isFinite(at) && /\d{4}-\d{2}-\d{2}/.test(value) ? at : null;
}

/** Every record since `since`, the rotated file's first, skipping lines that aren't one. */
export function readMcpCalls(path: string = mcpUsagePath(), since = 0): McpCallRecord[] {
  const records: McpCallRecord[] = [];
  for (const file of [`${path}.1`, path]) {
    if (!existsSync(file)) continue;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as McpCallRecord;
        if (
          typeof record?.ts === "number" && record.ts >= since && typeof record.tool === "string"
          && typeof record.ms === "number" && MCP_CALL_OUTCOMES.includes(record.outcome)
        ) records.push(record);
      } catch {}
    }
  }
  return records;
}

/**
 * An error as it is counted: ids, paths, quoted text and numbers collapsed, so "tab t7 is gone" and "tab t12 is gone"
 * are one problem, not two.
 */
export function errorGroup(error: string): string {
  return error
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'`)\],]+/gi, "<url>")
    .replace(/(?<![\w:<])(?:~|\.{1,2})?\/[^\s"'`)\],]+/g, "<path>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "\"…\"")
    .replace(/\b[a-z]*\d+[a-z\d]*\b/gi, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** The value at quantile q (nearest rank) of ascending values. */
export function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export interface McpToolUsage {
  tool: string;
  calls: number;
  sessions: number;
  outcomes: Record<McpCallOutcome, number>;
  errors: number;
  errorRate: number;
  p50ms: number;
  p90ms: number;
  /** The commonest errors, grouped (`errorGroup`), each with the outcome it was counted as. */
  topErrors: Array<{ outcome: McpCallOutcome; error: string; count: number }>;
}

export interface McpSessionUsage {
  session: string;
  backend?: McpBackend;
  calls: number;
  errors: number;
  first: number;
  last: number;
  tools: Record<string, number>;
}

export interface McpUsageSummary {
  since: number;
  until: number;
  path: string;
  calls: number;
  errors: number;
  sessions: number;
  outcomes: Record<McpCallOutcome, number>;
  tools: McpToolUsage[];
  bySession?: McpSessionUsage[];
}

export interface McpUsageOptions {
  since: number;
  until?: number;
  path?: string;
  /** Only this session's calls. */
  session?: string;
  bySession?: boolean;
  topErrors?: number;
}

const noOutcomes = (): Record<McpCallOutcome, number> => ({ ok: 0, "input-error": 0, refused: 0, failed: 0 });

export function summariseMcpCalls(all: readonly McpCallRecord[], options: McpUsageOptions): McpUsageSummary {
  const records = all.filter((record) => record.ts >= options.since && (!options.session || record.session === options.session));
  const byTool = new Map<string, McpCallRecord[]>();
  for (const record of records) byTool.set(record.tool, [...(byTool.get(record.tool) ?? []), record]);
  const tools = [...byTool].map(([tool, calls]): McpToolUsage => {
    const outcomes = noOutcomes();
    const groups = new Map<string, { outcome: McpCallOutcome; error: string; count: number }>();
    for (const call of calls) {
      outcomes[call.outcome] += 1;
      if (call.outcome !== "ok" && call.error) {
        const error = errorGroup(call.error);
        const key = `${call.outcome}\0${error}`;
        const group = groups.get(key) ?? { outcome: call.outcome, error, count: 0 };
        group.count += 1;
        groups.set(key, group);
      }
    }
    const errors = calls.length - outcomes.ok;
    const ms = calls.map((call) => call.ms).sort((a, b) => a - b);
    return {
      tool,
      calls: calls.length,
      sessions: new Set(calls.flatMap((call) => (call.session ? [call.session] : []))).size,
      outcomes,
      errors,
      errorRate: Math.round((errors / calls.length) * 1000) / 1000,
      p50ms: percentile(ms, 0.5),
      p90ms: percentile(ms, 0.9),
      topErrors: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, options.topErrors ?? 3),
    };
  }).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const outcomes = noOutcomes();
  for (const record of records) outcomes[record.outcome] += 1;
  const summary: McpUsageSummary = {
    since: options.since,
    until: options.until ?? Date.now(),
    path: options.path ?? mcpUsagePath(),
    calls: records.length,
    errors: records.length - outcomes.ok,
    sessions: new Set(records.flatMap((record) => (record.session ? [record.session] : []))).size,
    outcomes,
    tools,
  };
  if (options.bySession) {
    const bySession = new Map<string, McpSessionUsage>();
    for (const record of records) {
      const key = record.session ?? "(unknown)";
      const row = bySession.get(key) ?? { session: key, calls: 0, errors: 0, first: record.ts, last: record.ts, tools: {} };
      if (record.backend) row.backend = record.backend;
      row.calls += 1;
      if (record.outcome !== "ok") row.errors += 1;
      row.first = Math.min(row.first, record.ts);
      row.last = Math.max(row.last, record.ts);
      row.tools[record.tool] = (row.tools[record.tool] ?? 0) + 1;
      bySession.set(key, row);
    }
    summary.bySession = [...bySession.values()].sort((a, b) => b.calls - a.calls);
  }
  return summary;
}

export function formatMcpUsage(summary: McpUsageSummary): string[] {
  const when = (ms: number) => new Date(ms).toLocaleString();
  const lines = [`conch MCP calls since ${when(summary.since)} (${summary.path})`];
  if (!summary.calls) return [...lines, "no calls recorded in this window"];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  lines.push(
    `${summary.calls} calls · ${summary.sessions} sessions · ${summary.errors} errors`
      + ` (input ${summary.outcomes["input-error"]}, refused ${summary.outcomes.refused}, failed ${summary.outcomes.failed})`,
    "",
    `${"tool".padEnd(24)} ${"calls".padStart(6)} ${"sess".padStart(5)} ${"err".padStart(5)} ${"rate".padStart(5)}`
      + ` ${"in".padStart(4)} ${"ref".padStart(4)} ${"fail".padStart(4)} ${"p50ms".padStart(7)} ${"p90ms".padStart(7)}`,
  );
  for (const tool of summary.tools) {
    lines.push(
      `${tool.tool.padEnd(24)} ${String(tool.calls).padStart(6)} ${String(tool.sessions).padStart(5)} ${String(tool.errors).padStart(5)}`
        + ` ${pct(tool.errorRate).padStart(5)} ${String(tool.outcomes["input-error"]).padStart(4)} ${String(tool.outcomes.refused).padStart(4)}`
        + ` ${String(tool.outcomes.failed).padStart(4)} ${String(tool.p50ms).padStart(7)} ${String(tool.p90ms).padStart(7)}`,
    );
    for (const { outcome, error, count } of tool.topErrors) lines.push(`    ${String(count).padStart(4)}× ${outcome.padEnd(11)} ${error}`);
  }
  if (summary.bySession) {
    lines.push("", "by session:");
    for (const row of summary.bySession) {
      const top = Object.entries(row.tools).sort(([, a], [, b]) => b - a).slice(0, 4).map(([tool, n]) => `${tool} ${n}`).join(", ");
      lines.push(
        `  ${row.session.padEnd(38)} ${(row.backend ?? "").padEnd(6)} ${String(row.calls).padStart(5)} calls`
          + ` ${String(row.errors).padStart(4)} err  ${when(row.first)} → ${when(row.last)}  ${top}`,
      );
    }
  }
  return lines;
}

export const MCP_USAGE_HELP = "usage: conch mcp-usage [--since 7d|24h|90m|2w|YYYY-MM-DD] [--session <id>] [--by-session] [--json]";

/** `conch mcp-usage`'s arguments to its output and exit code. */
export function runMcpUsageCli(argv: readonly string[], path: string = mcpUsagePath(), now = Date.now()): { code: number; lines: string[] } {
  let since = now - 7 * UNIT_MS.d!;
  let session: string | undefined;
  let bySession = false;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++index];
    if (flag === "--since") {
      const raw = value();
      const parsed = raw === undefined ? null : parseSince(raw, now);
      if (parsed === null) return { code: 2, lines: [`--since takes a span (7d, 24h, 90m, 2w) or a date`, MCP_USAGE_HELP] };
      since = parsed;
    } else if (flag === "--session") {
      session = value();
      if (!session) return { code: 2, lines: [MCP_USAGE_HELP] };
    } else if (flag === "--by-session") bySession = true;
    else if (flag === "--json") json = true;
    else if (flag === "--help" || flag === "-h") return { code: 0, lines: [MCP_USAGE_HELP] };
    else return { code: 2, lines: [`unknown argument "${arg}"`, MCP_USAGE_HELP] };
  }
  const summary = summariseMcpCalls(readMcpCalls(path, since), { since, until: now, path, ...(session ? { session } : {}), bySession });
  return { code: 0, lines: json ? [JSON.stringify(summary, null, 2)] : formatMcpUsage(summary) };
}
