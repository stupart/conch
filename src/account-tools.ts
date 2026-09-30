/** Account-scoped tools. Provider CLIs own installation and authentication. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readAgentCapabilities, type AgentCapabilityEntity } from "./agent-capabilities.ts";
import { readClaudeAccounts, requireClaudeAccount, claudeAccountEnvironment, cachedClaudeAccountStatus, validAccountId, type ClaudeAccount } from "./claude-accounts.ts";
import { readCodexAccounts, requireCodexAccount, codexAccountEnvironment, cachedCodexAccount } from "./codex-accounts.ts";
import { applyPlan, planToggle } from "./config-write.ts";
import { conchHome } from "./home.ts";

type Backend = "claude" | "codex";
export interface AccountToolsRequest {
  kind: "account-tools"; backend: Backend; accountId: string;
  action: "list" | "install-plugin" | "remove-plugin" | "toggle-plugin" | "add-mcp" | "remove-mcp" | "toggle-mcp";
  requestId?: string; id?: string; source?: string; url?: string; command?: string; args?: string[]; enabled?: boolean;
}
export interface AccountToolItem {
  id: string; name: string; kind: "plugin" | "skill" | "mcp-server";
  enabled?: boolean; managed: boolean; detail: string;
}
export interface AccountToolsReply {
  kind: "account-tools"; backend: Backend; accountId: string;
  accounts: { id: string; label: string; email?: string }[];
  items: AccountToolItem[]; library: { id: string; name: string; source?: string }[];
  operation?: { id: string; state: "working" | "done" | "failed"; message: string };
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const printable = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const pluginID = (v: unknown): v is string => printable(v) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v);
const serverID = (v: unknown): v is string => printable(v, 100) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v);
export function validMarketplaceSource(v: unknown): v is string {
  if (!printable(v, 4096) || v.startsWith("-")) return false;
  if (isAbsolute(v)) return !v.includes(" /plugin ");
  if (/^[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/.test(v)) return true;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
export function accountToolsRequestError(v: Record<string, unknown>): string | undefined {
  if (!["claude", "codex"].includes(String(v.backend)) || !validAccountId(v.accountId)) return "Choose a provider and account";
  if (!["list", "install-plugin", "remove-plugin", "toggle-plugin", "add-mcp", "remove-mcp", "toggle-mcp"].includes(String(v.action))) return "Unknown tools action";
  if (v.action === "list") return;
  if (!validAccountId(v.requestId)) return "A tools operation needs a request id";
  if (String(v.action).endsWith("plugin") ? !pluginID(v.id) : !serverID(v.id)) return "Use name@marketplace for a plugin, or a server name for MCP";
  if (v.source !== undefined && (v.action !== "install-plugin" || !validMarketplaceSource(v.source))) return "Use a marketplace folder, owner/repository, or HTTPS Git URL";
  if (String(v.action).startsWith("toggle-") && typeof v.enabled !== "boolean") return "Choose enabled or disabled";
  if (v.action === "add-mcp") {
    if (v.command !== undefined) {
      if (v.url !== undefined || !printable(v.command, 4096) || v.command.startsWith("-")
        || (!isAbsolute(v.command) && !/^[\w.-]+$/.test(v.command))
        || (v.args !== undefined && (!Array.isArray(v.args) || v.args.length > 100 || !v.args.every(arg => printable(arg, 4096))))) return "Enter an executable and one argument per line, without a URL";
      return;
    }
    if (v.args !== undefined) return "MCP arguments need an executable";
    try { const u = new URL(String(v.url)); if (!printable(v.url, 4096) || !["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw new Error(); }
    catch { return "Enter an HTTP MCP URL without credentials or query parameters"; }
  }
}
export function isAccountToolsReply(v: unknown): v is AccountToolsReply {
  return record(v) && v.kind === "account-tools" && ["claude", "codex"].includes(v.backend) && validAccountId(v.accountId)
    && Array.isArray(v.accounts) && v.accounts.length <= 17 && v.accounts.every((a: any) => record(a) && validAccountId(a.id) && printable(a.label) && (a.email === undefined || printable(a.email)))
    && Array.isArray(v.items) && v.items.length <= 1000 && v.items.every((i: any) => record(i) && printable(i.id, 4096) && printable(i.name, 4096) && ["plugin", "skill", "mcp-server"].includes(i.kind) && typeof i.managed === "boolean" && typeof i.detail === "string" && i.detail.length <= 4096 && (i.enabled === undefined || typeof i.enabled === "boolean"))
    && Array.isArray(v.library) && v.library.length <= 200 && v.library.every((i: any) => record(i) && pluginID(i.id) && printable(i.name) && (i.source === undefined || validMarketplaceSource(i.source)))
    && (v.operation === undefined || (record(v.operation) && validAccountId(v.operation.id) && ["working", "done", "failed"].includes(v.operation.state) && printable(v.operation.message, 4096)));
}

function statePath(account: ClaudeAccount): string {
  return account.id === "default" && account.configDir === join(conchHome(), ".claude") ? join(conchHome(), ".claude.json") : join(account.configDir, ".claude.json");
}
function inventory(backend: Backend, account: ClaudeAccount) {
  // The profile directory is not a project. No unrelated cwd/project config is included.
  return readAgentCapabilities({ backend, cwd: account.configDir, configDir: account.configDir,
    ...(backend === "claude" ? { claudeHome: account.configDir, claudeStatePath: statePath(account) } : { codexHome: account.configDir }) });
}
export function toolsItems(entities: AgentCapabilityEntity[]): AccountToolItem[] {
  return entities.flatMap((e): AccountToolItem[] => {
    if (e.kind === "mcp-tool" || e.scope === "local" || e.scope === "project") return [];
    const metadata = e.kind === "plugin" ? e.plugin : e.kind === "skill" ? e.skill : e.mcpServer;
    const enabled = metadata.enabledForNextSession;
    const id = e.kind === "plugin" ? e.plugin.pluginId : e.kind === "skill" ? e.id : e.name;
    return [{ id, name: e.displayName, kind: e.kind, managed: e.scope !== "user" || !!e.parentId || e.kind === "skill",
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      detail: e.kind === "plugin" ? [e.plugin.version, e.scope].filter(Boolean).join(" · ")
        : e.kind === "skill" ? (e.skill.ownerPluginId ?? e.scope)
        : [e.mcpServer.ownerPluginId ?? e.scope, e.mcpServer.transport, e.mcpServer.url].filter(Boolean).join(" · ") }];
  }).slice(0, 1000);
}
function marketplaceSource(backend: Backend, account: ClaudeAccount, name: string): string | undefined {
  try {
    if (backend === "codex") {
      const config = Bun.TOML.parse(readFileSync(join(account.configDir, "config.toml"), "utf8")) as any;
      const source = config.marketplaces?.[name]?.source;
      if (!source) {
        // Codex also discovers a marketplace manifest in the user's home.
        try {
          const manifest = JSON.parse(readFileSync(join(conchHome(), ".agents", "plugins", "marketplace.json"), "utf8"));
          if (manifest.name === name) return conchHome();
        } catch {}
      }
      return validMarketplaceSource(source) ? source : undefined;
    }
    const config = JSON.parse(readFileSync(join(account.configDir, "plugins", "known_marketplaces.json"), "utf8"));
    const row = config[name]?.source;
    const source = row?.source === "directory" ? row.path : row?.source === "github" ? row.repo : row?.source === "git" ? row.url : undefined;
    return validMarketplaceSource(source) ? source : undefined;
  } catch { return; }
}
function library(backend: Backend, accounts: ClaudeAccount[]): AccountToolsReply["library"] {
  const found = new Map<string, AccountToolsReply["library"][number]>();
  for (const account of accounts) for (const e of inventory(backend, account).entities) {
    if (e.kind !== "plugin" || !pluginID(e.plugin.pluginId)) continue;
    const id = e.plugin.pluginId;
    found.set(id, { id, name: id.split("@")[0]!, source: marketplaceSource(backend, account, id.split("@")[1]!) });
  }
  if (backend === "claude") {
    const source = join(conchHome(), ".config", "conch", "plugin-dist");
    if (existsSync(source)) found.set("conch@conch", { id: "conch@conch", name: "Conch", source });
    found.set("blueprint-studio@blueprint-studio-marketplace", { id: "blueprint-studio@blueprint-studio-marketplace", name: "Blueprint Studio", source: "Blueprint-Studio-AI/claude-code-marketplace" });
  }
  return [...found.values()].slice(0, 200);
}

export type ToolsRunner = (backend: Backend, account: ClaudeAccount, args: string[]) => Promise<void>;
export const runToolsCommand: ToolsRunner = async (backend, account, args) => {
  mkdirSync(account.configDir, { recursive: true, mode: 0o700 });
  const env = backend === "claude" ? claudeAccountEnvironment(account.configDir, account.id !== "default") : codexAccountEnvironment(account);
  const proc = Bun.spawn([backend, ...args], { cwd: account.configDir, env: { ...env, CONCH_INTERNAL: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 90_000);
  try {
    const code = await proc.exited;
    if (code !== 0) throw new Error(timedOut ? "The provider took too long. Refresh to check the result before trying again. If it opened sign-in in your browser, finish there first." : `${backend === "claude" ? "Claude Code" : "Codex"} could not complete ${args.slice(0, 2).join(" ")} (exit ${code}). Check the marketplace/plugin name and sign-in, then refresh.`);
  } finally { clearTimeout(timer); }
};
export async function applyToolsAction(request: AccountToolsRequest, account: ClaudeAccount, items: AccountToolItem[], run: ToolsRunner = runToolsCommand): Promise<void> {
  const err = accountToolsRequestError(request as unknown as Record<string, unknown>); if (err) throw new Error(err);
  const { backend, action, id } = request;
  if (action === "list") return;
  const kind = action.endsWith("plugin") ? "plugin" : "mcp-server";
  const matches = items.filter(i => i.id === id && i.kind === kind);
  const item = matches.find(i => !i.managed) ?? matches[0];
  if (action === "install-plugin" && item) throw new Error("This plugin is already configured. Enable it below, or remove it before reinstalling.");
  if (action === "add-mcp" && item) throw new Error("That MCP server already exists. Choose a different name.");
  if (!["install-plugin", "add-mcp"].includes(action) && (!item || item.managed)) throw new Error("This item belongs to a plugin, project, or managed configuration. Manage it at its source.");
  const scope = backend === "claude" ? ["--scope", "user"] : [];
  if (action === "install-plugin") {
    if (request.source) {
      if (isAbsolute(request.source) && !existsSync(request.source)) throw new Error("The marketplace folder does not exist on this Mac.");
      await run(backend, account, ["plugin", "marketplace", "add", request.source, ...scope]);
    }
    await run(backend, account, ["plugin", backend === "claude" ? "install" : "add", id!, ...scope]);
  } else if (action === "remove-plugin") {
    await run(backend, account, ["plugin", backend === "claude" ? "uninstall" : "remove", id!, ...scope, ...(backend === "claude" ? ["--keep-data"] : [])]);
  } else if (action === "add-mcp") {
    await run(backend, account, request.command ? ["mcp", "add", ...scope, id!, "--", request.command, ...(request.args ?? [])]
      : backend === "claude" ? ["mcp", "add", "--transport", "http", ...scope, id!, request.url!] : ["mcp", "add", id!, "--url", request.url!]);
  } else if (action === "remove-mcp") {
    await run(backend, account, ["mcp", "remove", id!, ...scope]);
  } else {
    if (backend === "claude" && kind === "mcp-server") throw new Error("Claude MCP enable/disable is per project. Use /mcp in that session, or remove the account-level server here.");
    applyPlan(planToggle({ agent: backend, scope: "user", capability: kind, id: id!, enabled: request.enabled! }, {
      claudeHome: account.configDir, claudeStatePath: statePath(account), codexHome: account.configDir,
    }));
  }
}

const operations = new Map<string, NonNullable<AccountToolsReply["operation"]>>();
const requests = new Map<string, string>();
/** Mutations continue in the daemon across UI disconnects. Repeated request IDs never run twice. */
export async function handleAccountTools(request: AccountToolsRequest, defaultClaudeDir?: string): Promise<AccountToolsReply> {
  const error = accountToolsRequestError(request as unknown as Record<string, unknown>); if (error) throw new Error(error);
  const { backend, accountId } = request;
  const profiles = backend === "claude" ? readClaudeAccounts(defaultClaudeDir) : readCodexAccounts();
  const account = backend === "claude" ? requireClaudeAccount(accountId, defaultClaudeDir) : requireCodexAccount(accountId);
  const key = `${backend}:${accountId}`;
  let items = toolsItems(inventory(backend, account).entities);
  if (request.action !== "list") {
    const signature = JSON.stringify(request);
    const prior = requests.get(request.requestId!);
    if (prior && prior !== signature) throw new Error("That request id was already used for a different operation");
    if (!prior) {
      if (operations.get(key)?.state === "working") throw new Error("Wait for this account's current operation to finish");
      if (requests.size >= 2000) throw new Error("Restart Conch before starting more tools operations");
      requests.set(request.requestId!, signature);
      const operation: NonNullable<AccountToolsReply["operation"]> = { id: request.requestId!, state: "working", message: "Updating this account…" };
      operations.set(key, operation);
      void applyToolsAction(request, account, items).then(() => {
        operation.state = "done"; operation.message = "Saved. Start a new session, or reload plugins in the existing session. MCP connections may need sign-in through the provider.";
      }).catch(error => { operation.state = "failed"; operation.message = error instanceof Error ? error.message : "The provider could not update this account."; });
    }
  }
  const accounts = await Promise.all(profiles.map(async p => {
    const status = backend === "claude" ? await cachedClaudeAccountStatus(p) : (await cachedCodexAccount(p)).account;
    return { id: p.id, label: p.label, ...(status.email ? { email: status.email } : {}) };
  }));
  items = toolsItems(inventory(backend, account).entities);
  return { kind: "account-tools", backend, accountId, accounts, items, library: library(backend, profiles), operation: operations.get(key) };
}
