import { windowKey } from "./window-key.ts";
import { readClaudeAccounts, type ClaudeAccount } from "./claude-accounts.ts";
import { findTranscript, registrySnapshot, type RegistrySnapshot } from "./sessions.ts";
import { readResumableSessionsResult, type ReadResumableSessionsOptions, type ResumableSessionsRead } from "./resumable.ts";

/** Profiles are separate roots; Codex is read once, with the default profile. */
export async function accountRegistrySnapshot(defaultDir: string, accounts = readClaudeAccounts(defaultDir)): Promise<RegistrySnapshot | null> {
  const combined: RegistrySnapshot = { infos: [], liveIds: new Set(), complete: true };
  let available = false;
  for (const account of accounts) {
    const snapshot = await registrySnapshot(account.configDir, { skipCodex: account.id !== "default" });
    if (!snapshot) { combined.complete = false; continue; }
    available = true;
    combined.complete &&= snapshot.complete;
    for (const id of snapshot.liveIds) combined.liveIds.add(id);
    combined.infos.push(...snapshot.infos.map((session) => session.backend === "codex" ? session : {
      ...session, claudeAccountId: account.id, claudeConfigDir: account.configDir,
      accountLabel: account.label,
      transcriptPath: session.transcriptPath ?? findTranscript(account.configDir, session.agentSessionId ?? session.sessionId),
    }));
  }
  // Imported/copied histories may reuse a conversation UUID in two profiles.
  // Preserve each live window's identity instead of letting one overwrite the other.
  const counts = new Map<string, number>();
  for (const info of combined.infos) counts.set(info.sessionId, (counts.get(info.sessionId) ?? 0) + 1);
  combined.infos = combined.infos.map((info) => {
    if (counts.get(info.sessionId) === 1) return info;
    if (!info.pid) { combined.complete = false; return undefined; }
    const sessionId = windowKey(info.agentSessionId ?? info.sessionId, info.pid, true);
    combined.liveIds.add(sessionId);
    return { ...info, sessionId, agentSessionId: info.agentSessionId ?? info.sessionId };
  }).filter((info): info is NonNullable<typeof info> => info !== undefined);
  return available ? combined : null;
}

export function findAccountTranscript(defaultDir: string, id: string): string | undefined {
  const paths = new Set(readClaudeAccounts(defaultDir).flatMap((account) => {
    const path = findTranscript(account.configDir, id);
    return path ? [path] : [];
  }));
  // An unscoped ambiguous lookup cannot choose another account's conversation.
  return paths.size === 1 ? [...paths][0] : undefined;
}

export function accountResumableSessions(options: ReadResumableSessionsOptions, accounts: ClaudeAccount[]): ResumableSessionsRead {
  const result: ResumableSessionsRead = { sessions: [], complete: true };
  for (const account of accounts) {
    const read = readResumableSessionsResult({ ...options, claudeHome: account.configDir,
      ...(account.id === "default" ? {} : { codexHome: "" }) });
    result.complete &&= read.complete;
    result.sessions.push(...read.sessions.map((session) => session.backend === "codex" ? session : {
      ...session, claudeAccountId: account.id, accountLabel: account.label,
    }));
  }
  result.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = options.limit ?? 200;
  if (result.sessions.length > limit) result.complete = false;
  result.sessions = result.sessions.slice(0, limit);
  return result;
}

/** A fresh read is required before replacing credentials or forgetting a profile. */
export async function assertClaudeAccountIdle(account: ClaudeAccount): Promise<void> {
  const snapshot = await registrySnapshot(account.configDir, { skipCodex: true });
  if (!snapshot?.complete) throw new Error("Could not check this account’s live sessions. Try again before changing it.");
  if (snapshot.liveIds.size) throw new Error("Close this account’s live sessions before signing in again or removing it from Conch.");
}
