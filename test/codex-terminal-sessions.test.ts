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
    opened = null;
    expect((await probeCodexTerminalSessions(home, probe, 501)).size).toBe(0);
    expect((await probeCodexTerminalSessions(home, async () => null, 501)).size).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
