import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { adapterFor } from "./agent-adapter.ts";
import { readClaudeAccounts, type ClaudeAccount } from "./claude-accounts.ts";
import { conchHome } from "./home.ts";
import type { StartSessionRequest } from "./session-lifecycle.ts";

/**
 * Which Claude account profile `conch start --resume <id>` resumes in: the one whose folder holds `<id>.jsonl`.
 *
 * 2026-10-18: an agent ran `conch start claude --resume <id> --fork-session` with no `--account`. The new Terminal's
 * login shell doesn't inherit the agent's `CLAUDE_CONFIG_DIR`, so Claude Code started under the Default profile, where
 * that conversation doesn't exist, and exited; the conversation was only in the Blueprint profile. The daemon's own fork
 * carries the account (`forkRequest`); this is the CLI's way to the same answer, from where the transcript is.
 */

export interface ResumeLookup {
  /** conch's account profiles, Default being the real ~/.claude (`readClaudeAccounts` with no CLAUDE_CONFIG_DIR). */
  accounts: readonly ClaudeAccount[];
  /** The CLAUDE_CONFIG_DIR of whoever ran `conch start`: an agent's own profile. */
  callerConfigDir?: string;
  /** When `<id>.jsonl` in that profile was last written, or undefined when the profile doesn't have it. */
  heldAt(configDir: string, id: string): number | undefined;
  /** A folder's real path, so two spellings of one profile are one. */
  canonical(path: string): string;
}

export type ResumeAccount =
  | { ok: true; request: StartSessionRequest; said?: string }
  | { ok: false; error: string };

const named = (account: ClaudeAccount) => `"${account.label}"`;

/** The request with the account that holds its conversation, or why none can resume it. Only a Claude resume is looked at. */
export function resumeAccountFor(request: StartSessionRequest, lookup: ResumeLookup): ResumeAccount {
  const id = request.resumeSessionId?.trim();
  if (request.backend !== "claude" || !id) return { ok: true, request };
  const holders = lookup.accounts
    .map((account) => ({ account, at: lookup.heldAt(account.configDir, id) }))
    .filter((one): one is { account: ClaudeAccount; at: number } => one.at !== undefined)
    .sort((a, b) => b.at - a.at);
  const caller = lookup.callerConfigDir ? lookup.canonical(lookup.callerConfigDir) : undefined;
  const callerAccount = caller ? lookup.accounts.find((account) => lookup.canonical(account.configDir) === caller) : undefined;
  const looked = [
    ...lookup.accounts.map((account) => `${named(account)} (${account.configDir})`),
    ...(caller && !callerAccount ? [`your CLAUDE_CONFIG_DIR (${lookup.callerConfigDir})`] : []),
  ].join(", ");
  const none = `no Claude account profile has conversation ${id} (looked in ${looked}), so Claude Code would start with nothing to`
    + " resume and exit. Check the id (`conch resumable <words from it>`), or fork a live session from conch's Mac app or with conch_fork";

  if (request.claudeAccountId !== undefined) {
    const chosen = lookup.accounts.find((account) => account.id === request.claudeAccountId);
    if (!chosen) return { ok: false, error: `there is no Claude account profile with id ${request.claudeAccountId}` };
    if (lookup.heldAt(chosen.configDir, id) !== undefined) return { ok: true, request };
    if (!holders.length) return { ok: false, error: none };
    return {
      ok: false,
      error: `conversation ${id} isn't in the ${named(chosen)} account profile; it is in ${holders.map(({ account }) => `${named(account)} (--account ${account.id})`).join(" and ")}`,
    };
  }
  const own = holders.find(({ account }) => account === callerAccount);
  const pick = own ?? holders[0];
  if (pick) {
    const others = holders.filter((one) => one !== pick);
    return {
      ok: true,
      request: { ...request, claudeAccountId: pick.account.id },
      said: `resuming in the ${named(pick.account)} account profile, which has conversation ${id}`
        + (others.length ? ` (also in ${others.map(({ account }) => named(account)).join(", ")}: pass --account to choose)` : ""),
    };
  }
  // A profile conch doesn't know, but the one whoever asked runs under: started there by name.
  if (caller && !callerAccount && lookup.heldAt(lookup.callerConfigDir!, id) !== undefined) {
    if (request.host === "background") {
      return {
        ok: false,
        error: `conversation ${id} is in ${lookup.callerConfigDir}, which isn't one of conch's account profiles, and conch's background host`
          + " runs only those: start it in Terminal (without --background), or add that folder as an account in conch's Settings → Providers",
      };
    }
    return {
      ok: true,
      request: { ...request, claudeConfigDir: caller },
      said: `resuming in ${lookup.callerConfigDir} (your CLAUDE_CONFIG_DIR), which has conversation ${id}`,
    };
  }
  return { ok: false, error: none };
}

/** The real profiles: conch's account store, with Default the ~/.claude a fresh login shell's Claude Code uses. */
export function defaultResumeLookup(callerConfigDir: string | undefined): ResumeLookup {
  const canonical = (path: string) => {
    try {
      return realpathSync(resolve(path));
    } catch {
      return resolve(path);
    }
  };
  let accounts: ClaudeAccount[];
  try {
    accounts = readClaudeAccounts(join(conchHome(), ".claude"));
  } catch {
    accounts = [{ id: "default", label: "Default", configDir: join(conchHome(), ".claude") }];
  }
  return {
    accounts,
    ...(callerConfigDir ? { callerConfigDir } : {}),
    heldAt(configDir, id) {
      const path = adapterFor("claude").findTranscript(id, { claudeDir: configDir });
      if (!path) return undefined;
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
    canonical,
  };
}
