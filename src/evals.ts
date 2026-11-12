import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { CONCH_VERSION } from "./version.ts";
import { mcpUsagePath, readMcpCalls, replyBytesSummary, summariseMcpCalls, parseSince } from "./mcp-usage.ts";

/**
 * conch's own efficiency evals: what conch costs every agent's context, the Mac's CPU and memory, and how long its
 * own paths take (2026-11-11, Tyler: "performance benchmarks evals on conch for token efficiency, computer efficiency,
 * etc."). `conch evals` measures; `assets/evals-baseline.json` is what it measured last on purpose; and
 * test/evals.test.ts fails a change that grows the agent-facing context more than `CONTEXT_BUDGET` over that baseline.
 *
 * Three sections:
 * - tokens: what the plugin puts in front of an agent before it does anything (the MCP server's `instructions`, the
 *   skill's listing, the tools' schemas, Codex's AGENTS.md), each tool's share of it, and, from this Mac's call log
 *   and (asked for) Claude Code's transcripts, what conch's tool results add per call. Deterministic: it is the gate.
 * - compute: a test daemon (evals-harness.ts) at rest and under a scripted load, with a census of what each poll
 *   touches; one MCP server's memory; and, read-only, the live daemon's, app's and MCP servers' `ps` numbers.
 * - latency: control-socket round trips, hooks, the MCP server's cold start and tool calls, registry and transcript
 *   reads, the published state's build, an inject's pre-flight and a whisper transcription of a spoken fixture.
 *
 * Compute and latency depend on the machine and on what else it is doing, so they are reported and compared, never
 * gated; the baseline records the machine and its load when it was taken, and refuses a loaded one.
 *
 * Not in Settings › Benchmarks (benchmarks.ts): that is a catalog of other people's AI benchmarks; these are conch's.
 */

/** How much the agent-facing context may grow over the baseline before the gate fails: 10%. */
export const CONTEXT_BUDGET = 0.10;
/** A single tool may also grow this many tokens before its own 10% counts, so a short description can gain a clause. */
export const TOOL_SLACK_TOKENS = 40;
/** The checked-in baseline. */
export const EVALS_BASELINE_PATH = join(import.meta.dir, "..", "assets", "evals-baseline.json");
/** The checked-in plugin the marketplace serves (agent-instructions.ts renders it; a test holds it current). */
export const PLUGIN_ROOT = join(import.meta.dir, "..", "plugin", "plugins", "conch");
/** How a Claude Code session names a conch tool: the plugin `conch`'s server `conch`. */
export const CLAUDE_CODE_TOOL_PREFIX = "mcp__plugin_conch_conch__";

/**
 * The documented approximation, used when no API key is present and always for the gate: one token per four
 * characters, Anthropic's and OpenAI's long-standing rule of thumb for English. Prose lands near it; JSON schemas,
 * dense with quotes and braces, run about 10-30% more tokens than this says, so treat the absolute numbers as a floor
 * and the comparisons between versions as exact (the same rule on both sides). `conch evals` with ANTHROPIC_API_KEY
 * set also counts each piece with Anthropic's count_tokens endpoint and prints both.
 */
export const APPROX_RULE = "ceil(characters / 4)";
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---- tokens: the agent-facing context ----

export interface ToolCost {
  name: string;
  /** The tools/list entry as served, JSON: what a client puts in the model's tool list. */
  chars: number;
  tokens: number;
  descriptionChars: number;
  /** The input schema's JSON, its parameter descriptions included. */
  schemaChars: number;
  /** The parameters' own descriptions, summed: the part of the schema that is prose. */
  parameterProseChars: number;
  parameters: number;
}

export interface ContextPiece {
  chars: number;
  tokens: number;
  /** Anthropic count_tokens' count, when an API key was present. */
  apiTokens?: number;
}

export interface SurfaceCost extends ContextPiece {
  /** What it is made of, by piece name. */
  parts: string[];
}

export interface TokenReport {
  method: { approx: string; api?: string };
  tools: ToolCost[];
  pieces: Record<string, ContextPiece>;
  /** What each agent carries before anything is asked, and what loading every conch tool adds. */
  surfaces: Record<string, SurfaceCost>;
}

export interface McpToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface AgentContextSource {
  /** The tools/list result's tools, as served. */
  tools: McpToolEntry[];
  /** The `instructions` in initialize's reply to Claude Code; to Codex, none (mcp.ts). */
  serverInstructions: string;
  instructionsToCodex: string;
  /** Each plugin skill's SKILL.md, by folder name. */
  skills: Record<string, string>;
  /** The plugin's AGENTS.md: Codex's always-on text. */
  agentsMd: string;
}

/** The plugin skill's frontmatter name and description, as an agent's skill list shows it. */
export function skillListing(skillMd: string, plugin = "conch"): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? "";
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim() ?? "";
  return `- ${plugin}:${field("name")}: ${field("description")}`;
}

function parameterProse(schema: unknown): { chars: number; parameters: number } {
  let chars = 0;
  let parameters = 0;
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    const properties = (node as { properties?: unknown }).properties;
    if (properties && typeof properties === "object") {
      for (const child of Object.values(properties as Record<string, unknown>)) {
        if (depth === 0) parameters += 1;
        const description = (child as { description?: unknown })?.description;
        if (typeof description === "string") chars += description.length;
        walk(child, depth + 1);
      }
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) {
      const value = (node as Record<string, unknown>)[key];
      for (const child of Array.isArray(value) ? value : value ? [value] : []) walk(child, depth + 1);
    }
  };
  walk(schema, 0);
  return { chars, parameters };
}

const piece = (text: string): ContextPiece => ({ chars: text.length, tokens: approxTokens(text) });

/** The agent-facing context, from what the server and the plugin actually serve. Pure: the gate's input. */
export function measureAgentContext(source: AgentContextSource): TokenReport {
  const tools = source.tools.map((tool): ToolCost => {
    const json = JSON.stringify(tool);
    const schema = JSON.stringify(tool.inputSchema ?? {});
    const prose = parameterProse(tool.inputSchema);
    return {
      name: tool.name,
      chars: json.length,
      tokens: approxTokens(json),
      descriptionChars: tool.description?.length ?? 0,
      schemaChars: schema.length,
      parameterProseChars: prose.chars,
      parameters: prose.parameters,
    };
  }).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const listings = Object.values(source.skills).map((skill) => skillListing(skill)).join("\n");
  const toolsJson = JSON.stringify(source.tools);
  // Claude Code names each tool with its plugin and server, and lists a deferred one by that name alone (ToolSearch).
  const claudeTools = JSON.stringify(source.tools.map((tool) => ({ ...tool, name: `${CLAUDE_CODE_TOOL_PREFIX}${tool.name}` })));
  const deferredNames = source.tools.map((tool) => `${CLAUDE_CODE_TOOL_PREFIX}${tool.name}`).join("\n");
  const pieces: Record<string, ContextPiece> = {
    "server-instructions": piece(source.serverInstructions),
    "skill-listing": piece(listings),
    "agents-md": piece(source.agentsMd),
    "tools-list": piece(toolsJson),
    "tools-list (Claude Code names)": piece(claudeTools),
    "deferred-tool-names": piece(deferredNames),
    ...Object.fromEntries(Object.entries(source.skills).map(([name, text]) => [`skill:${name} (on load)`, piece(text)])),
  };
  const surface = (parts: string[]): SurfaceCost => {
    const chars = parts.reduce((sum, part) => sum + (pieces[part]?.chars ?? 0), 0);
    const tokens = parts.reduce((sum, part) => sum + (pieces[part]?.tokens ?? 0), 0);
    return { chars, tokens, parts };
  };
  return {
    method: { approx: APPROX_RULE },
    tools,
    pieces,
    surfaces: {
      // Claude Code's default: MCP tools wait behind ToolSearch, listed by name until a select loads them.
      "claude-code": surface(["server-instructions", "skill-listing", "deferred-tool-names"]),
      // The same session with every conch tool loaded (or tool search off).
      "claude-code (all tools loaded)": surface(["server-instructions", "skill-listing", "tools-list (Claude Code names)"]),
      // Codex: AGENTS.md always-on, no server instructions (mcp.ts), every tool's schema.
      codex: surface(["agents-md", "skill-listing", "tools-list", ...(source.instructionsToCodex ? ["server-instructions"] : [])]),
    },
  };
}

/** What this checkout serves: tools/list and initialize through the real dispatch, and the plugin's files. */
export async function agentContextSource(pluginRoot = PLUGIN_ROOT): Promise<AgentContextSource> {
  const { dispatchJsonRpc } = await import("./mcp.ts");
  const handlers = {} as Parameters<typeof dispatchJsonRpc>[1];
  const ask = async (method: string, params?: unknown) =>
    ((await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, handlers))?.result ?? {}) as Record<string, unknown>;
  const listed = await ask("tools/list");
  const claude = await ask("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "evals" }, capabilities: {} });
  const codex = await ask("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "evals" }, capabilities: {} });
  const skillsDir = join(pluginRoot, "skills");
  const skills: Record<string, string> = {};
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir).sort() : []) {
    const file = join(skillsDir, name, "SKILL.md");
    if (existsSync(file)) skills[name] = readFileSync(file, "utf8");
  }
  const agentsMd = join(pluginRoot, "AGENTS.md");
  return {
    tools: Array.isArray(listed.tools) ? listed.tools as McpToolEntry[] : [],
    serverInstructions: typeof claude.instructions === "string" ? claude.instructions : "",
    instructionsToCodex: typeof codex.instructions === "string" ? codex.instructions : "",
    skills,
    agentsMd: existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : "",
  };
}

// ---- tokens, counted by Anthropic when a key is present ----

export const COUNT_TOKENS_MODEL = "claude-opus-5-5";
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Exact counts from Anthropic's count_tokens endpoint (raw HTTP: conch takes no npm dependencies). A text piece is
 * counted as a user message, less a one-character message; a tool as the difference it makes to a request already
 * holding one tiny tool, so the fixed tool-use preamble a session pays anyway is not charged to conch.
 */
export async function countWithAnthropic(
  source: AgentContextSource,
  report: TokenReport,
  apiKey: string,
  fetcher: Fetch = fetch,
  model = COUNT_TOKENS_MODEL,
): Promise<void> {
  const tiny = { name: "noop", description: "x", input_schema: { type: "object", properties: {} } };
  const count = async (body: Record<string, unknown>): Promise<number> => {
    const response = await fetcher("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "." }], ...body }),
    });
    if (!response.ok) throw new Error(`count_tokens answered ${response.status}`);
    const value = await response.json() as { input_tokens?: unknown };
    if (typeof value.input_tokens !== "number") throw new Error("count_tokens returned no input_tokens");
    return value.input_tokens;
  };
  const asApiTool = (tool: McpToolEntry, name = tool.name) => ({ name, description: tool.description ?? "", input_schema: tool.inputSchema ?? { type: "object" } });
  const empty = await count({});
  const text = async (value: string) => (value ? (await count({ messages: [{ role: "user", content: value }] })) - empty + 1 : 0);
  const withTiny = await count({ tools: [tiny] });
  const tools = async (list: Array<Record<string, unknown>>) => (list.length ? (await count({ tools: [tiny, ...list] })) - withTiny : 0);
  const pieces = report.pieces;
  const listings = Object.values(source.skills).map((skill) => skillListing(skill)).join("\n");
  pieces["server-instructions"]!.apiTokens = await text(source.serverInstructions);
  pieces["skill-listing"]!.apiTokens = await text(listings);
  pieces["agents-md"]!.apiTokens = await text(source.agentsMd);
  pieces["deferred-tool-names"]!.apiTokens = await text(source.tools.map((tool) => `${CLAUDE_CODE_TOOL_PREFIX}${tool.name}`).join("\n"));
  pieces["tools-list"]!.apiTokens = await tools(source.tools.map((tool) => asApiTool(tool)));
  pieces["tools-list (Claude Code names)"]!.apiTokens = await tools(source.tools.map((tool) => asApiTool(tool, `${CLAUDE_CODE_TOOL_PREFIX}${tool.name}`)));
  for (const [name, skill] of Object.entries(source.skills)) {
    const key = `skill:${name} (on load)`;
    if (pieces[key]) pieces[key]!.apiTokens = await text(skill);
  }
  const byName = new Map(source.tools.map((tool) => [tool.name, tool]));
  for (const cost of report.tools) {
    const tool = byName.get(cost.name);
    if (tool) (cost as ToolCost & { apiTokens?: number }).apiTokens = await tools([asApiTool(tool)]);
  }
  for (const surface of Object.values(report.surfaces)) {
    const counted = surface.parts.map((part) => pieces[part]?.apiTokens);
    if (counted.every((value) => typeof value === "number")) surface.apiTokens = counted.reduce((sum, value) => sum! + value!, 0);
  }
  report.method.api = `Anthropic count_tokens (${model})`;
}

// ---- tokens: what tool results add, from this Mac's own records ----

export interface ToolUsage {
  tool: string;
  calls: number;
  share: number;
  sessions: number;
  errorRate: number;
  p50ms: number;
  p90ms: number;
  replyBytes?: { sized: number; p50: number; p90: number; mean: number; max: number };
}

export interface UsageReport {
  source: "mcp-usage.jsonl";
  days: number;
  calls: number;
  sessions: number;
  /** Calls whose line has the reply's size (logged since 2026-11-11). */
  sized: number;
  tools: ToolUsage[];
}

/** The call log, aggregated: per tool, never per session, and no session id leaves this function. */
export function usageReport(path = mcpUsagePath(), since: number, now = Date.now()): UsageReport | null {
  if (!existsSync(path) && !existsSync(`${path}.1`)) return null;
  const summary = summariseMcpCalls(readMcpCalls(path, since), { since, until: now, path });
  return {
    source: "mcp-usage.jsonl",
    days: Math.round(((now - since) / 86_400_000) * 10) / 10,
    calls: summary.calls,
    sessions: summary.sessions,
    sized: summary.tools.reduce((sum, tool) => sum + (tool.replyBytes?.sized ?? 0), 0),
    tools: summary.tools.map((tool) => ({
      tool: tool.tool,
      calls: tool.calls,
      share: summary.calls ? Math.round((tool.calls / summary.calls) * 1000) / 1000 : 0,
      sessions: tool.sessions,
      errorRate: tool.errorRate,
      p50ms: tool.p50ms,
      p90ms: tool.p90ms,
      ...(tool.replyBytes ? { replyBytes: tool.replyBytes } : {}),
    })),
  };
}

export interface TranscriptToolResults {
  tool: string;
  calls: number;
  p50: number;
  p90: number;
  mean: number;
  max: number;
  totalBytes: number;
}

export interface TranscriptReport {
  source: "claude-code transcripts";
  days: number;
  files: number;
  /** Each conch tool's results as the agent received them, in UTF-8 bytes. */
  results: TranscriptToolResults[];
  /** ToolSearch selects that loaded conch tools: each one puts those tools' schemas in the context. */
  toolSearch: { loads: number; conchToolsLoaded: number; byTool: Record<string, number>; schemaTokensLoaded?: number };
  /** Skill tool calls that loaded a conch skill, and what that added at today's size. */
  skillLoads: Record<string, number>;
  skillTokensLoaded?: number;
}

/**
 * Transcripts' conch tool results and ToolSearch loads, fed line by line. Each tool call counts once, by its id: a
 * fork or a resume copies the conversation into a new file, and its calls would otherwise count again. A call made
 * before `since` is skipped, though the file it is in was touched since. Exported for the tests.
 */
export class TranscriptScan {
  readonly sizes = new Map<string, number[]>();
  readonly loads = { loads: 0, conchToolsLoaded: 0, byTool: {} as Record<string, number> };
  /** Skill tool calls that loaded one of conch's skills, by skill. */
  readonly skillLoads: Record<string, number> = {};
  private readonly pending = new Map<string, string>();
  private readonly seen = new Set<string>();

  constructor(private readonly since = 0) {}

  line(text: string): void {
    const conch = text.includes(CLAUDE_CODE_TOOL_PREFIX) || text.includes("conch-control");
    if (!conch && !(this.pending.size && text.includes("tool_result"))) return;
    let record: { message?: { content?: unknown }; timestamp?: unknown };
    try { record = JSON.parse(text); } catch { return; }
    const at = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
    const content = Array.isArray(record?.message?.content) ? record.message!.content as Array<Record<string, unknown>> : [];
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string") {
        if (this.seen.has(block.id) || at < this.since) continue;
        this.seen.add(block.id);
        if (block.name.startsWith(CLAUDE_CODE_TOOL_PREFIX)) this.pending.set(block.id, block.name.slice(CLAUDE_CODE_TOOL_PREFIX.length));
        else if (block.name === "Skill") {
          const skill = (block.input as { skill?: unknown } | undefined)?.skill;
          if (typeof skill === "string" && /^(?:conch:)?conch-/.test(skill)) {
            const name = skill.replace(/^conch:/, "");
            this.skillLoads[name] = (this.skillLoads[name] ?? 0) + 1;
          }
        } else if (block.name === "ToolSearch") {
          const query = (block.input as { query?: unknown } | undefined)?.query;
          const names = typeof query === "string" ? [...query.matchAll(/mcp__plugin_conch_conch__(\w+)/g)].map((m) => m[1]!) : [];
          if (names.length) {
            this.loads.loads += 1;
            this.loads.conchToolsLoaded += names.length;
            for (const name of names) this.loads.byTool[name] = (this.loads.byTool[name] ?? 0) + 1;
          }
        }
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const tool = this.pending.get(block.tool_use_id);
        if (!tool) continue;
        this.pending.delete(block.tool_use_id);
        const inner = block.content;
        const textOf = typeof inner === "string" ? inner
          : Array.isArray(inner) ? inner.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
        const list = this.sizes.get(tool) ?? [];
        list.push(Buffer.byteLength(textOf, "utf8"));
        this.sizes.set(tool, list);
      }
    }
  }
}

/** Every line of a file, read in chunks so a 900 MB transcript is never one string. */
async function eachLine(path: string, visit: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of Bun.file(path).stream()) {
    const text = carry + decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line) visit(line);
  }
  if (carry) visit(carry);
}

/**
 * conch's tool results in Claude Code's own transcripts, read only, files touched since `since`. Codex reaches MCP
 * tools through its `exec` code tool, so its rollouts don't say which result was conch's; the call log's `bytes` covers
 * both from 2026-11-11.
 */
export async function transcriptReport(claudeDirs: readonly string[], since: number, now = Date.now()): Promise<TranscriptReport> {
  const scan = new TranscriptScan(since);
  let files = 0;
  const list = (folder: string) => { try { return readdirSync(folder, { withFileTypes: true }); } catch { return []; } };
  const visit = async (path: string) => {
    try { if (statSync(path).mtimeMs < since) return; } catch { return; }
    files += 1;
    await eachLine(path, (line) => scan.line(line)).catch(() => {});
  };
  for (const dir of claudeDirs) {
    for (const project of list(join(dir, "projects"))) {
      if (!project.isDirectory()) continue;
      const folder = join(dir, "projects", project.name);
      for (const entry of list(folder)) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) await visit(join(folder, entry.name));
        // A session's sub-agents keep their own transcripts beside it, and call conch's tools too.
        else if (entry.isDirectory()) {
          for (const agent of list(join(folder, entry.name, "subagents"))) {
            if (agent.isFile() && agent.name.endsWith(".jsonl")) await visit(join(folder, entry.name, "subagents", agent.name));
          }
        }
      }
    }
  }
  const results = [...scan.sizes].map(([tool, sizes]): TranscriptToolResults => {
    const sorted = sizes.sort((a, b) => a - b);
    const summary = replyBytesSummary(sorted);
    return { tool, calls: sorted.length, p50: summary.p50, p90: summary.p90, mean: summary.mean, max: summary.max, totalBytes: sorted.reduce((s, v) => s + v, 0) };
  }).sort((a, b) => b.totalBytes - a.totalBytes);
  return { source: "claude-code transcripts", days: Math.round(((now - since) / 86_400_000) * 10) / 10, files, results, toolSearch: scan.loads, skillLoads: scan.skillLoads };
}

// ---- the report, the baseline, the comparison ----

export type EvalSection = "tokens" | "compute" | "latency";
export const EVAL_SECTIONS: readonly EvalSection[] = ["tokens", "compute", "latency"];

export interface MachineNote {
  at: string;
  conch: string;
  bun: string;
  os: string;
  model?: string;
  cpu?: string;
  cores: number;
  memoryGB?: number;
  /** 1-minute load average when the run started and ended. */
  loadStart: number;
  loadEnd?: number;
  /** Why the numbers should, or shouldn't, be trusted as a baseline. */
  note?: string;
  /** The harness's settings, when compute or latency ran. */
  run?: { seconds: number; sessions: number };
}

export interface EvalReport {
  v: 1;
  machine: MachineNote;
  tokens?: TokenReport & { usage?: UsageReport | null; transcripts?: TranscriptReport };
  compute?: Record<string, unknown>;
  latency?: Record<string, unknown>;
}

function sysctl(name: string): string | undefined {
  try {
    const result = Bun.spawnSync(["/usr/sbin/sysctl", "-n", name], { stdout: "pipe", stderr: "ignore" });
    const text = result.stdout.toString().trim();
    return result.exitCode === 0 && text ? text : undefined;
  } catch {
    return undefined;
  }
}

export function machineNote(now = new Date()): MachineNote {
  const memory = Number(sysctl("hw.memsize"));
  let os = process.platform as string;
  try { os = `macOS ${Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"], { stdout: "pipe" }).stdout.toString().trim()}`; } catch {}
  return {
    at: now.toISOString(),
    conch: CONCH_VERSION,
    bun: Bun.version,
    os,
    model: sysctl("hw.model"),
    cpu: sysctl("machdep.cpu.brand_string"),
    cores: cpus().length,
    ...(Number.isFinite(memory) && memory > 0 ? { memoryGB: Math.round(memory / 2 ** 30) } : {}),
    loadStart: Math.round(loadavg()[0]! * 100) / 100,
  };
}

/** A machine too busy for its compute and latency numbers to be anyone's baseline: load above half its cores. */
export function machineTooBusy(machine: MachineNote): boolean {
  return Math.max(machine.loadStart, machine.loadEnd ?? 0) > machine.cores * 0.5;
}

export interface Breach {
  what: string;
  baseline: number;
  now: number;
  limit: number;
}

/**
 * The gate: every surface, the whole tools/list and each tool may grow at most CONTEXT_BUDGET over the baseline (a
 * tool also TOOL_SLACK_TOKENS). A tool the baseline doesn't know is held to the totals; one it knows that is gone is fine.
 */
export function contextBreaches(baseline: TokenReport, now: TokenReport, budget = CONTEXT_BUDGET): Breach[] {
  const breaches: Breach[] = [];
  const check = (what: string, before: number | undefined, after: number | undefined, slack = 0) => {
    if (before === undefined || after === undefined) return;
    const limit = Math.floor(Math.max(before * (1 + budget), before + slack));
    if (after > limit) breaches.push({ what, baseline: before, now: after, limit });
  };
  for (const [name, surface] of Object.entries(now.surfaces)) check(`surface ${name}`, baseline.surfaces[name]?.tokens, surface.tokens);
  for (const name of ["tools-list", "server-instructions", "skill-listing", "agents-md"]) check(name, baseline.pieces[name]?.tokens, now.pieces[name]?.tokens);
  const before = new Map(baseline.tools.map((tool) => [tool.name, tool.tokens]));
  for (const tool of now.tools) {
    const was = before.get(tool.name);
    if (was !== undefined) check(`tool ${tool.name}`, was, tool.tokens, TOOL_SLACK_TOKENS);
  }
  return breaches;
}

/** Read the baseline, or null when there isn't one (or it isn't one). */
export function readBaseline(path = EVALS_BASELINE_PATH): EvalReport | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as EvalReport;
    return value?.v === 1 ? value : null;
  } catch {
    return null;
  }
}

/**
 * What goes in the baseline: this run's sections over the old file's, never this Mac's call log or transcripts (they
 * are one person's usage), and compute and latency only from a machine that wasn't busy.
 */
export function baselineFrom(report: EvalReport, previous: EvalReport | null, force = false): { baseline: EvalReport; kept: string[] } {
  const kept: string[] = [];
  const tokens = report.tokens ? (({ usage: _usage, transcripts: _transcripts, ...rest }) => rest)(report.tokens) : previous?.tokens;
  const busy = machineTooBusy(report.machine) && !force;
  const pick = (section: "compute" | "latency") => {
    if (!report[section]) return previous?.[section];
    if (busy) {
      kept.push(section);
      return previous?.[section];
    }
    return report[section];
  };
  // The machine block says how compute and latency were taken, so it moves only with them.
  const measured = (report.compute || report.latency) && !busy;
  const load = Math.max(report.machine.loadStart, report.machine.loadEnd ?? 0);
  const machine: MachineNote = measured ? { ...report.machine, note: `idle enough: load ${load} on ${report.machine.cores} cores` }
    : previous?.machine ?? { ...report.machine, note: busy && (report.compute || report.latency) ? `compute and latency not recorded: load ${load} on ${report.machine.cores} cores` : "tokens only: compute and latency not recorded" };
  const compute = pick("compute");
  const latency = pick("latency");
  return { baseline: { v: 1, machine, ...(tokens ? { tokens } : {}), ...(compute ? { compute } : {}), ...(latency ? { latency } : {}) }, kept };
}

/** Numeric leaves of a section, by dotted path: how compute and latency are compared. */
export function numericLeaves(value: unknown, prefix = "", out = new Map<string, number>()): Map<string, number> {
  if (typeof value === "number" && Number.isFinite(value)) out.set(prefix, value);
  else if (Array.isArray(value)) value.forEach((item, index) => numericLeaves(item, `${prefix}[${(item as { name?: string })?.name ?? index}]`, out));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) numericLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

// ---- human output ----

const kb = (bytes: number) => (bytes >= 10_240 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024).toFixed(1)} KB`);
const n = (value: number) => value.toLocaleString("en-US");

export function formatTokens(report: NonNullable<EvalReport["tokens"]>, baseline?: TokenReport): string[] {
  const api = report.method.api;
  const lines = [`tokens — ${api ? `${api}; approx ${report.method.approx} in brackets` : `approx ${report.method.approx} (no ANTHROPIC_API_KEY)`}`];
  const delta = (now: number, before: number | undefined) => (before === undefined || before === now ? "" : ` (${now > before ? "+" : ""}${n(now - before)} vs baseline)`);
  const show = (value: ContextPiece) => (value.apiTokens !== undefined ? `${n(value.apiTokens)} [${n(value.tokens)}]` : n(value.tokens));
  lines.push("  always-on, per session:");
  for (const [name, surface] of Object.entries(report.surfaces)) {
    lines.push(`    ${name.padEnd(32)} ${show(surface).padStart(13)} tokens${delta(surface.tokens, baseline?.surfaces[name]?.tokens)}  (${surface.parts.join(" + ")})`);
  }
  lines.push("  pieces:");
  for (const [name, value] of Object.entries(report.pieces)) {
    lines.push(`    ${name.padEnd(32)} ${show(value).padStart(13)} tokens  ${n(value.chars)} chars${delta(value.tokens, baseline?.pieces[name]?.tokens)}`);
  }
  lines.push(`  tools (${report.tools.length}), largest first — tokens, description / schema / parameter prose in chars:`);
  const before = new Map((baseline?.tools ?? []).map((tool) => [tool.name, tool.tokens]));
  for (const tool of report.tools) {
    const apiTokens = (tool as ToolCost & { apiTokens?: number }).apiTokens;
    lines.push(`    ${tool.name.padEnd(24)} ${(apiTokens !== undefined ? `${apiTokens} [${tool.tokens}]` : String(tool.tokens)).padStart(11)}  ${String(tool.descriptionChars).padStart(5)} / ${String(tool.schemaChars).padStart(5)} / ${String(tool.parameterProseChars).padStart(5)}  ${tool.parameters} params${before.size && !before.has(tool.name) ? "  (new)" : delta(tool.tokens, before.get(tool.name))}`);
  }
  if (report.usage) {
    const usage = report.usage;
    lines.push(`  tool calls on this Mac, last ${usage.days} days (mcp-usage.jsonl): ${n(usage.calls)} calls, ${usage.sessions} sessions${usage.sized ? `, ${n(usage.sized)} with reply sizes` : "; reply sizes are logged from this version on"}`);
    for (const tool of usage.tools.slice(0, 12)) {
      const size = tool.replyBytes ? `  reply p50 ${kb(tool.replyBytes.p50)} p90 ${kb(tool.replyBytes.p90)}` : "";
      lines.push(`    ${tool.tool.padEnd(24)} ${String(tool.calls).padStart(6)} calls ${`${Math.round(tool.share * 100)}%`.padStart(4)}  p50 ${tool.p50ms} ms  p90 ${tool.p90ms} ms${size}`);
    }
  } else if (report.usage === null) lines.push("  no MCP call log on this Mac");
  if (report.transcripts) {
    const t = report.transcripts;
    lines.push(`  conch tool results in Claude Code transcripts, last ${t.days} days (${n(t.files)} files), most context first:`);
    for (const row of t.results.slice(0, 12)) {
      lines.push(`    ${row.tool.padEnd(24)} ${String(row.calls).padStart(6)} calls  p50 ${kb(row.p50).padStart(7)}  p90 ${kb(row.p90).padStart(7)}  mean ${kb(row.mean).padStart(7)}  total ~${n(Math.round(row.totalBytes / 4))} tokens`);
    }
    const loaded = Object.entries(t.toolSearch.byTool).sort(([, a], [, b]) => b - a).slice(0, 5).map(([name, count]) => `${name} ${count}`).join(", ");
    const skills = Object.entries(t.skillLoads ?? {}).map(([name, count]) => `${name} ${count}×`).join(", ");
    if (skills) lines.push(`    skill loads: ${skills}${t.skillTokensLoaded !== undefined ? ` (~${n(t.skillTokensLoaded)} tokens at today's size)` : ""}`);
    lines.push(`    ToolSearch loads of conch tools: ${t.toolSearch.loads}, ${t.toolSearch.conchToolsLoaded} schemas${t.toolSearch.schemaTokensLoaded !== undefined ? ` (~${n(t.toolSearch.schemaTokensLoaded)} tokens at today's sizes)` : ""}: ${loaded}`);
  }
  return lines;
}

/** A dotted path's value. */
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), value);
}

/** `p50 / p90` of a Stats at `path`, with its change from the baseline's p50 when it moved more than 10%. */
function timing(section: unknown, baseline: unknown, path: string): string {
  const p50 = at(section, `${path}.p50`);
  const p90 = at(section, `${path}.p90`);
  if (typeof p50 !== "number") return "—";
  const was = at(baseline, `${path}.p50`);
  const change = typeof was === "number" && was > 0 && Math.abs(p50 - was) / was > 0.1 ? ` (${p50 > was ? "+" : ""}${Math.round(((p50 - was) / was) * 100)}% vs baseline)` : "";
  return `${p50} / ${typeof p90 === "number" ? p90 : "—"}${change}`;
}

const perMinute = (value: unknown) => (typeof value === "number" ? `${n(Math.round(value))}/min` : "—");
const spawnSite = (key: string) => key.replace(" ← guardedSpawn (runaway.ts)", "");

export function formatCompute(compute: Record<string, unknown>, baseline?: Record<string, unknown>): string[] {
  const lines = ["compute (share of one core; per minute)"];
  const daemon = compute.testDaemon as Record<string, unknown> | undefined;
  if (daemon) {
    const startup = (daemon.startup ?? {}) as Record<string, unknown>;
    lines.push(`  test daemon, ${daemon.sessions} fixture sessions (${daemon.fixtureMB} MB of transcripts): answering in ${startup.firstPongMs} ms, settled after ${startup.settleSeconds} s and ${startup.cpuSecondsToSettle} CPU s`);
    for (const [name, label] of [["rest", "at rest"], ["load", "under load"]] as const) {
      const window = daemon[name] as Record<string, unknown> | undefined;
      if (!window) continue;
      const minute = (window.perMinute ?? {}) as Record<string, unknown>;
      const was = at(baseline, `testDaemon.${name}.cpuPercent`);
      const published = (minute.writtenKB as Record<string, number> | undefined)?.["sessions-file"];
      lines.push(`    ${label.padEnd(11)} ${String(window.cpuPercent).padStart(5)}%${typeof was === "number" ? ` (baseline ${was}%)` : ""}  ${window.rssMB} MB  ${perMinute(minute.fsCalls)} file calls  ${perMinute(minute.spawns)} processes  ${perMinute(minute.publishedWrites)} sessions-file writes${published ? ` (${kb(published * 1024)}/min)` : ""}`);
      const sites = Object.entries((minute.fsBySite ?? {}) as Record<string, number>).slice(0, 5);
      if (sites.length) lines.push(`      file calls from: ${sites.map(([site, count]) => `${site} ${n(Math.round(count))}`).join(" · ")}`);
      const spawned = Object.entries((minute.spawned ?? {}) as Record<string, number>).slice(0, 4);
      if (spawned.length) lines.push(`      processes: ${spawned.map(([site, count]) => `${spawnSite(site)} ${n(Math.round(count))}`).join(" · ")}`);
    }
    if (daemon.publishedStateKB !== undefined) lines.push(`    published sessions file: ${daemon.publishedStateKB} KB`);
  }
  if (compute.mcpServerRssMB !== undefined) lines.push(`  one MCP server (every session runs one): ${compute.mcpServerRssMB} MB resident`);
  const live = compute.live as Record<string, unknown> | undefined;
  if (live) {
    const proc = (key: string, label: string) => {
      const row = live[key] as Record<string, number> | undefined;
      return row ? `${row.processes > 1 ? `${row.processes} ` : ""}${label} ${row.rssMB} MB, ${row.lifetimeCpuPercent}% over ${row.uptimeHours} h (${row.windowCpuPercent}% now)` : undefined;
    };
    const published = live.publishedState as Record<string, number> | undefined;
    const children = Object.entries((live.daemonChildren ?? {}) as Record<string, { processes: number; rssMB: number }>)
      .map(([program, row]) => `${row.processes > 1 ? `${row.processes} ` : ""}${program} ${row.rssMB} MB`).join(", ");
    const parts = [proc("daemon", "daemon"), children ? `its children: ${children}` : undefined, proc("app", "app"), proc("mcpServers", "MCP servers"), published ? `sessions file ${published.kb} KB, ${published.rewritesPerMinute} rewrites/min` : undefined].filter(Boolean);
    lines.push(`  this Mac's live conch (ps, ${live.windowSeconds} s, read only): ${parts.join(" · ")}`);
  }
  return lines;
}

export function formatLatency(latency: Record<string, unknown>, baseline?: Record<string, unknown>): string[] {
  const t = (path: string) => timing(latency, baseline, path);
  const lines = ["latency (p50 / p90 ms)"];
  const row = (label: string, text: string) => lines.push(`  ${label.padEnd(26)} ${text}`);
  if (latency.controlPing) row("control socket ping", `${t("controlPing")}${latency.controlPingUnderLoad ? `   under load ${t("controlPingUnderLoad")}` : ""}`);
  if (latency.controlGetConfig) row("control socket get-config", t("controlGetConfig"));
  if (latency.hook) row(`hooks (${at(latency, "hook.transcriptMB")} MB transcript)`, `UserPromptSubmit ${t("hook.userPromptSubmit")}   Stop ${t("hook.stop")}`);
  if (latency.cliVersion) row("cli start (conch version)", t("cliVersion"));
  if (latency.mcp) {
    row("MCP server cold start", `${t("mcp.coldStartToInitializeMs")}   tools/list ${t("mcp.toolsList")} (${kb(Number(at(latency, "mcp.toolsList.bytes") ?? 0))})   resident ${at(latency, "mcp.serverRssMB")} MB`);
    const calls = (at(latency, "mcp.toolCalls") ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, call] of Object.entries(calls)) row(`  ${name}`, `${t(`mcp.toolCalls.${name}`)}   reply ${kb(Number(call.replyBytes ?? 0))}${call.ok ? "" : " (an error)"}`);
    if (latency.conchSessionsUnderLoad) row("  conch_sessions under load", t("conchSessionsUnderLoad"));
  }
  if (latency.registrySnapshot) row(`registry read (${at(latency, "registrySnapshot.sessions")} sessions)`, t("registrySnapshot"));
  if (latency.transcriptTail) row(`transcript tail (${at(latency, "transcriptTail.transcriptMB")} MB)`, `cold ${at(latency, "transcriptTail.coldMs")}   unchanged ${t("transcriptTail.unchanged")}   after an append ${t("transcriptTail.afterAppend")}`);
  if (latency.transcriptMark) row("inject: prompt count", `${t("transcriptMark")}   (${at(latency, "transcriptMark.transcriptMB")} MB, no cursor)`);
  if (latency.injectPreflight) row("inject: dead-target check", t("injectPreflight"));
  if (latency.ps) row("ps -axo (one process probe)", t("ps"));
  if (latency.publishedStateRows) row("published state: rows", `${t("publishedStateRows")}   (${kb(Number(at(latency, "publishedStateRows.bytes") ?? 0))})`);
  if (latency.publishedStateFile) row(`published file (${at(latency, "publishedStateFile.kb")} KB)`, `parse ${t("publishedStateFile.parse")}   write+rename ${t("publishedStateFile.writeAndRename")}`);
  const whisper = latency.whisper as Record<string, unknown> | undefined;
  if (whisper?.skipped) row("whisper", `skipped: ${whisper.skipped}`);
  else if (whisper) row(`whisper (${whisper.engine}, ${whisper.model})`, `${whisper.audioSeconds} s of speech in ${t("whisper.warmMs")} (first ${whisper.firstRunMs}), real-time factor ${whisper.realTimeFactor}, word error ${whisper.wordErrorRate}`);
  if (latency.benchError) row("micro-benchmarks failed", String(latency.benchError));
  return lines;
}

// ---- the command ----

export const EVALS_HELP = `usage: conch evals [--only tokens|compute|latency[,…]] [--json] [--compare [file]] [--write-baseline [--force]]
                   [--seconds N] [--sessions N] [--since 7d] [--transcripts [7d]] [--no-live] [--offline]

  tokens   what conch puts in every agent's context (instructions, skill, tool schemas), each tool's share, and
           this Mac's tool calls (mcp-usage.jsonl); --transcripts also reads Claude Code's transcripts for result sizes
  compute  a test daemon (its own home, socket and fixtures; never the live one) at rest and under load, with a
           census of what it touches; an MCP server's memory; the live daemon, app and MCP servers by \`ps\` (--no-live skips)
  latency  control socket, hooks, MCP cold start and tool calls, registry and transcript reads, published state,
           inject pre-flight, whisper on a spoken fixture (skipped when the engine isn't installed)

  --compare          against assets/evals-baseline.json (or a file); exit 1 when the agent context is over budget
  --write-baseline   write this run to assets/evals-baseline.json; compute and latency only from an idle machine
  --offline          approximate tokens even when ANTHROPIC_API_KEY is set`;

export interface EvalsOptions {
  sections: EvalSection[];
  json: boolean;
  compare?: string;
  writeBaseline: boolean;
  force: boolean;
  seconds: number;
  sessions: number;
  since: number;
  transcriptsSince?: number;
  live: boolean;
  offline: boolean;
}

export function parseEvalsArgs(argv: readonly string[], now = Date.now()): EvalsOptions | { error: string } {
  const options: EvalsOptions = {
    sections: [...EVAL_SECTIONS], json: false, writeBaseline: false, force: false,
    seconds: 15, sessions: 12, since: now - 7 * 86_400_000, live: true, offline: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const next = () => inline ?? argv[++index];
    const optional = () => inline ?? (argv[index + 1] && !argv[index + 1]!.startsWith("--") ? argv[++index] : undefined);
    if (flag === "--only") {
      const value = next();
      const sections = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      if (!sections.length || sections.some((part) => !EVAL_SECTIONS.includes(part as EvalSection))) return { error: `--only takes ${EVAL_SECTIONS.join(", ")}` };
      options.sections = sections as EvalSection[];
    } else if (flag === "--json") options.json = true;
    else if (flag === "--compare") options.compare = optional() ?? EVALS_BASELINE_PATH;
    else if (flag === "--write-baseline") options.writeBaseline = true;
    else if (flag === "--force") options.force = true;
    else if (flag === "--no-live") options.live = false;
    else if (flag === "--offline") options.offline = true;
    else if (flag === "--seconds" || flag === "--sessions") {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 1 || value > (flag === "--seconds" ? 300 : 64)) return { error: `${flag} takes a whole number (${flag === "--seconds" ? "1-300" : "1-64"})` };
      if (flag === "--seconds") options.seconds = value;
      else options.sessions = value;
    } else if (flag === "--since" || flag === "--transcripts") {
      const raw = flag === "--since" ? next() : optional() ?? "7d";
      const parsed = raw === undefined ? null : parseSince(raw, now);
      if (parsed === null) return { error: `${flag} takes a span (7d, 24h, 2w) or a date` };
      if (flag === "--since") options.since = parsed;
      else options.transcriptsSince = parsed;
    } else if (flag === "--help" || flag === "-h") return { error: "" };
    else return { error: `unknown argument "${arg}"` };
  }
  return options;
}

/** `conch evals`: measure, print, compare, maybe write the baseline. Progress goes to stderr. */
export async function runEvalsCli(argv: readonly string[]): Promise<number> {
  const parsed = parseEvalsArgs(argv);
  if ("error" in parsed) {
    if (parsed.error) console.error(parsed.error);
    console[parsed.error ? "error" : "log"](EVALS_HELP);
    return parsed.error ? 2 : 0;
  }
  const options = parsed;
  const progress = (line: string) => { if (!options.json || process.stderr.isTTY) console.error(`[evals] ${line}`); };
  const report: EvalReport = { v: 1, machine: machineNote() };
  const baseline = options.compare ? readBaseline(options.compare) : null;
  if (options.compare && !baseline) console.error(`[evals] no baseline at ${options.compare}`);

  if (options.sections.includes("tokens")) {
    progress("tokens: the agent-facing context");
    const source = await agentContextSource();
    const tokens: NonNullable<EvalReport["tokens"]> = measureAgentContext(source);
    const key = process.env.ANTHROPIC_API_KEY;
    if (key && !options.offline) {
      progress(`tokens: counting with Anthropic's count_tokens (${COUNT_TOKENS_MODEL})`);
      await countWithAnthropic(source, tokens, key).catch((error) => progress(`count_tokens failed, approximations only: ${error instanceof Error ? error.message : error}`));
    }
    tokens.usage = usageReport(mcpUsagePath(), options.since);
    if (options.transcriptsSince !== undefined) {
      progress("tokens: reading Claude Code transcripts for conch tool results (read only)");
      const { loadConfig } = await import("./config.ts");
      const { readClaudeAccounts } = await import("./claude-accounts.ts");
      const dirs = new Set([loadConfig().claudeDir, ...readClaudeAccounts().map((account) => account.configDir)]);
      tokens.transcripts = await transcriptReport([...dirs], options.transcriptsSince);
      // What those loads cost at today's schemas.
      const cost = new Map(tokens.tools.map((tool) => [tool.name, tool.tokens]));
      tokens.transcripts.toolSearch.schemaTokensLoaded = Object.entries(tokens.transcripts.toolSearch.byTool).reduce((sum, [name, count]) => sum + count * (cost.get(name) ?? 0), 0);
      tokens.transcripts.skillTokensLoaded = Object.entries(tokens.transcripts.skillLoads).reduce((sum, [name, count]) => sum + count * (tokens.pieces[`skill:${name} (on load)`]?.tokens ?? 0), 0);
    }
    report.tokens = tokens;
  }
  if (options.sections.includes("compute") || options.sections.includes("latency")) {
    const { runHarness } = await import("./evals-harness.ts");
    const measured = await runHarness({
      compute: options.sections.includes("compute"),
      latency: options.sections.includes("latency"),
      seconds: options.seconds,
      sessions: options.sessions,
      live: options.live,
      progress,
    });
    if (measured.compute) report.compute = measured.compute;
    if (measured.latency) report.latency = measured.latency;
  }
  report.machine.loadEnd = Math.round(loadavg()[0]! * 100) / 100;
  if (report.compute || report.latency) report.machine.run = { seconds: options.seconds, sessions: options.sessions };
  if ((report.compute || report.latency) && machineTooBusy(report.machine)) report.machine.note = `busy: load ${Math.max(report.machine.loadStart, report.machine.loadEnd)} on ${report.machine.cores} cores; compute and latency are inflated`;

  let code = 0;
  const breaches = baseline?.tokens && report.tokens ? contextBreaches(baseline.tokens, report.tokens) : [];
  if (breaches.length) code = 1;
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    const m = report.machine;
    console.log(`conch ${m.conch} evals · ${m.model ?? ""} ${m.cpu ?? ""} · ${m.cores} cores · load ${m.loadStart}→${m.loadEnd}${m.note ? ` · ${m.note}` : ""}`);
    if (baseline && (report.compute || report.latency)) console.log(`  baseline compute/latency: ${baseline.machine.at} · load ${baseline.machine.loadStart}${baseline.machine.note ? ` · ${baseline.machine.note}` : ""}`);
    if (report.tokens) for (const line of formatTokens(report.tokens, baseline?.tokens)) console.log(line);
    if (report.compute) for (const line of formatCompute(report.compute, baseline?.compute)) console.log(line);
    if (report.latency) for (const line of formatLatency(report.latency, baseline?.latency)) console.log(line);
  }
  if (baseline?.tokens && report.tokens) {
    if (breaches.length) {
      console.error(`[evals] the agent context grew past its budget (+${CONTEXT_BUDGET * 100}% over ${options.compare}):`);
      for (const breach of breaches) console.error(`  ${breach.what}: ${breach.baseline} → ${breach.now} tokens (limit ${breach.limit})`);
    } else console.error(`[evals] agent context within budget of ${options.compare}`);
  }
  if (options.writeBaseline) {
    const { baseline: next, kept } = baselineFrom(report, readBaseline(EVALS_BASELINE_PATH), options.force);
    writeFileSync(EVALS_BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.error(`[evals] wrote ${EVALS_BASELINE_PATH}${kept.length ? ` (kept the previous ${kept.join(" and ")}: the machine was busy; --force to override)` : ""}`);
  }
  return code;
}

