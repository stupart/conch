import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClaudeAccount } from "./claude-accounts.ts";
import { conchHome } from "./home.ts";

/**
 * Claude Code's workflows (2026-11-11), for Settings › Workflows. Tyler wanted skills and workflows "much more pleasurable
 * to use", and conch had no notion of a workflow beyond the tool call it draws in a conversation.
 *
 * What Claude Code means by one, read from Claude Code 2.1.322 itself (its Workflow tool's schema, its loader and its
 * `/workflows` command): a workflow is a plain JavaScript script that orchestrates subagents (`agent()`, `parallel()`,
 * `pipeline()`, `phase()`), whose first statement is `export const meta = { name, description, whenToUse?, phases? }`,
 * a pure literal. A session writes one on the fly and runs it with the Workflow tool, or runs a saved one by name.
 * Saved ones live in three places:
 *
 * - the person's: `<config dir>/workflows/*.js`, per Claude account;
 * - a project's: `.claude/workflows/*.js` in the session's folder and the folders above it, nearest winning;
 * - a plugin's: `<plugin>/workflows/*.js`, named `<plugin>:<name>`.
 *
 * Only `.js` loads (a `.ts`, `.mjs` or `.cjs` is skipped as a near miss), up to 512 KB, and one whose meta doesn't parse is
 * skipped too. Each saved workflow is a slash command, `/<name> [args]`, which asks the session to run it with the
 * Workflow tool, so starting one in a session is typing that line. A run's progress is the session's: its record in
 * `<session>/workflows/wf_<id>.json` once it ends, its journal (`launched`, then `started` and `result` per agent, each
 * under a phase) in `<session>/subagents/workflows/wf_<id>/journal.jsonl` while it goes, and the script it ran in
 * `<session>/workflows/scripts/<name>-wf_<id>.js`. The feature is a setting (`enableWorkflows`, `disableWorkflows`) and
 * defaults by plan.
 *
 * Read only: nothing here writes a workflow or starts a run.
 */

export const WORKFLOW_MAX_BYTES = 512 * 1024;
const TEXT_MAX = 360;
const PHASES_MAX = 24;
const RUNS_MAX = 30;
/** How long a finished run stays listed. */
const RECENT_MS = 12 * 60 * 60 * 1_000;
const RECORD_MAX_BYTES = 8 * 1024 * 1024;
const JOURNAL_MAX_BYTES = 32 * 1024 * 1024;

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name: string;
  description?: string;
  whenToUse?: string;
  phases: WorkflowPhase[];
}

// MARK: - The meta literal

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

/**
 * `export const meta = { … }`, the script's first statement, read as the pure literal Claude Code requires: strings,
 * numbers, booleans, null, arrays and objects, with comments and trailing commas. Never evaluated: a variable, a call, a
 * spread or an interpolation is refused, as Claude Code refuses it.
 */
export function parseWorkflowMeta(script: string): { meta: WorkflowMeta } | { error: string } {
  let index = 0;
  const fail = (why: string) => { throw new Error(why); };
  const skip = () => {
    while (index < script.length) {
      const ch = script[index]!;
      if (/\s/.test(ch)) index += 1;
      else if (script.startsWith("//", index)) {
        const end = script.indexOf("\n", index);
        index = end === -1 ? script.length : end + 1;
      } else if (script.startsWith("/*", index)) {
        const end = script.indexOf("*/", index + 2);
        if (end === -1) fail("a comment never closes");
        index = end + 2;
      } else break;
    }
  };
  const string = (): string => {
    const quote = script[index]!;
    index += 1;
    let out = "";
    while (index < script.length) {
      const ch = script[index]!;
      if (ch === quote) { index += 1; return out; }
      if (quote === "`" && ch === "$" && script[index + 1] === "{") fail("meta must be a pure literal: no interpolation");
      if (ch === "\\") {
        const next = script[index + 1];
        const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "`": "`", "\\": "\\", "\n": "" };
        if (next === "u") {
          const hex = /^[0-9a-fA-F]{4}/.exec(script.slice(index + 2))?.[0];
          if (!hex) fail("a string has a broken \\u escape");
          out += String.fromCharCode(parseInt(hex!, 16));
          index += 6;
          continue;
        }
        out += next !== undefined && next in escapes ? escapes[next]! : (next ?? "");
        index += 2;
        continue;
      }
      if (ch === "\n" && quote !== "`") fail("a string runs past the end of its line");
      out += ch;
      index += 1;
    }
    return fail("a string never closes");
  };
  let depth = 0;
  const value = (): Literal => {
    skip();
    const ch = script[index];
    if (ch === undefined) return fail("meta ends early");
    if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth > 8) fail("meta nests too deeply");
      index += 1;
      const close = ch === "{" ? "}" : "]";
      const out: Literal = ch === "{" ? {} : [];
      while (true) {
        skip();
        if (script[index] === close) { index += 1; break; }
        if (Array.isArray(out)) {
          out.push(value());
        } else {
          let key: string;
          if (script[index] === "'" || script[index] === '"') key = string();
          else {
            const word = /^[A-Za-z_$][\w$]*/.exec(script.slice(index, index + 128))?.[0];
            if (!word) fail("meta must be a pure literal: a key that isn't a name or a string");
            key = word!;
            index += key.length;
          }
          skip();
          if (script[index] !== ":") fail(`meta must be a pure literal: ${key} has no value`);
          index += 1;
          (out as Record<string, Literal>)[key] = value();
        }
        skip();
        if (script[index] === ",") { index += 1; continue; }
        if (script[index] === close) { index += 1; break; }
        fail("meta must be a pure literal: something other than a value follows one");
      }
      depth -= 1;
      return out;
    }
    if (ch === "'" || ch === '"' || ch === "`") return string();
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(script.slice(index, index + 64))?.[0];
    if (number) { index += number.length; return Number(number); }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (script.startsWith(word, index) && !/[\w$]/.test(script[index + word.length] ?? "")) {
        index += word.length;
        return literal;
      }
    }
    return fail("meta must be a pure literal: no variables, calls or spreads");
  };
  try {
    skip();
    const head = /^export\s+const\s+meta\s*=\s*/.exec(script.slice(index, index + 256));
    if (!head) return { error: "`export const meta = { name, description, phases }` must be the first statement" };
    index += head[0].length;
    if (script[index] !== "{") return { error: "meta must be an object" };
    const parsed = value();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "meta must be an object" };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) return { error: "meta has no name" };
    const text = (raw: Literal | undefined) => typeof raw === "string" && raw.trim() ? clip(raw, TEXT_MAX) : undefined;
    const phases: WorkflowPhase[] = [];
    if (Array.isArray(parsed.phases)) {
      for (const phase of parsed.phases.slice(0, PHASES_MAX)) {
        if (!phase || typeof phase !== "object" || Array.isArray(phase) || typeof phase.title !== "string" || !phase.title.trim()) continue;
        const detail = text(phase.detail);
        phases.push({ title: clip(phase.title, 80), ...(detail ? { detail: clip(detail, 160) } : {}) });
      }
    }
    const description = text(parsed.description);
    const whenToUse = text(parsed.whenToUse);
    return { meta: { name: clip(name, 128), ...(description ? { description } : {}), ...(whenToUse ? { whenToUse } : {}), phases } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// MARK: - Saved workflows

export type WorkflowOrigin = "user" | "project" | "plugin";

export interface WorkflowLocation {
  agent: "claude";
  /** The conch account; absent for a project's, which every account loads in that folder. */
  accountId?: string;
  accountLabel?: string;
  origin: WorkflowOrigin;
  path: string;
  projectPath?: string;
  pluginId?: string;
  /** For the next session: false when its plugin is switched off; null where nothing says. */
  enabled: boolean | null;
  /** How it is typed: `/name`, `/plugin:name`. */
  invocation: string;
  digest: string;
}

export interface WorkflowEntry {
  /** `<origin family>:<name>`: stable across reads. */
  id: string;
  name: string;
  description?: string;
  whenToUse?: string;
  phases: WorkflowPhase[];
  origin: WorkflowOrigin;
  plugin?: string;
  locations: WorkflowLocation[];
  /** How many different texts its locations hold. */
  versions: number;
  /** Why Claude Code skips it, when it does: a meta that doesn't parse, the wrong extension, too big. */
  problem?: string;
}

/** An account, and whether workflows are on for it as its settings say. */
export interface WorkflowAccount {
  id: string;
  label: string;
  configDir: string;
  /** "off" when its settings turn the feature off, "on" when they turn it on, "default" to leave it to the plan. */
  feature: "on" | "off" | "default";
  workflows: number;
}

export interface WorkflowsRead {
  accounts: WorkflowAccount[];
  workflows: WorkflowEntry[];
  problems: string[];
  readAt: number;
}

export interface WorkflowHomes {
  claudeAccounts: ClaudeAccount[];
  /** Folders sessions work in: each, and the folders above it below home, is a project whose workflows load there. */
  projectFolders: string[];
  /** One account's plugins, where they are installed and whether they are on (skills-library.ts passes the capability
   * read's); none when absent. */
  plugins?(account: ClaudeAccount): Array<{ pluginId: string; installPath: string; enabled: boolean | null }>;
  /** Where the walk up from a working folder stops: home, by default. */
  home?: string;
}

function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); } catch { return []; }
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

interface Found {
  meta?: WorkflowMeta;
  problem?: string;
  /** The file's own name, for one whose meta can't say. */
  fallbackName: string;
  location: WorkflowLocation;
}

/** The workflows in one folder, as Claude Code's loader reads it: every `.js`, and the near misses it skips, said. */
export function scanWorkflowFolder(folder: string, location: Omit<WorkflowLocation, "path" | "digest" | "invocation">, prefix = ""): Found[] {
  const found: Found[] = [];
  for (const entry of entries(folder)) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const path = join(folder, entry.name);
    const stem = entry.name.replace(/\.(js|mjs|cjs|ts)$/, "");
    if (!entry.name.endsWith(".js")) {
      if (/\.(mjs|cjs|ts)$/.test(entry.name)) {
        found.push({ fallbackName: stem, problem: "Claude Code reads only .js workflows, so it skips this one.",
          location: { ...location, path, invocation: `/${prefix}${stem}`, digest: "" } });
      }
      continue;
    }
    let text: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.size > WORKFLOW_MAX_BYTES) {
        found.push({ fallbackName: stem, problem: "It is over 512 KB, so Claude Code skips it.",
          location: { ...location, path, invocation: `/${prefix}${stem}`, digest: "" } });
        continue;
      }
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseWorkflowMeta(text);
    if ("error" in parsed) {
      found.push({ fallbackName: stem, problem: `Its meta can't be read (${parsed.error}), so Claude Code skips it.`,
        location: { ...location, path, invocation: `/${prefix}${stem}`, digest: digestOf(text) } });
      continue;
    }
    found.push({ meta: parsed.meta, fallbackName: stem,
      location: { ...location, path, invocation: `/${prefix}${parsed.meta.name}`, digest: digestOf(text) } });
  }
  return found.sort((a, b) => a.location.path.localeCompare(b.location.path));
}

/** Whether an account's settings turn workflows on or off: `disableWorkflows` wins, then `enableWorkflows`. */
export function workflowFeature(configDir: string): "on" | "off" | "default" {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "default";
    const values = settings as Record<string, unknown>;
    if (values.disableWorkflows === true || values.enableWorkflows === false) return "off";
    if (values.enableWorkflows === true) return "on";
  } catch {}
  return "default";
}

/** Each working folder and the folders above it, below home, once each: where a project's `.claude/workflows` loads. */
export function workflowProjectFolders(folders: readonly string[], home = conchHome()): string[] {
  const out = new Set<string>();
  for (const folder of folders.slice(0, 64)) {
    let current = folder;
    while (current.startsWith(`${home}/`) && current !== home) {
      out.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...out].sort();
}

/** Every saved workflow on this Mac, one entry per workflow (its family and name), its places listed. */
export function readWorkflows(homes: WorkflowHomes, now = Date.now): WorkflowsRead {
  const found: Found[] = [];
  const problems: string[] = [];
  const accounts: WorkflowAccount[] = [];
  for (const account of homes.claudeAccounts) {
    accounts.push({ id: account.id, label: account.label, configDir: account.configDir, feature: workflowFeature(account.configDir), workflows: 0 });
    const where = { agent: "claude" as const, accountId: account.id, accountLabel: account.label };
    found.push(...scanWorkflowFolder(join(account.configDir, "workflows"), { ...where, origin: "user", enabled: true }));
    let plugins: Array<{ pluginId: string; installPath: string; enabled: boolean | null }> = [];
    try {
      plugins = homes.plugins?.(account) ?? [];
    } catch (error) {
      problems.push(`Claude Code · ${account.label}: its plugins could not be read (${error instanceof Error ? error.message : String(error)}).`);
    }
    for (const plugin of plugins) {
      const name = plugin.pluginId.split("@")[0]!;
      found.push(...scanWorkflowFolder(join(plugin.installPath, "workflows"),
        { ...where, origin: "plugin", pluginId: plugin.pluginId, enabled: plugin.enabled }, `${name}:`));
    }
  }
  for (const folder of workflowProjectFolders(homes.projectFolders, homes.home)) {
    const root = join(folder, ".claude", "workflows");
    if (!existsSync(root)) continue;
    found.push(...scanWorkflowFolder(root, { agent: "claude", origin: "project", projectPath: folder, enabled: null }));
  }
  const groups = new Map<string, Found[]>();
  for (const item of found) {
    const name = item.location.invocation.slice(1);
    const family = item.location.origin === "plugin" ? "plugin" : "own";
    const key = `${family}:${name}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const workflows: WorkflowEntry[] = [];
  for (const [id, members] of groups) {
    const lead = members.find((member) => member.meta) ?? members[0]!;
    const rank = { user: 0, project: 1, plugin: 2 } as const;
    const origin = members.map((member) => member.location.origin).sort((a, b) => rank[a] - rank[b])[0]!;
    const plugin = members.find((member) => member.location.pluginId)?.location.pluginId?.split("@")[0];
    const problem = members.every((member) => member.problem) ? lead.problem : undefined;
    workflows.push({
      id,
      name: lead.location.invocation.slice(1),
      ...(lead.meta?.description ? { description: lead.meta.description } : {}),
      ...(lead.meta?.whenToUse ? { whenToUse: lead.meta.whenToUse } : {}),
      phases: lead.meta?.phases ?? [],
      origin,
      ...(plugin ? { plugin } : {}),
      locations: members.map((member) => member.location),
      versions: new Set(members.map((member) => member.location.digest)).size,
      ...(problem ? { problem } : {}),
    });
  }
  workflows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  for (const account of accounts) {
    account.workflows = workflows.filter((workflow) => workflow.locations.some((location) => location.accountId === account.id)).length;
  }
  return { accounts, workflows, problems, readAt: now() };
}

// MARK: - Runs

/** A live session whose workflow runs are looked for: its transcript says where its folder is. */
export interface WorkflowSession {
  id: string;
  label: string;
  transcriptPath?: string;
}

export interface WorkflowRunPhase {
  title: string;
  detail?: string;
  /** Agents started under it, and finished. */
  started: number;
  done: number;
}

export interface WorkflowRun {
  runId: string;
  sessionId: string;
  sessionLabel: string;
  name: string;
  /** "running" while it has no record; else the record's own word ("completed", or how it ended). */
  status: string;
  phases: WorkflowRunPhase[];
  /** The phase the newest unfinished agent is in, while it runs. */
  currentPhase?: string;
  agents: { started: number; done: number };
  startedAt?: number;
  /** When its journal or record last moved. */
  updatedAt: number;
  durationMs?: number;
  summary?: string;
}

const RUN_ID = /^wf_[A-Za-z0-9-]{1,64}$/;

function readJson(path: string, max: number): Record<string, unknown> | undefined {
  try {
    if (statSync(path).size > max) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** A journal's agents, by phase: who started under which, and who has a result. */
export function journalProgress(text: string): { phases: Map<string, { started: number; done: number }>; order: string[]; current?: string } {
  const phaseOf = new Map<string, string>();
  const done = new Set<string>();
  const order: string[] = [];
  let lastOpen: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { continue; }
    const agent = typeof event.agentId === "string" ? event.agentId : typeof event.key === "string" ? event.key : undefined;
    if (!agent) continue;
    if (event.type === "started") {
      const phase = typeof event.phase === "string" ? event.phase : "";
      phaseOf.set(agent, phase);
      if (!order.includes(phase)) order.push(phase);
      lastOpen = agent;
    } else if (event.type === "result") {
      done.add(agent);
    }
  }
  const phases = new Map<string, { started: number; done: number }>();
  for (const [agent, phase] of phaseOf) {
    const count = phases.get(phase) ?? { started: 0, done: 0 };
    count.started += 1;
    if (done.has(agent)) count.done += 1;
    phases.set(phase, count);
  }
  const open = [...phaseOf.keys()].filter((agent) => !done.has(agent));
  const current = open.length ? phaseOf.get(open.at(-1)!) : lastOpen ? phaseOf.get(lastOpen) : undefined;
  return { phases, order, ...(current ? { current } : {}) };
}

/** The workflow runs of live sessions: every one still going, and those that ended in the last twelve hours. */
export function readWorkflowRuns(sessions: readonly WorkflowSession[], now = Date.now()): WorkflowRun[] {
  const runs: WorkflowRun[] = [];
  for (const session of sessions) {
    if (!session.transcriptPath?.endsWith(".jsonl")) continue;
    const folder = session.transcriptPath.slice(0, -".jsonl".length);
    const records = new Map<string, string>();
    for (const entry of entries(join(folder, "workflows"))) {
      const id = entry.name.replace(/\.json$/, "");
      if (entry.isFile() && entry.name.endsWith(".json") && RUN_ID.test(id)) records.set(id, join(folder, "workflows", entry.name));
    }
    const journals = new Map<string, string>();
    for (const entry of entries(join(folder, "subagents", "workflows"))) {
      if (entry.isDirectory() && RUN_ID.test(entry.name)) journals.set(entry.name, join(folder, "subagents", "workflows", entry.name, "journal.jsonl"));
    }
    const scripts = entries(join(folder, "workflows", "scripts")).map((entry) => entry.name);
    for (const runId of new Set([...records.keys(), ...journals.keys()])) {
      const recordPath = records.get(runId);
      const journalPath = journals.get(runId);
      const recordStat = recordPath ? safeStat(recordPath) : undefined;
      const journalStat = journalPath ? safeStat(journalPath) : undefined;
      const updatedAt = Math.max(recordStat?.mtimeMs ?? 0, journalStat?.mtimeMs ?? 0);
      if (!updatedAt) continue;
      if (recordPath && now - updatedAt > RECENT_MS) continue;
      const record = recordPath ? readJson(recordPath, RECORD_MAX_BYTES) : undefined;
      let progress: ReturnType<typeof journalProgress> | undefined;
      if (journalPath && journalStat && journalStat.size <= JOURNAL_MAX_BYTES) {
        try { progress = journalProgress(readFileSync(journalPath, "utf8")); } catch {}
      }
      // Its declared phases: the record's, or the meta of the script it ran.
      let declared: WorkflowPhase[] = [];
      let name = typeof record?.workflowName === "string" ? record.workflowName : undefined;
      if (Array.isArray(record?.phases)) {
        declared = (record.phases as unknown[]).flatMap((phase) => phase && typeof phase === "object" && typeof (phase as Record<string, unknown>).title === "string"
          ? [{ title: clip((phase as Record<string, string>).title!, 80), ...(typeof (phase as Record<string, unknown>).detail === "string" ? { detail: clip((phase as Record<string, string>).detail!, 160) } : {}) }]
          : []);
      }
      if (!name || declared.length === 0) {
        const script = scripts.find((file) => file.endsWith(`-${runId}.js`));
        if (script) {
          try {
            const parsed = parseWorkflowMeta(readFileSync(join(folder, "workflows", "scripts", script), "utf8").slice(0, WORKFLOW_MAX_BYTES));
            if ("meta" in parsed) {
              name ??= parsed.meta.name;
              if (declared.length === 0) declared = parsed.meta.phases;
            }
          } catch {}
          name ??= script.slice(0, -`-${runId}.js`.length);
        }
      }
      const titles = [...declared.map((phase) => phase.title), ...(progress?.order ?? []).filter((title) => title && !declared.some((phase) => phase.title === title))];
      const phases: WorkflowRunPhase[] = titles.slice(0, PHASES_MAX).map((title) => {
        const count = progress?.phases.get(title) ?? { started: 0, done: 0 };
        const detail = declared.find((phase) => phase.title === title)?.detail;
        return { title, ...(detail ? { detail } : {}), started: count.started, done: count.done };
      });
      const agents = { started: 0, done: 0 };
      for (const count of progress?.phases.values() ?? []) { agents.started += count.started; agents.done += count.done; }
      if (!progress && typeof record?.agentCount === "number") { agents.started = record.agentCount; agents.done = record.agentCount; }
      const status = record ? (typeof record.status === "string" ? record.status : "ended") : "running";
      const startedAt = typeof record?.startTime === "number" ? record.startTime : journalStat?.birthtimeMs;
      runs.push({
        runId,
        sessionId: session.id,
        sessionLabel: session.label,
        name: clip(name ?? "workflow", 128),
        status: clip(status, 24),
        phases,
        ...(status === "running" && progress?.current ? { currentPhase: progress.current } : {}),
        agents,
        ...(startedAt ? { startedAt: Math.round(startedAt) } : {}),
        updatedAt: Math.round(updatedAt),
        ...(typeof record?.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        ...(typeof record?.summary === "string" && record.summary.trim() ? { summary: clip(record.summary, 300) } : {}),
      });
    }
  }
  // Running first, then the newest.
  return runs.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt - a.updatedAt).slice(0, RUNS_MAX);
}

function safeStat(path: string) {
  try { return statSync(path); } catch { return undefined; }
}
