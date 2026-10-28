#!/usr/bin/env bun
/**
 * One Claude profile for all of conch (2026-10-28, Tyler: "we should have one account for all of conch I thought? (at
 * least for mine)"). Folds a second profile into Default: its conversations and memory copied across, the settings and
 * MCP servers Default lacks carried over, and the profile retired, so conch launches nothing in it again
 * (src/retired-profile.ts). Rotation already moves Default's sign-in between every subscription; the second profile
 * only split sessions, settings and memory in two.
 *
 *   bun scripts/one-account.ts                  says what it would do; nothing is written
 *   bun scripts/one-account.ts --apply          does it
 *     --from <id or name>                       the profile to fold in (default: the one besides Default)
 *     --even-if-not-rotated                     retire it although rotation doesn't cover its subscription
 *
 * It reads the profile it folds in and never writes there: its folder, transcripts and sign-in all stay. It never reads
 * a credential or the Keychain and never signs anything in or out. Every file it changes in Default is copied first to
 * ~/.config/conch/one-account-backups/<time>/, with a manifest of what it wrote. Running it again is safe: it brings
 * across only what is new, which is how the turns and memory a session wrote before it moved come across.
 */
import { createHash } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { readClaudeAccounts, retireClaudeAccount, type ClaudeAccount } from "../src/claude-accounts.ts";
import { profileKeychainService } from "../src/claude-rotation.ts";
import { conchHome } from "../src/home.ts";
import { bringConversationAcross, type BroughtAcross } from "../src/retired-profile.ts";

export interface MigrationPaths {
  home: string;
  /** Default's folder, and the file Claude keeps Default's MCP servers and folder trust in. */
  defaultDir: string;
  defaultConfig: string;
  conchConfigDir: string;
  /** claude-swap's list of accounts, read for the emails in it (never its credentials). */
  swapSequence: string;
  /** conch's published state: which live sessions it shows, and under what name. */
  sessionsFile: string;
}

/**
 * The real ones. Default is ~/.claude as a fresh shell's Claude Code has it, whatever CLAUDE_CONFIG_DIR says here: run
 * from a session in the profile being folded in, that names the profile itself (resume-account.ts reads them the same way).
 */
export function realPaths(env: Record<string, string | undefined> = process.env): MigrationPaths {
  const home = conchHome();
  return {
    home,
    defaultDir: join(home, ".claude"),
    defaultConfig: join(home, ".claude.json"),
    conchConfigDir: env.CONCH_CONFIG_DIR ?? join(home, ".config", "conch"),
    swapSequence: join(home, ".claude-swap-backup", "sequence.json"),
    sessionsFile: env.CONCH_SESSIONS_FILE || "/tmp/conch-sessions.json",
  };
}

type Json = Record<string, unknown>;
const readJson = (path: string): Json | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** Files under a folder, as paths relative to it; symlinks passed over. */
function filesUnder(root: string, under = ""): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, under), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => entry.isDirectory() ? filesUnder(root, join(under, entry.name))
    : entry.isFile() ? [join(under, entry.name)] : []);
}

/**
 * Two memory indexes as one: Default's lines as they are, then each of the other's whose memory Default's doesn't list.
 * Where both list the same memory differently, the newer index's line wins.
 */
export function mergeMemoryIndex(base: string, incoming: string, incomingNewer: boolean): string {
  const target = (line: string) => /\]\(([^)\s]+)\)/.exec(line)?.[1];
  const lines = base.replace(/\n+$/, "").split("\n");
  const at = new Map(lines.flatMap((line, index) => target(line) ? [[target(line)!, index] as const] : []));
  for (const line of incoming.split("\n")) {
    if (!line.trim()) continue;
    const memory = target(line);
    const index = memory === undefined ? undefined : at.get(memory);
    if (index !== undefined) {
      if (incomingNewer) lines[index] = line;
      continue;
    }
    if (memory === undefined && lines.includes(line)) continue;
    if (memory !== undefined) at.set(memory, lines.length);
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

/** Settings in the folded profile that are its own (conch's per-profile status line and hooks) or about signing in. */
const SETTINGS_LEFT = new Set(["statusLine", "hooks", "env", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod", "forceLoginOrgUUID", "otelHeadersHelper"]);

export interface SettingsPlan {
  /** Default with what it lacks added. */
  merged: Json;
  carried: string[];
  conflicts: { key: string; kept: unknown; theirs: unknown }[];
  left: string[];
}

/** What Default lacks from the other profile's settings.json, one level into objects; where both say, Default's stands. */
export function planSettings(defaults: Json, theirs: Json): SettingsPlan {
  const merged: Json = structuredClone(defaults);
  const plan: SettingsPlan = { merged, carried: [], conflicts: [], left: [] };
  for (const [key, value] of Object.entries(theirs)) {
    if (SETTINGS_LEFT.has(key)) {
      if (!same(defaults[key], value)) plan.left.push(key);
      continue;
    }
    if (!(key in defaults)) {
      merged[key] = value;
      plan.carried.push(`${key}: ${JSON.stringify(value)}`);
    } else if (isObject(value) && isObject(defaults[key])) {
      const into = merged[key] as Json;
      for (const [inner, innerValue] of Object.entries(value)) {
        if (!(inner in into)) {
          into[inner] = innerValue;
          plan.carried.push(`${key}.${inner}: ${JSON.stringify(innerValue)}`);
        } else if (!same(into[inner], innerValue)) {
          plan.conflicts.push({ key: `${key}.${inner}`, kept: into[inner], theirs: innerValue });
        }
      }
    } else if (!same(defaults[key], value)) {
      plan.conflicts.push({ key, kept: defaults[key], theirs: value });
    }
  }
  return plan;
}

export interface ConversationPlan { id: string; project: string; bytes: number; transcript: BroughtAcross; files: number }
export interface MemoryPlan {
  project: string;
  file: string;
  /** copy: Default lacks it; merge: both indexes, joined; replace/keep: both differ, the newer wins. */
  action: "copy" | "merge" | "replace" | "keep" | "same";
  merged?: string;
}
export interface LiveSession { pid: number; id: string; cwd: string; label: string; kind: string; hidden: boolean; caller: boolean }

export interface Plan {
  from: ClaudeAccount;
  to: ClaudeAccount;
  email?: string;
  rotation: { on: boolean; emails: string[]; covers: boolean };
  conversations: ConversationPlan[];
  memory: MemoryPlan[];
  settings: SettingsPlan;
  settingsDigest: string;
  mcp: { add: { name: string; config: unknown }[]; conflicts: string[]; perProject: string[] };
  plugins: { notInstalled: string[]; marketplaces: string[] };
  userFiles: { copy: string[]; conflicts: string[] };
  live: LiveSession[];
}

function chooseProfile(accounts: ClaudeAccount[], from?: string): ClaudeAccount {
  const others = accounts.filter((account) => account.id !== "default");
  if (from) {
    const chosen = others.find((account) => account.id === from || account.label.toLowerCase() === from.toLowerCase());
    if (!chosen) throw new Error(`no Claude profile "${from}" besides Default (there is ${others.map((one) => `"${one.label}"`).join(", ") || "none"})`);
    return chosen;
  }
  if (others.length !== 1) throw new Error(others.length ? `say which profile to fold in with --from: ${others.map((one) => `"${one.label}" (${one.id})`).join(", ")}` : "there is no profile besides Default: nothing to fold in");
  return others[0]!;
}

/** The processes this one runs under: a session running the script is moved last. */
function ancestors(): Set<number> {
  const parents = new Map<number, number>();
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  for (const row of ps.stdout.toString().trim().split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) parents.set(pid, ppid);
  }
  const chain = new Set<number>();
  for (let pid = process.pid; pid > 1 && !chain.has(pid); pid = parents.get(pid) ?? 0) chain.add(pid);
  return chain;
}

function liveSessions(from: ClaudeAccount, sessionsFile: string): LiveSession[] {
  const published = readJson(sessionsFile);
  const rows = Array.isArray(published?.rows) ? published.rows as Json[] : [];
  const dismissed = Array.isArray(published?.dismissedRows) ? published.dismissedRows as Json[] : [];
  const mine = ancestors();
  const live: LiveSession[] = [];
  for (const name of readdirSync(join(from.configDir, "sessions"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
    const entry = readJson(join(from.configDir, "sessions", name.name));
    const pid = Number(entry?.pid);
    if (!entry || !Number.isSafeInteger(pid) || typeof entry.sessionId !== "string") continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") continue;
    }
    const row = rows.find((one) => one.id === entry.sessionId);
    const hidden = dismissed.find((one) => one.id === entry.sessionId);
    live.push({
      pid, id: entry.sessionId, cwd: String(entry.cwd ?? ""), kind: String(entry.kind ?? "interactive"),
      label: String(row?.label ?? hidden?.label ?? entry.name ?? entry.sessionId), hidden: !row, caller: mine.has(pid),
    });
  }
  return live.sort((a, b) => Number(a.caller) - Number(b.caller));
}

export async function planMigration(paths: MigrationPaths, options: { from?: string } = {}): Promise<Plan> {
  const accounts = readClaudeAccounts(paths.defaultDir, join(paths.conchConfigDir, "claude-accounts.json"));
  const from = chooseProfile(accounts, options.from);
  const to = accounts[0]!;
  const theirConfig = readJson(join(from.configDir, ".claude.json")) ?? {};
  const ourConfig = readJson(paths.defaultConfig) ?? {};
  const email = isObject(theirConfig.oauthAccount) && typeof theirConfig.oauthAccount.emailAddress === "string" ? theirConfig.oauthAccount.emailAddress : undefined;
  const sequence = readJson(paths.swapSequence);
  const emails = isObject(sequence?.accounts) ? Object.values(sequence.accounts).flatMap((one) => isObject(one) && typeof one.email === "string" ? [one.email] : []) : [];
  const on = readJson(join(paths.conchConfigDir, "settings.json"))?.["claude-rotation"] === true;

  const conversations: ConversationPlan[] = [];
  const memory: MemoryPlan[] = [];
  const projects = join(from.configDir, "projects");
  for (const project of existsSync(projects) ? readdirSync(projects, { withFileTypes: true }) : []) {
    if (!project.isDirectory()) continue;
    for (const file of readdirSync(join(projects, project.name)).filter((name) => UUID_JSONL.test(name))) {
      const id = file.slice(0, -".jsonl".length);
      const brought = await bringConversationAcross(id, from, to, { dryRun: true });
      if (brought) conversations.push({ id, project: project.name, bytes: statSync(brought.source).size, transcript: brought.transcript, files: brought.files });
    }
    const theirs = join(projects, project.name, "memory");
    const ours = join(to.configDir, "projects", project.name, "memory");
    for (const file of filesUnder(theirs)) {
      const source = join(theirs, file);
      const destination = join(ours, file);
      if (!existsSync(destination)) {
        memory.push({ project: project.name, file, action: "copy" });
        continue;
      }
      const [a, b] = [readFileSync(source, "utf8"), readFileSync(destination, "utf8")];
      if (a === b) {
        memory.push({ project: project.name, file, action: "same" });
      } else if (file === "MEMORY.md") {
        const merged = mergeMemoryIndex(b, a, statSync(source).mtimeMs > statSync(destination).mtimeMs);
        memory.push({ project: project.name, file, action: merged === b ? "same" : "merge", merged });
      } else {
        memory.push({ project: project.name, file, action: statSync(source).mtimeMs > statSync(destination).mtimeMs ? "replace" : "keep" });
      }
    }
  }

  const settingsPath = join(to.configDir, "settings.json");
  const settings = planSettings(readJson(settingsPath) ?? {}, readJson(join(from.configDir, "settings.json")) ?? {});
  const ourServers = isObject(ourConfig.mcpServers) ? ourConfig.mcpServers : {};
  const theirServers = isObject(theirConfig.mcpServers) ? theirConfig.mcpServers : {};
  const perProject = isObject(theirConfig.projects) ? Object.entries(theirConfig.projects).flatMap(([folder, project]) =>
    isObject(project) && isObject(project.mcpServers) ? Object.keys(project.mcpServers).map((name) => `${name} (in ${folder})`) : []) : [];
  const installed = (dir: string) => {
    const plugins = readJson(join(dir, "plugins", "installed_plugins.json"))?.plugins;
    return isObject(plugins) ? Object.keys(plugins) : [];
  };
  const marketplaces = (dir: string) => Object.keys(readJson(join(dir, "plugins", "known_marketplaces.json")) ?? {});
  const ourPlugins = installed(to.configDir);
  const ourMarketplaces = marketplaces(to.configDir);
  const enabled = isObject(settings.merged.enabledPlugins) ? settings.merged.enabledPlugins : {};
  const userFiles: Plan["userFiles"] = { copy: [], conflicts: [] };
  for (const top of ["CLAUDE.md", "settings.local.json", "keybindings.json", "commands", "agents", "output-styles", "skills"]) {
    for (const file of statSync(join(from.configDir, top), { throwIfNoEntry: false })?.isDirectory() ? filesUnder(from.configDir, top) : [top]) {
      if (file.startsWith(join("skills", "synced")) || !existsSync(join(from.configDir, file))) continue;
      if (!existsSync(join(to.configDir, file))) userFiles.copy.push(file);
      else if (digest(join(from.configDir, file)) !== digest(join(to.configDir, file))) userFiles.conflicts.push(file);
    }
  }
  return {
    from, to, ...(email ? { email } : {}),
    rotation: { on, emails, covers: on && !!email && emails.includes(email) },
    conversations, memory, settings, settingsDigest: digest(settingsPath),
    mcp: {
      add: Object.entries(theirServers).filter(([name]) => !(name in ourServers)).map(([name, config]) => ({ name, config })),
      conflicts: Object.keys(theirServers).filter((name) => name in ourServers && !same(ourServers[name], theirServers[name])),
      perProject,
    },
    plugins: {
      notInstalled: installed(from.configDir).filter((plugin) => !ourPlugins.includes(plugin)).map((plugin) => `${plugin}${enabled[plugin] === true ? "" : " (switched off)"}`),
      marketplaces: marketplaces(from.configDir).filter((name) => !ourMarketplaces.includes(name)),
    },
    userFiles,
    live: existsSync(join(from.configDir, "sessions")) ? liveSessions(from, paths.sessionsFile) : [],
  };
}

/** The plan in words. */
export function describePlan(plan: Plan, applied = false): string[] {
  const will = applied ? "" : "would ";
  const out: string[] = [];
  const say = (line = "") => out.push(line);
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  say(`Fold the "${plan.from.label}" Claude profile (${plan.from.configDir}) into "${plan.to.label}" (${plan.to.configDir}).`);
  say(`Signed in as ${plan.email ?? "an unknown account"}. Rotation is ${plan.rotation.on ? "on" : "off"}`
    + (plan.rotation.emails.length ? `, across ${plan.rotation.emails.join(", ")}` : "") + ".");
  say(plan.rotation.covers
    ? `  Its subscription is already in the rotation, so Default keeps using it: nothing is lost by retiring this profile.`
    : `  Its subscription is NOT in the rotation${plan.rotation.on ? "" : " (rotation is off)"}: add ${plan.email ?? "it"} in Settings → Providers first, or pass --even-if-not-rotated.`);
  say();
  const moving = plan.conversations.filter((one) => one.transcript === "copied" || one.transcript === "extended");
  const bytes = moving.reduce((sum, one) => sum + one.bytes, 0);
  say(`Conversations: ${count(plan.conversations.length, "transcript")} there; ${will}copy ${count(plan.conversations.filter((one) => one.transcript === "copied").length, "new one")}`
    + ` and extend ${plan.conversations.filter((one) => one.transcript === "extended").length} (${megabytes(bytes)}, copy-on-write clones: no extra disk), with ${count(moving.reduce((sum, one) => sum + one.files, 0), "file")} of subagents, tool results, checkpoints and tasks.`);
  const projects = new Map<string, ConversationPlan[]>();
  for (const one of plan.conversations) projects.set(one.project, [...projects.get(one.project) ?? [], one]);
  for (const [project, ones] of projects) {
    const tally = Object.entries(Object.groupBy(ones, (one) => one.transcript)).map(([what, list]) => `${list!.length} ${what === "copied" ? "new" : what}`).join(", ");
    say(`  ${project}: ${tally} (${megabytes(ones.reduce((sum, one) => sum + one.bytes, 0))})`);
  }
  for (const one of plan.conversations.filter((one) => one.transcript === "diverged")) {
    say(`  ! ${one.id} went on in both profiles: Default's copy stays, the other stays in ${plan.from.label}'s folder`);
  }
  say();
  const memory = (action: MemoryPlan["action"]) => plan.memory.filter((one) => one.action === action);
  say(`Memory: ${count(memory("copy").length, "file")} ${will}copy, ${count(memory("merge").length, "index", "indexes")} ${will}merge, ${memory("same").length} already the same.`);
  for (const one of memory("merge")) say(`  merge ${one.project}/memory/MEMORY.md (Default's lines kept, the other's added)`);
  for (const one of memory("replace")) say(`  ! ${one.project}/memory/${one.file} differs in both: the other's is newer and ${applied ? "replaced" : "would replace"} Default's (backed up)`);
  for (const one of memory("keep")) say(`  ! ${one.project}/memory/${one.file} differs in both: Default's is newer and stays`);
  const copies = new Map<string, string[]>();
  for (const one of memory("copy")) copies.set(one.project, [...copies.get(one.project) ?? [], one.file]);
  for (const [project, files] of copies) say(`  ${project}: ${files.join(", ")}`);
  say();
  say(`Settings (${plan.to.configDir}/settings.json): ${plan.settings.carried.length ? `${will}add what Default lacks:` : "Default lacks nothing."}`);
  for (const line of plan.settings.carried) say(`  + ${line}`);
  for (const one of plan.settings.conflicts) say(`  = ${one.key}: Default's ${JSON.stringify(one.kept)} stays (the other has ${JSON.stringify(one.theirs)})`);
  if (plan.settings.left.length) say(`  (left as each profile has it: ${plan.settings.left.join(", ")})`);
  say(`MCP servers: ${plan.mcp.add.length ? `${will}add ${plan.mcp.add.map((one) => one.name).join(", ")} to Default (claude mcp add-json --scope user)` : "Default has every one."}`);
  for (const name of plan.mcp.conflicts) say(`  = ${name}: both have it, configured differently; Default's stays`);
  for (const name of plan.mcp.perProject) say(`  ! per-folder server ${name}: not carried; add it in that folder with claude mcp add-json --scope local`);
  say(`Plugins: ${plan.plugins.notInstalled.length ? `installed only there: ${plan.plugins.notInstalled.join(", ")} (install with /plugin in a Default session if wanted)` : "Default has every one installed."}`
    + (plan.plugins.marketplaces.length ? ` Marketplaces only there: ${plan.plugins.marketplaces.join(", ")}.` : ""));
  say(`CLAUDE.md, skills, commands, agents, keybindings: ${plan.userFiles.copy.length ? `${will}copy ${plan.userFiles.copy.join(", ")}` : "nothing Default lacks"}`
    + (plan.userFiles.conflicts.length ? `; both have (Default's stays): ${plan.userFiles.conflicts.join(", ")}` : "") + ".");
  say();
  say(`Profile: ${plan.from.retired ? "already retired." : `${will}retire "${plan.from.label}" in conch: no longer offered, and nothing starts in it again; a restart, fork or resume of one of its conversations runs in Default.`}`);
  say(`Left where it is, on purpose: the folder itself, its sign-in (Keychain item "${profileKeychainService(plan.from.configDir)}", never read), its up-arrow prompt history (history.jsonl), Claude background jobs (jobs/), caches and logs.`);
  say();
  if (plan.live.length) {
    say(`Running in "${plan.from.label}" now: ${count(plan.live.length, "session")}. Move each after its current turn; it keeps running there until then:`);
    for (const one of plan.live) {
      const what = `  "${one.label}" (${one.id.slice(0, 8)}, pid ${one.pid}, in ${one.cwd})`;
      if (one.kind !== "interactive") say(`${what}: a background job; close it in conch, then Start → Resume it (listed under Default).`);
      else if (one.hidden) say(`${what}: hidden in conch; end it in its Terminal tab (/exit), then Start → Resume it (listed under Default).`);
      else say(`${what}: in conch, its session menu → Restart. It comes back in Default with its conversation.${one.caller ? " This is the session running this script: move it last." : ""}`);
    }
    say(`Then run this again with --apply: it brings across anything they wrote meanwhile (late turns, new memories).`);
  } else {
    say(`Nothing is running in "${plan.from.label}".`);
  }
  return out;
}

export interface ApplyDependencies {
  /** `claude mcp add-json <name> <json> --scope user` against Default; injectable so a test never runs the real one. */
  addMcpServer: (name: string, config: unknown) => Promise<{ ok: boolean; output: string }>;
  now?: () => Date;
}

export function defaultApplyDependencies(paths: MigrationPaths): ApplyDependencies {
  return {
    addMcpServer: async (name, config) => {
      // Claude's own writer for ~/.claude.json, which every running session also writes; Default as a fresh shell has it.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.CLAUDE_CONFIG_DIR;
      const child = Bun.spawn(["claude", "mcp", "add-json", name, JSON.stringify(config), "--scope", "user"], { env, cwd: paths.home, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { ok: code === 0, output: `${out}${err}`.trim() };
    },
  };
}

/** Do the plan. Every file changed in Default is copied into the backup folder first; the manifest lists every write. */
export async function applyMigration(plan: Plan, paths: MigrationPaths, dependencies: ApplyDependencies, options: { evenIfNotRotated?: boolean } = {}): Promise<{ backup: string; lines: string[] }> {
  if (!plan.rotation.covers && !options.evenIfNotRotated && !plan.from.retired) {
    throw new Error(`not done: rotation doesn't cover ${plan.email ?? "this profile's subscription"}. Add it in Settings → Providers, or pass --even-if-not-rotated`);
  }
  const stamp = (dependencies.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backup = join(paths.conchConfigDir, "one-account-backups", stamp);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const manifest: { action: string; path: string; backup?: string }[] = [];
  const lines: string[] = [];
  const keep = async (path: string): Promise<string | undefined> => {
    if (!existsSync(path)) return undefined;
    const copy = join(backup, relative("/", path));
    await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
    await copyFile(path, copy, constants.COPYFILE_FICLONE);
    return copy;
  };
  const write = async (path: string, text: string, action: string) => {
    const kept = await keep(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.conch-${crypto.randomUUID()}.tmp`;
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, path);
    manifest.push({ action, path, ...(kept ? { backup: kept } : {}) });
  };
  await writeFile(join(backup, "plan.txt"), describePlan(plan).join("\n") + "\n", { mode: 0o600 });
  await keep(join(paths.conchConfigDir, "claude-accounts.json"));

  let copied = 0;
  let extended = 0;
  for (const one of plan.conversations) {
    const brought = await bringConversationAcross(one.id, plan.from, plan.to, {
      beforeReplace: async (path) => {
        const kept = await keep(path);
        manifest.push({ action: "extend", path, ...(kept ? { backup: kept } : {}) });
      },
    });
    if (brought?.transcript === "copied") {
      copied++;
      manifest.push({ action: "copy", path: brought.destination });
    }
    if (brought?.transcript === "extended") extended++;
  }
  lines.push(`conversations: copied ${copied}, extended ${extended}`);

  let memories = 0;
  for (const one of plan.memory) {
    const source = join(plan.from.configDir, "projects", one.project, "memory", one.file);
    const destination = join(plan.to.configDir, "projects", one.project, "memory", one.file);
    if (one.action === "copy" && !existsSync(destination)) {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const { atime, mtime } = statSync(source);
      await utimes(destination, atime, mtime);
      manifest.push({ action: "copy", path: destination });
    } else if (one.action === "merge") {
      // Joined again from both as they are now: a memory a Default session saved since the plan stays.
      const merged = mergeMemoryIndex(await readFile(destination, "utf8"), await readFile(source, "utf8"), statSync(source).mtimeMs > statSync(destination).mtimeMs);
      await write(destination, merged, "merge");
    } else if (one.action === "replace" && statSync(source).mtimeMs > statSync(destination).mtimeMs) {
      await write(destination, await readFile(source, "utf8"), "replace");
    } else continue;
    memories++;
  }
  lines.push(`memory: ${memories} files written`);

  const settingsPath = join(plan.to.configDir, "settings.json");
  if (plan.settings.carried.length) {
    // Written over only as it was planned: a settings change made since is never lost to this.
    if (digest(settingsPath) !== plan.settingsDigest) lines.push(`settings: NOT changed, ${settingsPath} changed since the plan; run this again`);
    else {
      await write(settingsPath, JSON.stringify(plan.settings.merged, null, 2) + "\n", "settings");
      lines.push(`settings: added ${plan.settings.carried.length}`);
    }
  }
  if (plan.mcp.add.length) await keep(paths.defaultConfig);
  for (const server of plan.mcp.add) {
    const added = await dependencies.addMcpServer(server.name, server.config);
    manifest.push({ action: added.ok ? "mcp-add" : "mcp-add-failed", path: `${paths.defaultConfig}#mcpServers.${server.name}` });
    lines.push(`MCP server ${server.name}: ${added.ok ? "added" : `NOT added (${added.output.slice(-200)})`}`);
  }
  for (const file of plan.userFiles.copy) {
    const destination = join(plan.to.configDir, file);
    if (existsSync(destination)) continue;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(plan.from.configDir, file), destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    manifest.push({ action: "copy", path: destination });
  }
  if (!plan.from.retired) {
    retireClaudeAccount(plan.from.id, true, join(paths.conchConfigDir, "claude-accounts.json"), paths.defaultDir);
    manifest.push({ action: "retire", path: join(paths.conchConfigDir, "claude-accounts.json") });
    lines.push(`retired "${plan.from.label}"`);
  }
  await writeFile(join(backup, "manifest.json"), JSON.stringify({ from: plan.from, to: plan.to, writes: manifest }, null, 2) + "\n", { mode: 0o600 });
  lines.push(`backup and manifest: ${backup}`);
  lines.push(`to undo the retirement: cp '${join(backup, relative("/", join(paths.conchConfigDir, "claude-accounts.json")))}' '${join(paths.conchConfigDir, "claude-accounts.json")}'`);
  return { backup, lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const known = new Set(["--apply", "--from", "--even-if-not-rotated", "--help", "-h"]);
  const unknown = args.find((arg, index) => arg.startsWith("-") ? !known.has(arg) : args[index - 1] !== "--from");
  if (args.includes("--help") || args.includes("-h") || unknown) {
    if (unknown) console.error(`unknown argument: ${unknown}`);
    console.log("usage: bun scripts/one-account.ts [--apply] [--from <id or name>] [--even-if-not-rotated]");
    process.exit(unknown ? 2 : 0);
  }
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;
  const paths = realPaths();
  try {
    const plan = await planMigration(paths, from ? { from } : {});
    for (const line of describePlan(plan)) console.log(line);
    if (!args.includes("--apply")) {
      console.log("\nDry run: nothing was written. Run again with --apply to do it.");
    } else {
      const done = await applyMigration(plan, paths, defaultApplyDependencies(paths), { evenIfNotRotated: args.includes("--even-if-not-rotated") });
      console.log("\nDone:");
      for (const line of done.lines) console.log(`  ${line}`);
    }
  } catch (error) {
    console.error(`[one-account] ${(error as Error).message}`);
    process.exit(1);
  }
}
