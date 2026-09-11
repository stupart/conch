/**
 * The write pass (B3): flip a plugin or MCP server on or off for the NEXT
 * session, in the file the agent itself reads, the way the agent's own
 * commands would.
 *
 * Where each agent keeps the switch (verified against Claude Code 2.1.266 and
 * Codex 0.153.4; `agent-capabilities.ts` reads exactly these shapes):
 *
 * - Claude plugin: `enabledPlugins["name@marketplace"]: bool` in
 *   `~/.claude/settings.json` (user) or `<project>/.claude/settings.json`
 *   (project) — `claude plugin enable|disable --scope user|project`.
 * - Claude MCP server: per PROJECT only. The `/mcp` toggle writes
 *   `projects["<dir>"].disabledMcpServers` in `~/.claude.json` for a server
 *   defined in that file (user or local scope); a server from
 *   `<project>/.mcp.json` is approved or rejected through
 *   `enabledMcpjsonServers` / `disabledMcpjsonServers` in the same entry.
 * - Codex plugin: `[plugins."name@marketplace"] enabled = bool` in
 *   `~/.codex/config.toml` (user) or `<project>/.codex/config.toml` (project).
 * - Codex MCP server: `[mcp_servers.<name>] enabled = bool`, same two files;
 *   `codex mcp list` shows the result as Status disabled.
 *
 * Nothing here installs, removes, or edits a definition. A plan is computed
 * first and carries the unified diff; applying writes a temp file and renames
 * it, keeps `<file>.conch-backup-<ms>` (the newest three), reads the file
 * back, and refuses — restoring the previous bytes — when it does not parse
 * or does not carry the change.
 *
 * TOML has a parser in Bun (`Bun.TOML.parse`) but no serializer, so the edit
 * is an exact-line one: only the `enabled = …` line under the one table
 * header moves, and the result is re-parsed and compared with the parsed
 * original plus the change to prove nothing else moved. JSON is re-emitted
 * with the file's own indentation, which is byte-identical for files the
 * agents wrote themselves.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ConfigWriteAgent = "claude" | "codex";
export type ConfigWriteScope = "user" | "project";
export type ConfigWriteCapability = "plugin" | "mcp-server";

export interface ConfigToggleRequest {
  agent: ConfigWriteAgent;
  scope: ConfigWriteScope;
  /** Required for project scope; the session's working directory. */
  projectDir?: string;
  capability: ConfigWriteCapability;
  /** The config key: `name@marketplace` for a plugin, the server name for an MCP server. */
  id: string;
  enabled: boolean;
}

export interface ConfigWriteHomes {
  claudeHome: string;
  /** `~/.claude.json` — Claude's state file, where its per-project MCP lists live. */
  claudeStatePath: string;
  codexHome: string;
}

export interface ConfigTogglePlan extends ConfigToggleRequest {
  file: string;
  /** Empty when the file does not exist yet. */
  before: string;
  after: string;
  /** Unified diff of before → after; empty when nothing would change. */
  diff: string;
  beforeHash: string;
  /** The agents read these files at start; a running session is untouched. */
  appliesNextSession: true;
}

export interface ConfigApplyResult {
  file: string;
  backup?: string;
}

/** Test seams: a rename that fails, or a readback that lies. */
export interface ConfigWriteIo {
  rename?: (from: string, to: string) => void;
  readBack?: (file: string) => string;
}

export const BACKUP_KEEP = 3;
const BACKUP_INFIX = ".conch-backup-";
const CLAUDE_LOCK_STALE_MS = 10_000;

export function defaultConfigWriteHomes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigWriteHomes {
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return {
    claudeHome,
    claudeStatePath: join(dirname(claudeHome), ".claude.json"),
    codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
  };
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function parseJsonFile(file: string, text: string): JsonRecord {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

function parseTomlFile(file: string, text: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!record(parsed)) throw new Error(`${file} is not a TOML table`);
  return parsed;
}

function parseByExtension(file: string, text: string): JsonRecord {
  return file.endsWith(".toml") ? parseTomlFile(file, text) : parseJsonFile(file, text);
}

export function contentHash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// ── diff ─────────────────────────────────────────────────────────────────────

/**
 * A unified diff with one hunk. Every edit here is one contiguous region
 * (one line changed or inserted), so common prefix + common suffix IS the
 * diff. ponytail: no LCS; a second hunk would need a real line diff.
 */
export function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;
  const context = 3;
  const aStart = Math.max(0, prefix - context);
  const aEnd = Math.min(a.length, a.length - suffix + context);
  const bStart = Math.max(0, prefix - context);
  const bEnd = Math.min(b.length, b.length - suffix + context);
  const range = (start: number, end: number) => `${end - start === 0 ? start : start + 1},${end - start}`;
  const lines = [
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -${range(aStart, aEnd)} +${range(bStart, bEnd)} @@`,
  ];
  for (let i = aStart; i < prefix; i += 1) lines.push(` ${a[i]}`);
  for (let i = prefix; i < a.length - suffix; i += 1) lines.push(`-${a[i]}`);
  for (let i = prefix; i < b.length - suffix; i += 1) lines.push(`+${b[i]}`);
  for (let i = a.length - suffix; i < aEnd; i += 1) lines.push(` ${a[i]}`);
  return lines.join("\n") + "\n";
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ── JSON ─────────────────────────────────────────────────────────────────────

function jsonIndent(text: string): string | number {
  const match = /\n([ \t]+)"/.exec(text);
  return match ? match[1]! : 2;
}

function emitJson(before: string, value: JsonRecord): string {
  const text = JSON.stringify(value, null, jsonIndent(before));
  return before && !before.endsWith("\n") ? text : `${text}\n`;
}

function stringList(owner: JsonRecord, key: string, file: string): string[] {
  const current = owner[key];
  if (current === undefined) return [];
  if (!Array.isArray(current) || current.some((entry) => typeof entry !== "string")) {
    throw new Error(`${file}: ${key} is not a list of names; conch will not edit it.`);
  }
  return current as string[];
}

function withMember(list: string[], name: string, present: boolean): string[] {
  const without = list.filter((entry) => entry !== name);
  return present ? [...without, name] : without;
}

// ── TOML ─────────────────────────────────────────────────────────────────────

/** `[a.b."c@d"]` → ["a","b","c@d"]; null for anything that is not a plain table header. */
export function tomlHeaderPath(line: string): string[] | null {
  const match = /^\s*\[(?!\[)([^\]]*)\]\s*(#.*)?$/.exec(line);
  if (!match) return null;
  const inner = match[1]!;
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ".") {
      segments.push(current.trim());
      current = "";
    } else current += ch;
  }
  segments.push(current.trim());
  return quote || segments.some((segment) => !segment) ? null : segments;
}

function tomlKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : `"${segment}"`;
}

/**
 * Set `enabled` under one table, touching nothing else. Throws in words when
 * the table is absent (unless `create`), or is written in a form this editor
 * does not edit (inline table, dotted keys, a non-boolean `enabled`).
 */
export function tomlSetEnabled(
  file: string,
  text: string,
  path: string[],
  enabled: boolean,
  create: boolean,
): string {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => {
    const parsed = tomlHeaderPath(line);
    return parsed !== null && parsed.length === path.length && parsed.every((s, i) => s === path[i]);
  });
  const headerText = `[${path.map(tomlKey).join(".")}]`;
  if (header === -1) {
    const parsed = parseTomlFile(file, text);
    const existing = path.reduce<unknown>((node, key) => record(node) ? node[key] : undefined, parsed);
    if (existing !== undefined) {
      throw new Error(`${file}: ${headerText} is written in a form conch does not edit (inline table or dotted keys).`);
    }
    if (!create) throw new Error(`${file}: ${headerText} is not defined; conch does not add entries.`);
    const base = text === "" ? "" : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
    return `${base}${headerText}\nenabled = ${enabled}\n`;
  }
  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
  for (let i = header + 1; i < end; i += 1) {
    const line = lines[i]!;
    if (!/^\s*enabled\s*=/.test(line)) continue;
    const match = /^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?)$/.exec(line);
    if (!match) throw new Error(`${file}: enabled under ${headerText} is not a bare boolean; conch will not edit it.`);
    lines[i] = `${match[1]}${enabled}${match[3]}`;
    return lines.join("\n");
  }
  lines.splice(header + 1, 0, `enabled = ${enabled}`);
  return lines.join("\n");
}

// ── planning ─────────────────────────────────────────────────────────────────

function withPath(root: JsonRecord, path: string[], value: unknown): JsonRecord {
  const clone = structuredClone(root);
  let node: JsonRecord = clone;
  for (const key of path.slice(0, -1)) {
    if (!record(node[key])) node[key] = {};
    node = node[key] as JsonRecord;
  }
  node[path[path.length - 1]!] = value;
  return clone;
}

function projectDirOf(request: ConfigToggleRequest): string {
  if (request.scope !== "project") return "";
  if (!request.projectDir) throw new Error("project scope needs the project directory.");
  return resolve(request.projectDir);
}

function planClaudePlugin(request: ConfigToggleRequest, homes: ConfigWriteHomes, projectDir: string) {
  const ledgerPath = join(homes.claudeHome, "plugins", "installed_plugins.json");
  const ledger = parseJsonFile(ledgerPath, readText(ledgerPath));
  const installs = record(ledger.plugins) ? ledger.plugins[request.id] : undefined;
  if (!Array.isArray(installs) || installs.length === 0) {
    throw new Error(`Claude plugin "${request.id}" is not installed (not in ${ledgerPath}); conch does not install plugins.`);
  }
  const file = request.scope === "user"
    ? join(homes.claudeHome, "settings.json")
    : join(projectDir, ".claude", "settings.json");
  const before = readText(file);
  const parsed = parseJsonFile(file, before);
  if (parsed.enabledPlugins !== undefined && !record(parsed.enabledPlugins)) {
    throw new Error(`${file}: enabledPlugins is not an object; conch will not edit it.`);
  }
  const expected = withPath(parsed, ["enabledPlugins", request.id], request.enabled);
  return { file, before, after: emitJson(before, expected), expected };
}

function planClaudeMcpServer(request: ConfigToggleRequest, homes: ConfigWriteHomes, projectDir: string) {
  const file = homes.claudeStatePath;
  if (request.scope !== "project") {
    throw new Error(`Claude Code records MCP server enablement per project (in ${file}); choose project scope.`);
  }
  const before = readText(file);
  if (!before) throw new Error(`${file} does not exist; Claude Code has not run yet.`);
  const state = parseJsonFile(file, before);
  const projects = record(state.projects) ? state.projects : {};
  const project = projects[projectDir];
  if (!record(project)) {
    throw new Error(`${file} has no entry for ${projectDir}; open the project in Claude Code once first.`);
  }
  const mcpJsonPath = join(projectDir, ".mcp.json");
  const mcpJson = parseJsonFile(mcpJsonPath, readText(mcpJsonPath));
  const name = request.id;
  const fromProjectFile = record(mcpJson.mcpServers) && Object.hasOwn(mcpJson.mcpServers, name);
  const standalone = (record(state.mcpServers) && Object.hasOwn(state.mcpServers, name))
    || (record(project.mcpServers) && Object.hasOwn(project.mcpServers, name));
  if (!fromProjectFile && !standalone) {
    throw new Error(
      `MCP server "${name}" is not defined for Claude in ${mcpJsonPath}, ${file} mcpServers, `
      + `or the ${projectDir} entry; conch does not add servers.`,
    );
  }
  const next: JsonRecord = { ...project };
  if (fromProjectFile) {
    next.enabledMcpjsonServers = withMember(stringList(project, "enabledMcpjsonServers", file), name, request.enabled);
    next.disabledMcpjsonServers = withMember(stringList(project, "disabledMcpjsonServers", file), name, !request.enabled);
  } else {
    next.disabledMcpServers = withMember(stringList(project, "disabledMcpServers", file), name, !request.enabled);
  }
  const expected = withPath(state, ["projects", projectDir], next);
  return { file, before, after: emitJson(before, expected), expected };
}

function planCodex(request: ConfigToggleRequest, homes: ConfigWriteHomes, projectDir: string) {
  const userFile = join(homes.codexHome, "config.toml");
  const file = request.scope === "user" ? userFile : join(projectDir, ".codex", "config.toml");
  const before = readText(file);
  const parsed = parseTomlFile(file, before);
  const table = request.capability === "plugin" ? "plugins" : "mcp_servers";
  const path = [table, request.id];
  if (request.capability === "plugin") {
    const named = [parsed, file === userFile ? {} : parseTomlFile(userFile, readText(userFile))]
      .some((config) => record(config.plugins) && record(config.plugins[request.id]));
    if (!named) {
      throw new Error(`Codex plugin "${request.id}" is not named in ${file}${file === userFile ? "" : ` or ${userFile}`}; conch does not install plugins.`);
    }
  }
  const after = tomlSetEnabled(file, before, path, request.enabled, request.capability === "plugin");
  const expected = withPath(parsed, [...path, "enabled"], request.enabled);
  return { file, before, after, expected };
}

/** Compute the edit without touching the disk. Throws, in words, when it refuses. */
export function planToggle(
  request: ConfigToggleRequest,
  homes: ConfigWriteHomes = defaultConfigWriteHomes(),
): ConfigTogglePlan {
  const projectDir = projectDirOf(request);
  const planned = request.agent === "codex"
    ? planCodex(request, homes, projectDir)
    : request.capability === "plugin"
      ? planClaudePlugin(request, homes, projectDir)
      : planClaudeMcpServer(request, homes, projectDir);
  // The proof that only the one key moved: the edited text re-parses to the
  // original object plus the change. For TOML this is what makes a line edit
  // safe to trust; for JSON it catches an emitter that dropped something.
  if (!Bun.deepEquals(parseByExtension(planned.file, planned.after), planned.expected, true)) {
    throw new Error(`${planned.file}: the edit would change more than ${request.id}; refusing.`);
  }
  return {
    ...request,
    ...(request.scope === "project" ? { projectDir } : {}),
    file: planned.file,
    before: planned.before,
    after: planned.after,
    diff: unifiedDiff(planned.file, planned.before, planned.after),
    beforeHash: contentHash(planned.before),
    appliesNextSession: true,
  };
}

// ── writing ──────────────────────────────────────────────────────────────────

function writeAtomically(file: string, content: string, io: ConfigWriteIo): void {
  const temp = `${file}.conch-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content);
  try {
    if (existsSync(file)) chmodSync(temp, statSync(file).mode & 0o777);
    (io.rename ?? renameSync)(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function backupsFor(file: string): string[] {
  const prefix = `${basename(file)}${BACKUP_INFIX}`;
  let names: string[];
  try {
    names = readdirSync(dirname(file)).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
  return names
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
    .map((name) => join(dirname(file), name));
}

function writeBackup(file: string, content: string): string {
  let stamp = Date.now();
  while (existsSync(`${file}${BACKUP_INFIX}${stamp}`)) stamp += 1;
  const backup = `${file}${BACKUP_INFIX}${stamp}`;
  writeFileSync(backup, content);
  for (const stale of backupsFor(file).slice(0, -BACKUP_KEEP)) rmSync(stale, { force: true });
  return backup;
}

/**
 * Claude Code's own config writer takes `<file>.lock` (a directory, stale
 * after ten seconds) around `~/.claude.json` and its settings files, and
 * re-reads when the file's mtime moved under it. Holding the same lock for
 * the few milliseconds of a write keeps the two writers from interleaving.
 */
function acquireClaudeLock(file: string): () => void {
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - statSync(lock).mtimeMs < CLAUDE_LOCK_STALE_MS) {
      throw new Error(`Claude Code is writing ${file} right now (${lock} is held); try again in a moment.`);
    }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

function replaceFile(file: string, before: string, after: string, io: ConfigWriteIo): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  const release = file.endsWith(".json") ? acquireClaudeLock(file) : () => {};
  try {
    const backup = before === "" ? undefined : writeBackup(file, before);
    writeAtomically(file, after, io);
    let why: string | null = null;
    try {
      const readBack = (io.readBack ?? ((path) => readFileSync(path, "utf8")))(file);
      if (readBack !== after && !Bun.deepEquals(parseByExtension(file, readBack), parseByExtension(file, after), true)) {
        why = "it does not contain the change";
      }
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
    if (why !== null) {
      if (before === "") rmSync(file, { force: true });
      else writeAtomically(file, before, io);
      throw new Error(`refused: ${file} read back wrong after the write (${why}); the previous content is restored.`);
    }
    return backup;
  } finally {
    release();
  }
}

/** Write the plan. Refuses when the file moved since it was planned, or reads back wrong. */
export function applyPlan(plan: ConfigTogglePlan, io: ConfigWriteIo = {}): ConfigApplyResult {
  if (readText(plan.file) !== plan.before) {
    throw new Error(`${plan.file} changed since the preview; ask for a new preview.`);
  }
  if (plan.before === plan.after) return { file: plan.file };
  const backup = replaceFile(plan.file, plan.before, plan.after, io);
  return { file: plan.file, ...(backup ? { backup } : {}) };
}

/** Put the newest backup back. The content being replaced becomes a backup itself, so a rollback can be undone. */
export function rollbackFile(file: string, io: ConfigWriteIo = {}): { file: string; restoredFrom: string } {
  const backup = backupsFor(file).at(-1);
  if (!backup) throw new Error(`no conch backup beside ${file}; nothing to roll back.`);
  const before = readText(file);
  const restored = readFileSync(backup, "utf8");
  if (before !== restored) replaceFile(file, before, restored, io);
  return { file, restoredFrom: backup };
}
