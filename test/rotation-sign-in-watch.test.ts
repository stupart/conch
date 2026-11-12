import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSwapDashboard, type SwapDashboard, type SwapUsageAccount } from "../src/claude-swap.ts";
import {
  accountKey,
  NEEDS_SIGN_IN_STATUSES,
  RotationSignInWatch,
  signInChanges,
  signInNotice,
} from "../src/rotation-sign-in-watch.ts";

// An account in the rotation sat unusable for about six days because its sign-in had died and nothing said so
// (rotation-sign-in-watch.ts, 2026-11-10). These hold the rule: told once when it newly needs signing in, and again only
// after it has worked and broken again.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-rotation-watch-"));
  roots.push(root);
  return join(root, "rotation-sign-in-alerts.json");
}

/** claude-swap's own `list --json`, as `readSwapDashboard` decodes it: the fixtures go through the real decoder. */
function dashboard(rows: Array<{ number: number; email: string; usageStatus: string; disabled?: boolean; alias?: string }>): SwapDashboard {
  return decodeSwapDashboard(JSON.stringify({
    schemaVersion: 1,
    accounts: rows.map((row) => ({ organizationUuid: "org-1", active: row.number === 1, ...row })),
  }));
}

const A = { number: 1, email: "a@example.com", alias: "Work Max" };
const B = { number: 2, email: "b@example.com" };
const C = { number: 3, email: "c@example.com" };

describe("which accounts newly need signing in", () => {
  test("the Mac app's needsSignIn statuses, and only those", () => {
    expect([...NEEDS_SIGN_IN_STATUSES].sort()).toEqual(["foreign_credential", "no_credentials", "relogin_required", "token_expired"]);
    const read = dashboard([
      { ...A, usageStatus: "ok" },
      { ...B, usageStatus: "relogin_required" },
      { ...C, usageStatus: "keychain_unavailable" },
    ]);
    const { newly, told } = signInChanges(new Set(), read);
    expect(newly.map((one) => one.email)).toEqual(["b@example.com"]);
    expect(told).toEqual(new Set([accountKey(read.accounts[1]!)]));
  });

  test("told once; still broken is not told again; working again clears it; broken again is told again", () => {
    const broken = dashboard([{ ...A, usageStatus: "ok" }, { ...B, usageStatus: "token_expired" }]);
    const first = signInChanges(new Set(), broken);
    expect(first.newly.map((one) => one.number)).toEqual([2]);
    const again = signInChanges(first.told, dashboard([{ ...A, usageStatus: "ok" }, { ...B, usageStatus: "relogin_required" }]));
    expect(again.newly).toEqual([]);
    const fixed = signInChanges(again.told, dashboard([{ ...A, usageStatus: "ok" }, { ...B, usageStatus: "ok" }]));
    expect(fixed.newly).toEqual([]);
    expect(fixed.told.size).toBe(0);
    const brokenAgain = signInChanges(fixed.told, broken);
    expect(brokenAgain.newly.map((one) => one.number)).toEqual([2]);
  });

  test("an account held out of switching isn't the rotation's, and a list that couldn't be read changes nothing", () => {
    const held = signInChanges(new Set(), dashboard([{ ...B, usageStatus: "no_credentials", disabled: true }]));
    expect(held.newly).toEqual([]);
    const told = signInChanges(new Set(), dashboard([{ ...B, usageStatus: "no_credentials" }])).told;
    for (const unread of [
      { source: "claude-swap", state: "error", accounts: [], message: "x" },
      { source: "claude-swap", state: "unavailable", accounts: [] },
    ] as SwapDashboard[]) {
      expect(signInChanges(told, unread)).toEqual({ newly: [], told });
    }
    // Removed from the list: forgotten, so one added back broken is told.
    expect(signInChanges(told, dashboard([{ ...A, usageStatus: "ok" }])).told.size).toBe(0);
  });

  test("the notice names the account as the list does and says where to fix it", () => {
    expect(signInNotice([{ label: "Work Max" }])).toEqual({
      title: "A Claude account needs signing in",
      body: "Work Max has stopped working, so the rotation skips it. Sign it in again in conch's Settings › Providers.",
    });
    expect(signInNotice([{ label: "Work Max" }, { label: "b@example.com" }]).title).toBe("2 Claude accounts need signing in");
  });
});

describe("the watch", () => {
  function watch(file: string, reads: SwapDashboard[]) {
    const told: SwapUsageAccount[][] = [];
    let index = 0;
    const instance = new RotationSignInWatch({
      read: async () => reads[Math.min(index++, reads.length - 1)]!,
      tell: (accounts) => { told.push(accounts); },
      file,
      intervalMs: 60_000,
      soonMs: 5,
    });
    return { instance, told };
  }

  test("what it told is kept on disk by hash, so a restart doesn't tell it again", async () => {
    const file = scratch();
    const broken = dashboard([{ ...A, usageStatus: "ok" }, { ...B, usageStatus: "relogin_required" }]);
    const first = watch(file, [broken]);
    await first.instance.check();
    expect(first.told.map((accounts) => accounts.map((one) => one.number))).toEqual([[2]]);
    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain("example.com");
    expect(JSON.parse(stored).told).toEqual([accountKey(broken.accounts[1]!)]);
    // The daemon restarts: the same account, still broken, is not told again.
    const restarted = watch(file, [broken]);
    await restarted.instance.check();
    expect(restarted.told).toEqual([]);
    // It's signed in again, and the file goes.
    const fixed = watch(file, [dashboard([{ ...A, usageStatus: "ok" }, { ...B, usageStatus: "ok" }])]);
    await fixed.instance.check();
    expect(existsSync(file)).toBe(false);
  });

  test("rotation on reads soon after; a switcher event reads soon; off stops; a read that throws changes nothing", async () => {
    const file = scratch();
    const { instance, told } = watch(file, [dashboard([{ ...B, usageStatus: "token_expired" }])]);
    instance.soon();
    await Bun.sleep(20);
    expect(told).toEqual([]);
    instance.set(true);
    await Bun.sleep(30);
    expect(told).toHaveLength(1);
    instance.stop();
    const failing = new RotationSignInWatch({ read: async () => { throw new Error("cswap crashed"); }, tell: () => { throw new Error("never"); }, file });
    await failing.check();
    expect(JSON.parse(readFileSync(file, "utf8")).told).toHaveLength(1);
  });
});

describe("in the daemon", () => {
  test("on with rotation, read again after whatever the switcher says, told through notifyUser with no key needed, and filed", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    const watch = daemon.slice(daemon.indexOf("const rotationSignIns = new RotationSignInWatch"), daemon.indexOf("rotationSignIns.set(cfg.claudeRotation);"));
    expect(watch).toContain("read: () => readSwapDashboard()");
    expect(watch).toContain('recordDaemonError("claude-rotation-sign-in"');
    expect(watch).toContain('notifier.notify({ title, body, source: "conch", target: "providers" })');
    expect(watch).toMatch(/new RotationSupervisor\(\(line\) => \{[\s\S]*rotationSignIns\.soon\(\);/);
    expect(daemon).toMatch(/if \(key === "claude-rotation"\) \{\s*rotation\.set\(value === true\);\s*rotationSignIns\.set\(value === true\);/);
    expect(daemon).toContain("rotationSignIns.stop();");
  });
});
