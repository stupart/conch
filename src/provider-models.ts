/** Model discovery through provider-owned protocols. No prompt, turn, or credential read. */
import { claudeAccountEnvironment, readClaudeAccounts, type ClaudeAccount } from "./claude-accounts.ts";
import { codexAccountEnvironment, readCodexAccounts } from "./codex-accounts.ts";
import { conchHome } from "./home.ts";
import { claudeModelLabel, readSessionSettingsCatalog, type AgentModelChoice, type SessionSettingsCatalog } from "./session-settings.ts";

type Backend = "claude" | "codex";
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const safe = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 180 && !/[\u0000-\u001f\u007f]/.test(value);
export function decodeProviderModels(backend: Backend, value: unknown): AgentModelChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter(object).flatMap(row => {
    const id = backend === "claude" ? row.value : row.model;
    if (!safe(id) || /\s/.test(id) || seen.has(id) || row.hidden === true) return [];
    seen.add(id);
    const levels = backend === "claude" ? row.supportedEffortLevels : (Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((v: any) => v?.reasoningEffort) : undefined);
    const resolved = backend === "claude" && safe(row.resolvedModel) ? row.resolvedModel : undefined;
    return [{ id, label: resolved ? (id === "default" ? `Default · ${claudeModelLabel(resolved)}` : claudeModelLabel(resolved)) : safe(row.displayName) ? row.displayName : id,
      ...(resolved ? { resolvedModel: resolved } : {}),
      ...(Array.isArray(levels) ? { efforts: levels.filter(safe) } : backend === "claude" && !row.supportsEffort ? { efforts: [] } : {}),
      ...(safe(row.defaultReasoningEffort) ? { defaultEffort: row.defaultReasoningEffort } : {}) }];
  }).slice(0, 100);
}

export async function discoverProviderModels(backend: Backend, account: ClaudeAccount, executable: string = backend, timeoutMs = 12_000): Promise<AgentModelChoice[]> {
  const env = backend === "claude" ? claudeAccountEnvironment(account.configDir, account.id !== "default") : codexAccountEnvironment(account);
  const proc = Bun.spawn(backend === "claude"
    ? [executable, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--no-session-persistence"]
    : [executable, "app-server", "--listen", "stdio://"],
  { cwd: conchHome(), env: { ...env, CONCH_INTERNAL: "1" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const send = (value: unknown) => { proc.stdin.write(JSON.stringify(value) + "\n"); proc.stdin.flush(); };
  const models: AgentModelChoice[] = [];
  try {
    if (backend === "claude") send({ type: "control_request", request_id: "conch-models", request: { subtype: "initialize" } });
    else send({ id: 1, method: "initialize", params: { clientInfo: { name: "conch_models", version: "1" }, capabilities: {} } });
    let buffer = "";
    const decoder = new TextDecoder();
    let pages = 0;
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("Model catalog response is too large");
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (backend === "claude" && message.type === "control_response" && message.response?.request_id === "conch-models") {
          const result = decodeProviderModels(backend, message.response?.response?.models);
          if (!result.length) throw new Error("Claude did not return a model catalog");
          return result;
        }
        if (backend === "codex" && message.id === 1) {
          if (message.error) throw new Error("Codex initialization failed");
          send({ method: "initialized" });
          send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false } });
        } else if (backend === "codex" && message.id === 2) {
          if (message.error) throw new Error("Codex model discovery failed");
          models.push(...decodeProviderModels(backend, message.result?.data));
          if (message.result?.nextCursor && ++pages < 5) send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: false, cursor: message.result.nextCursor } });
          else if (models.length) return models;
          else throw new Error("Codex did not return a model catalog");
        }
      }
    }
    throw new Error("Model discovery timed out or closed before replying");
  } finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
}

const cache = new Map<string, { models?: AgentModelChoice[]; at: number; pending?: Promise<void> }>();
/** Cache by profile, refresh in the background, and retain the last successful catalog on error. */
export function providerModels(backend: Backend, account: ClaudeAccount, changed: () => void = () => {}, refresh = false): AgentModelChoice[] | undefined {
  const key = JSON.stringify([backend, account.id, account.configDir]);
  const entry = cache.get(key) ?? { at: 0 };
  cache.set(key, entry);
  if (!entry.pending && (refresh || Date.now() - entry.at > 5 * 60_000)) {
    entry.at = Date.now();
    entry.pending = discoverProviderModels(backend, account).then(models => { entry.models = models; changed(); }).catch(() => {}).finally(() => { entry.pending = undefined; });
  }
  return entry.models;
}

export function accountModelCatalog(homes: { claudeDir: string; codexHome: string | null }, changed: () => void): SessionSettingsCatalog {
  const catalog = readSessionSettingsCatalog(homes);
  // Preserve the existing redirected-state boundary: no real profiles or CLI probes.
  if (homes.codexHome === null) return catalog;
  catalog.accounts = {};
  for (const backend of ["claude", "codex"] as const) {
    for (const account of backend === "claude" ? readClaudeAccounts(homes.claudeDir) : readCodexAccounts(homes.codexHome ?? undefined)) {
      const own = readSessionSettingsCatalog({ claudeDir: backend === "claude" ? account.configDir : homes.claudeDir,
        codexHome: backend === "codex" ? account.configDir : homes.codexHome })[backend];
      const models = providerModels(backend, account, changed);
      if (models?.length) own.models = models;
      catalog.accounts[`${backend}:${account.id}`] = own;
      if (account.id === "default") catalog[backend] = own;
    }
  }
  return catalog;
}

export function modelCatalogForSession(backend: Backend, catalog: SessionSettingsCatalog | undefined,
  session?: { claudeAccountId?: string; codexAccountId?: string }): SessionSettingsCatalog | undefined {
  const id = (backend === "claude" ? session?.claudeAccountId : session?.codexAccountId) ?? "default";
  const own = catalog?.accounts?.[`${backend}:${id}`];
  return own && catalog ? { ...catalog, [backend]: own } : catalog;
}
