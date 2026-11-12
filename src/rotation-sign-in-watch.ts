import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SwapDashboard, SwapUsageAccount } from "./claude-swap.ts";
import { conchHome } from "./home.ts";

/**
 * Saying when a Claude account in the rotation needs signing in again (2026-11-10). An account sat unusable for about
 * six days because its sign-in had died and nothing said so: claude-swap never emitted `account-quarantined` for it
 * (claude-rotation.ts `describeSwapEvent` would have logged one), and its auto-switcher simply skips an account it can't
 * use. Settings › Providers showed "Signed out · sign in again to use it", but nothing pointed there.
 *
 * So the daemon looks for itself: claude-swap's list (`readSwapDashboard`) every `ROTATION_SIGN_IN_CHECK_MS` while
 * rotation is on, and soon after each thing the switcher says. An account that newly needs signing in is told once
 * (`notifyUser`, which reaches the Mac with no push key), logged, and filed as the daemon files an error; told again
 * only after it has worked and broken again. Which accounts have been told is kept on disk, so a restart doesn't tell
 * them again, by a hash of each account's id: the file holds no address.
 */

/** claude-swap's statuses for a sign-in that has stopped working: the Mac app's `needsSignIn` (ClaudeAccountsView.swift). */
export const NEEDS_SIGN_IN_STATUSES: ReadonlySet<string> = new Set(["token_expired", "relogin_required", "no_credentials", "foreign_credential"]);

export const ROTATION_SIGN_IN_CHECK_MS = 15 * 60_000;
/** After the switcher says something, the list is read this long after: claude-swap has written what it found by then. */
export const ROTATION_SIGN_IN_SOON_MS = 20_000;

/** An account as the watch keeps it: a hash of claude-swap's id for it (`SwapUsageAccount.id`), never the address. */
export const accountKey = (account: Pick<SwapUsageAccount, "id">): string =>
  createHash("sha256").update(account.id).digest("hex").slice(0, 24);

export const needsSignIn = (account: Pick<SwapUsageAccount, "status">): boolean => NEEDS_SIGN_IN_STATUSES.has(account.status);

/**
 * What one read of the list means against what was already told (`told`, by `accountKey`):
 * - `newly`: accounts in the rotation (not held out with `cswap disable`) that need signing in and weren't told;
 * - `told`: what is told after this read: each account still broken, and nothing for one that works again, has been
 *   held out or removed, so its next break is told afresh.
 * A read that isn't `ready` (claude-swap missing or failing) changes nothing: an account can't be seen to recover in
 * a list that couldn't be read.
 */
export function signInChanges(told: ReadonlySet<string>, dashboard: SwapDashboard): { newly: SwapUsageAccount[]; told: Set<string> } {
  if (dashboard.state !== "ready") return { newly: [], told: new Set(told) };
  const broken = dashboard.accounts.filter((account) => account.disabled !== true && needsSignIn(account));
  return {
    newly: broken.filter((account) => !told.has(accountKey(account))),
    told: new Set(broken.map(accountKey)),
  };
}

/** The notice for accounts that newly need signing in: the account's own name in the list, and where to fix it. */
export function signInNotice(accounts: readonly Pick<SwapUsageAccount, "label">[]): { title: string; body: string } {
  if (accounts.length === 1) {
    return {
      title: "A Claude account needs signing in",
      body: `${accounts[0]!.label} has stopped working, so the rotation skips it. Sign it in again in conch's Settings › Providers.`,
    };
  }
  return {
    title: `${accounts.length} Claude accounts need signing in`,
    body: `${accounts.map((one) => one.label).join(", ")} have stopped working, so the rotation skips them. Sign them in again in conch's Settings › Providers.`,
  };
}

export function rotationSignInAlertsPath(home = conchHome()): string {
  return join(process.env.CONCH_CONFIG_DIR ?? join(home, ".config", "conch"), "rotation-sign-in-alerts.json");
}

function readTold(file: string): Set<string> {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { told?: unknown };
    return new Set(Array.isArray(stored.told) ? stored.told.filter((one): one is string => typeof one === "string" && /^[0-9a-f]{24}$/.test(one)).slice(0, 100) : []);
  } catch {
    return new Set();
  }
}

function saveTold(file: string, told: ReadonlySet<string>): void {
  try {
    if (!told.size) {
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ told: [...told] }) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } catch {}
}

export interface RotationSignInWatchDependencies {
  /** claude-swap's list (claude-swap.ts `readSwapDashboard`). */
  read(): Promise<SwapDashboard>;
  /** Accounts that newly need signing in: tell, log and file them. */
  tell(accounts: SwapUsageAccount[]): void | Promise<void>;
  file?: string;
  intervalMs?: number;
  soonMs?: number;
}

/** The check, on a timer while rotation is on, and soon after each thing the switcher says. One read at a time. */
export class RotationSignInWatch {
  readonly #deps: RotationSignInWatchDependencies;
  readonly #file: string;
  #told: Set<string>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #soon: ReturnType<typeof setTimeout> | undefined;
  #checking: Promise<void> | undefined;
  #on = false;

  constructor(deps: RotationSignInWatchDependencies) {
    this.#deps = deps;
    this.#file = deps.file ?? rotationSignInAlertsPath();
    this.#told = readTold(this.#file);
  }

  /** Rotation on or off. On starts the timer and reads the list soon; off stops both. */
  set(on: boolean): void {
    if (on === this.#on) return;
    this.#on = on;
    if (!on) {
      if (this.#timer) clearInterval(this.#timer);
      if (this.#soon) clearTimeout(this.#soon);
      this.#timer = this.#soon = undefined;
      return;
    }
    this.#timer = setInterval(() => void this.check(), this.#deps.intervalMs ?? ROTATION_SIGN_IN_CHECK_MS);
    this.#timer.unref?.();
    this.soon();
  }

  /** The switcher said something (switched, quarantined, failed over): read the list shortly. */
  soon(): void {
    if (!this.#on || this.#soon) return;
    this.#soon = setTimeout(() => {
      this.#soon = undefined;
      void this.check();
    }, this.#deps.soonMs ?? ROTATION_SIGN_IN_SOON_MS);
    this.#soon.unref?.();
  }

  stop(): void {
    this.set(false);
  }

  /** One read. Never throws: a read that fails is a read that changed nothing. */
  check(): Promise<void> {
    this.#checking ??= (async () => {
      try {
        const dashboard = await this.#deps.read();
        const { newly, told } = signInChanges(this.#told, dashboard);
        const changed = told.size !== this.#told.size || [...told].some((one) => !this.#told.has(one));
        this.#told = told;
        if (changed) saveTold(this.#file, told);
        if (newly.length) await this.#deps.tell(newly);
      } catch {} finally {
        this.#checking = undefined;
      }
    })();
    return this.#checking;
  }
}
