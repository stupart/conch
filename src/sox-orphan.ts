import { readProcessIdentity, sameProcessIdentity, validProcessIdentity, type ProcessIdentity, type ProcessIdentityProbe } from "./process-identity.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { conchHome } from "./home.ts";
import { join } from "node:path";
import { processAlive } from "./daemon-identity.ts";
import type { OrphanReaperDeps } from "./whisper-orphan.ts";

/**
 * Which sox recorders this daemon spawned, so the NEXT daemon can reap the
 * ones a hard death left behind.
 *
 * Shutdown SIGKILLs every recorder, but a daemon that dies by SIGKILL itself
 * (a force-quit app, a crash) never runs shutdown: its sox is reparented, the
 * mic stays open, and the `silence` effect waits for speech that never comes
 * — the eight-minute orphan `listen.ts` remembers. Same shape as the
 * whisper-server record (D3): the pid of the daemon that owns them, and only
 * a dead owner's pids are candidates.
 */
export interface SoxSpawnRecord {
  daemonPid: number;
  pids: number[];
  identities?: Record<string, ProcessIdentity>;
}

export const SOX_RECORD_PATH = join(conchHome(), ".cache/conch/sox-recorders.json");

export function readSoxRecord(path = SOX_RECORD_PATH): SoxSpawnRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<SoxSpawnRecord>;
    if (typeof record.daemonPid !== "number" || !Array.isArray(record.pids)) return null;
    const identities = Object.fromEntries(Object.entries(record.identities ?? {}).filter(([pid, identity]) =>
      validProcessIdentity(identity) && identity.pid === Number(pid)));
    return { daemonPid: record.daemonPid, pids: record.pids.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0),
      ...(Object.keys(identities).length ? { identities } : {}) };
  } catch {
    return null;
  }
}

function writeSoxRecord(pids: number[], path: string, identities: Record<string, ProcessIdentity> = {}): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ daemonPid: process.pid, pids, identities: Object.fromEntries(
      pids.filter((pid) => identities[pid]).map((pid) => [pid, identities[pid]!])) } satisfies SoxSpawnRecord) + "\n");
  } catch {
    // An aid, never a dependency: without it the orphan merely lives on as before.
  }
}

/** Another daemon's record is replaced, not merged: its pids are not ours to keep. */
export function recordSpawnedSox(pid: number, path = SOX_RECORD_PATH, probe: ProcessIdentityProbe = readProcessIdentity): void {
  const current = readSoxRecord(path);
  const pids = current?.daemonPid === process.pid ? current.pids.filter((p) => p !== pid) : [];
  const identities = current?.daemonPid === process.pid ? { ...current.identities } : {};
  delete identities[pid];
  const identity = probe(pid);
  if (identity) identities[pid] = identity;
  writeSoxRecord([...pids, pid], path, identities);
}

export function forgetSox(pid: number, path = SOX_RECORD_PATH): void {
  const current = readSoxRecord(path);
  if (current?.daemonPid !== process.pid) return;
  writeSoxRecord(current.pids.filter((p) => p !== pid), path, current.identities);
}

/**
 * Whether this argv is a conch capture: `soxCaptureArgs` in listen.ts, as
 * `ps -o command=` prints it. A pid that was reused by anything else — even
 * another sox — is not ours to kill.
 */
export function isConchSox(command: string): boolean {
  return /(^|\/)sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t raw \/tmp\/conch-\S+ (gain \S+ )?silence -l 1 0\.15 /.test(command);
}

function psCommand(pid: number): string | null {
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  const command = ps.stdout.toString().trim();
  return ps.exitCode === 0 && command ? command : null;
}

/**
 * Kill the recorders a DEAD conch daemon recorded as its own — and only those.
 * Resolves to the pids killed: none when there is no record, the recording
 * daemon is still alive (they are its to stop), or a pid is gone or no longer
 * a conch sox.
 */
export async function reapOrphanedSox(
  path = SOX_RECORD_PATH,
  deps: OrphanReaperDeps = {},
): Promise<number[]> {
  const record = readSoxRecord(path);
  if (!record) return [];
  const alive = deps.alive ?? processAlive;
  if (alive(record.daemonPid)) return [];
  const command = deps.command ?? psCommand;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  const killed: number[] = [];
  for (const pid of record.pids) {
    const identity = record.identities?.[pid];
    if (!identity) continue;
    const argv = command(pid);
    if (!argv || !isConchSox(argv)) continue;
    if (!sameProcessIdentity(identity, (deps.identity ?? readProcessIdentity)(pid))) continue;
    kill(pid);
    killed.push(pid);
  }
  return killed;
}
