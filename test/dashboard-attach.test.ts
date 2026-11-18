import { describe, expect, test } from "bun:test";
import { locateDashboard, openDashboard, type DashboardDeps } from "../src/dashboard-attach.ts";
import type { DaemonIdentity } from "../src/daemon-identity.ts";

/**
 * `conch` with no arguments, and `conch dashboard` (2026-11-11). They attached to a tmux session named `conch` that
 * nothing has made since launchd started running the daemon directly, so with launchd's daemon up they said the Mac
 * app was hosting it, and with none they waited for ever. Now who started the daemon decides.
 */
const SOCKET = "/tmp/conch-test-dashboard.sock";

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
  });

  test("launchd: not the app, and it says where to look instead", async () => {
    const target = await locateDashboard(SOCKET, deps({ startedBy: "launchd" }));
    expect(target).toEqual({ kind: "launchd", pid: 4242, answering: true });
  });

  test("nothing running: says so at once, and fails, rather than waiting", async () => {
    const target = await locateDashboard(SOCKET, deps(null));
    expect(target).toEqual({ kind: "none" });
    expect(await openDashboard(SOCKET, deps(null))).toBe(1);
  });

  test("a terminal daemon in a tmux pane is attached to; one in a plain terminal is named", async () => {
    const inTmux = await locateDashboard(SOCKET, deps({}, { ttyOf: () => "ttys004", tmuxSessionOn: (tty) => tty === "ttys004" ? "work" : null }));
    expect(inTmux).toEqual({ kind: "terminal", pid: 4242, answering: true, tty: "ttys004", tmuxSession: "work" });

    const plain = await locateDashboard(SOCKET, deps({}, { ttyOf: () => "ttys004" }));
    expect(plain).toMatchObject({ kind: "terminal", tty: "ttys004", tmuxSession: null });

    expect(await locateDashboard(SOCKET, deps({}))).toMatchObject({ kind: "terminal", tty: null });
  });

  test("a daemon on another socket is not this one; an answer with no identity is said plainly", async () => {
    const elsewhere = deps({ startedBy: "app", socketPath: "/tmp/elsewhere.sock" }, { answering: async () => false });
    expect(await locateDashboard(SOCKET, elsewhere)).toEqual({ kind: "none" });

    const anonymous = deps(null, { answering: async () => true });
    const target = await locateDashboard(SOCKET, anonymous);
    expect(target).toEqual({ kind: "unknown" });
    expect(await openDashboard(SOCKET, anonymous)).toBe(0);
  });
});
