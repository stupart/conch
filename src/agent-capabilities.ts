import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { codexThreadDbPaths, openReadOnly } from "./codex-threads.ts";

export type AgentCapabilityBackend = "claude" | "codex";
export type AgentCapabilityKind = "plugin" | "skill" | "mcp-server" | "mcp-tool";
export type AgentCapabilityScope =
  | "user"
  | "project"
  | "local"
  | "plugin"
  | "system"
  | "admin"
  | "managed"
  | "unknown";
export type AgentEvidenceState = "yes" | "no" | "unknown";
export type AgentEvidenceBasis =
  | "config"
  | "filesystem"
  | "provider-state"
  | "provider-cli"
  | "runtime"
  | "transcript"
  | "none";

export interface AgentCapabilityEvidence {
  state: AgentEvidenceState;
  basis: AgentEvidenceBasis;
  detail: string;
  at?: number;
}

export interface AgentCapabilityEvidenceSet {
  configured: AgentCapabilityEvidence;
  available: AgentCapabilityEvidence;
  loaded: AgentCapabilityEvidence;
  observed: AgentCapabilityEvidence;
}

export interface AgentCapabilitySubject {
  /** Stable rank/feed identity. It is deliberately independent of a session row. */
  id: string;
  type: "agent-capability";
  title: string;
}

export interface AgentCapabilitySource {
  kind: "config" | "state" | "manifest" | "directory" | "transcript";
  path: string;
  scope: AgentCapabilityScope;
  projectPath?: string;
}

export interface AgentCapabilityDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  subjectId?: string;
  sourcePath?: string;
}

interface AgentCapabilityBase {
  id: string;
  subject: AgentCapabilitySubject;
  backend: AgentCapabilityBackend;
  kind: AgentCapabilityKind;
  name: string;
  displayName: string;
  description?: string;
  parentId?: string;
  scope: AgentCapabilityScope;
  sources: AgentCapabilitySource[];
  evidence: AgentCapabilityEvidenceSet;
  diagnostics: AgentCapabilityDiagnostic[];
}

export interface PluginCapabilityMetadata {
  pluginId: string;
  marketplace?: string;
  version?: string;
  installed: boolean;
  /** Persisted/default state for a new host. It is never presented as live state. */
  enabledForNextSession: boolean | null;
  installPath?: string;
  components: {
    skills: number;
    mcpServers: number;
    hooks: boolean;
    apps: boolean;
  };
}

export interface SkillCapabilityMetadata {
  path: string;
  ownerPluginId?: string;
  enabledForNextSession: boolean | null;
  visibility?: "on" | "name-only" | "user-invocable-only" | "off";
  userInvocable: boolean;
  modelInvocable: boolean;
  allowedTools: string[];
  argumentHint?: string;
  model?: string;
  bytes: number;
}

export type McpTransportKind = "stdio" | "http" | "sse" | "websocket" | "unknown";

export interface McpServerCapabilityMetadata {
  ownerPluginId?: string;
  transport: McpTransportKind;
  /** Executable only; arguments and environment values never cross the wire. */
  command?: string;
  argsCount?: number;
  /** Only the URL origin is retained; path, query, fragment, and credentials are removed. */
  url?: string;
  credentialSources: string[];
  enabledForNextSession: boolean | null;
  projectDecision?: "approved" | "rejected" | "unspecified";
  required?: boolean;
  startupTimeoutSeconds?: number;
  toolTimeoutSeconds?: number;
}

export interface McpToolCapabilityMetadata {
  serverName: string;
  ownerPluginId?: string;
  policy?: "enabled" | "disabled" | "allow" | "ask" | "deny";
  approvalMode?: string;
  /** Some plugin manifests name tools for display without supplying a catalog. */
  manifestHint: boolean;
}

export type AgentCapabilityEntity =
  | AgentCapabilityBase & { kind: "plugin"; plugin: PluginCapabilityMetadata }
  | AgentCapabilityBase & { kind: "skill"; skill: SkillCapabilityMetadata }
  | AgentCapabilityBase & { kind: "mcp-server"; mcpServer: McpServerCapabilityMetadata }
  | AgentCapabilityBase & { kind: "mcp-tool"; mcpTool: McpToolCapabilityMetadata };

export interface AgentCapabilitiesRead {
  schemaVersion: 1;
  context: {
    backend: AgentCapabilityBackend;
    cwd: string;
    sessionId?: string;
    projectTrust?: AgentProjectTrust;
    /** Configuration Codex persisted on this thread, not a claim about live in-memory state. */
    threadConfiguration?: AgentThreadConfiguration;
  };
  entities: AgentCapabilityEntity[];
  diagnostics: AgentCapabilityDiagnostic[];
  complete: boolean;
  readAt: number;
}

export interface AgentProjectTrust {
  projectPath: string;
  trusted: boolean | null;
  basis: "config" | "provider-state" | "none";
  detail: string;
  sourcePath?: string;
}

export interface AgentThreadConfiguration {
  basis: "provider-state";
  sourcePath: string;
  source?: string;
  modelProvider?: string;
  sandboxPolicy?: string;
  approvalMode?: string;
  model?: string;
  reasoningEffort?: string;
  memoryMode?: string;
  historyMode?: string;
  agentPath?: string;
  cliVersion?: string;
  recordedAt?: number;
}

export interface ReadAgentCapabilitiesOptions {
  backend: AgentCapabilityBackend;
  cwd: string;
  sessionId?: string;
  /** Like resumable.ts: a redirected conch home suppresses accidental real-home reads. */
  configDir?: string;
  claudeHome?: string;
  claudeStatePath?: string;
  claudeManagedSettingsPath?: string | null;
  claudeManagedMcpPath?: string | null;
  codexHome?: string;
  codexStatePath?: string;
  agentsHome?: string;
  codexAdminSkills?: string;
  codexManagedConfigPath?: string | null;
  codexRequirementsPath?: string | null;
  /** Positive observations already decoded by conch; never interpreted as current loaded state. */
  observations?: readonly AgentCapabilityObservation[];
}

export interface AgentCapabilityObservation {
  kind: "mcp-tool";
  serverName: string;
  toolName: string;
  sessionId: string;
  at?: number;
}

type JsonRecord = Record<string, unknown>;
type SkillVisibility = NonNullable<SkillCapabilityMetadata["visibility"]>;

interface UsageRecord {
  usageCount: number;
  lastUsedAt?: number;
}

interface SettingsLayer {
  path: string;
  scope: AgentCapabilityScope;
  value: JsonRecord;
}

interface SkillMetadata {
  name: string;
  description?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  allowedTools: string[];
  argumentHint?: string;
  model?: string;
  bytes: number;
  valid: boolean;
}

interface SkillScanOptions {
  backend: AgentCapabilityBackend;
  root: string;
  scope: AgentCapabilityScope;
  collector: Collector;
  usage: ReadonlyMap<string, UsageRecord>;
  visibility?: ReadonlyMap<string, SkillVisibility>;
  enabledByPath?: ReadonlyMap<string, boolean>;
  parentId?: string;
  ownerPluginId?: string;
  parentEnabled?: boolean | null;
  defaultEnabled?: boolean;
}

interface McpReadContext {
  backend: AgentCapabilityBackend;
  collector: Collector;
  sourcePath: string;
  identity?: string;
  scope: AgentCapabilityScope;
  additionalSources?: AgentCapabilitySource[];
  projectPath?: string;
  parentId?: string;
  ownerPluginId?: string;
  parentEnabled?: boolean | null;
  projectDecision?: "approved" | "rejected" | "unspecified";
  projectTrusted?: boolean | null;
  requiresProjectTrust?: boolean;
  overrides?: JsonRecord;
  toolPermissions?: ReadonlyMap<string, "allow" | "ask" | "deny">;
  policyUnavailable?: string;
  policyUnknown?: string;
}

const JSON_MAX_BYTES = 8 * 1024 * 1024;
const SKILL_HEAD_BYTES = 128 * 1024;
const ENTITY_LIMIT = 2_000;
const CAPABILITY_SCOPES = new Set<AgentCapabilityScope>([
  "user", "project", "local", "plugin", "system", "admin", "managed", "unknown",
]);
const EVIDENCE_BASES = new Set<AgentEvidenceBasis>([
  "config", "filesystem", "provider-state", "provider-cli", "runtime", "transcript", "none",
]);
const VISIBILITIES = new Set<SkillVisibility>([
  "on",
  "name-only",
  "user-invocable-only",
  "off",
]);

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean);
}

function capabilityId(
  backend: AgentCapabilityBackend,
  kind: AgentCapabilityKind,
  name: string,
  identity: string,
): string {
  return ["agent-capability", backend, kind, name, identity]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function evidence(
  configuredDetail: string,
  available: AgentCapabilityEvidence,
  observed: AgentCapabilityEvidence = {
    state: "unknown",
    basis: "none",
    detail: "No use has been observed; absence of evidence is not evidence of absence.",
  },
  configuredBasis: Extract<AgentEvidenceBasis, "config" | "filesystem" | "provider-state"> = "config",
): AgentCapabilityEvidenceSet {
  return {
    configured: { state: "yes", basis: configuredBasis, detail: configuredDetail },
    available,
    loaded: {
      state: "unknown",
      basis: "none",
      detail: "Conch is attached to a host it did not initialize, so loaded state is not observable.",
    },
    observed,
  };
}

function unknownAvailable(): AgentCapabilityEvidence {
  return {
    state: "unknown",
    basis: "none",
    detail: "Disk configuration does not prove that a fresh or attached host made this available.",
  };
}

function unavailable(detail: string): AgentCapabilityEvidence {
  return { state: "no", basis: "config", detail };
}

function usageEvidence(usage: UsageRecord | undefined): AgentCapabilityEvidence {
  if (!usage || usage.usageCount <= 0) {
    return {
      state: "unknown",
      basis: "none",
      detail: "No positive provider usage record was found.",
    };
  }
  return {
    state: "yes",
    basis: "provider-state",
    detail: `Claude recorded ${usage.usageCount} use${usage.usageCount === 1 ? "" : "s"}.`,
    ...(usage.lastUsedAt === undefined ? {} : { at: usage.lastUsedAt }),
  };
}

class Collector {
  readonly entities: AgentCapabilityEntity[] = [];
  readonly diagnostics: AgentCapabilityDiagnostic[] = [];
  readonly ids = new Set<string>();
  complete = true;

  add(entity: AgentCapabilityEntity): boolean {
    if (this.ids.has(entity.id)) return false;
    if (this.entities.length >= ENTITY_LIMIT) {
      this.complete = false;
      if (!this.diagnostics.some((item) => item.code === "entity-limit")) {
        this.diagnostic({
          severity: "warning",
          code: "entity-limit",
          message: `Capability inventory stopped at ${ENTITY_LIMIT} entities.`,
        });
      }
      return false;
    }
    this.ids.add(entity.id);
    this.entities.push(entity);
    return true;
  }

  diagnostic(item: AgentCapabilityDiagnostic, incomplete = false): void {
    this.diagnostics.push(item);
    if (incomplete) this.complete = false;
  }
}

function readJson(
  path: string,
  collector: Collector,
  label: string,
): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > JSON_MAX_BYTES) throw new Error(`exceeds ${JSON_MAX_BYTES} bytes`);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(parsed)) throw new Error("root must be an object");
    return parsed;
  } catch (error) {
    collector.diagnostic({
      severity: "error",
      code: "invalid-json",
      message: `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath: path,
    }, true);
    return null;
  }
}

function readToml(
  path: string,
  collector: Collector,
  label: string,
): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > JSON_MAX_BYTES) throw new Error(`exceeds ${JSON_MAX_BYTES} bytes`);
    const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
    if (!record(parsed)) throw new Error("root must be a table");
    return parsed;
  } catch (error) {
    collector.diagnostic({
      severity: "error",
      code: "invalid-toml",
      message: `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath: path,
    }, true);
    return null;
  }
}

function readHead(path: string, maxBytes: number): { text: string; bytes: number } {
  const stat = statSync(path);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const count = readSync(fd, buffer, 0, length, 0);
    return { text: buffer.subarray(0, count).toString("utf8"), bytes: stat.size };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function projectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** Root-to-cwd, bounded by the repository root when one is present. */
function projectDirectories(cwd: string): string[] {
  const root = projectRoot(cwd);
  const result: string[] = [];
  let current = resolve(cwd);
  while (true) {
    result.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.reverse();
}

function redirectedConfigDir(options: ReadAgentCapabilitiesOptions): string | undefined {
  return options.configDir ?? process.env.CONCH_CONFIG_DIR;
}

function homes(options: ReadAgentCapabilitiesOptions): {
  claudeHome: string | null;
  claudeStatePath: string | null;
  codexHome: string | null;
  agentsHome: string | null;
} {
  const redirected = redirectedConfigDir(options);
  const claudeHome = options.claudeHome
    ?? (redirected ? null : process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  const codexHome = options.codexHome
    ?? (redirected ? null : process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const agentsHome = options.agentsHome
    ?? (redirected ? null : join(homedir(), ".agents"));
  const claudeStatePath = options.claudeStatePath
    ?? (claudeHome ? join(dirname(claudeHome), ".claude.json") : null);
  return { claudeHome, claudeStatePath, codexHome, agentsHome };
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((item) =>
      item.trim().replace(/^(['"])(.*)\1$/, "$2")
    ).filter(Boolean);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/, "").trim();
}

/** Small frontmatter reader: only metadata scalars/lists, never arbitrary YAML execution. */
function parseFrontmatter(text: string): JsonRecord | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  const result: JsonRecord = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2]!;
    if (raw === "|" || raw === ">") {
      const block: string[] = [];
      while (index + 1 < end && (/^\s+/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) {
        index += 1;
        block.push(lines[index]!.replace(/^\s{1,4}/, ""));
      }
      result[key] = raw === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
      continue;
    }
    if (!raw && index + 1 < end && /^\s*-\s+/.test(lines[index + 1]!)) {
      const values: string[] = [];
      while (index + 1 < end && /^\s*-\s+/.test(lines[index + 1]!)) {
        index += 1;
        const item = /^\s*-\s+(.*)$/.exec(lines[index]!)?.[1] ?? "";
        const parsed = parseScalar(item);
        if (typeof parsed === "string" && parsed) values.push(parsed);
      }
      result[key] = values;
      continue;
    }
    result[key] = parseScalar(raw);
  }
  return result;
}

function allowedTools(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  if (typeof value !== "string") return [];
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function readSkillMetadata(path: string): SkillMetadata {
  const { text, bytes } = readHead(path, SKILL_HEAD_BYTES);
  const frontmatter = parseFrontmatter(text);
  const name = stringValue(frontmatter?.name) ?? basename(dirname(path));
  const description = stringValue(frontmatter?.description);
  return {
    name,
    ...(description ? { description } : {}),
    userInvocable: booleanValue(frontmatter?.["user-invocable"]) ?? true,
    modelInvocable: !(booleanValue(frontmatter?.["disable-model-invocation"]) ?? false),
    allowedTools: allowedTools(frontmatter?.["allowed-tools"]),
    ...(stringValue(frontmatter?.["argument-hint"])
      ? { argumentHint: stringValue(frontmatter?.["argument-hint"]) }
      : {}),
    ...(stringValue(frontmatter?.model) ? { model: stringValue(frontmatter?.model) } : {}),
    bytes,
    valid: Boolean(frontmatter && stringValue(frontmatter.name) && description),
  };
}

function directoryEntries(path: string, collector: Collector, label: string) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    collector.diagnostic({
      severity: "error",
      code: "unreadable-directory",
      message: `${label} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath: path,
    }, true);
    return [];
  }
}

function skillUsageFor(
  usage: ReadonlyMap<string, UsageRecord>,
  name: string,
  ownerPluginId?: string,
): UsageRecord | undefined {
  if (ownerPluginId) {
    const pluginName = ownerPluginId.split("@")[0]!;
    return usage.get(`${pluginName}:${name}`) ?? usage.get(name);
  }
  return usage.get(name);
}

function scanSkillRoot(options: SkillScanOptions): number {
  let count = 0;
  for (const entry of directoryEntries(options.root, options.collector, "skill directory")) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(options.root, entry.name, "SKILL.md");
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    let metadata: SkillMetadata;
    try {
      metadata = readSkillMetadata(path);
    } catch (error) {
      options.collector.diagnostic({
        severity: "error",
        code: "unreadable-skill",
        message: `Skill metadata could not be read: ${error instanceof Error ? error.message : String(error)}`,
        sourcePath: path,
      }, true);
      continue;
    }
    const id = capabilityId(
      options.backend,
      "skill",
      metadata.name,
      options.parentId ? `${options.parentId}:${metadata.name}` : resolve(path),
    );
    const visibility = options.parentId ? undefined : options.visibility?.get(metadata.name);
    const pathEnabled = options.enabledByPath?.get(resolve(path));
    const enabled = options.parentEnabled === false || pathEnabled === false || visibility === "off"
      ? false
      : pathEnabled === true || visibility !== undefined || options.parentEnabled === true
        ? true
        : options.defaultEnabled ?? null;
    const diagnostics: AgentCapabilityDiagnostic[] = [];
    if (!metadata.valid) {
      diagnostics.push({
        severity: "warning",
        code: "invalid-skill-metadata",
        message: "SKILL.md must have frontmatter with both name and description.",
        subjectId: id,
        sourcePath: path,
      });
    }
    const available = !metadata.valid
      ? unavailable("The skill metadata is invalid, so a host should not load it.")
      : enabled === false
        ? unavailable("Configuration disables this skill for future hosts.")
        : unknownAvailable();
    const entity: AgentCapabilityEntity = {
      id,
      subject: { id, type: "agent-capability", title: metadata.name },
      backend: options.backend,
      kind: "skill",
      name: metadata.name,
      displayName: metadata.name,
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      scope: options.parentId ? "plugin" : options.scope,
      sources: [{
        kind: "directory",
        path,
        scope: options.parentId ? "plugin" : options.scope,
      }],
      evidence: evidence(
        "A SKILL.md exists in a configured discovery directory.",
        available,
        usageEvidence(skillUsageFor(options.usage, metadata.name, options.ownerPluginId)),
        "filesystem",
      ),
      diagnostics,
      skill: {
        path,
        ...(options.ownerPluginId ? { ownerPluginId: options.ownerPluginId } : {}),
        enabledForNextSession: enabled,
        ...(visibility ? { visibility } : {}),
        userInvocable: visibility === "off" ? false : metadata.userInvocable,
        modelInvocable: visibility === "off" || visibility === "user-invocable-only"
          ? false
          : metadata.modelInvocable,
        allowedTools: metadata.allowedTools,
        ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
        ...(metadata.model ? { model: metadata.model } : {}),
        bytes: metadata.bytes,
      },
    };
    if (options.collector.add(entity)) {
      count += 1;
      for (const diagnostic of diagnostics) options.collector.diagnostic(diagnostic);
    }
  }
  return count;
}

function usageMap(value: unknown): Map<string, UsageRecord> {
  const result = new Map<string, UsageRecord>();
  if (!record(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (!record(raw)) continue;
    const usageCount = finiteNumber(raw.usageCount);
    if (usageCount === undefined) continue;
    const lastUsedAt = finiteNumber(raw.lastUsedAt);
    result.set(key, {
      usageCount: Math.max(0, Math.trunc(usageCount)),
      ...(lastUsedAt === undefined ? {} : { lastUsedAt: Math.max(0, Math.trunc(lastUsedAt)) }),
    });
  }
  return result;
}

function defaultClaudeManagedPath(file: "managed-settings.json" | "managed-mcp.json"): string {
  return process.platform === "darwin"
    ? join("/Library/Application Support/ClaudeCode", file)
    : join("/etc/claude-code", file);
}

function claudeSettingsLayers(
  options: ReadAgentCapabilitiesOptions,
  claudeHome: string,
  cwd: string,
  collector: Collector,
): SettingsLayer[] {
  const root = projectRoot(cwd);
  const candidates: Array<Omit<SettingsLayer, "value">> = [
    { path: join(claudeHome, "settings.json"), scope: "user" },
    { path: join(root, ".claude", "settings.json"), scope: "project" },
    { path: join(root, ".claude", "settings.local.json"), scope: "local" },
  ];
  const layers: SettingsLayer[] = [];
  for (const candidate of candidates) {
    const value = readJson(candidate.path, collector, "Claude settings");
    if (value) layers.push({ ...candidate, value });
  }
  const managedPath = options.claudeManagedSettingsPath === undefined
    ? defaultClaudeManagedPath("managed-settings.json")
    : options.claudeManagedSettingsPath;
  if (managedPath) {
    const managed = readJson(managedPath, collector, "Claude managed settings");
    if (managed) layers.push({ path: managedPath, scope: "managed", value: managed });
    const dropInDirectory = join(dirname(managedPath), "managed-settings.d");
    const dropIns = directoryEntries(dropInDirectory, collector, "Claude managed settings drop-ins")
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dropIns) {
      const path = join(dropInDirectory, entry.name);
      const value = readJson(path, collector, "Claude managed settings drop-in");
      if (value) layers.push({ path, scope: "managed", value });
    }
  }
  return layers;
}

function effectiveBooleanMap(layers: SettingsLayer[], key: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const layer of layers) {
    const values = layer.value[key];
    if (!record(values)) continue;
    for (const [name, raw] of Object.entries(values)) {
      if (typeof raw === "boolean") result.set(name, raw);
    }
  }
  return result;
}

function effectiveSkillVisibility(layers: SettingsLayer[]): Map<string, SkillVisibility> {
  const result = new Map<string, SkillVisibility>();
  for (const layer of layers) {
    const values = layer.value.skillOverrides;
    if (!record(values)) continue;
    for (const [name, raw] of Object.entries(values)) {
      if (typeof raw === "string" && VISIBILITIES.has(raw as SkillVisibility)) {
        result.set(name, raw as SkillVisibility);
      }
    }
  }
  return result;
}

function mcpPermissionMap(layers: SettingsLayer[], allowedProjectTools: unknown): Map<string, "allow" | "ask" | "deny"> {
  const result = new Map<string, "allow" | "ask" | "deny">();
  for (const tool of stringArray(allowedProjectTools)) {
    if (tool.startsWith("mcp__")) result.set(tool, "allow");
  }
  for (const layer of layers) {
    const permissions = layer.value.permissions;
    if (!record(permissions)) continue;
    for (const policy of ["allow", "ask", "deny"] as const) {
      for (const tool of stringArray(permissions[policy])) {
        if (tool.startsWith("mcp__")) result.set(tool, policy);
      }
    }
  }
  return result;
}

function cleanUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // Paths can contain tenant IDs, signed route segments, or tokens. The
    // origin is enough to identify an endpoint without moving secrets over the
    // daemon wire.
    return url.origin === "null" ? `<redacted ${url.protocol} URL>` : `${url.origin}/`;
  } catch {
    return "<redacted invalid URL>";
  }
}

function credentialSources(definition: JsonRecord): string[] {
  const result = new Set<string>();
  if (record(definition.env)) {
    for (const key of Object.keys(definition.env)) result.add(`env:${key}`);
  }
  if (Array.isArray(definition.env_vars)) {
    for (const entry of definition.env_vars) {
      const name = typeof entry === "string" ? entry : record(entry) ? stringValue(entry.name) : undefined;
      if (name) result.add(`env:${name}`);
    }
  }
  const bearer = stringValue(definition.bearer_token_env_var);
  if (bearer) result.add(`env:${bearer}`);
  for (const key of ["headers", "http_headers", "env_http_headers"] as const) {
    if (!record(definition[key])) continue;
    for (const header of Object.keys(definition[key] as JsonRecord)) result.add(`header:${header}`);
  }
  if (definition.oauth_resource !== undefined || definition.auth === "oauth") result.add("oauth");
  if (definition.auth === "chatgpt") result.add("chatgpt-session");
  return [...result].sort();
}

function transportKind(definition: JsonRecord): McpTransportKind {
  if (stringValue(definition.command)) return "stdio";
  const type = stringValue(definition.type)?.toLowerCase();
  if (type === "sse") return "sse";
  if (type === "ws" || type === "websocket") return "websocket";
  if (type === "http" || type === "streamable-http" || stringValue(definition.url)) return "http";
  return "unknown";
}

function toolNamesFromDefinition(definition: JsonRecord): Map<string, McpToolCapabilityMetadata> {
  const result = new Map<string, McpToolCapabilityMetadata>();
  for (const name of stringArray(definition.enabled_tools)) {
    result.set(name, { serverName: "", policy: "enabled", manifestHint: false });
  }
  for (const name of stringArray(definition.disabled_tools)) {
    result.set(name, { serverName: "", policy: "disabled", manifestHint: false });
  }
  if (record(definition.tools)) {
    for (const [name, raw] of Object.entries(definition.tools)) {
      const approvalMode = record(raw) ? stringValue(raw.approval_mode) : undefined;
      const previous = result.get(name);
      result.set(name, {
        serverName: "",
        ...(previous?.policy ? { policy: previous.policy } : {}),
        ...(approvalMode ? { approvalMode } : {}),
        manifestHint: false,
      });
    }
  }
  const meta = definition._meta;
  if (record(meta) && record(meta.ideToolTitles)) {
    for (const name of Object.keys(meta.ideToolTitles)) {
      if (!result.has(name)) result.set(name, { serverName: "", manifestHint: true });
    }
  }
  return result;
}

/** Plugin MCP files exist in both wrapped and legacy direct-map forms. */
function pluginMcpServers(parsed: JsonRecord | null): JsonRecord | null {
  if (!parsed) return null;
  if (record(parsed.mcpServers)) return parsed.mcpServers;
  const entries = Object.entries(parsed);
  return entries.length && entries.every(([, value]) => record(value)) ? parsed : null;
}

function mergeMcpDefinition(base: JsonRecord, overrides: JsonRecord | undefined): JsonRecord {
  if (!overrides) return base;
  const merged: JsonRecord = { ...base, ...overrides };
  if (record(base.tools) || record(overrides.tools)) {
    merged.tools = {
      ...(record(base.tools) ? base.tools : {}),
      ...(record(overrides.tools) ? overrides.tools : {}),
    };
  }
  return merged;
}

function addMcpServer(name: string, rawDefinition: unknown, context: McpReadContext): boolean {
  if (!record(rawDefinition)) {
    context.collector.diagnostic({
      severity: "warning",
      code: "invalid-mcp-definition",
      message: `MCP server ${name} is not an object.`,
      sourcePath: context.sourcePath,
    }, true);
    return false;
  }
  const definition = mergeMcpDefinition(rawDefinition, context.overrides);
  const sourceIdentity = context.identity ?? (context.parentId
    ? context.parentId
    : `${context.scope}:${context.projectPath ?? context.sourcePath}`);
  const id = capabilityId(context.backend, "mcp-server", name, sourceIdentity);
  const explicitlyEnabled = booleanValue(definition.enabled);
  const enabled = context.parentEnabled === false
    ? false
    : explicitlyEnabled ?? context.parentEnabled ?? (context.backend === "codex" ? true : null);
  let unavailableDetail = context.policyUnavailable ?? null;
  if (!unavailableDetail && context.requiresProjectTrust && context.projectTrusted !== true) {
    unavailableDetail = "Codex ignores project-scoped executable configuration until this project is trusted.";
  } else if (!unavailableDetail && context.projectTrusted === false) {
    unavailableDetail = "Project-scoped executable configuration is ignored until this project is trusted.";
  } else if (!unavailableDetail && context.projectDecision === "rejected") {
    unavailableDetail = "Claude records this project MCP server as rejected.";
  } else if (!unavailableDetail && enabled === false) {
    unavailableDetail = "Configuration disables this server for future hosts.";
  }
  const metadata: McpServerCapabilityMetadata = {
    ...(context.ownerPluginId ? { ownerPluginId: context.ownerPluginId } : {}),
    transport: transportKind(definition),
    ...(stringValue(definition.command) ? { command: stringValue(definition.command) } : {}),
    ...(Array.isArray(definition.args) ? { argsCount: definition.args.length } : {}),
    ...(cleanUrl(definition.url) ? { url: cleanUrl(definition.url) } : {}),
    credentialSources: credentialSources(definition),
    enabledForNextSession: context.policyUnavailable ? false : enabled,
    ...(context.projectDecision ? { projectDecision: context.projectDecision } : {}),
    ...(booleanValue(definition.required) === undefined ? {} : { required: booleanValue(definition.required) }),
    ...(finiteNumber(definition.startup_timeout_sec) === undefined
      ? {}
      : { startupTimeoutSeconds: finiteNumber(definition.startup_timeout_sec) }),
    ...(finiteNumber(definition.tool_timeout_sec) === undefined
      ? {}
      : { toolTimeoutSeconds: finiteNumber(definition.tool_timeout_sec) }),
  };
  const entity: AgentCapabilityEntity = {
    id,
    subject: { id, type: "agent-capability", title: name },
    backend: context.backend,
    kind: "mcp-server",
    name,
    displayName: name,
    ...(context.parentId ? { parentId: context.parentId } : {}),
    scope: context.parentId ? "plugin" : context.scope,
    sources: [{
      kind: context.parentId ? "manifest" : context.scope === "local" ? "state" : "config",
      path: context.sourcePath,
      scope: context.parentId ? "plugin" : context.scope,
      ...(context.projectPath ? { projectPath: context.projectPath } : {}),
    }, ...(context.additionalSources ?? [])
      .filter((source) => source.path !== context.sourcePath)
      .slice(0, 31)],
    evidence: evidence(
      "A redacted MCP server definition exists on disk.",
      unavailableDetail
        ? unavailable(unavailableDetail)
        : context.policyUnknown
          ? { state: "unknown", basis: "config", detail: context.policyUnknown }
          : unknownAvailable(),
    ),
    diagnostics: [],
    mcpServer: metadata,
  };
  if (!context.collector.add(entity)) return false;

  const toolNames = toolNamesFromDefinition(definition);
  for (const [permissionName, permission] of context.toolPermissions ?? []) {
    const match = /^mcp__(.+?)__(.+)$/.exec(permissionName);
    if (!match || match[1] !== name) continue;
    const previous = toolNames.get(match[2]!);
    toolNames.set(match[2]!, {
      serverName: name,
      ...(previous?.approvalMode ? { approvalMode: previous.approvalMode } : {}),
      policy: permission,
      manifestHint: previous?.manifestHint ?? false,
    });
  }
  for (const [toolName, rawTool] of toolNames) {
    const tool = { ...rawTool, serverName: name, ...(context.ownerPluginId ? { ownerPluginId: context.ownerPluginId } : {}) };
    const toolId = capabilityId(context.backend, "mcp-tool", `${name}/${toolName}`, `${id}:${toolName}`);
    const isDisabled = unavailableDetail !== null || tool.policy === "disabled" || tool.policy === "deny";
    const configured = tool.manifestHint
      ? {
        state: "unknown" as const,
        basis: "filesystem" as const,
        detail: "The plugin names this tool for display, but that metadata is not a tools/list catalog.",
      }
      : {
        state: "yes" as const,
        basis: "config" as const,
        detail: "Configuration contains a policy entry for this tool.",
      };
    context.collector.add({
      id: toolId,
      subject: { id: toolId, type: "agent-capability", title: `${name} · ${toolName}` },
      backend: context.backend,
      kind: "mcp-tool",
      name: toolName,
      displayName: toolName,
      parentId: id,
      scope: context.parentId ? "plugin" : context.scope,
      sources: [...entity.sources],
      evidence: {
        configured,
        available: isDisabled
          ? unavailable("The parent server or this tool is disabled by configuration.")
          : unknownAvailable(),
        loaded: {
          state: "unknown",
          basis: "none",
          detail: "Only the initialized MCP connection has the current tools/list catalog.",
        },
        observed: {
          state: "unknown",
          basis: "none",
          detail: "This read did not observe a call to the tool.",
        },
      },
      diagnostics: [],
      mcpTool: tool,
    });
  }
  return true;
}

function manifestAt(root: string, backend: AgentCapabilityBackend): string | null {
  const candidates = backend === "claude"
    ? [join(root, ".claude-plugin", "plugin.json"), join(root, ".codex-plugin", "plugin.json")]
    : [join(root, ".codex-plugin", "plugin.json"), join(root, ".claude-plugin", "plugin.json")];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function manifestDisplayName(manifest: JsonRecord | null, fallback: string): string {
  const interfaceValue = manifest?.interface;
  return record(interfaceValue)
    ? stringValue(interfaceValue.displayName) ?? stringValue(interfaceValue.display_name) ?? fallback
    : fallback;
}

function manifestPath(root: string, manifest: JsonRecord | null, key: string, fallback: string): string {
  const configured = stringValue(manifest?.[key]);
  return resolve(root, configured ?? fallback);
}

function claudeProjectDecision(
  state: JsonRecord | null,
  name: string,
  projectFile: boolean,
  enableAllProject: boolean,
): "approved" | "rejected" | "unspecified" {
  const enabled = stringArray(state?.[projectFile ? "enabledMcpjsonServers" : "enabledMcpServers"]);
  const disabled = stringArray(state?.[projectFile ? "disabledMcpjsonServers" : "disabledMcpServers"]);
  if (disabled.includes(name)) return "rejected";
  if (enabled.includes(name) || projectFile && enableAllProject) return "approved";
  return "unspecified";
}

function readClaude(
  options: ReadAgentCapabilitiesOptions,
  collector: Collector,
  claudeHome: string,
  statePath: string,
): AgentProjectTrust {
  const state = readJson(statePath, collector, "Claude state");
  const projectState = record(state?.projects) && record(state.projects[resolve(options.cwd)])
    ? state.projects[resolve(options.cwd)] as JsonRecord
    : null;
  const projectTrusted = projectState && typeof projectState.hasTrustDialogAccepted === "boolean"
    ? projectState.hasTrustDialogAccepted
    : null;
  const pluginUsage = usageMap(state?.pluginUsage);
  const skillUsage = usageMap(state?.skillUsage);
  const layers = claudeSettingsLayers(options, claudeHome, options.cwd, collector);
  const enabledPlugins = effectiveBooleanMap(layers, "enabledPlugins");
  const visibility = effectiveSkillVisibility(layers);
  const toolPermissions = mcpPermissionMap(layers, projectState?.allowedTools);
  const enableAllProject = layers.some((layer) => layer.value.enableAllProjectMcpServers === true);
  const managedMcpPath = options.claudeManagedMcpPath === undefined
    ? defaultClaudeManagedPath("managed-mcp.json")
    : options.claudeManagedMcpPath;
  const managedMcpPresent = Boolean(managedMcpPath && existsSync(managedMcpPath));
  const managedMcp = managedMcpPath
    ? readJson(managedMcpPath, collector, "Claude managed MCP configuration")
    : null;
  const managedMcpUnavailable = managedMcpPresent
    ? "A managed-mcp.json deployment gives the managed server set exclusive control."
    : undefined;

  const ledgerPath = join(claudeHome, "plugins", "installed_plugins.json");
  const ledger = readJson(ledgerPath, collector, "Claude plugin installation ledger");
  if (record(ledger?.plugins)) {
    for (const [pluginId, rawInstalls] of Object.entries(ledger.plugins)) {
      if (!Array.isArray(rawInstalls)) continue;
      for (const [index, rawInstall] of rawInstalls.entries()) {
        if (!record(rawInstall)) continue;
        const installPath = stringValue(rawInstall.installPath);
        const sourcePath = installPath ?? `${ledgerPath}#${pluginId}:${index}`;
        const scope: AgentCapabilityScope = rawInstall.scope === "user"
          || rawInstall.scope === "project"
          || rawInstall.scope === "local"
          ? rawInstall.scope
          : "unknown";
        const projectPath = stringValue(rawInstall.projectPath) ?? "";
        const id = capabilityId(
          "claude",
          "plugin",
          pluginId,
          `${scope}:${projectPath}:${pluginId}`,
        );
        const pluginName = pluginId.split("@")[0] ?? pluginId;
        const marketplace = pluginId.includes("@") ? pluginId.slice(pluginId.indexOf("@") + 1) : undefined;
        const manifestFile = installPath ? manifestAt(installPath, "claude") : null;
        const manifest = manifestFile ? readJson(manifestFile, collector, "Claude plugin manifest") : null;
        const enabled = enabledPlugins.get(pluginId) ?? null;
        const diagnostics: AgentCapabilityDiagnostic[] = [];
        if (!installPath || !existsSync(installPath)) {
          diagnostics.push({
            severity: "error",
            code: "plugin-package-missing",
            message: "The installation ledger points to a package that is not present.",
            subjectId: id,
            sourcePath,
          });
        } else if (!manifestFile) {
          diagnostics.push({
            severity: "warning",
            code: "plugin-manifest-missing",
            message: "The installed package has no plugin manifest.",
            subjectId: id,
            sourcePath: installPath,
          });
        }
        const components = {
          skills: 0,
          mcpServers: 0,
          hooks: Boolean(installPath && (existsSync(join(installPath, "hooks")) || manifest?.hooks)),
          apps: Boolean(manifest?.apps),
        };
        const entity: AgentCapabilityEntity = {
          id,
          subject: { id, type: "agent-capability", title: manifestDisplayName(manifest, pluginName) },
          backend: "claude",
          kind: "plugin",
          name: pluginName,
          displayName: manifestDisplayName(manifest, pluginName),
          ...(stringValue(manifest?.description) ? { description: stringValue(manifest?.description) } : {}),
          scope,
          sources: [
            { kind: "state", path: ledgerPath, scope: "user" },
            ...(manifestFile ? [{ kind: "manifest" as const, path: manifestFile, scope: "plugin" as const }] : []),
          ],
          evidence: evidence(
            "Claude's installation ledger records this plugin.",
            enabled === false
              ? unavailable("Scoped settings disable this plugin for future hosts.")
              : unknownAvailable(),
            usageEvidence(pluginUsage.get(pluginId)),
            "provider-state",
          ),
          diagnostics,
          plugin: {
            pluginId,
            ...(marketplace ? { marketplace } : {}),
            ...(stringValue(rawInstall.version) ? { version: stringValue(rawInstall.version) } : {}),
            installed: true,
            enabledForNextSession: enabled,
            ...(installPath ? { installPath } : {}),
            components,
          },
        };
        if (!collector.add(entity)) continue;
        for (const diagnostic of diagnostics) collector.diagnostic(diagnostic, diagnostic.severity === "error");
        if (!installPath || !existsSync(installPath)) continue;
        components.skills = scanSkillRoot({
          backend: "claude",
          root: manifestPath(installPath, manifest, "skills", "skills"),
          scope: "plugin",
          collector,
          usage: skillUsage,
          parentId: id,
          ownerPluginId: pluginId,
          parentEnabled: enabled,
        });
        const mcpFile = manifestPath(installPath, manifest, "mcpServers", ".mcp.json");
        if (existsSync(mcpFile)) {
          const parsed = readJson(mcpFile, collector, "Claude plugin MCP configuration");
          const servers = pluginMcpServers(parsed);
          if (record(servers)) {
            for (const [name, definition] of Object.entries(servers)) {
              const decision = claudeProjectDecision(projectState, name, false, enableAllProject);
              if (addMcpServer(name, definition, {
                backend: "claude",
                collector,
                sourcePath: mcpFile,
                scope: "plugin",
                parentId: id,
                ownerPluginId: pluginId,
                parentEnabled: enabled,
                projectDecision: decision,
                toolPermissions,
                ...(managedMcpUnavailable ? { policyUnavailable: managedMcpUnavailable } : {}),
              })) components.mcpServers += 1;
            }
          }
        }
      }
    }
  }

  scanSkillRoot({
    backend: "claude",
    root: join(claudeHome, "skills"),
    scope: "user",
    collector,
    usage: skillUsage,
    visibility,
  });
  const managedSettingsPath = options.claudeManagedSettingsPath === undefined
    ? defaultClaudeManagedPath("managed-settings.json")
    : options.claudeManagedSettingsPath;
  if (managedSettingsPath) scanSkillRoot({
    backend: "claude",
    root: join(dirname(managedSettingsPath), ".claude", "skills"),
    scope: "managed",
    collector,
    usage: skillUsage,
    visibility,
    defaultEnabled: true,
  });
  for (const directory of projectDirectories(options.cwd)) {
    scanSkillRoot({
      backend: "claude",
      root: join(directory, ".claude", "skills"),
      scope: "project",
      collector,
      usage: skillUsage,
      visibility,
    });
  }

  if (record(state?.mcpServers)) {
    for (const [name, definition] of Object.entries(state.mcpServers)) {
      addMcpServer(name, definition, {
        backend: "claude",
        collector,
        sourcePath: statePath,
        scope: "user",
        projectDecision: claudeProjectDecision(projectState, name, false, enableAllProject),
        toolPermissions,
        ...(managedMcpUnavailable ? { policyUnavailable: managedMcpUnavailable } : {}),
      });
    }
  }
  if (record(projectState?.mcpServers)) {
    for (const [name, definition] of Object.entries(projectState.mcpServers)) {
      addMcpServer(name, definition, {
        backend: "claude",
        collector,
        sourcePath: `${statePath}#projects.${resolve(options.cwd)}.mcpServers`,
        scope: "local",
        projectPath: resolve(options.cwd),
        projectDecision: claudeProjectDecision(projectState, name, false, enableAllProject),
        projectTrusted,
        toolPermissions,
        ...(managedMcpUnavailable ? { policyUnavailable: managedMcpUnavailable } : {}),
      });
    }
  }
  for (const directory of projectDirectories(options.cwd).slice().reverse()) {
    const path = join(directory, ".mcp.json");
    if (!existsSync(path)) continue;
    const parsed = readJson(path, collector, "Claude project MCP configuration");
    if (!record(parsed?.mcpServers)) continue;
    for (const [name, definition] of Object.entries(parsed.mcpServers)) {
      addMcpServer(name, definition, {
        backend: "claude",
        collector,
        sourcePath: path,
        scope: "project",
        projectPath: directory,
        projectDecision: claudeProjectDecision(projectState, name, true, enableAllProject),
        projectTrusted,
        toolPermissions,
        ...(managedMcpUnavailable ? { policyUnavailable: managedMcpUnavailable } : {}),
      });
    }
  }
  if (managedMcpPath && record(managedMcp?.mcpServers)) {
    for (const [name, definition] of Object.entries(managedMcp.mcpServers)) {
      addMcpServer(name, definition, {
        backend: "claude",
        collector,
        sourcePath: managedMcpPath,
        scope: "managed",
        toolPermissions,
      });
    }
  }
  return {
    projectPath: resolve(options.cwd),
    trusted: projectTrusted,
    basis: projectTrusted === null ? "none" : "provider-state",
    detail: projectTrusted === null
      ? "Claude has no project trust decision recorded for this working directory."
      : projectTrusted
        ? "Claude records that this working directory accepted the trust dialog."
        : "Claude records that this working directory has not accepted the trust dialog.",
    ...(projectTrusted === null ? {} : { sourcePath: statePath }),
  };
}

function skillEnabledByPath(configs: Array<{ path: string; value: JsonRecord }>): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const config of configs) {
    const skills = config.value.skills;
    if (!record(skills) || !Array.isArray(skills.config)) continue;
    for (const entry of skills.config) {
      if (!record(entry)) continue;
      const path = stringValue(entry.path);
      const enabled = booleanValue(entry.enabled);
      if (path && enabled !== undefined) result.set(resolve(path), enabled);
    }
  }
  return result;
}

function newestManifestRoot(path: string, collector: Collector): string | null {
  if (!existsSync(path)) return null;
  if (manifestAt(path, "codex")) return path;
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const entry of directoryEntries(path, collector, "Codex plugin cache")) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = join(path, entry.name);
    if (!manifestAt(candidate, "codex")) continue;
    let mtime = 0;
    try { mtime = statSync(candidate).mtimeMs; } catch {}
    candidates.push({ path: candidate, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
  return candidates[0]?.path ?? null;
}

function codexPluginRoot(
  codexHome: string,
  pluginName: string,
  marketplace: string,
  userConfig: JsonRecord,
  collector: Collector,
): string | null {
  const candidates: string[] = [];
  const marketplaces = userConfig.marketplaces;
  if (record(marketplaces) && record(marketplaces[marketplace])) {
    const source = stringValue((marketplaces[marketplace] as JsonRecord).source);
    if (source) candidates.push(join(source, "plugins", pluginName), join(source, pluginName));
  }
  candidates.push(
    join(codexHome, ".tmp", "bundled-marketplaces", marketplace, "plugins", pluginName),
    join(codexHome, ".tmp", "plugins", "plugins", pluginName),
    join(codexHome, "plugins", "cache", marketplace, pluginName),
  );
  for (const candidate of candidates) {
    const root = newestManifestRoot(candidate, collector);
    if (root) return root;
  }
  return null;
}

interface CodexConfigFile {
  path: string;
  value: JsonRecord;
  scope: AgentCapabilityScope;
  trusted: boolean | null;
}

interface CodexConfigRead {
  files: CodexConfigFile[];
  projectTrust: AgentProjectTrust;
}

function mergeConfig(base: JsonRecord, overlay: JsonRecord): JsonRecord {
  const result: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = record(value) && record(result[key])
      ? mergeConfig(result[key] as JsonRecord, value)
      : value;
  }
  return result;
}

function codexConfigFiles(
  options: ReadAgentCapabilitiesOptions,
  codexHome: string,
  cwd: string,
  collector: Collector,
): CodexConfigRead {
  const userPath = join(codexHome, "config.toml");
  const user = readToml(userPath, collector, "Codex user configuration") ?? {};
  const root = projectRoot(cwd);
  const trustEntry = record(user.projects) && record(user.projects[root])
    ? user.projects[root] as JsonRecord
    : null;
  const trustLevel = stringValue(trustEntry?.trust_level);
  const trusted = trustLevel === "trusted" ? true : trustLevel === "untrusted" ? false : null;
  const files: CodexConfigFile[] = [{ path: userPath, value: user, scope: "user", trusted: true }];
  for (const directory of projectDirectories(cwd)) {
    const path = join(directory, ".codex", "config.toml");
    const value = readToml(path, collector, "Codex project configuration");
    if (value) files.push({ path, value, scope: "project", trusted });
  }
  const managedPath = options.codexManagedConfigPath === undefined
    ? "/etc/codex/managed_config.toml"
    : options.codexManagedConfigPath;
  if (managedPath) {
    const value = readToml(managedPath, collector, "Codex managed configuration");
    if (value) files.push({ path: managedPath, value, scope: "managed", trusted: true });
  }
  return {
    files,
    projectTrust: {
      projectPath: root,
      trusted,
      basis: trusted === null ? "none" : "config",
      detail: trusted === null
        ? "Codex has no trust_level entry for this project root."
        : trusted
          ? "Codex config marks this project root as trusted."
          : "Codex config marks this project root as untrusted.",
      ...(trusted === null ? {} : { sourcePath: userPath }),
    },
  };
}

function requirementValueMatches(rule: unknown, value: string): boolean | null {
  if (typeof rule === "string") return rule === value;
  if (!record(rule)) return null;
  const match = stringValue(rule.match);
  const expected = stringValue(rule.value);
  const expression = stringValue(rule.expression);
  if (match === "exact" && expected) return value === expected;
  if (match === "prefix" && expected) return value.startsWith(expected);
  // A provider may evaluate managed regexes under its own bounded engine. A
  // render-path companion must not execute administrator-supplied regex text.
  if (match === "regex" && expression) return null;
  return null;
}

function requirementIdentityMatches(identity: unknown, definition: JsonRecord): boolean | null {
  if (!record(identity)) return null;
  if (identity.command !== undefined) {
    const command = stringValue(definition.command);
    if (!command) return false;
    if (typeof identity.command === "string") return identity.command === command;
    if (!record(identity.command)) return null;
    const executable = stringValue(identity.command.executable);
    if (!executable || executable !== command) return false;
    if (!Array.isArray(identity.command.args)) return true;
    const args = Array.isArray(definition.args)
      ? definition.args.map((arg) => typeof arg === "string" ? arg : null)
      : [];
    if (args.length !== identity.command.args.length || args.some((arg) => arg === null)) return false;
    let unknown = false;
    for (const [index, rule] of identity.command.args.entries()) {
      const matched = requirementValueMatches(rule, args[index]!);
      if (matched === false) return false;
      if (matched === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if (identity.url !== undefined) {
    const url = stringValue(definition.url);
    return url ? requirementValueMatches(identity.url, url) : false;
  }
  return null;
}

function codexMcpRequirementPolicy(
  requirements: JsonRecord | null,
  name: string,
  definition: unknown,
  ownerPluginId?: string,
): { unavailable?: string; unknown?: string } {
  if (!requirements || !record(definition)) return {};
  let allowlist: JsonRecord | null = null;
  if (ownerPluginId) {
    if (!Object.hasOwn(requirements, "plugins")) return {};
    const plugins = requirements.plugins;
    const plugin = record(plugins) && record(plugins[ownerPluginId])
      ? plugins[ownerPluginId] as JsonRecord
      : null;
    allowlist = plugin && record(plugin.mcp_servers) ? plugin.mcp_servers : null;
    if (!allowlist) {
      return { unavailable: "Managed requirements do not allow this plugin MCP server." };
    }
  } else {
    if (!Object.hasOwn(requirements, "mcp_servers")) return {};
    allowlist = record(requirements.mcp_servers) ? requirements.mcp_servers : null;
    if (!allowlist) {
      return { unknown: "The managed MCP requirements table could not be interpreted." };
    }
  }
  const entry = allowlist[name];
  if (!record(entry)) {
    return { unavailable: "Managed requirements do not allow this MCP server name." };
  }
  const matched = requirementIdentityMatches(entry.identity, definition);
  if (matched === false) {
    return { unavailable: "This MCP definition does not match its managed identity requirement." };
  }
  if (matched === null) {
    return { unknown: "Conch could not fully evaluate this server's managed identity requirement." };
  }
  return {};
}

function readCodex(
  options: ReadAgentCapabilitiesOptions,
  collector: Collector,
  codexHome: string,
  agentsHome: string | null,
): AgentProjectTrust {
  const configRead = codexConfigFiles(options, codexHome, options.cwd, collector);
  const configs = configRead.files;
  const effectiveConfigs = configs.filter(
    (config) => config.scope !== "project" || config.trusted === true,
  );
  const effectiveConfig = effectiveConfigs.reduce(
    (merged, config) => mergeConfig(merged, config.value),
    {} as JsonRecord,
  );
  const requirementsPath = options.codexRequirementsPath === undefined
    ? "/etc/codex/requirements.toml"
    : options.codexRequirementsPath;
  const requirements = requirementsPath
    ? readToml(requirementsPath, collector, "Codex managed requirements")
    : null;
  const pluginsDisabledByPolicy = record(requirements?.features)
    && requirements.features.plugins === false;
  const enabledByPath = skillEnabledByPath(
    effectiveConfigs,
  );
  const emptyUsage = new Map<string, UsageRecord>();

  for (const config of configs) {
    const plugins = config.value.plugins;
    if (!record(plugins)) continue;
    for (const [pluginId, rawPluginConfig] of Object.entries(plugins)) {
      if (!record(rawPluginConfig)) continue;
      const effectivePlugins = effectiveConfig.plugins;
      const effectivePluginConfig = record(effectivePlugins) && record(effectivePlugins[pluginId])
        ? effectivePlugins[pluginId] as JsonRecord
        : config.scope === "project" && config.trusted !== true
          ? null
          : rawPluginConfig;
      const pluginName = pluginId.split("@")[0] ?? pluginId;
      const marketplace = pluginId.includes("@") ? pluginId.slice(pluginId.indexOf("@") + 1) : "unknown";
      const pluginRoot = codexPluginRoot(codexHome, pluginName, marketplace, effectiveConfig, collector);
      const sourcePath = pluginRoot ?? `${config.path}#plugins.${pluginId}`;
      const id = capabilityId(
        "codex",
        "plugin",
        pluginId,
        pluginId,
      );
      const manifestFile = pluginRoot ? manifestAt(pluginRoot, "codex") : null;
      const manifest = manifestFile ? readJson(manifestFile, collector, "Codex plugin manifest") : null;
      const configuredEnabled = booleanValue(effectivePluginConfig?.enabled);
      const enabled = pluginsDisabledByPolicy
        ? false
        : effectivePluginConfig === null
          ? false
          : configuredEnabled ?? true;
      const diagnostics: AgentCapabilityDiagnostic[] = [];
      if (!pluginRoot || !manifestFile) diagnostics.push({
        severity: "warning",
        code: "plugin-package-missing",
        message: "Codex configuration names this plugin, but its active manifest was not found.",
        subjectId: id,
        sourcePath: config.path,
      });
      const components = {
        skills: 0,
        mcpServers: 0,
        hooks: Boolean(pluginRoot && (existsSync(join(pluginRoot, "hooks")) || manifest?.hooks)),
        apps: Boolean(manifest?.apps),
      };
      const entity: AgentCapabilityEntity = {
        id,
        subject: { id, type: "agent-capability", title: manifestDisplayName(manifest, pluginName) },
        backend: "codex",
        kind: "plugin",
        name: pluginName,
        displayName: manifestDisplayName(manifest, pluginName),
        ...(stringValue(manifest?.description) ? { description: stringValue(manifest?.description) } : {}),
        scope: config.scope,
        sources: [
          ...configs
            .filter((candidate) => record(candidate.value.plugins)
              && record((candidate.value.plugins as JsonRecord)[pluginId]))
            .map((candidate) => ({
              kind: "config" as const,
              path: candidate.path,
              scope: candidate.scope,
            }))
            .slice(0, manifestFile ? 31 : 32),
          ...(manifestFile ? [{ kind: "manifest" as const, path: manifestFile, scope: "plugin" as const }] : []),
        ],
        evidence: evidence(
          "A Codex plugins table records this plugin.",
          enabled === false
            ? unavailable(pluginsDisabledByPolicy
              ? "Managed requirements disable plugins for future hosts."
              : effectivePluginConfig === null
                ? "Codex will ignore this project plugin until the project is trusted."
                : "Configuration disables this plugin for future sessions.")
            : unknownAvailable(),
        ),
        diagnostics,
        plugin: {
          pluginId,
          marketplace,
          ...(stringValue(manifest?.version) ? { version: stringValue(manifest?.version) } : {}),
          installed: true,
          enabledForNextSession: enabled,
          ...(pluginRoot ? { installPath: pluginRoot } : {}),
          components,
        },
      };
      if (!collector.add(entity)) continue;
      for (const diagnostic of diagnostics) collector.diagnostic(diagnostic);
      if (!pluginRoot) continue;
      components.skills = scanSkillRoot({
        backend: "codex",
        root: manifestPath(pluginRoot, manifest, "skills", "skills"),
        scope: "plugin",
        collector,
        usage: emptyUsage,
        parentId: id,
        ownerPluginId: pluginId,
        parentEnabled: enabled,
      });
      const mcpFile = manifestPath(pluginRoot, manifest, "mcpServers", ".mcp.json");
      if (existsSync(mcpFile)) {
        const parsed = readJson(mcpFile, collector, "Codex plugin MCP configuration");
        const servers = pluginMcpServers(parsed);
        if (record(servers)) {
          const controls = record(effectivePluginConfig?.mcp_servers)
            ? effectivePluginConfig.mcp_servers
            : {};
          for (const [name, definition] of Object.entries(servers)) {
            const overrides = record(controls[name]) ? controls[name] as JsonRecord : undefined;
            const policy = codexMcpRequirementPolicy(
              requirements,
              name,
              record(definition) ? mergeMcpDefinition(definition, overrides) : definition,
              pluginId,
            );
            if (addMcpServer(name, definition, {
              backend: "codex",
              collector,
              sourcePath: mcpFile,
              scope: "plugin",
              parentId: id,
              ownerPluginId: pluginId,
              parentEnabled: enabled,
              overrides,
              ...(policy.unavailable ? { policyUnavailable: policy.unavailable } : {}),
              ...(policy.unknown ? { policyUnknown: policy.unknown } : {}),
            })) components.mcpServers += 1;
          }
        }
      }
    }
  }

  if (agentsHome) scanSkillRoot({
    backend: "codex",
    root: join(agentsHome, "skills"),
    scope: "user",
    collector,
    usage: emptyUsage,
    enabledByPath,
    defaultEnabled: true,
  });
  scanSkillRoot({
    backend: "codex",
    root: join(codexHome, "skills"),
    scope: "user",
    collector,
    usage: emptyUsage,
    enabledByPath,
    defaultEnabled: true,
  });
  scanSkillRoot({
    backend: "codex",
    root: join(codexHome, "skills", ".system"),
    scope: "system",
    collector,
    usage: emptyUsage,
    enabledByPath,
    defaultEnabled: true,
  });
  for (const directory of projectDirectories(options.cwd)) {
    scanSkillRoot({
      backend: "codex",
      root: join(directory, ".agents", "skills"),
      scope: "project",
      collector,
      usage: emptyUsage,
      enabledByPath,
      ...(configRead.projectTrust.trusted === null
        ? {}
        : { parentEnabled: configRead.projectTrust.trusted }),
    });
  }
  const adminSkills = options.codexAdminSkills ?? "/etc/codex/skills";
  scanSkillRoot({
    backend: "codex",
    root: adminSkills,
    scope: "admin",
    collector,
    usage: emptyUsage,
    enabledByPath,
    defaultEnabled: true,
  });

  const selectedServers = new Map<string, { config: CodexConfigFile; definition: unknown; effective: boolean }>();
  for (const config of configs) {
    const servers = config.value.mcp_servers;
    if (!record(servers)) continue;
    const effective = config.scope !== "project" || config.trusted === true;
    for (const [name, definition] of Object.entries(servers)) {
      if (effective || !selectedServers.has(name)) {
        selectedServers.set(name, { config, definition, effective });
      }
    }
  }
  const effectiveServers = record(effectiveConfig.mcp_servers)
    ? effectiveConfig.mcp_servers
    : {};
  for (const [name, selected] of selectedServers) {
    const definition = selected.effective && Object.hasOwn(effectiveServers, name)
      ? effectiveServers[name]
      : selected.definition;
    const policy = codexMcpRequirementPolicy(requirements, name, definition);
    addMcpServer(name, definition, {
      backend: "codex",
      collector,
      sourcePath: selected.config.path,
      identity: `standalone:${name}`,
      scope: selected.config.scope,
      additionalSources: configs
        .filter((candidate) => record(candidate.value.mcp_servers)
          && Object.hasOwn(candidate.value.mcp_servers as JsonRecord, name))
        .map((candidate) => ({
          kind: "config" as const,
          path: candidate.path,
          scope: candidate.scope,
          ...(candidate.scope === "project"
            ? { projectPath: dirname(dirname(candidate.path)) }
            : {}),
        })),
      projectPath: selected.config.scope === "project"
        ? dirname(dirname(selected.config.path))
        : undefined,
      projectTrusted: selected.config.scope === "project" ? selected.config.trusted : null,
      requiresProjectTrust: selected.config.scope === "project",
      ...(policy.unavailable ? { policyUnavailable: policy.unavailable } : {}),
      ...(policy.unknown ? { policyUnknown: policy.unknown } : {}),
    });
  }
  return configRead.projectTrust;
}

const CODEX_THREAD_CONFIG_COLUMNS = [
  "source",
  "model_provider",
  "sandbox_policy",
  "approval_mode",
  "model",
  "reasoning_effort",
  "memory_mode",
  "history_mode",
  "agent_path",
  "cli_version",
  "updated_at_ms",
] as const;

function threadConfigurationString(
  row: Record<string, unknown>,
  column: typeof CODEX_THREAD_CONFIG_COLUMNS[number],
  collector: Collector,
  sourcePath: string,
): string | undefined {
  const value = row[column];
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 8_192) {
    collector.diagnostic({
      severity: "warning",
      code: "invalid-codex-thread-configuration",
      message: `Codex thread column ${column} was not a bounded string and was omitted.`,
      sourcePath,
    }, true);
    return undefined;
  }
  return value;
}

/** Read only the non-secret configuration receipt Codex persisted for one thread. */
function readCodexThreadConfiguration(
  options: ReadAgentCapabilitiesOptions,
  collector: Collector,
  codexHome: string,
): AgentThreadConfiguration | undefined {
  if (!options.sessionId) return undefined;
  const statePath = options.codexStatePath ?? codexThreadDbPaths(codexHome).state;
  if (!existsSync(statePath)) return undefined;
  let db: ReturnType<typeof openReadOnly> | undefined;
  try {
    db = openReadOnly(statePath);
    const columns = new Set(
      (db.query("PRAGMA table_info(threads)").all() as Array<Record<string, unknown>>)
        .map((row) => typeof row.name === "string" ? row.name : "")
        .filter(Boolean),
    );
    if (!columns.has("id")) throw new Error("threads table has no id column");
    const selected = CODEX_THREAD_CONFIG_COLUMNS.filter((column) => columns.has(column));
    if (selected.length === 0) throw new Error("threads table has no supported configuration columns");
    const row = db
      .query(`SELECT ${selected.join(", ")} FROM threads WHERE id = ? LIMIT 1`)
      .get(options.sessionId) as Record<string, unknown> | null;
    if (!row) return undefined;
    const recordedAt = typeof row.updated_at_ms === "number" && Number.isSafeInteger(row.updated_at_ms)
      ? row.updated_at_ms
      : undefined;
    const source = threadConfigurationString(row, "source", collector, statePath);
    const modelProvider = threadConfigurationString(row, "model_provider", collector, statePath);
    const sandboxPolicy = threadConfigurationString(row, "sandbox_policy", collector, statePath);
    const approvalMode = threadConfigurationString(row, "approval_mode", collector, statePath);
    const model = threadConfigurationString(row, "model", collector, statePath);
    const reasoningEffort = threadConfigurationString(row, "reasoning_effort", collector, statePath);
    const memoryMode = threadConfigurationString(row, "memory_mode", collector, statePath);
    const historyMode = threadConfigurationString(row, "history_mode", collector, statePath);
    const agentPath = threadConfigurationString(row, "agent_path", collector, statePath);
    const cliVersion = threadConfigurationString(row, "cli_version", collector, statePath);
    return {
      basis: "provider-state",
      sourcePath: statePath,
      ...(source ? { source } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(approvalMode ? { approvalMode } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(memoryMode ? { memoryMode } : {}),
      ...(historyMode ? { historyMode } : {}),
      ...(agentPath ? { agentPath } : {}),
      ...(cliVersion ? { cliVersion } : {}),
      ...(recordedAt === undefined ? {} : { recordedAt }),
    };
  } catch (error) {
    collector.diagnostic({
      severity: "warning",
      code: "unreadable-codex-thread-configuration",
      message: `Codex thread configuration could not be read: ${error instanceof Error ? error.message : String(error)}`,
      sourcePath: statePath,
    }, true);
    return undefined;
  } finally {
    db?.close();
  }
}

const KIND_ORDER: Record<AgentCapabilityKind, number> = {
  plugin: 0,
  skill: 1,
  "mcp-server": 2,
  "mcp-tool": 3,
};

function observedEvidence(
  kind: "server" | "tool",
  sessionId: string,
  at?: number,
): AgentCapabilityEvidence {
  return {
    state: "yes",
    basis: "transcript",
    detail: `Conch observed this MCP ${kind} in session ${sessionId}; that proves past use, not current availability.`,
    ...(at === undefined ? {} : { at }),
  };
}

function serverAliases(name: string): Set<string> {
  const aliases = new Set([name]);
  const withoutPlugin = name.replace(/^plugin[_-]/, "");
  aliases.add(withoutPlugin);
  const pieces = withoutPlugin.split(/[_-]/).filter(Boolean);
  const deduped = pieces.filter((piece, index) => piece !== pieces[index - 1]);
  aliases.add(deduped.join("-"));
  aliases.add(deduped.join("_"));
  if (deduped[0] === "claude" && deduped.length > 1) {
    aliases.add(deduped.slice(1).join("-"));
    aliases.add(deduped.slice(1).join("_"));
  }
  return aliases;
}

function addObservationSource(entity: AgentCapabilityEntity, sessionId: string): void {
  const path = `transcript:${sessionId}`;
  if (entity.sources.some((source) => source.kind === "transcript" && source.path === path)) return;
  if (entity.sources.length >= 32) entity.sources.splice(31);
  entity.sources.push({ kind: "transcript", path, scope: "unknown" });
}

function applyObservations(
  backend: AgentCapabilityBackend,
  observations: readonly AgentCapabilityObservation[],
  collector: Collector,
): void {
  for (const observation of observations) {
    if (observation.kind !== "mcp-tool"
      || !observation.serverName
      || observation.serverName.length > 4_096
      || !observation.toolName
      || observation.toolName.length > 4_096) continue;
    const aliases = serverAliases(observation.serverName);
    const configuredServers = collector.entities.filter(
      (entity): entity is Extract<AgentCapabilityEntity, { kind: "mcp-server" }> =>
        entity.backend === backend && entity.kind === "mcp-server",
    );
    const exactMatches = configuredServers.filter((entity) => entity.name === observation.serverName);
    const matches = exactMatches.length > 0
      ? exactMatches
      : configuredServers.filter((entity) =>
      entity.backend === backend
      && (aliases.has(entity.name) || serverAliases(entity.name).has(observation.serverName))
      );
    let server = matches.length === 1 ? matches[0] : undefined;
    let ambiguousDiagnostic: AgentCapabilityDiagnostic | undefined;
    if (matches.length > 1) {
      ambiguousDiagnostic = {
        severity: "warning",
        code: "ambiguous-mcp-observation",
        message: `An observed call to ${observation.serverName} matches multiple configured servers, so conch did not attribute it to any one of them.`,
      };
    }
    if (!server) {
      const id = capabilityId(backend, "mcp-server", observation.serverName, `observed:${observation.serverName}`);
      if (ambiguousDiagnostic) ambiguousDiagnostic.subjectId = id;
      server = {
        id,
        subject: { id, type: "agent-capability", title: observation.serverName },
        backend,
        kind: "mcp-server",
        name: observation.serverName,
        displayName: observation.serverName,
        scope: "unknown",
        sources: [{ kind: "transcript", path: `transcript:${observation.sessionId}`, scope: "unknown" }],
        evidence: {
          configured: {
            state: "unknown",
            basis: "none",
            detail: "The observed server was not found in the candidate disk configuration.",
          },
          available: unknownAvailable(),
          loaded: {
            state: "unknown",
            basis: "none",
            detail: "A past call does not prove that the server remains loaded now.",
          },
          observed: observedEvidence("server", observation.sessionId, observation.at),
        },
        diagnostics: ambiguousDiagnostic ? [ambiguousDiagnostic] : [],
        mcpServer: {
          transport: "unknown",
          credentialSources: [],
          enabledForNextSession: null,
        },
      };
      if (!collector.add(server)) continue;
      if (ambiguousDiagnostic) collector.diagnostic(ambiguousDiagnostic);
    } else {
      server.evidence.observed = observedEvidence("server", observation.sessionId, observation.at);
      addObservationSource(server, observation.sessionId);
    }

    let tool = collector.entities.find((entity): entity is Extract<AgentCapabilityEntity, { kind: "mcp-tool" }> =>
      entity.backend === backend
      && entity.kind === "mcp-tool"
      && entity.parentId === server!.id
      && entity.name === observation.toolName
    );
    if (!tool) {
      const id = capabilityId(
        backend,
        "mcp-tool",
        `${server.name}/${observation.toolName}`,
        `${server.id}:${observation.toolName}`,
      );
      tool = {
        id,
        subject: { id, type: "agent-capability", title: `${server.name} · ${observation.toolName}` },
        backend,
        kind: "mcp-tool",
        name: observation.toolName,
        displayName: observation.toolName,
        parentId: server.id,
        scope: server.scope,
        sources: [...server.sources],
        evidence: {
          configured: {
            state: "unknown",
            basis: "none",
            detail: "The tool was observed, but no disk policy or tools/list catalog names it.",
          },
          available: unknownAvailable(),
          loaded: {
            state: "unknown",
            basis: "none",
            detail: "A past call does not prove that the tool remains loaded now.",
          },
          observed: observedEvidence("tool", observation.sessionId, observation.at),
        },
        diagnostics: [],
        mcpTool: {
          serverName: server.name,
          ...(server.mcpServer.ownerPluginId ? { ownerPluginId: server.mcpServer.ownerPluginId } : {}),
          manifestHint: false,
        },
      };
      collector.add(tool);
    } else {
      tool.evidence.observed = observedEvidence("tool", observation.sessionId, observation.at);
      addObservationSource(tool, observation.sessionId);
    }
  }
}

/**
 * Read the configured agent capability environment without starting an agent,
 * executing a plugin, connecting to MCP, or mutating provider state.
 */
export function readAgentCapabilities(options: ReadAgentCapabilitiesOptions): AgentCapabilitiesRead {
  const collector = new Collector();
  const cwd = resolve(options.cwd);
  const resolvedOptions = { ...options, cwd };
  const resolvedHomes = homes(resolvedOptions);
  let projectTrust: AgentProjectTrust | undefined;
  let threadConfiguration: AgentThreadConfiguration | undefined;
  if (options.backend === "claude") {
    if (resolvedHomes.claudeHome && resolvedHomes.claudeStatePath) {
      projectTrust = readClaude(
        resolvedOptions,
        collector,
        resolvedHomes.claudeHome,
        resolvedHomes.claudeStatePath,
      );
    }
  } else if (resolvedHomes.codexHome) {
    projectTrust = readCodex(resolvedOptions, collector, resolvedHomes.codexHome, resolvedHomes.agentsHome);
    threadConfiguration = readCodexThreadConfiguration(resolvedOptions, collector, resolvedHomes.codexHome);
  }
  applyObservations(options.backend, options.observations ?? [], collector);
  collector.entities.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.displayName.localeCompare(b.displayName)
    || a.id.localeCompare(b.id)
  );
  return {
    schemaVersion: 1,
    context: {
      backend: options.backend,
      cwd,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(projectTrust ? { projectTrust } : {}),
      ...(threadConfiguration ? { threadConfiguration } : {}),
    },
    entities: collector.entities,
    diagnostics: collector.diagnostics,
    complete: collector.complete,
    readAt: Date.now(),
  };
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validEvidence(value: unknown): value is AgentCapabilityEvidence {
  return record(value)
    && (value.state === "yes" || value.state === "no" || value.state === "unknown")
    && typeof value.basis === "string"
    && EVIDENCE_BASES.has(value.basis as AgentEvidenceBasis)
    && boundedString(value.detail, 8_000)
    && (value.at === undefined || Number.isSafeInteger(value.at));
}

function validSource(value: unknown): value is AgentCapabilitySource {
  return record(value)
    && (value.kind === "config" || value.kind === "state" || value.kind === "manifest"
      || value.kind === "directory" || value.kind === "transcript")
    && boundedString(value.path, 8_192)
    && typeof value.scope === "string"
    && CAPABILITY_SCOPES.has(value.scope as AgentCapabilityScope)
    && (value.projectPath === undefined || boundedString(value.projectPath, 8_192));
}

function validDiagnostic(value: unknown): value is AgentCapabilityDiagnostic {
  return record(value)
    && (value.severity === "info" || value.severity === "warning" || value.severity === "error")
    && boundedString(value.code, 200)
    && boundedString(value.message, 8_000)
    && (value.subjectId === undefined || boundedString(value.subjectId, 16_384))
    && (value.sourcePath === undefined || boundedString(value.sourcePath, 8_192));
}

function validProjectTrust(value: unknown): value is AgentProjectTrust {
  return record(value)
    && boundedString(value.projectPath, 8_192)
    && (value.trusted === true || value.trusted === false || value.trusted === null)
    && (value.basis === "config" || value.basis === "provider-state" || value.basis === "none")
    && boundedString(value.detail, 8_000)
    && (value.sourcePath === undefined || boundedString(value.sourcePath, 8_192));
}

function validThreadConfiguration(value: unknown): value is AgentThreadConfiguration {
  if (!record(value)
    || value.basis !== "provider-state"
    || !boundedString(value.sourcePath, 8_192)
    || (value.recordedAt !== undefined && !Number.isSafeInteger(value.recordedAt))) return false;
  for (const key of [
    "source",
    "modelProvider",
    "sandboxPolicy",
    "approvalMode",
    "model",
    "reasoningEffort",
    "memoryMode",
    "historyMode",
    "agentPath",
    "cliVersion",
  ]) {
    if (value[key] !== undefined && !boundedString(value[key], 8_192)) return false;
  }
  return true;
}

/** Strict-enough wire guard shared by the daemon control response validator. */
export function isAgentCapabilitiesRead(value: unknown): value is AgentCapabilitiesRead {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.complete !== "boolean") return false;
  if (!Number.isSafeInteger(value.readAt) || !record(value.context)) return false;
  if ((value.context.backend !== "claude" && value.context.backend !== "codex")
    || !boundedString(value.context.cwd, 8_192)
    || (value.context.sessionId !== undefined && !boundedString(value.context.sessionId, 1_000))
    || (value.context.projectTrust !== undefined && !validProjectTrust(value.context.projectTrust))
    || (value.context.threadConfiguration !== undefined
      && !validThreadConfiguration(value.context.threadConfiguration))) return false;
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 2_000
    || !value.diagnostics.every(validDiagnostic)) return false;
  if (!Array.isArray(value.entities) || value.entities.length > ENTITY_LIMIT) return false;
  for (const entity of value.entities) {
    if (!record(entity)
      || !boundedString(entity.id, 16_384)
      || !record(entity.subject)
      || entity.subject.type !== "agent-capability"
      || entity.subject.id !== entity.id
      || !boundedString(entity.subject.title, 4_096)
      || (entity.backend !== "claude" && entity.backend !== "codex")
      || !Object.hasOwn(KIND_ORDER, String(entity.kind))
      || !boundedString(entity.name, 4_096)
      || !boundedString(entity.displayName, 4_096)
      || typeof entity.scope !== "string"
      || !CAPABILITY_SCOPES.has(entity.scope as AgentCapabilityScope)
      || !Array.isArray(entity.sources)
      || entity.sources.length > 32
      || !entity.sources.every(validSource)
      || !record(entity.evidence)
      || !validEvidence(entity.evidence.configured)
      || !validEvidence(entity.evidence.available)
      || !validEvidence(entity.evidence.loaded)
      || !validEvidence(entity.evidence.observed)
      || !Array.isArray(entity.diagnostics)
      || !entity.diagnostics.every(validDiagnostic)) return false;
    if (entity.kind === "plugin" && !record(entity.plugin)) return false;
    if (entity.kind === "skill" && !record(entity.skill)) return false;
    if (entity.kind === "mcp-server" && !record(entity.mcpServer)) return false;
    if (entity.kind === "mcp-tool" && !record(entity.mcpTool)) return false;
  }
  return true;
}
