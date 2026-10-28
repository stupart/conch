import { realpathSync } from "node:fs";
import { join } from "node:path";
import { withCodexAppServer, type CodexAccount } from "./codex-accounts.ts";

/**
 * Codex's hook review, for the sessions conch starts where nobody can answer it.
 *
 * Codex 0.164 runs a hook only once someone has trusted it. Until then every `codex` stops, before it does anything,
 * on "Hooks need review · 3 hooks are new or changed · 1. Review hooks 2. Trust all and continue 3. Continue without
 * trusting". conch wires its own three into hooks.json on a Codex start (`runCodexInstall`), so from then on every
 * Codex session asks. In Terminal someone is there to answer. In a background session nobody is, and it sat there:
 * Tyler's "atals and nura", resumed in the background on 2026-10-28, never checked in, its pane on that screen for
 * as long as anyone left it ("having trouble with resuming a codex session 'atals and nura'").
 *
 * So a background start trusts conch's OWN hooks, for that one launch: the ones in this home's hooks.json whose
 * command is exactly the one conch wrote there, at the hash Codex itself gives them (`hooks/list`). It goes on the
 * command line as a `-c hooks.state=…` override, the way the folder-trust answer does (`trustFolderArgs`), and is
 * never written to config.toml: trusting them for good stays the person's answer, in Codex's own review. Any other hook
 * Codex would ask about is not conch's to vouch for, so the start is refused and says which, rather than started onto
 * a screen nobody will see (`backgroundHookReviewError`).
 *
 * Measured on codex-cli 0.164.0: the key is `<realpath of hooks.json>:<event>:<group>:<handler>`, the hash
 * `sha256:<hex>`; a per-key `-c hooks.state."<key>".trusted_hash=…` is not read (the key's own dots split it), the
 * whole table as one inline value is, and it merges with what config.toml already trusts. `enabled=false` doesn't
 * spare a hook the review.
 */

/** One hook as Codex's `hooks/list` describes it: only what deciding about its review needs. */
export interface CodexHookListing {
  key: string;
  /** Where it was configured: "user" is this home's own hooks.json; "project" a repo's `.codex/hooks.json`. */
  source: string;
  sourcePath: string;
  /** Present for a command handler. */
  command?: string;
  currentHash: string;
  /** "trusted" and "managed" run; "untrusted" and "modified" are what Codex stops to ask about. */
  trustStatus: string;
}

/** What a background start does about Codex's review: the override for conch's own hooks, and any it can't vouch for. */
export interface CodexHookReview {
  /** `hooks.state={…}`, for `-c`; absent when none of conch's hooks need it. */
  trust?: string;
  /** The other hooks Codex would stop to ask about, by command (or key, for a handler with none). */
  others: string[];
}

const ASKS = new Set(["untrusted", "modified"]);
/** A Codex hook key: an absolute path with nothing a TOML basic string must escape, then event, group and handler. */
const HOOK_KEY = /^\/[^\u0000-\u001f\u007f"\\]+:[a-z_]+:\d+:\d+$/;
const HOOK_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * The review a launch in `codexHome` would meet, from `hooks/list`'s entries. conch's own: a command handler from this
 * home's hooks.json, that file by its real path as Codex keys it, running exactly `command` (`codexHookCommand`).
 * A repo's `.codex/hooks.json` that names the same command is still a repo's, and is never trusted here.
 */
export function codexHookReview(hooks: readonly CodexHookListing[], codexHome: string, command: string): CodexHookReview {
  let hooksJson: string;
  try { hooksJson = realpathSync(join(codexHome, "hooks.json")); } catch { hooksJson = join(codexHome, "hooks.json"); }
  const ours: string[] = [];
  const others: string[] = [];
  for (const hook of hooks) {
    if (!ASKS.has(hook.trustStatus)) continue;
    const own = hook.source === "user" && hook.sourcePath === hooksJson && hook.command === command
      && HOOK_KEY.test(hook.key) && hook.key.startsWith(`${hooksJson}:`) && HOOK_HASH.test(hook.currentHash);
    if (own) ours.push(`${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}`);
    else others.push(hook.command ?? hook.key);
  }
  return { ...(ours.length ? { trust: `hooks.state={${ours.join(",")}}` } : {}), others: [...new Set(others)] };
}

/** Why a background start was refused: Codex would stop on hooks conch can't answer for. */
export function backgroundHookReviewError(others: readonly string[]): string {
  const named = others.slice(0, 3).map((hook) => hook.length > 80 ? `${hook.slice(0, 79)}…` : hook).join("; ");
  const more = others.length > 3 ? ` and ${others.length - 3} more` : "";
  return `Codex would stop before starting to ask you to review ${others.length === 1 ? "a hook" : `${others.length} hooks`}`
    + ` conch didn't add (${named}${more}), and in the background nobody would see it. Start this one in Terminal and`
    + " answer it there once, or review them in any Codex session first.";
}

/** One `hooks/list` entry, kept only when it has the shape `codexHookReview` reads. */
function listing(value: unknown): CodexHookListing | null {
  if (!value || typeof value !== "object") return null;
  const hook = value as Record<string, unknown>;
  for (const field of ["key", "source", "sourcePath", "currentHash", "trustStatus"]) {
    if (typeof hook[field] !== "string") return null;
  }
  return {
    key: hook.key as string,
    source: hook.source as string,
    sourcePath: hook.sourcePath as string,
    ...(typeof hook.command === "string" ? { command: hook.command } : {}),
    currentHash: hook.currentHash as string,
    trustStatus: hook.trustStatus as string,
  };
}

/** The hooks a Codex start in `cwd` would load, as `hooks/list` gives them. Null when Codex couldn't say. */
export function decodeHooksList(raw: unknown): CodexHookListing[] | null {
  const data = raw && typeof raw === "object" ? (raw as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return null;
  const hooks = new Map<string, CodexHookListing>();
  for (const entry of data) {
    const listed = entry && typeof entry === "object" ? (entry as { hooks?: unknown }).hooks : undefined;
    if (!Array.isArray(listed)) continue;
    for (const value of listed) {
      const hook = listing(value);
      if (hook) hooks.set(hook.key, hook);
    }
  }
  return [...hooks.values()];
}

/**
 * Ask Codex, in `account`'s home, which hooks a session in `cwd` would load and whether each is trusted. Null when it
 * couldn't be asked: a Codex from before hooks needed trust has no `hooks/list`, and asks nothing either. A third of a
 * second on Tyler's Mac; bounded well inside the 8 s a phone's start waits for its reply (daemon.ts `injectTimeoutFor`).
 */
export async function readCodexHooks(
  account: CodexAccount,
  cwd: string,
  executable = "codex",
  timeoutMs = 4_000,
): Promise<CodexHookListing[] | null> {
  try {
    return decodeHooksList(await withCodexAppServer(account, "conch_hooks", (call) => call("hooks/list", { cwds: [cwd] }), { executable, timeoutMs }));
  } catch {
    return null;
  }
}
