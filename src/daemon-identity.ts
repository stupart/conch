import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONCH_VERSION } from "./version.ts";

/**
 * Who the running daemon is, so the app can stop guessing.
 *
 * The Mac app treats a socket that answers as proof the daemon belongs to
 * someone else, permanently. That single assumption produces three failures
 * Tyler hit in one evening: quitting the app left a daemon running, killing a
 * daemon left the app connected to nothing with the start toggle HIDDEN, and a
 * deploy silently adopted the OLD daemon so new app code talked to old daemon
 * code — twice reporting work as shipped when it was not.
 *
 * The missing fact is identity. A daemon that says its pid, its version, and
 * who started it turns three unanswerable questions into three lookups: is it
 * alive, is it mine, is it current?
 *
 * Deliberately a plain file rather than a socket handshake. It has to be
 * readable when the socket is exactly what is in doubt, and a stale file is
 * self-diagnosing: the pid either exists or it does not.
 */
export interface DaemonIdentity {
  pid: number;
  version: string;
  /** Who launched it, so the app can tell its own child from a stranger. */
  startedBy: "app" | "terminal" | "launchd";
  startedAt: number;
}

export const IDENTITY_PATH = join(homedir(), ".cache/conch/daemon.json");

/**
 * `CONCH_STARTED_BY` is set by whoever spawns the daemon. Absent means a person
 * ran `conch daemon` in a terminal — the honest default, because it is the case
 * where conch must NOT assume ownership.
 */
export function startedByFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonIdentity["startedBy"] {
  const declared = env.CONCH_STARTED_BY;
  return declared === "app" || declared === "launchd" ? declared : "terminal";
}

export function writeIdentity(
  path = IDENTITY_PATH,
  identity: Partial<DaemonIdentity> = {},
): DaemonIdentity {
  const record: DaemonIdentity = {
    pid: identity.pid ?? process.pid,
    version: identity.version ?? CONCH_VERSION,
    startedBy: identity.startedBy ?? startedByFromEnv(),
    startedAt: identity.startedAt ?? Date.now(),
  };
  try {
    mkdirSync(join(homedir(), ".cache/conch"), { recursive: true });
    writeFileSync(path, JSON.stringify(record) + "\n");
  } catch {
    // Identity is an aid, never a dependency. A daemon that cannot write it
    // still runs; the app simply falls back to today's behaviour.
  }
  return record;
}

export function clearIdentity(path = IDENTITY_PATH): void {
  try {
    unlinkSync(path);
  } catch {}
}

/**
 * Read the identity, treating a record whose process is gone as no record.
 *
 * This is the whole point: an orphaned file must never be mistaken for a live
 * daemon. A whisper-server orphaned on Aug 10 was adopted by every daemon since
 * and stopped by none of them, for exactly this lack of a liveness check.
 */
export function readIdentity(
  path = IDENTITY_PATH,
  alive: (pid: number) => boolean = processAlive,
): DaemonIdentity | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<DaemonIdentity>;
    if (typeof record.pid !== "number" || !alive(record.pid)) return null;
    return {
      pid: record.pid,
      version: typeof record.version === "string" ? record.version : "unknown",
      startedBy: record.startedBy === "app" || record.startedBy === "launchd"
        ? record.startedBy
        : "terminal",
      startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
    };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
