import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexTerminalCandidates, probeCodexTerminalSessions, resumedCodexThread } from "../src/codex-terminal-sessions.ts";

const THREAD = "01a0b8e3-c575-72b1-8570-a071638e3acf";
test("explicit resume, including the installed CLI's yolo command, identifies the native thread", () => {
  for (const args of [
    `codex resume ${THREAD}`, `codex yolo resume ${THREAD}`,
    `/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox resume ${THREAD}`,
    `codex -c model=gpt-6-sol --no-alt-screen resume ${THREAD}`,
  ]) expect(resumedCodexThread(args)).toBe(THREAD);
});
test("prompts, exec jobs, forks, and ambiguous selections never borrow a thread's terminal", () => {
  for (const args of [
    `codex explain resume ${THREAD}`, `codex exec resume ${THREAD}`, `codex fork ${THREAD}`,
    `node codex resume ${THREAD}`, `codex resume --last`, `codex resume`,
    `codex -c 'prompt=please resume ${THREAD}'`, `codex app-server resume ${THREAD}`,
    `codex resume ${THREAD} --remote wss://another-host`, `codex --remote unix:// resume ${THREAD}`,
    `codex resume ${THREAD} --help`,
  ]) expect(resumedCodexThread(args)).toBeUndefined();
});
test("only this user's foreground, non-stopped TUI with a tty is eligible", () => {
  const rows = [
    ` 11 501 ttys006 S+ codex yolo resume ${THREAD}`,
    ` 12 502 ttys007 S+ codex resume ${THREAD}`,
    ` 13 501 ?? S+ codex resume ${THREAD}`,
    ` 14 501 ttys008 S codex resume ${THREAD}`,
    ` 15 501 ttys009 T+ codex resume ${THREAD}`,
    ` 16 501 ttys010 Z+ codex resume ${THREAD}`,
    ` 17 501 ttys011 S+ codex app-server --listen unix://`,
  ];
  expect([...codexTerminalCandidates(rows.join("\n"), 501)]).toEqual([[THREAD, [11]]]);
});
test("the open log database scopes terminals to the actual Codex account; failures are unknown", async () => {
  const home = mkdtempSync(join(tmpdir(), "conch-terminal-profile-"));
  const db = join(home, "logs_2.sqlite"); writeFileSync(db, "");
  const calls: string[][] = [];
  let opened: string | null = `p11\nn/another/account/logs_2.sqlite\np12\nn${db}\n`;
  const probe = async (argv: string[]) => {
    calls.push(argv);
    return argv[0] === "ps" ? `11 501 ttys001 S+ codex resume ${THREAD}\n12 501 ttys002 S+ codex resume ${THREAD}` : opened;
  };
  try {
    expect([...await probeCodexTerminalSessions(home, probe, 501)]).toEqual([[THREAD, 12]]);
    expect(calls[1]).toEqual(["lsof", "-a", "-p", "11,12", "-F", "pn", "--", db]);
    // A failed probe proves nothing: what the last good one found stands while its process lives (2026-10-15, a live
    // Codex session logged "Codex row has no pid" five times on a loaded Mac).
    opened = null;
    expect([...await probeCodexTerminalSessions(home, probe, 501, () => true)]).toEqual([[THREAD, 12]]);
    expect([...await probeCodexTerminalSessions(home, async () => null, 501, () => true)]).toEqual([[THREAD, 12]]);
    // Not once its process is gone, nor two minutes on.
    expect((await probeCodexTerminalSessions(home, async () => null, 501, () => false)).size).toBe(0);
    expect((await probeCodexTerminalSessions(home, async () => null, 501, () => true, () => Date.now() + 121_000)).size).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a TUI attached to the shared daemon is proven by its socket to the server holding its thread (2026-10-23)", async () => {
  // Live: `codex yolo resume` on ttys006 had no log database open, and its fd 21 was connected to fd 62 of pid 6163
  // (`codex app-server --listen unix:// … --managed-daemon`), which held the thread's lock. conch called it hosted by
  // the app-server, with no terminal to type into.
  const OTHER = "5e5e5e06-6b67-7e00-8000-000000000006";
  const home = mkdtempSync(join(tmpdir(), "conch-terminal-daemon-"));
  writeFileSync(join(home, "logs_2.sqlite"), "");
  const calls: string[][] = [];
  let sockets: string | null = [
    "p6163", "f43", "d0x6b3743792424763e", "n/private/tmp/codex-daemon-501/f4b0",
    "f62", "d0x6ff70a56160a7b34", "n/private/tmp/codex-daemon-501/f4b0",
    "p48984", "f17", "d0xb3f72ade8491358f", "n->0x70a4510e6028149", "f21", "d0x1562e41b1629f387", "n->0x6ff70a56160a7b34",
    // Another TUI, connected to something else: no proof of anything.
    "p48985", "f21", "d0x1a", "n->0x2b",
  ].join("\n");
  const probe = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "ps") return `48984 501 ttys006 S+ codex yolo resume ${THREAD}\n48985 501 ttys007 S+ codex resume ${OTHER}`;
    return argv.includes("-U") ? sockets : ""; // lsof's exit 1: no log database open
  };
  const servers = new Map([[THREAD, 6163], [OTHER, 6163]]);
  try {
    expect([...await probeCodexTerminalSessions(home, probe, 501, () => true, Date.now, servers)]).toEqual([[THREAD, 48984]]);
    expect(calls.at(-1)).toEqual(["lsof", "-a", "-U", "-p", "48984,48985,6163", "-F", "pdn"]);
    // A failed socket probe is unknown too: what the last good one proved stands while its process lives.
    sockets = null;
    expect([...await probeCodexTerminalSessions(home, probe, 501, () => true, Date.now, servers)]).toEqual([[THREAD, 48984]]);
    expect((await probeCodexTerminalSessions(home, probe, 501, () => false, Date.now, servers)).size).toBe(0);
    // Connected to a server that doesn't hold its thread proves nothing.
    sockets = ["p7000", "f9", "d0x6ff70a56160a7b34", "p48984", "f21", "d0x1562e41b1629f387", "n->0x6ff70a56160a7b34"].join("\n");
    expect((await probeCodexTerminalSessions(home, probe, 501, () => true, Date.now, new Map([[THREAD, 6163]]))).size).toBe(0);
    // And with no app-server holding its thread there is nothing to be connected to, so nothing is asked.
    calls.length = 0;
    expect((await probeCodexTerminalSessions(home, probe, 501, () => true)).size).toBe(0);
    expect(calls.some(argv => argv.includes("-U"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a probe that succeeds and finds no session drops it at once", async () => {
  const home = mkdtempSync(join(tmpdir(), "conch-terminal-gone-"));
  const db = join(home, "logs_2.sqlite"); writeFileSync(db, "");
  let table = `12 501 ttys002 S+ codex resume ${THREAD}`;
  const probe = async (argv: string[]) => (argv[0] === "ps" ? table : `p12\nn${db}\n`);
  try {
    expect([...await probeCodexTerminalSessions(home, probe, 501, () => true)]).toEqual([[THREAD, 12]]);
    // Out of its terminal's foreground (a child holds it): no route, whatever was known.
    table = `12 501 ttys002 S codex resume ${THREAD}`;
    expect((await probeCodexTerminalSessions(home, probe, 501, () => true)).size).toBe(0);
    expect((await probeCodexTerminalSessions(home, async () => null, 501, () => true)).size).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
