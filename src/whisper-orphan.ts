import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { processAlive } from "./daemon-identity.ts";

/**
 * Which whisper-server this daemon spawned, so the NEXT daemon can tell a
 * conch orphan from a stranger on the port.
 *
 * The supervisor adopts whatever answers on the port and, rightly, never kills
 * an adopted process — it might be someone else's. But a daemon that dies hard
 * (SIGKILL, a crash, a force-quit app) leaves its own whisper-server listening,
 * and every daemon after it adopted that one: never stopped on shutdown, never
 * replaced when it wedged, never reloaded after a model change. That is the
 * Aug 10 orphan `daemon-identity.ts` remembers (D3).
 *
 * Same shape as the daemon identity file: a pid is self-diagnosing. Written
 * on every spawn, never cleared — a record whose pid is gone, or is no longer
 * a whisper-server on this port, proves nothing and reaps nothing.
 */
export interface WhisperSpawnRecord {
  pid: number;
  port: number;
  /** The daemon that spawned it. Alive means that daemon still owns it. */
  daemonPid: number;
  startedAt: number;
}

export const WHISPER_RECORD_PATH = join(homedir(), ".cache/conch/whisper-server.json");

export function recordSpawnedWhisper(pid: number, port: number, path = WHISPER_RECORD_PATH): void {
  const record: WhisperSpawnRecord = { pid, port, daemonPid: process.pid, startedAt: Date.now() };
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(record) + "\n");
  } catch {
    // An aid, never a dependency: without it the next daemon merely adopts.
  }
}

export function readWhisperRecord(path = WHISPER_RECORD_PATH): WhisperSpawnRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<WhisperSpawnRecord>;
    if (typeof record.pid !== "number" || typeof record.port !== "number" || typeof record.daemonPid !== "number") {
      return null;
    }
    return { pid: record.pid, port: record.port, daemonPid: record.daemonPid, startedAt: record.startedAt ?? 0 };
  } catch {
    return null;
  }
}

export interface OrphanReaperDeps {
  alive?: (pid: number) => boolean;
  /** The argv of a live pid, or null when it is gone. */
  command?: (pid: number) => string | null;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Whether this argv is a whisper-server bound to exactly this port. */
export function isWhisperServerOn(command: string, port: number): boolean {
  return /(^|\/)whisper-server(\s|$)/.test(command) && new RegExp(`(^|\\s)--port ${port}(\\s|$)`).test(command);
}

function psCommand(pid: number): string | null {
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  const command = ps.stdout.toString().trim();
  return ps.exitCode === 0 && command ? command : null;
}

/**
 * Kill the whisper-server a DEAD conch daemon spawned on this port — and only
 * that. Resolves to the pid killed, or null when nothing was provably ours:
 * no record, another port, its daemon still alive, or a pid that is gone or
 * reused by something that is not a whisper-server on this port. A stranger
 * on the port is never touched; the supervisor adopts it as before.
 */
export async function reapOrphanedWhisper(
  port: number,
  path = WHISPER_RECORD_PATH,
  deps: OrphanReaperDeps = {},
): Promise<number | null> {
  const record = readWhisperRecord(path);
  if (!record || record.port !== port) return null;
  const alive = deps.alive ?? processAlive;
  if (alive(record.daemonPid)) return null;
  const command = (deps.command ?? psCommand)(record.pid);
  if (!command || !isWhisperServerOn(command, port)) return null;
  (deps.kill ?? ((pid) => process.kill(pid, "SIGKILL")))(record.pid);
  // Wait for the port to be released, or the supervisor's first presence
  // probe would adopt the corpse and sit in fallback until its next canary.
  const sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
  for (let waited = 0; waited < 2_000 && alive(record.pid); waited += 50) await sleep(50);
  return record.pid;
}
