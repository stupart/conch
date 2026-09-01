import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tell people when the conch they are running has been superseded.
 *
 * Homebrew never upgrades an installed package on its own. `brew update`
 * refreshes formula metadata and stops there, and the scheduled upgrade people
 * remember is `brew autoupdate`, a third-party tap nobody has by default. So a
 * user installs once and stays on that version forever unless something tells
 * them otherwise — which is how someone could have run the release where the
 * microphone could not hear, indefinitely, with the fix already published.
 *
 * Automatic upgrading is deliberately NOT the answer here. conch holds a
 * microphone and drives other people's terminals; swapping the binary
 * underneath a running voice loop is not a thing it should do to someone while
 * they are mid-sentence. Telling them, once, is.
 */

export interface VersionCheckState {
  /** Epoch millis of the last completed check, successful or not. */
  checkedAt: number;
  /** Latest version seen, without the `v`. Absent when no check has succeeded. */
  latest?: string;
}

/** Parsed `x.y.z`, or null for anything that is not exactly that. */
export function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Is `latest` strictly newer than `current`?
 *
 * Returns false when either side is unparseable rather than guessing. A wrong
 * "you are out of date" is worse than silence: it sends someone to upgrade
 * something that is already current, and the next real notice gets ignored.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function versionCheckPath(configDir?: string): string {
  return join(configDir ?? join(homedir(), ".config", "conch"), "version-check.json");
}

export function readVersionCheck(path: string): VersionCheckState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VersionCheckState;
    if (typeof parsed?.checkedAt !== "number") return null;
    if (parsed.latest !== undefined && typeof parsed.latest !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeVersionCheck(path: string, state: VersionCheckState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Same-directory temp then rename: a torn read here would be indistinguishable
    // from "never checked", which would re-check on every single daemon start.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Never fatal. A version notice is a courtesy, not a feature to fail over.
  }
}

/** True when enough time has passed to ask again. */
export function isCheckDue(
  state: VersionCheckState | null,
  now: number,
  intervalMs: number,
): boolean {
  if (!state) return true;
  // A clock that moved backwards (sleep, timezone, NTP) must not park the next
  // check in the future forever.
  if (state.checkedAt > now) return true;
  return now - state.checkedAt >= intervalMs;
}

export interface UpdateNotice {
  current: string;
  latest: string;
  /** What the person should actually type. */
  command: string;
}

/**
 * The line to show, or null when there is nothing to say.
 *
 * `fromSource` suppresses it entirely: someone running from a checkout upgrades
 * with `git pull`, and telling them to `brew upgrade` would be wrong advice
 * that also happens to be impossible to follow.
 */
export function updateNotice(
  current: string,
  latest: string | undefined,
  fromSource: boolean,
): UpdateNotice | null {
  if (fromSource || !latest || !isNewer(latest, current)) return null;
  return { current, latest, command: "brew upgrade conch" };
}

export function describeNotice(notice: UpdateNotice): string {
  return `conch ${notice.latest} is available (running ${notice.current}) — ${notice.command}`;
}

/**
 * Ask GitHub for the newest published release.
 *
 * Unauthenticated and best-effort: a rate limit, an outage, or no network at
 * all returns null and the caller stays quiet. Bounded so a hung request cannot
 * hold anything open.
 */
export async function fetchLatestVersion(
  timeoutMs = 5_000,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      "https://api.github.com/repos/stupart/conch/releases/latest",
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return null;
    const body = await response.json() as { tag_name?: unknown };
    if (typeof body?.tag_name !== "string") return null;
    return parseVersion(body.tag_name) ? body.tag_name.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

/** Running from a checkout (`bun link`) rather than an installed binary. */
export function runningFromSource(execPath: string = process.execPath): boolean {
  // A compiled release is a single binary; source runs go through bun.
  return /\/bun$/.test(execPath) || execPath.endsWith("/bun");
}

export { existsSync };
