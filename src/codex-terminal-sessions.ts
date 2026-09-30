import { readdirSync } from "node:fs";
import { join } from "node:path";
import { probeCommand } from "./probe.ts";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SWITCHES = new Set(["--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--no-alt-screen", "--oss"]);
const VALUES = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "--enable", "--disable"]);

/** Only an explicit resume identifies a thread. Never guess from cwd, a prompt,
 * --last, the picker, or a fork's source UUID. ps flattens argv, so ambiguous
 * option values are deliberately not interpreted as a command. */
export function resumedCodexThread(args: string): string | undefined {
  const words = args.trim().split(/\s+/);
  if (!/(?:^|\/)codex$/.test(words.shift() ?? "")) return;
  // Options can appear after the UUID too. A remote TUI's local log database
  // identifies its config, not the machine hosting its conversation.
  if (words.some(word => /^(?:--remote(?:=|-|$)|--help$|-h$|--version$)/.test(word))) return;
  while (words.length) {
    const word = words.shift()!;
    if (word === "resume") return UUID.test(words[0] ?? "") ? words[0]!.toLowerCase() : undefined;
    if (word === "yolo" && words[0] === "resume") continue;
    if (SWITCHES.has(word)) continue;
    if (VALUES.has(word)) {
      const value = words.shift();
      if (!value || /["']/.test(value) || value.startsWith("-")) return;
      if (["-c", "--config"].includes(word) && !value.includes("=")) return;
      continue;
    }
    return;
  }
}

export function codexTerminalCandidates(table: string, uid: number): Map<string, number[]> {
  const candidates = new Map<string, number[]>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match || Number(match[2]) !== uid || match[3] === "??" || match[3] === "?"
      || !match[4]!.includes("+") || /[TZ]/.test(match[4]!)) continue;
    const thread = resumedCodexThread(match[5]!);
    if (!thread) continue;
    candidates.set(thread, [...(candidates.get(thread) ?? []), Number(match[1])]);
  }
  return candidates;
}

type Probe = typeof probeCommand;
export async function probeCodexTerminalSessions(codexHome: string, probe: Probe = probeCommand, uid = process.getuid?.()): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (uid === undefined) return result;
  // The open log DB proves the profile. Reading CODEX_HOME out of ps's full
  // environment would expose credentials; cwd cannot distinguish accounts.
  let logs: string[];
  try { logs = readdirSync(codexHome).filter(name => /^logs_\d+\.sqlite$/.test(name)).map(name => join(codexHome, name)); }
  catch { return result; }
  if (!logs.length) return result;
  const table = await probe(["ps", "-axo", "pid=,uid=,tty=,stat=,args="], [0]);
  if (table === null) return result;
  const candidates = codexTerminalCandidates(table, uid);
  const pids = [...candidates.values()].flat();
  if (!pids.length) return result;
  const opened = await probe(["lsof", "-a", "-p", pids.join(","), "-F", "pn", "--", ...logs], [0, 1]);
  if (opened === null) return result;
  const matched = new Set<number>();
  let pid = 0;
  for (const line of opened.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (pid && line.startsWith("n") && logs.includes(line.slice(1))) matched.add(pid);
  }
  for (const [thread, options] of candidates) {
    const pid = options.filter(pid => matched.has(pid)).sort((a, b) => a - b)[0];
    if (pid) result.set(thread, pid);
  }
  return result;
}

// Rendering polls faster than ps/lsof should run. Coalesce readers and expire
// quickly so closing/backgrounding a terminal doesn't leave a sticky route.
const snapshots = new Map<string, { expires: number; result: Promise<Map<string, number>> }>();
export function readCodexTerminalSessions(codexHome: string): Promise<Map<string, number>> {
  const cached = snapshots.get(codexHome);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (snapshots.size > 32) snapshots.clear();
  const result = probeCodexTerminalSessions(codexHome);
  snapshots.set(codexHome, { expires: Date.now() + 5_000, result });
  return result;
}
