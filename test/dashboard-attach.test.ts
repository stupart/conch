import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeDashboard, locateDashboard, openDashboard, type DashboardDeps } from "../src/dashboard-attach.ts";
import type { DaemonIdentity } from "../src/daemon-identity.ts";

/**
 * `conch` with no arguments, and `conch dashboard` (2026-11-11). They attached to a tmux session named `conch` that
 * nothing has made since launchd started running the daemon directly, so with launchd's daemon up they said the Mac
 * app was hosting it, and with none they waited for ever. Now who started the daemon decides.
 */
const SOCKET = "/tmp/conch-test-dashboard.sock";
const LOG = "/tmp/conch-test-daemon.log";

function deps(identity: Partial<DaemonIdentity> | null, over: Partial<DashboardDeps> = {}): DashboardDeps {
  return {
    identity: () => identity ? { pid: 4242, version: "test", startedAt: 1, startedBy: "terminal", ...identity } : null,
    answering: async () => identity !== null,
    ttyOf: () => null,
    tmuxSessionOn: () => null,
    say: () => {},
    ...over,
  };
}

describe("who runs the daemon decides what `conch` does", () => {
  test("the Mac app: the app is the dashboard, and nothing is attached", async () => {
    const target = await locateDashboard(SOCKET, deps({ startedBy: "app" }));
    expect(target).toEqual({ kind: "app", pid: 4242, answering: true });
    const said = describeDashboard(target, SOCKET, LOG);
    expect(said).toContain("The Mac app is hosting conch's daemon (pid 4242)");
    expect(said).toContain("Nothing to attach to here.");
  });

  test("launchd: not the app, and it says where to look instead", async () => {
    const target = await locateDashboard(SOCKET, deps({ startedBy: "launchd" }));
    expect(target).toEqual({ kind: "launchd", pid: 4242, answering: true });
    const said = describeDashboard(target, SOCKET, LOG);
    expect(said).toContain("launchd is running conch's daemon (pid 4242");
    expect(said).not.toContain("Mac app is hosting");
    expect(said).toContain("conch.app attaches to it");
    expect(said).toContain("`conch sessions`");
    expect(said).toContain(`tail -f ${LOG}`);
  });

  test("nothing running: says so at once, and fails, rather than waiting", async () => {
    const target = await locateDashboard(SOCKET, deps(null));
    expect(target).toEqual({ kind: "none" });
    expect(describeDashboard(target, SOCKET, LOG)).toContain("conch's daemon isn't running");
    expect(await openDashboard(SOCKET, deps(null))).toBe(1);
  });

  test("a terminal daemon in a tmux pane is attached to; one in a plain terminal is named", async () => {
    const inTmux = await locateDashboard(SOCKET, deps({}, { ttyOf: () => "ttys004", tmuxSessionOn: (tty) => tty === "ttys004" ? "work" : null }));
    expect(inTmux).toEqual({ kind: "terminal", pid: 4242, answering: true, tty: "ttys004", tmuxSession: "work" });
    expect(describeDashboard(inTmux, SOCKET, LOG)).toContain('tmux session "work"');

    const plain = await locateDashboard(SOCKET, deps({}, { ttyOf: () => "ttys004" }));
    expect(plain).toMatchObject({ kind: "terminal", tty: "ttys004", tmuxSession: null });
    expect(describeDashboard(plain, SOCKET, LOG)).toContain("its dashboard is in that terminal (ttys004)");

    const detached = await locateDashboard(SOCKET, deps({}));
    expect(describeDashboard(detached, SOCKET, LOG)).toContain("started with no terminal");
  });

  test("a daemon on another socket is not this one; an answer with no identity is said plainly", async () => {
    const elsewhere = deps({ startedBy: "app", socketPath: "/tmp/elsewhere.sock" }, { answering: async () => false });
    expect(await locateDashboard(SOCKET, elsewhere)).toEqual({ kind: "none" });

    const anonymous = deps(null, { answering: async () => true });
    const target = await locateDashboard(SOCKET, anonymous);
    expect(target).toEqual({ kind: "unknown" });
    expect(describeDashboard(target, SOCKET, LOG)).toContain(`A daemon answers on ${SOCKET}`);
    expect(await openDashboard(SOCKET, anonymous)).toBe(0);
  });

  test("an identity whose socket stays quiet says so", async () => {
    const target = await locateDashboard(SOCKET, deps({ startedBy: "launchd" }, { answering: async () => false }));
    expect(describeDashboard(target, SOCKET, LOG)).toContain(`It isn't answering on ${SOCKET} yet.`);
  });

  test("the CLI no longer waits on a tmux session named conch", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    expect(cli).not.toContain('"has-session", "-t", "conch"');
    expect(cli).toContain("await openDashboard(cfg.socketPath)");
  });
});
