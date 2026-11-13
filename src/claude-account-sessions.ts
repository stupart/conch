import { statSync } from "node:fs";
import { windowKey, processParentTableWith } from "./window-key.ts";
import { readClaudeAccounts, type ClaudeAccount } from "./claude-accounts.ts";
import { registryProcessAlive } from "./process-identity.ts";
import { findTranscript, registrySnapshot, codexRegistrySnapshot, withStartedBy, type RegistrySnapshot } from "./sessions.ts";
import { defaultIsPidAlive } from "./codex-sessions.ts";
import { CODEX_THREAD_CLOSED } from "./codex-threads.ts";
import type { ClaudeSwapRun } from "./claude-swap-runs.ts";
import { canonicalDir } from "./elsewhere.ts";
import { readResumableSessionsResult, type ReadResumableSessionsOptions, type ResumableSessionsRead } from "./resumable.ts";
import { parkedSessions, type ParkedSessionsOptions } from "./parked-jobs.ts";

/** Read each provider root once, retaining the account that owns its sessions.
 * The optional Codex list preserves the legacy default-only reader for callers. `runs` are claude-swap's per-terminal
 * folders (claude-swap-runs.ts), read after the accounts. */
export async function accountRegistrySnapshot(
  defaultDir: string,
  accounts = readClaudeAccounts(defaultDir),
  codexAccounts?: ClaudeAccount[],
  parkedOptions?: ParkedSessionsOptions,
  runs: readonly ClaudeSwapRun[] = [],
): Promise<RegistrySnapshot | null> {
  const combined: RegistrySnapshot = { infos: [], liveIds: new Set(), complete: true };
  let available = false;
  /** Accounts whose registry could be read: only there can a job be known not to be running. */
  const read: ClaudeAccount[] = [];
  for (const account of accounts) {
    const snapshot = await registrySnapshot(account.configDir, { skipCodex: codexAccounts !== undefined || account.id !== "default", processParents: async () => null });
    if (!snapshot) { combined.complete = false; continue; }
    available = true;
    read.push(account);
    combined.complete &&= snapshot.complete;
    for (const id of snapshot.liveIds) combined.liveIds.add(id);
    combined.infos.push(...snapshot.infos.map((session) => session.backend === "codex" ? session : {
      ...session, claudeAccountId: account.id, claudeConfigDir: account.configDir,
      accountLabel: account.label,
      transcriptPath: session.transcriptPath ?? findTranscript(account.configDir, session.agentSessionId ?? session.sessionId),
    }));
  }
  // A claude-swap run (`cswap run 3 -- claude`) is a row like a profile's (2026-11-12), named by its account's number,
  // with its own folder carried so a restart or fork comes back in it (`restartRequest`). It has no conch account id:
  // nothing that lists, signs in or removes conch's accounts sees it. Only its live sessions: nobody prunes a run
  // folder's entries once its terminal has gone, so a dead one is debris, never a row.
  const profiles = new Set(accounts.map((account) => canonicalDir(account.configDir)));
  for (const run of runs) {
    if (profiles.has(canonicalDir(run.configDir))) continue;
    const snapshot = await registrySnapshot(run.configDir, { skipCodex: true, processParents: async () => null });
    if (!snapshot) continue;
    available = true;
    combined.complete &&= snapshot.complete;
    const live = snapshot.infos.filter((session) => [session.pid, session.agentPid].some((pid) => pid && defaultIsPidAlive(pid)));
    for (const session of live) combined.liveIds.add(session.sessionId);
    combined.infos.push(...live.map((session) => ({
      ...session, claudeConfigDir: run.configDir, accountLabel: run.label,
      transcriptPath: session.transcriptPath ?? findTranscript(run.configDir, session.agentSessionId ?? session.sessionId),
    })));
  }
  for (const account of codexAccounts ?? []) {
    const snapshot = await codexRegistrySnapshot(account.configDir, { processParents: async () => null });
    available = true;
    combined.complete &&= snapshot.complete;
    for (const id of snapshot.liveIds) combined.liveIds.add(id);
    combined.infos.push(...snapshot.infos.map(session => ({ ...session, codexAccountId: account.id, codexHome: account.configDir, accountLabel: account.label })));
  }
  // A dead entry is debris once something live holds its conversation, across profiles as within one (`registrySnapshot`).
  // After a restart, a retired profile's entry from the last boot, its pid someone else's now, and the session resumed
  // in Default read as two windows of one conversation, the dead one first (seashell's #996 beside #1372, 2026-11-06).
  const conversation = (info: RegistrySnapshot["infos"][number]) => info.agentSessionId ?? info.sessionId;
  const ownProcess = (info: RegistrySnapshot["infos"][number]) =>
    info.backend !== "codex" && !info.jobId && Boolean(info.pid) && registryProcessAlive(info.pid, info.procStart);
  const held = new Set(combined.infos.filter(ownProcess).map(conversation));
  combined.infos = combined.infos.filter((info) =>
    info.backend === "codex" || info.jobId || !info.pid || !held.has(conversation(info)) || ownProcess(info));
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
  // Background agents Claude Code stopped while they wait on you (parked-jobs.ts, 2026-10-24): no registry above
  // lists them, so without this they left every conch surface the moment they asked. After the live rows, which win:
  // a parked row is only ever a conversation nothing runs. Its id is live too, for what "has this closed?" asks — it
  // hasn't, a reply brings it back — and so a dismissal or a held turn isn't pruned while it waits.
  for (const parked of parkedSessions(read, combined, parkedOptions)) {
    combined.infos.push(parked);
    combined.liveIds.add(parked.sessionId);
  }
  if (combined.infos.filter(info => info.pid).length >= 2) {
    const parents = await processParentTableWith(combined.infos.flatMap(info => [info.pid, info.agentPid]).filter((pid): pid is number => !!pid && pid > 0));
    if (parents) combined.infos = withStartedBy(combined.infos, parents);
  }
  return available ? combined : null;
}

export function findAccountTranscript(defaultDir: string, id: string): string | undefined {
  const found = new Map<string, boolean>();
  for (const account of readClaudeAccounts(defaultDir)) {
    const path = findTranscript(account.configDir, id);
    if (path) found.set(path, (found.get(path) ?? false) || !account.retired);
  }
  // An unscoped ambiguous lookup cannot choose another account's conversation.
  const offered = [...found].filter(([, active]) => active).map(([path]) => path);
  if (found.size === 1) return [...found.keys()][0];
  if (offered.length !== 1) return undefined;
  // A copy brought across from a retired profile is the same conversation (retired-profile.ts): the one written last is
  // the one going on, which is the retired profile's only while a session there hasn't moved yet.
  const written = (path: string) => { try { return statSync(path).mtimeMs; } catch { return -1; } };
  return [...found.keys()].reduce((newest, path) => written(path) > written(newest) ? path : newest, offered[0]!);
}

/**
 * A live session's transcript: the path its row already knows, else a look in the folder of the account the
 * row says it runs under, else every account's (`findAccountTranscript`).
 *
 * An account's folder is looked in directly, never handed to `findAccountTranscript` as the default one: that
 * reads the account list again with this folder as the default, finds it listed twice, and throws "Account
 * profiles must have separate directories". It did on 2026-10-05, for the first message to a new session on
 * a second Claude account, after the words were already typed; the send errored halfway. Tyler: "part of my
 * message sent somehow and i had to go to the terminal and send the full one".
 */
export function sessionTranscript(
  defaultDir: string, sessionId: string, row?: { transcriptPath?: string; claudeConfigDir?: string },
): string | undefined {
  if (row?.transcriptPath) return row.transcriptPath;
  return row?.claudeConfigDir ? findTranscript(row.claudeConfigDir, sessionId) : findAccountTranscript(defaultDir, sessionId);
}

export function accountResumableSessions(options: ReadResumableSessionsOptions, accounts: ClaudeAccount[], codexAccounts?: ClaudeAccount[]): ResumableSessionsRead {
  const result: ResumableSessionsRead = { sessions: [], complete: true };
  // A retired profile's conversations resume in Default (retired-profile.ts), so they are listed as Default's, once.
  const home = accounts.find((account) => account.id === "default");
  for (const account of accounts) {
    const read = readResumableSessionsResult({ ...options, claudeHome: account.configDir,
      ...(codexAccounts === undefined && account.id === "default" ? {} : { codexHome: "" }) });
    result.complete &&= read.complete;
    const listedAs = account.retired && home ? home : account;
    result.sessions.push(...read.sessions.map((session) => session.backend === "codex" ? session : {
      ...session, claudeAccountId: listedAs.id, accountLabel: listedAs.label,
    }));
  }
  for (const account of codexAccounts ?? []) {
    const read = readResumableSessionsResult({ ...options, claudeHome: "", codexHome: account.configDir });
    result.complete &&= read.complete;
    result.sessions.push(...read.sessions.map(session => ({ ...session, codexAccountId: account.id, accountLabel: account.label })));
  }
  result.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const listed = new Set<string>();
  result.sessions = result.sessions.filter((session) => {
    if (session.backend !== "claude") return true;
    const key = `${session.claudeAccountId}:${session.sessionId}`;
    return !listed.has(key) && !!listed.add(key);
  });
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

/**
 * The same rule for a Codex profile, over the threads some process has open. Codex's listing also carries every thread
 * touched in the last eight hours, closed ones included (`CODEX_THREAD_CLOSED`), and counting those refused "Sign in
 * again" for Default on any day Codex had been used, with nothing open to close. The ones that are open are named, since
 * the ChatGPT app's own server holds some of them and they are not in a Terminal anyone would think to look at.
 */
export async function assertCodexAccountIdle(account: ClaudeAccount): Promise<void> {
  const snapshot = await codexRegistrySnapshot(account.configDir);
  if (!snapshot.complete) throw new Error("Could not check this account’s live sessions. Try again before changing it.");
  const open = snapshot.infos.filter((info) => info.noTerminal !== CODEX_THREAD_CLOSED);
  if (!open.length) return;
  const named = open.slice(0, 3).map((info) => `“${info.name ?? info.cwd?.split("/").pop() ?? info.sessionId.slice(0, 8)}”`);
  throw new Error(`Close this account’s live sessions before signing in again or removing it from Conch: ${named.join(", ")}`
    + `${open.length > 3 ? ` and ${open.length - 3} more` : ""}.`);
}
