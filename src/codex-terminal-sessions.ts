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

/**
 * The last routes a probe confirmed, per Codex home. A probe that fails (`ps` or `lsof` past its time on a loaded Mac)
 * proves nothing either way, and treating it as "no terminal" made a live Codex session unsendable: Tyler's
 * "notes and research" logged "Codex row has no pid" five times in an afternoon while its process sat on ttys006 the whole
 * time (2026-10-15). So a failed probe answers with what the last good one found, for as long as that process is alive
 * and for at most `KEEP_CONFIRMED_MS`. A probe that succeeds and doesn't find a session still drops it at once.
 */
const confirmed = new Map<string, { at: number; routes: Map<string, number> }>();
const KEEP_CONFIRMED_MS = 120_000;
/** `ps` over every process and `lsof` over the candidates can take seconds when the Mac is loaded. */
const PROBE_WAIT_MS = 6_000;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lastConfirmed(codexHome: string, alive: (pid: number) => boolean, now: number): Map<string, number> {
  const known = confirmed.get(codexHome);
  const result = new Map<string, number>();
  if (!known || now - known.at > KEEP_CONFIRMED_MS) return result;
  for (const [thread, pid] of known.routes) if (alive(pid)) result.set(thread, pid);
  return result;
}

/**
 * Each process's unix sockets, from `lsof -U -F pdn`: the socket's own address (`d`), and, when it is connected, its
 * peer's (`n->0x…`). A client and the server it is connected to name the same socket from either end.
 */
export function unixSockets(answer: string): Map<number, { own: Set<string>; peers: Set<string> }> {
  const sockets = new Map<number, { own: Set<string>; peers: Set<string> }>();
  let current: { own: Set<string>; peers: Set<string> } | undefined;
  for (const line of answer.split("\n")) {
    if (/^p\d+$/.test(line)) sockets.set(Number(line.slice(1)), current = { own: new Set(), peers: new Set() });
    else if (current && /^d0x[0-9a-f]+$/i.test(line)) current.own.add(line.slice(1).toLowerCase());
    else if (current && /^n->0x[0-9a-f]+$/i.test(line)) current.peers.add(line.slice(3).toLowerCase());
  }
  return sockets;
}

/**
 * `servers` is each thread an app-server holds, with that server's pid. A TUI attached to the shared daemon need not
 * have the log database open: "notes and research" (`codex yolo resume`, ttys006, in the foreground) had none open on
 * 2026-10-23, its last log row nearly two hours old, while its socket was connected to the daemon holding its thread.
 * So conch called it "hosted by codex app-server … no terminal to type into", and nothing conch sent could reach it.
 * The socket is the better proof: a TUI connected to the very process that holds its thread's lock in this home
 * belongs to this home, and is that thread's window.
 */
export async function probeCodexTerminalSessions(
  codexHome: string,
  probe: Probe = probeCommand,
  uid = process.getuid?.(),
  alive: (pid: number) => boolean = processAlive,
  now: () => number = Date.now,
  servers: ReadonlyMap<string, number> = new Map(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (uid === undefined) return result;
  // The open log DB proves the profile. Reading CODEX_HOME out of ps's full
  // environment would expose credentials; cwd cannot distinguish accounts.
  let logs: string[];
  try { logs = readdirSync(codexHome).filter(name => /^logs_\d+\.sqlite$/.test(name)).map(name => join(codexHome, name)); }
  catch { return result; }
  if (!logs.length) return result;
  const table = await probe(["ps", "-axo", "pid=,uid=,tty=,stat=,args="], [0], PROBE_WAIT_MS);
  if (table === null) return lastConfirmed(codexHome, alive, now());
  const candidates = codexTerminalCandidates(table, uid);
  const pids = [...candidates.values()].flat();
  if (!pids.length) {
    confirmed.set(codexHome, { at: now(), routes: result });
    return result;
  }
  const opened = await probe(["lsof", "-a", "-p", pids.join(","), "-F", "pn", "--", ...logs], [0, 1], PROBE_WAIT_MS);
  if (opened === null) {
    // ps answered, lsof didn't: a candidate still in its terminal's foreground, at the pid the last good probe proved.
    const known = lastConfirmed(codexHome, alive, now());
    for (const [thread, options] of candidates) {
      const pid = known.get(thread);
      if (pid !== undefined && options.includes(pid)) result.set(thread, pid);
    }
    return result;
  }
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
  const unproven = [...candidates].filter(([thread]) => !result.has(thread) && servers.has(thread));
  if (unproven.length) {
    const asked = [...new Set([...unproven.flatMap(([, options]) => options), ...unproven.map(([thread]) => servers.get(thread)!)])];
    const answer = await probe(["lsof", "-a", "-U", "-p", asked.join(","), "-F", "pdn"], [0, 1], PROBE_WAIT_MS);
    if (answer === null) {
      // The same rule as the log database's probe: unknown, so what the last good probe proved stands.
      const known = lastConfirmed(codexHome, alive, now());
      for (const [thread, options] of unproven) {
        const pid = known.get(thread);
        if (pid !== undefined && options.includes(pid)) result.set(thread, pid);
      }
      return result;
    }
    const sockets = unixSockets(answer);
    for (const [thread, options] of unproven) {
      const server = sockets.get(servers.get(thread)!)?.own;
      const pid = options
        .filter(pid => [...sockets.get(pid)?.peers ?? []].some(peer => server?.has(peer)))
        .sort((a, b) => a - b)[0];
      if (pid) result.set(thread, pid);
    }
  }
  confirmed.set(codexHome, { at: now(), routes: result });
  return result;
}

// Rendering polls faster than ps/lsof should run. Coalesce readers and expire
// quickly so closing/backgrounding a terminal doesn't leave a sticky route.
const snapshots = new Map<string, { key: string; expires: number; result: Promise<Map<string, number>> }>();
export function readCodexTerminalSessions(
  codexHome: string,
  servers: ReadonlyMap<string, number> = new Map(),
): Promise<Map<string, number>> {
  const key = [...servers].map(([thread, pid]) => `${thread}:${pid}`).sort().join(",");
  const cached = snapshots.get(codexHome);
  if (cached && cached.key === key && cached.expires > Date.now()) return cached.result;
  if (snapshots.size > 32) snapshots.clear();
  const result = probeCodexTerminalSessions(codexHome, probeCommand, process.getuid?.(), processAlive, Date.now, servers);
  snapshots.set(codexHome, { key, expires: Date.now() + 5_000, result });
  return result;
}
