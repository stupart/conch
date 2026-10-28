import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { accountCapabilities, statePath } from "./account-tools.ts";
import { readSkillMetadata, type AgentCapabilityEntity } from "./agent-capabilities.ts";
import { defaultClaudeDir, readClaudeAccounts, type ClaudeAccount } from "./claude-accounts.ts";
import { readCodexAccounts, type CodexAccount } from "./codex-accounts.ts";
import { CONTROL_FRAME_MAX_BYTES } from "./control-framing.ts";
import { conchHome } from "./home.ts";
import { workingFolderOverrides } from "./sessions.ts";
import { applySkillCopy, planSkillCopy, prepareTrialFolder, trialPrompt, validSkillFolderName } from "./skill-install.ts";

/**
 * The skills library (2026-10-28): every skill on this Mac, across every account and both agents, in one list. Tyler:
 * "is there a nice screen or view in conch with all my skills and if not can u find and scrape all my skills from all my
 * accounts and put them there".
 *
 * The capability inspector answers "what does THIS session carry"; this answers "what do I have, anywhere". It is the
 * inspector's read (`accountCapabilities`, agent-capabilities.ts) run once per account conch knows — Claude's default
 * folder and each profile in `claude-accounts.json`, Codex's and each in `codex-accounts.json`, none of them named here —
 * plus the four places that read never looks:
 *
 * - **claude.ai's skills.** Claude Code copies the skills of the claude.ai account it is signed in as into
 *   `<config>/skills/synced/<organization>_<account>/`, one folder per sign-in it has seen, with a `manifest.json`
 *   saying where each came from (`anthropic`, `anthropic-example`). Only the folder of the sign-in the profile holds now
 *   (`oauthAccount` in its `.claude.json`) is loaded, as `anthropic-skills:<name>`; the others are what a sign-in that
 *   has since been swapped out left behind, and are not listed. The inspector skipped the whole folder, because
 *   `synced/` holds no SKILL.md of its own.
 * - **Commands.** A `commands/*.md` is a skill in all but its folder: a slash command with a description. The user's,
 *   each plugin's and each project's are listed as commands beside the skills.
 * - **`~/.agents/skills`**, which every Codex profile reads and the per-account read leaves out (it is no one account's).
 * - **Projects.** The folders Tyler's sessions say they work in (`working-folders.json`), and folders a few levels under
 *   them with skills of their own (`nestedSkillFolders`): a `.claude/skills` there is every Claude account's in that
 *   folder, an `.agents/skills` every Codex account's.
 *
 * One skill installed in several places is one entry with several locations: the same plugin's skill in two accounts,
 * a skill copied into both agents, claude.ai's skills in every profile. Two skills that share a name but not an origin
 * (Codex's own skill-creator and claude.ai's) stay apart: the key is the origin's family, the plugin and the name
 * (`skillKey`). Each location carries a digest of its text, so an entry can say its copies differ.
 *
 * Read only. Nothing here enables, disables or removes anything; adding a skill is skill-install.ts.
 */

export type SkillAgent = "claude" | "codex";
export const SKILL_ORIGINS = ["user", "plugin", "project", "claude.ai", "system", "managed", "admin"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export interface SkillLocation {
  agent: SkillAgent;
  /** The conch account; absent for what every account of the agent loads (a project's skills, `~/.agents/skills`). */
  accountId?: string;
  accountLabel?: string;
  origin: SkillOrigin;
  /** A skill's SKILL.md, or a command's own `.md`. */
  kind: "skill" | "command";
  path: string;
  /** `name@marketplace`, for a plugin's. */
  pluginId?: string;
  pluginVersion?: string;
  /** The folder whose `.claude` or `.agents` holds it, for a project's. */
  projectPath?: string;
  /** For the next session, as the agent's own configuration says; null where nothing says. */
  enabled: boolean | null;
  /** How it is called by hand in its agent (`/figma:figma-use`, `$seashell-meetings`); absent when only the model may. */
  invocation?: string;
  /** Where claude.ai said it came from (`anthropic`, `anthropic-example`), for one of its skills. */
  publisher?: string;
  /** The first 12 hex digits of the file's sha256: two locations with one digest hold the same words. */
  digest: string;
}

export interface InstalledSkill {
  /** `skillKey`: the origin's family, the plugin and the name. Stable across reads, so a pick survives a refresh. */
  id: string;
  name: string;
  description?: string;
  origin: SkillOrigin;
  kind: "skill" | "command";
  /** The plugin's name, for a plugin's skill. */
  plugin?: string;
  locations: SkillLocation[];
  /** How many different texts its locations hold: more than one is copies that have drifted, or two versions. */
  versions: number;
}

/** An account, and how many skills it carries: what the list's account filter offers. */
export interface LibraryAccount {
  agent: SkillAgent;
  id: string;
  label: string;
  configDir: string;
  skills: number;
}

export interface InstalledSkillsRead {
  accounts: LibraryAccount[];
  skills: InstalledSkill[];
  /** What could not be read, in words; the rest of the list stands. */
  problems: string[];
  readAt: number;
}

export interface SkillsLibraryHomes {
  claudeAccounts: ClaudeAccount[];
  codexAccounts: CodexAccount[];
  /** `~/.agents`, which every Codex profile reads; null leaves it out. */
  agentsHome: string | null;
  /** Folders sessions work in, each scanned for project skills. */
  projectFolders: string[];
}

const DESCRIPTION_MAX = 360;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMAND_FILE_MAX = 256 * 1024;
const PROJECT_FOLDERS_MAX = 64;
const DIGEST_HEAD_BYTES = 512 * 1024;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The homes this Mac has: every registered account of both agents, `~/.agents`, and the folders sessions work in. */
export function libraryHomes(defaultDir = defaultClaudeDir()): SkillsLibraryHomes {
  const folders = new Set<string>();
  for (const list of Object.values(workingFolderOverrides())) for (const folder of list) folders.add(folder);
  return {
    claudeAccounts: readClaudeAccounts(defaultDir),
    codexAccounts: readCodexAccounts(),
    agentsHome: join(conchHome(), ".agents"),
    projectFolders: [...folders],
  };
}

/** One line of a description, at most `DESCRIPTION_MAX` characters: the whole text is the SKILL.md, a click away. */
export function shortDescription(value: string | undefined): string | undefined {
  const flat = value?.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= DESCRIPTION_MAX ? flat : `${flat.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

function digestOf(path: string): string {
  try {
    const bytes = readFileSync(path);
    return createHash("sha256").update(bytes.subarray(0, DIGEST_HEAD_BYTES)).digest("hex").slice(0, 12);
  } catch {
    return "unreadable";
  }
}

/**
 * Which entry a location belongs to. A plugin's skill is its plugin's, whichever account or agent installed it; claude.ai's
 * are claude.ai's; Codex's built-in ones and an administrator's are their own; anything else a person put in a skills
 * folder (their own, or a project's) is one skill by its name, so a copy in Claude and a copy in Codex meet.
 */
export function skillKey(location: Pick<SkillLocation, "origin" | "kind" | "pluginId">, name: string): string {
  const family = location.origin === "plugin" ? `plugin:${(location.pluginId ?? "").split("@")[0]}`
    : location.origin === "claude.ai" ? "claude.ai"
    : location.origin === "system" ? "system"
    : location.origin === "managed" || location.origin === "admin" ? "managed"
    : "own";
  return `${location.kind === "command" ? "command" : "skill"}:${family}:${name}`;
}

/** How a skill is called by hand, in the agent's own spelling; undefined when only the model may call it. */
export function invocationFor(agent: SkillAgent, name: string, options: { plugin?: string; synced?: boolean; userInvocable?: boolean } = {}): string | undefined {
  if (options.userInvocable === false) return undefined;
  if (agent === "codex") return `$${name}`;
  if (options.synced) return `/anthropic-skills:${name}`;
  return options.plugin ? `/${options.plugin}:${name}` : `/${name}`;
}

interface Found {
  name: string;
  description?: string;
  location: SkillLocation;
}

function originOf(entity: AgentCapabilityEntity): SkillOrigin | null {
  switch (entity.scope) {
    case "plugin": return "plugin";
    case "user": return "user";
    case "project": case "local": return "project";
    case "system": return "system";
    case "managed": return "managed";
    case "admin": return "admin";
    default: return null;
  }
}

/** The skills one account's capability read found, and its plugins' commands. */
function accountSkills(agent: SkillAgent, account: ClaudeAccount, problems: string[]): Found[] {
  const found: Found[] = [];
  let entities: AgentCapabilityEntity[];
  try {
    const read = accountCapabilities(agent, account);
    entities = read.entities;
    if (!read.complete) problems.push(`${agentName(agent)} · ${account.label}: part of its configuration could not be read.`);
  } catch (error) {
    problems.push(`${agentName(agent)} · ${account.label}: ${error instanceof Error ? error.message : String(error)}`);
    return found;
  }
  const plugins = new Map<string, Extract<AgentCapabilityEntity, { kind: "plugin" }>>();
  for (const entity of entities) if (entity.kind === "plugin") plugins.set(entity.id, entity);
  for (const entity of entities) {
    if (entity.kind !== "skill") continue;
    const origin = originOf(entity);
    if (!origin) continue;
    const plugin = entity.parentId ? plugins.get(entity.parentId) : undefined;
    const pluginName = entity.skill.ownerPluginId?.split("@")[0];
    found.push({
      name: entity.name,
      ...(entity.description ? { description: entity.description } : {}),
      location: {
        agent,
        accountId: account.id,
        accountLabel: account.label,
        origin,
        kind: "skill",
        path: entity.skill.path,
        ...(entity.skill.ownerPluginId ? { pluginId: entity.skill.ownerPluginId } : {}),
        ...(plugin?.plugin.version ? { pluginVersion: plugin.plugin.version } : {}),
        enabled: entity.skill.enabledForNextSession,
        ...optional("invocation", invocationFor(agent, entity.name, { plugin: pluginName, userInvocable: entity.skill.userInvocable })),
        digest: digestOf(entity.skill.path),
      },
    });
  }
  // A Claude plugin's commands: the capability read counts its skills, not these.
  if (agent === "claude") {
    for (const plugin of plugins.values()) {
      if (!plugin.plugin.installPath) continue;
      const pluginName = plugin.plugin.pluginId.split("@")[0]!;
      for (const command of commandFiles(join(plugin.plugin.installPath, "commands"))) {
        found.push(commandFound(command, {
          agent, accountId: account.id, accountLabel: account.label, origin: "plugin",
          pluginId: plugin.plugin.pluginId, ...(plugin.plugin.version ? { pluginVersion: plugin.plugin.version } : {}),
          enabled: plugin.plugin.enabledForNextSession,
        }, pluginName));
      }
    }
    for (const command of commandFiles(join(account.configDir, "commands"))) {
      found.push(commandFound(command, { agent, accountId: account.id, accountLabel: account.label, origin: "user", enabled: true }));
    }
    found.push(...syncedSkills(account, problems));
  }
  return found;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function agentName(agent: SkillAgent): string {
  return agent === "claude" ? "Claude Code" : "Codex";
}

/**
 * claude.ai's skills for the sign-in this profile holds now: the folder named for its organization and account, read
 * with its manifest. A profile signed in with an API key, or not at all, has none.
 */
export function syncedSkills(account: ClaudeAccount, problems: string[] = []): Found[] {
  const root = join(account.configDir, "skills", "synced");
  if (!existsSync(root)) return [];
  let bucket: string | undefined;
  try {
    const state: unknown = JSON.parse(readFileSync(statePath(account), "utf8"));
    const oauth = record(state) && record(state.oauthAccount) ? state.oauthAccount : null;
    const organization = text(oauth?.organizationUuid);
    const user = text(oauth?.accountUuid);
    if (organization && user && /^[A-Za-z0-9-]{1,64}$/.test(organization) && /^[A-Za-z0-9-]{1,64}$/.test(user)) {
      bucket = `${organization}_${user}`;
    }
  } catch {
    return [];
  }
  if (!bucket || !existsSync(join(root, bucket))) return [];
  const folder = join(root, bucket);
  const publishers = new Map<string, string>();
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
    if (record(manifest) && Array.isArray(manifest.skills)) {
      for (const skill of manifest.skills) {
        const name = record(skill) ? text(skill.name) : undefined;
        const source = record(skill) ? text(skill.source) : undefined;
        if (name && source) publishers.set(name, source);
      }
    }
  } catch {
    problems.push(`Claude Code · ${account.label}: claude.ai's skill manifest could not be read.`);
  }
  const found: Found[] = [];
  for (const entry of safeEntries(folder)) {
    if (!entry.isDirectory()) continue;
    const path = join(folder, entry.name, "SKILL.md");
    if (!isFile(path)) continue;
    let metadata: ReturnType<typeof readSkillMetadata>;
    try { metadata = readSkillMetadata(path); } catch { continue; }
    const publisher = publishers.get(metadata.name) ?? publishers.get(entry.name);
    found.push({
      name: metadata.name,
      ...(metadata.description ? { description: metadata.description } : {}),
      location: {
        agent: "claude", accountId: account.id, accountLabel: account.label, origin: "claude.ai", kind: "skill", path,
        enabled: true,
        ...optional("invocation", invocationFor("claude", metadata.name, { synced: true, userInvocable: metadata.userInvocable })),
        ...(publisher ? { publisher } : {}),
        digest: digestOf(path),
      },
    });
  }
  return found;
}

function safeEntries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); } catch { return []; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** `commands/*.md`, and one folder deep (`commands/<group>/*.md`, which Claude Code lists under the group). */
function commandFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of safeEntries(root)) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      for (const inner of safeEntries(path)) {
        if (inner.isFile() && inner.name.endsWith(".md")) files.push(join(path, inner.name));
      }
    }
  }
  return files.sort();
}

/** A command's name is its file's; its description its frontmatter's, else its first line of prose. */
export function commandMetadata(path: string): { name: string; description?: string } {
  const name = basename(path).replace(/\.md$/, "");
  let head = "";
  try {
    if (statSync(path).size <= COMMAND_FILE_MAX) head = readFileSync(path, "utf8");
  } catch {}
  const lines = head.replaceAll("\r\n", "\n").split("\n");
  let body = lines;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      const described = lines.slice(1, end).map((line) => /^description:\s*(.*)$/.exec(line)?.[1]).find(Boolean);
      const cleaned = described?.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (cleaned) return { name, description: cleaned };
      body = lines.slice(end + 1);
    }
  }
  const prose = body.map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("<!--"));
  return { name, ...(prose ? { description: prose } : {}) };
}

function commandFound(path: string, location: Omit<SkillLocation, "kind" | "path" | "digest">, plugin?: string): Found {
  const metadata = commandMetadata(path);
  return {
    name: metadata.name,
    ...(metadata.description ? { description: metadata.description } : {}),
    location: {
      ...location, kind: "command", path,
      ...optional("invocation", invocationFor(location.agent, metadata.name, { plugin })),
      digest: digestOf(path),
    },
  };
}

/** A folder's skills for every account of each agent: `.claude/skills` and `.claude/commands`, `.agents/skills`. */
function projectSkills(folder: string): Found[] {
  const found: Found[] = [];
  const scan = (agent: SkillAgent, root: string) => {
    for (const entry of safeEntries(root)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(root, entry.name, "SKILL.md");
      if (!isFile(path)) continue;
      let metadata: ReturnType<typeof readSkillMetadata>;
      try { metadata = readSkillMetadata(path); } catch { continue; }
      found.push({
        name: metadata.name,
        ...(metadata.description ? { description: metadata.description } : {}),
        location: {
          agent, origin: "project", kind: "skill", path, projectPath: folder, enabled: null,
          ...optional("invocation", invocationFor(agent, metadata.name, { userInvocable: metadata.userInvocable })),
          digest: digestOf(path),
        },
      });
    }
  };
  scan("claude", join(folder, ".claude", "skills"));
  scan("codex", join(folder, ".agents", "skills"));
  for (const command of commandFiles(join(folder, ".claude", "commands"))) {
    found.push(commandFound(command, { agent: "claude", origin: "project", projectPath: folder, enabled: null }));
  }
  return found;
}

/** `~/.agents/skills`: every Codex profile's. */
function sharedCodexSkills(agentsHome: string): Found[] {
  const found: Found[] = [];
  const root = join(agentsHome, "skills");
  for (const entry of safeEntries(root)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root, entry.name, "SKILL.md");
    if (!isFile(path)) continue;
    let metadata: ReturnType<typeof readSkillMetadata>;
    try { metadata = readSkillMetadata(path); } catch { continue; }
    found.push({
      name: metadata.name,
      ...(metadata.description ? { description: metadata.description } : {}),
      location: {
        agent: "codex", origin: "user", kind: "skill", path, enabled: true,
        ...optional("invocation", invocationFor("codex", metadata.name, { userInvocable: metadata.userInvocable })),
        digest: digestOf(path),
      },
    });
  }
  return found;
}

/** Never looked inside for a project's skills: what tools install, build or check out, not what a person writes. */
const NOT_PROJECT_FOLDERS = new Set(["node_modules", ".git", ".worktrees", "build", "dist", ".next", ".build", "vendor", "Pods",
  "DerivedData", "target", ".venv", "venv", "__pycache__", ".cache"]);
const NESTED_DEPTH = 3;
const NESTED_VISITS_MAX = 4_000;

/**
 * The folders under a project, a few levels down, that hold skills of their own (`.claude/skills`, `.claude/commands`,
 * `.agents/skills`): Claude Code loads one when it works on files beneath it, so `conch-design/brand`'s are the project's
 * too. Bounded in depth and in folders looked at.
 */
export function nestedSkillFolders(root: string, depth = NESTED_DEPTH): string[] {
  const found: string[] = [];
  let visits = 0;
  const visit = (folder: string, level: number) => {
    if (level > depth || visits >= NESTED_VISITS_MAX) return;
    for (const entry of safeEntries(folder)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || NOT_PROJECT_FOLDERS.has(entry.name)) continue;
      visits += 1;
      const child = join(folder, entry.name);
      if (["skills", "commands"].some((kind) => existsSync(join(child, ".claude", kind))) || existsSync(join(child, ".agents", "skills"))) {
        found.push(child);
      }
      visit(child, level + 1);
    }
  };
  visit(root, 1);
  return found;
}

/** Folders that exist, each once by its real path, a session's folder and its repository's top. */
function projectRoots(folders: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const folder of folders) {
    if (roots.size >= PROJECT_FOLDERS_MAX) break;
    let real: string;
    try {
      real = realpathSync(folder);
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue;
    }
    // Home is no project: its `.claude` is the default account's own folder, read above.
    if (real === realpathOr(conchHome())) continue;
    roots.add(real);
    let current = real;
    while (true) {
      if (existsSync(join(current, ".git"))) {
        if (current !== realpathOr(conchHome())) roots.add(current);
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...roots].sort();
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Origins in the order an entry names the one it leads with. */
const ORIGIN_RANK: Record<SkillOrigin, number> = {
  user: 0, project: 1, plugin: 2, "claude.ai": 3, system: 4, managed: 5, admin: 6,
};

/** Every location, one entry per skill (`skillKey`), sorted by name. */
export function collapseSkills(found: readonly Found[]): InstalledSkill[] {
  const groups = new Map<string, { name: string; description?: string; locations: SkillLocation[] }>();
  for (const item of found) {
    if (!SKILL_NAME.test(item.name)) continue;
    const key = skillKey(item.location, item.name);
    const group = groups.get(key) ?? { name: item.name, locations: [] };
    if (!group.description && item.description) group.description = item.description;
    // The same file read twice (a plugin listed for two scopes of one account) is one location.
    if (!group.locations.some((existing) => existing.path === item.location.path
      && existing.agent === item.location.agent && existing.accountId === item.location.accountId)) {
      group.locations.push(item.location);
    }
    groups.set(key, group);
  }
  const skills: InstalledSkill[] = [];
  for (const [id, group] of groups) {
    const locations = group.locations.sort((a, b) =>
      a.agent.localeCompare(b.agent)
      || (a.accountLabel ?? "~").localeCompare(b.accountLabel ?? "~")
      || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]
      || a.path.localeCompare(b.path));
    const lead = locations.reduce((best, location) => ORIGIN_RANK[location.origin] < ORIGIN_RANK[best.origin] ? location : best);
    const plugin = locations.find((location) => location.pluginId)?.pluginId?.split("@")[0];
    skills.push({
      id,
      name: group.name,
      ...optional("description", shortDescription(group.description)),
      origin: lead.origin,
      kind: lead.kind,
      ...(plugin ? { plugin } : {}),
      locations,
      versions: new Set(locations.map((location) => location.digest)).size,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** Every skill this Mac has, read now. */
export function readInstalledSkills(homes: SkillsLibraryHomes = libraryHomes()): InstalledSkillsRead {
  const problems: string[] = [];
  const found: Found[] = [];
  const accounts: LibraryAccount[] = [];
  for (const [agent, list] of [["claude", homes.claudeAccounts], ["codex", homes.codexAccounts]] as const) {
    for (const account of list) {
      found.push(...accountSkills(agent, account, problems));
      accounts.push({ agent, id: account.id, label: account.label, configDir: account.configDir, skills: 0 });
    }
  }
  if (homes.agentsHome && homes.codexAccounts.length) found.push(...sharedCodexSkills(homes.agentsHome));
  const folders = new Set<string>();
  for (const root of projectRoots(homes.projectFolders)) {
    folders.add(root);
    for (const nested of nestedSkillFolders(root)) folders.add(nested);
  }
  for (const folder of folders) found.push(...projectSkills(folder));
  const skills = collapseSkills(found);
  // How many skills each account carries: entries with a copy there, not copies (a plugin installed for two scopes of
  // one account is one skill of it).
  for (const account of accounts) {
    account.skills = skills.filter((skill) => skill.locations.some((location) =>
      location.agent === account.agent && location.accountId === account.id)).length;
  }
  return { accounts, skills, problems, readAt: Date.now() };
}

// MARK: - Paging

/**
 * Items from `offset` that fit `budget` bytes of JSON, at least one: a reply has to fit one control frame (64 KiB, the
 * phone's bridge reads no more), and a library outgrows that. `next` is where the following page starts.
 */
export function pageOf<T>(items: readonly T[], offset: number, budget: number): { items: T[]; next?: number } {
  const page: T[] = [];
  let used = 2;
  let index = Math.max(0, Math.min(offset, items.length));
  while (index < items.length) {
    const size = Buffer.byteLength(JSON.stringify(items[index])) + 1;
    if (page.length > 0 && used + size > budget) break;
    page.push(items[index]!);
    used += size;
    index += 1;
  }
  return index < items.length ? { items: page, next: index } : { items: page };
}

/** What a page of a reply may spend on its items: a frame, less room for everything else the reply says. */
export const PAGE_BUDGET = CONTROL_FRAME_MAX_BYTES - 12 * 1024;

// MARK: - Discover's shape (skill-indexes.ts fills it)

/** One public index the library reads, and how its last read went. */
export interface SkillIndexStatus {
  id: string;
  name: string;
  maintainer: string;
  /** The index's own page, for a person to read. */
  url: string;
  /** Who its skills are written for. */
  agents: SkillAgent[];
  /** Skills it lists, as last read; for a search index, what the last search found. */
  count: number;
  fetchedAt?: number;
  /** Why the last read failed, in words; what was read before it is still listed. */
  error?: string;
}

/** A skill from a public index. */
export interface DiscoverSkill {
  /** `<index>:<where in it>`, stable across reads. */
  id: string;
  index: string;
  name: string;
  description?: string;
  /** `owner/repository` on GitHub, where its files are. */
  repo?: string;
  /** Its folder in that repository. */
  path?: string;
  /** Where to read about it on the web. */
  url: string;
  /** What the index counts (skills.sh's installs). */
  installs?: number;
  /** Who reviewed its plugin, in Anthropic's directory: Anthropic, a partner, or nobody yet (community). */
  trust?: "anthropic" | "partner" | "community";
  /** The licence its index names. */
  license?: string;
  /** For a plugin's skill: the plugin, which has to be installed whole for this skill to work (`needsPlugin`). */
  plugin?: string;
  /** Its SKILL.md uses its plugin's own folder, so a copy of the skill alone would not run. */
  needsPlugin?: boolean;
  /** Tyler has a skill by this name already, somewhere (`markInstalled`). */
  installed?: boolean;
  /** Its folder on this Mac, once fetched. */
  local?: string;
}

export interface DiscoverProvider {
  /** What the indexes list, filtered; `refresh` reads every index again, in the background. */
  list(options: { query?: string; index?: string; refresh?: boolean }): Promise<{ indexes: SkillIndexStatus[]; entries: DiscoverSkill[]; refreshing: boolean }>;
  /** The skill's folder on this Mac, fetched now if it isn't yet. */
  local(entryId: string): Promise<{ entry: DiscoverSkill; folder: string }>;
}

/** Entries whose name Tyler already has, marked, so Discover can say so rather than offer it again. */
export function markInstalled(entries: readonly DiscoverSkill[], installed: readonly InstalledSkill[]): DiscoverSkill[] {
  const names = new Set(installed.map((skill) => skill.name.toLowerCase()));
  return entries.map((entry) => names.has(entry.name.toLowerCase()) ? { ...entry, installed: true } : entry);
}

// MARK: - The wire

export const SKILLS_LIBRARY_ACTIONS = ["installed", "discover", "open", "add-preview", "add", "trial"] as const;
export type SkillsLibraryAction = (typeof SKILLS_LIBRARY_ACTIONS)[number];

export interface SkillsLibraryRequest {
  kind: "skills-library";
  action: SkillsLibraryAction;
  /** A page's start (`installed`, `discover`): the previous reply's `next`. */
  offset?: number;
  /** `discover`: words to look for, and one index to look in. */
  query?: string;
  index?: string;
  /** `discover`: read every index again. `installed`: read the disk again rather than the last read's pages. */
  refresh?: true;
  /** `open`, `add-preview`, `add`, `trial` of a skill from an index. */
  entryId?: string;
  /** `trial` of an installed skill: the location's file, as `installed` gave it. */
  path?: string;
  /** `add-preview`, `add`, `trial`: whose account. A project's or `~/.agents`' skill tried has none. */
  agent?: SkillAgent;
  accountId?: string;
  /** `add`: the preview's `planHash`, so a folder that changed since is refused. */
  planHash?: string;
}

export interface SkillAddPreview extends SkillCopyPlanWire {
  agent: SkillAgent;
  accountId: string;
  accountLabel: string;
}

/** `SkillCopyPlan` as it crosses the wire (skill-install.ts). */
export interface SkillCopyPlanWire {
  name: string;
  destination: string;
  files: Array<{ path: string; bytes: number }>;
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
  planHash: string;
  refusal?: string;
}

export type SkillsLibraryReply =
  | { kind: "skills-library"; action: "installed"; accounts: LibraryAccount[]; skills: InstalledSkill[]; total: number;
    next?: number; problems: string[]; readAt: number }
  | { kind: "skills-library"; action: "discover"; indexes: SkillIndexStatus[]; entries: DiscoverSkill[]; total: number;
    next?: number; refreshing: boolean }
  | { kind: "skills-library"; action: "open"; entry: DiscoverSkill; folder: string }
  | { kind: "skills-library"; action: "add-preview"; preview: SkillAddPreview }
  | { kind: "skills-library"; action: "add"; added: string; agent: SkillAgent; accountId: string; name: string }
  | { kind: "skills-library"; action: "trial"; cwd: string; prompt: string; agent: SkillAgent; accountId?: string; name: string };

const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f]/;
const printable = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !UNPRINTABLE.test(value);
const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function skillsLibraryRequestError(value: Record<string, unknown>): string | undefined {
  if (!(SKILLS_LIBRARY_ACTIONS as readonly string[]).includes(String(value.action))) return "Unknown skills library action";
  const allowed: Record<SkillsLibraryAction, string[]> = {
    installed: ["offset", "refresh"],
    discover: ["offset", "query", "index", "refresh"],
    open: ["entryId"],
    "add-preview": ["entryId", "agent", "accountId"],
    add: ["entryId", "agent", "accountId", "planHash"],
    trial: ["entryId", "path", "agent", "accountId"],
  };
  const action = value.action as SkillsLibraryAction;
  for (const key of Object.keys(value)) {
    if (key !== "kind" && key !== "action" && !allowed[action].includes(key)) return `skills-library ${action} takes no ${key}`;
  }
  if (value.offset !== undefined && !(Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 && (value.offset as number) <= 100_000)) return "offset must be a page's start";
  if (value.refresh !== undefined && value.refresh !== true) return "refresh must be true when present";
  if (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 200 || UNPRINTABLE.test(value.query))) return "query must be up to 200 printable characters";
  if (value.index !== undefined && !(printable(value.index, 64) && /^[a-z0-9][a-z0-9-]*$/.test(value.index))) return "index must name an index";
  if (value.entryId !== undefined && !printable(value.entryId, 1_024)) return "entryId must name a skill from an index";
  if (value.path !== undefined && !(printable(value.path, 4_096) && value.path.startsWith("/"))) return "path must be an installed skill's file";
  if (value.agent !== undefined && value.agent !== "claude" && value.agent !== "codex") return "agent must be claude or codex";
  if (value.accountId !== undefined && !(typeof value.accountId === "string" && ACCOUNT_ID.test(value.accountId))) return "Choose an account";
  if (value.planHash !== undefined && !(typeof value.planHash === "string" && /^[0-9a-f]{64}$/.test(value.planHash))) return "planHash must be the preview's";
  if (action === "open" && value.entryId === undefined) return "open names a skill from an index";
  if ((action === "add-preview" || action === "add") && (value.entryId === undefined || value.agent === undefined || value.accountId === undefined)) {
    return "Choose a skill and the account to add it to";
  }
  if (action === "add" && value.planHash === undefined) return "add carries the preview's planHash";
  if (action === "trial") {
    if ((value.entryId === undefined) === (value.path === undefined)) return "trial names either a skill from an index or an installed skill's file";
    if (value.entryId !== undefined && value.agent === undefined) return "Choose the agent to try it in";
  }
}

function isLocation(value: unknown): value is SkillLocation {
  return record(value)
    && (value.agent === "claude" || value.agent === "codex")
    && (value.accountId === undefined || (typeof value.accountId === "string" && ACCOUNT_ID.test(value.accountId)))
    && (value.accountLabel === undefined || printable(value.accountLabel, 120))
    && (SKILL_ORIGINS as readonly string[]).includes(String(value.origin))
    && (value.kind === "skill" || value.kind === "command")
    && printable(value.path, 4_096)
    && (value.enabled === null || typeof value.enabled === "boolean")
    && typeof value.digest === "string" && value.digest.length <= 16;
}

function isInstalledSkill(value: unknown): value is InstalledSkill {
  return record(value) && printable(value.id, 512) && printable(value.name, 128)
    && (value.description === undefined || printable(value.description, DESCRIPTION_MAX))
    && Array.isArray(value.locations) && value.locations.length > 0 && value.locations.length <= 64 && value.locations.every(isLocation)
    && Number.isSafeInteger(value.versions);
}

function isIndexStatus(value: unknown): value is SkillIndexStatus {
  return record(value) && printable(value.id, 64) && printable(value.name, 120) && printable(value.url, 2_048)
    && Array.isArray(value.agents) && Number.isSafeInteger(value.count)
    && (value.error === undefined || printable(value.error, 600));
}

function isDiscoverSkill(value: unknown): value is DiscoverSkill {
  return record(value) && printable(value.id, 1_024) && printable(value.index, 64) && printable(value.name, 128)
    && printable(value.url, 2_048) && (value.description === undefined || printable(value.description, DESCRIPTION_MAX));
}

/** The reply's shape, for the CLI and the tests: the app decodes the same fields. */
export function isSkillsLibraryReply(value: unknown): value is SkillsLibraryReply {
  if (!record(value) || value.kind !== "skills-library") return false;
  switch (value.action) {
    case "installed":
      return Array.isArray(value.accounts) && Array.isArray(value.skills) && value.skills.every(isInstalledSkill)
        && Number.isSafeInteger(value.total) && Array.isArray(value.problems);
    case "discover":
      return Array.isArray(value.indexes) && value.indexes.every(isIndexStatus) && Array.isArray(value.entries)
        && value.entries.every(isDiscoverSkill) && Number.isSafeInteger(value.total) && typeof value.refreshing === "boolean";
    case "open": return isDiscoverSkill(value.entry) && printable(value.folder, 4_096);
    case "add-preview": return record(value.preview) && printable(value.preview.destination, 4_096) && Array.isArray(value.preview.files);
    case "add": return printable(value.added, 4_096);
    case "trial": return printable(value.cwd, 4_096) && printable(value.prompt, 2_000);
    default: return false;
  }
}

// MARK: - The handler

export interface SkillsLibraryDependencies {
  homes(): SkillsLibraryHomes;
  discover: DiscoverProvider;
  now?(): number;
}

/** A read the next pages of a listing come from, so a page never comes from a different read than the one before it. */
const INSTALLED_FRESH_MS = 5_000;

/**
 * The daemon's skills library: one inventory read per listing (pages after the first come from it), the indexes through
 * `discover`, and Add and Try (skill-install.ts) against the accounts the homes name — never a folder the request names,
 * except an installed skill's own file, which must be one the inventory lists.
 */
export function createSkillsLibrary(dependencies: SkillsLibraryDependencies) {
  const now = dependencies.now ?? Date.now;
  let last: { read: InstalledSkillsRead; at: number } | undefined;

  /** The last read, unless `fresh` (or there is none). */
  const installed = (fresh: boolean): InstalledSkillsRead => {
    if (last && !fresh) return last.read;
    const read = readInstalledSkills(dependencies.homes());
    last = { read, at: now() };
    return read;
  };

  const account = (agent: SkillAgent, accountId: string): ClaudeAccount => {
    const homes = dependencies.homes();
    const found = (agent === "claude" ? homes.claudeAccounts : homes.codexAccounts).find((candidate) => candidate.id === accountId);
    if (!found) throw new Error(`That ${agentName(agent)} account was removed or is unavailable. Choose an account again.`);
    return found;
  };

  const preview = async (request: SkillsLibraryRequest): Promise<{ preview: SkillAddPreview; folder: string; entry: DiscoverSkill }> => {
    const target = account(request.agent!, request.accountId!);
    const { entry, folder } = await dependencies.discover.local(request.entryId!);
    const name = validSkillFolderName(entry.name) ? entry.name : basename(folder);
    const plan = planSkillCopy(folder, name, join(target.configDir, "skills"));
    const refusal = entry.needsPlugin
      ? `it runs from its plugin's own folder; install ${entry.plugin ?? "its plugin"} in Settings › Plugins & MCP instead`
      : plan.refusal;
    const { source: _source, ...wire } = plan;
    return {
      folder,
      entry,
      preview: { ...wire, ...(refusal ? { refusal } : {}), agent: request.agent!, accountId: target.id, accountLabel: target.label },
    };
  };

  async function handle(request: SkillsLibraryRequest): Promise<SkillsLibraryReply> {
    switch (request.action) {
      case "installed": {
        // A listing's first page reads the disk again, unless a read is only seconds old; its later pages come from it.
        const stale = !last || now() - last.at >= INSTALLED_FRESH_MS;
        const read = installed(request.refresh === true || (!request.offset && stale));
        const page = pageOf(read.skills, request.offset ?? 0, PAGE_BUDGET);
        return {
          kind: "skills-library", action: "installed", accounts: read.accounts, skills: page.items, total: read.skills.length,
          ...(page.next === undefined ? {} : { next: page.next }), problems: read.problems.slice(0, 20), readAt: read.readAt,
        };
      }
      case "discover": {
        const listed = await dependencies.discover.list({
          ...(request.query ? { query: request.query } : {}),
          ...(request.index ? { index: request.index } : {}),
          ...(request.refresh ? { refresh: true } : {}),
        });
        const entries = markInstalled(listed.entries, installed(false).skills);
        const page = pageOf(entries, request.offset ?? 0, PAGE_BUDGET - 8 * 1024);
        return {
          kind: "skills-library", action: "discover", indexes: listed.indexes, entries: page.items, total: entries.length,
          ...(page.next === undefined ? {} : { next: page.next }), refreshing: listed.refreshing,
        };
      }
      case "open": {
        const { entry, folder } = await dependencies.discover.local(request.entryId!);
        return { kind: "skills-library", action: "open", entry, folder };
      }
      case "add-preview":
        return { kind: "skills-library", action: "add-preview", preview: (await preview(request)).preview };
      case "add": {
        const { preview: plan, folder } = await preview(request);
        if (plan.refusal) throw new Error(`Not added: ${plan.refusal}.`);
        const target = account(request.agent!, request.accountId!);
        const added = applySkillCopy(folder, plan.name, join(target.configDir, "skills"), request.planHash!);
        last = undefined;
        return { kind: "skills-library", action: "add", added, agent: request.agent!, accountId: target.id, name: plan.name };
      }
      case "trial": {
        if (request.entryId) {
          const { entry, folder } = await dependencies.discover.local(request.entryId);
          if (entry.needsPlugin) throw new Error(`Can't try ${entry.name} alone: it runs from its plugin's own folder. Install ${entry.plugin ?? "its plugin"} in Settings › Plugins & MCP.`);
          const agent = request.agent!;
          if (request.accountId) account(agent, request.accountId);
          const name = validSkillFolderName(entry.name) ? entry.name : basename(folder);
          const { cwd } = prepareTrialFolder(name, agent, folder);
          return {
            kind: "skills-library", action: "trial", cwd, prompt: trialPrompt(name, invocationFor(agent, name)), agent,
            ...(request.accountId ? { accountId: request.accountId } : {}), name,
          };
        }
        const read = installed(true);
        let found: { skill: InstalledSkill; location: SkillLocation } | undefined;
        for (const skill of read.skills) {
          const location = skill.locations.find((candidate) => candidate.path === request.path
            && (request.agent === undefined || candidate.agent === request.agent)
            && (candidate.accountId === undefined || request.accountId === undefined || candidate.accountId === request.accountId));
          if (location) { found = { skill, location }; break; }
        }
        if (!found) throw new Error("That skill isn't where it was; refresh the list.");
        const { skill, location } = found;
        const accountId = location.accountId ?? request.accountId;
        if (accountId && !location.accountId) account(location.agent, accountId);
        const folderName = validSkillFolderName(skill.name) ? skill.name : "skill";
        const cwd = location.projectPath ?? prepareTrialFolder(folderName, location.agent).cwd;
        return {
          kind: "skills-library", action: "trial", cwd, prompt: trialPrompt(skill.name, location.invocation), agent: location.agent,
          ...(accountId ? { accountId } : {}), name: skill.name,
        };
      }
    }
  }

  return { handle, forget: () => { last = undefined; } };
}

// MARK: - The CLI (`conch skills`)

type ControlResult = { ok: true; response: unknown } | { ok: false; reason: string; diagnostic?: string };

/** Every page of a listing, asked for in turn until the daemon says there is no next one (at most `limit` pages). */
export async function collectSkillsPages(
  ask: (offset: number) => Promise<ControlResult>,
  limit: number,
): Promise<{ replies: SkillsLibraryReply[] } | { error: string }> {
  const replies: SkillsLibraryReply[] = [];
  let offset = 0;
  for (let page = 0; page < limit; page += 1) {
    const result = await ask(offset);
    if (!result.ok) return { error: result.reason === "daemon-down" ? "daemon not running" : `the daemon didn't answer${result.diagnostic ? ` (${result.diagnostic})` : ""}` };
    const response = result.response;
    if (!isSkillsLibraryReply(response)) {
      const said = record(response) && typeof response.error === "string" ? response.error : "an answer conch doesn't know";
      return { error: `${said} — the daemon may need updating` };
    }
    replies.push(response);
    const next = "next" in response ? response.next : undefined;
    if (next === undefined) break;
    offset = next;
  }
  return { replies };
}

/** Where a location lives, in a few words: "Claude · Blueprint · plugin figma", "Codex · project Conch". */
export function locationLabel(location: SkillLocation): string {
  const who = location.accountLabel ?? (location.origin === "project" ? `project ${basename(location.projectPath ?? "")}` : "every account");
  const what = location.origin === "plugin" ? `plugin ${(location.pluginId ?? "").split("@")[0]}`
    : location.origin === "project" ? "" : location.origin;
  return [agentName(location.agent), who, what, location.enabled === false ? "off" : ""].filter(Boolean).join(" · ");
}

export function formatInstalledTable(replies: readonly SkillsLibraryReply[]): string[] {
  const pages = replies.filter((reply): reply is Extract<SkillsLibraryReply, { action: "installed" }> => reply.action === "installed");
  const first = pages[0];
  if (!first) return [];
  const skills = pages.flatMap((page) => page.skills);
  const lines = [`${skills.length} skills in ${skills.reduce((sum, skill) => sum + skill.locations.length, 0)} places`];
  for (const account of first.accounts) lines.push(`  ${agentName(account.agent)} · ${account.label}: ${account.skills}  ${account.configDir}`);
  for (const problem of first.problems) lines.push(`  ! ${problem}`);
  lines.push("");
  for (const skill of skills) {
    lines.push(`${skill.name.padEnd(36)} ${skill.locations.map(locationLabel).join("; ")}${skill.versions > 1 ? `  (${skill.versions} versions)` : ""}`);
  }
  return lines;
}

export function formatDiscoverTable(replies: readonly SkillsLibraryReply[]): string[] {
  const reply = replies.find((page): page is Extract<SkillsLibraryReply, { action: "discover" }> => page.action === "discover");
  if (!reply) return [];
  const lines = reply.indexes.map((index) => `  ${index.name} (${index.maintainer}): ${index.count}${index.error ? `  ! ${index.error}` : ""}`);
  lines.unshift(`${reply.total} skills${reply.refreshing ? " (reading the indexes…)" : ""}`);
  lines.push("");
  for (const entry of reply.entries.slice(0, 40)) {
    lines.push(`${entry.name.padEnd(32)} ${entry.index.padEnd(20)} ${entry.installed ? "have it  " : ""}${entry.description?.slice(0, 80) ?? entry.repo ?? ""}`);
  }
  return lines;
}
