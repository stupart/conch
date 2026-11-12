import { dlopen, FFIType } from "bun:ffi";
import { basename } from "node:path";
import type { SessionInfo } from "./sessions.ts";

/** Kernel birth time, not the time conch happened to discover a PID. */
export interface ProcessIdentity {
  pid: number;
  birth: string;
  birthTimeMs: number;
  executable: string;
  ttyDevice: number | null;
}
export type ProcessIdentityProbe = (pid: number) => ProcessIdentity | null;

interface ProcessReader {
  info(pid: number, buffer: Buffer): number;
  path(pid: number, buffer: Buffer): number;
  /** The file behind the process's first mapped region: its executable, even once deleted. */
  region?(pid: number, buffer: Buffer): number;
}
let reader: ProcessReader | null | undefined;
function nativeReader(): ProcessReader | null {
  if (reader !== undefined) return reader;
  if (process.platform !== "darwin") return (reader = null);
  try {
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      proc_regionfilename: { args: [FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    } as const);
    reader = {
      info: (pid, buffer) => library.symbols.proc_pidinfo(pid, 3, 0, buffer, buffer.length),
      path: (pid, buffer) => library.symbols.proc_pidpath(pid, buffer, buffer.length),
      region: (pid, buffer) => library.symbols.proc_regionfilename(pid, 0n, buffer, buffer.length),
    };
  } catch { reader = null; }
  return reader;
}

/** proc_bsdinfo's `pbi_comm`: the executable's file name, cut at MAXCOMLEN (16). */
function processName(bsd: Buffer): string {
  const comm = bsd.subarray(48, 64);
  const end = comm.indexOf(0);
  return comm.subarray(0, end < 0 ? comm.length : end).toString();
}

/** macOS SDK sys/proc_info.h: PROC_PIDTBSDINFO, 136-byte proc_bsdinfo. */
export function decodeProcessIdentity(pid: number, bsd: Buffer, executable: string): ProcessIdentity | null {
  if (bsd.length !== 136 || bsd.readUInt32LE(12) !== pid || !executable.startsWith("/")) return null;
  const seconds = bsd.readBigUInt64LE(120);
  const micros = bsd.readBigUInt64LE(128);
  if (seconds === 0n || micros >= 1_000_000n) return null;
  const tty = bsd.readUInt32LE(108);
  return {
    pid, birth: `${seconds}.${micros.toString().padStart(6, "0")}`,
    birthTimeMs: Number(seconds) * 1000 + Number(micros) / 1000,
    executable, ttyDevice: tty === 0xffffffff ? null : tty,
  };
}

/** No argv, environment, signals, or second-resolution `ps lstart` fallback. */
export function readProcessIdentity(pid: number, readerOverride?: ProcessReader): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const api = readerOverride ?? nativeReader();
    if (!api) return null;
    const before = Buffer.alloc(136), after = Buffer.alloc(136), path = Buffer.alloc(4096);
    if (api.info(pid, before) !== before.length) return null;
    // A binary deleted while it runs has no path: `brew upgrade` renames the
    // old version's directory to `<version>.upgrading`, then removes it, and
    // proc_pidpath returns 0 from then on. Measured 2026-09-23: claude pid
    // 43544 (2.1.266) and both live codex sessions, which conch then could
    // neither close nor read a version for. The kernel still names the file
    // the first mapped region came from (what `lsof -d txt` shows); it is
    // taken only when its file name is the process's own name.
    let fromRegion = false;
    if (api.path(pid, path) <= 0) {
      if (!api.region || api.region(pid, path) <= 0) return null;
      fromRegion = true;
    }
    if (api.info(pid, after) !== after.length) return null;
    const executable = path.subarray(0, path.indexOf(0) < 0 ? path.length : path.indexOf(0)).toString();
    if (fromRegion && basename(executable).slice(0, 16) !== processName(before)) return null;
    const first = decodeProcessIdentity(pid, before, executable);
    const last = decodeProcessIdentity(pid, after, executable);
    return sameProcessIdentity(first, last) ? last : null;
  } catch { return null; }
}

export function validProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ProcessIdentity>;
  return Number.isSafeInteger(v.pid) && (v.pid ?? 0) > 0
    && typeof v.birth === "string" && /^\d+\.\d{6}$/.test(v.birth)
    && typeof v.birthTimeMs === "number" && Number.isFinite(v.birthTimeMs)
    && typeof v.executable === "string" && v.executable.startsWith("/")
    && (v.ttyDevice === null || (Number.isSafeInteger(v.ttyDevice) && (v.ttyDevice ?? -1) >= 0));
}

/**
 * The same file before and after `brew upgrade` renamed its version directory
 * (`Caskroom/codex/0.155.1/…` → `0.155.1.upgrading/…`). Only that rename is
 * forgiven: a process bound before an upgrade is still the same process after
 * it, and closing it is exactly what installs the update.
 */
function executableFile(path: string): string {
  return path.replace(/(\/Caskroom\/[^/]+\/[^/]+)\.upgrading\//, "$1/");
}

export function sameProcessIdentity(a: ProcessIdentity | null | undefined, b: ProcessIdentity | null | undefined): boolean {
  return Boolean(a && b && a.pid === b.pid && a.birth === b.birth
    && executableFile(a.executable) === executableFile(b.executable) && a.ttyDevice === b.ttyDevice);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Wed Sep 23 04:39:09 2026`, the UTC `ps -o lstart=` Claude Code records as an entry's `procStart`, as epoch seconds. */
export function lstartSeconds(lstart: string): number | null {
  const match = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000;
}

/** As Claude Code decides it: only "no such process" is dead. EPERM is someone's live process. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Is the process a registry entry names still running: its pid alive, and still the process that started at the entry's
 * `procStart`, when the entry says when and the kernel can tell. Only positive evidence counts as gone.
 *
 * A pid comes round again, and after a restart soonest of all: the Mac hands the low numbers out again, and an entry
 * the last boot left names whatever holds its number now. On 2026-11-06 two of them did: one session's (972, now macOS's
 * ImageIOXPCService) and a seashell window's (996, now the `login` of a Terminal tab). Asked only "is 972 alive?",
 * conch counted both sessions as running, so it did not bring either back after the restart, typed a message for the first
 * at a process with no terminal, and its Restart was refused, the close finding someone else's process.
 */
export function registryProcessAlive(
  pid: unknown,
  procStart: unknown,
  probes: { alive?(pid: number): boolean; identity?: ProcessIdentityProbe } = {},
): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!(probes.alive ?? pidAlive)(pid)) return false;
  const expected = typeof procStart === "string" ? lstartSeconds(procStart) : null;
  if (expected === null) return true;
  const now = (probes.identity ?? readProcessIdentity)(pid);
  if (!now) return true;
  return Math.abs(Math.floor(now.birthTimeMs / 1000) - expected) <= 1;
}

export function processMatchesProvider(identity: ProcessIdentity, backend: SessionInfo["backend"]): boolean {
  return new RegExp(`(^|/)${backend ?? "claude"}(?:/|$|-)`).test(identity.executable);
}

/** Daemon-only enrichment; ordinary registry reads and their tests never probe processes. */
export function bindSessionProcess(
  session: SessionInfo,
  previous: SessionInfo | undefined,
  probe: ProcessIdentityProbe,
): SessionInfo {
  if (!session.pid || session.jobId) return session;
  // Never bless PID reuse just because the same stale registry row was polled again.
  if (previous?.processIdentity && previous.sessionId === session.sessionId && previous.pid === session.pid
    && previous.backend === session.backend && previous.startedAt === session.startedAt) {
    return { ...session, processIdentity: previous.processIdentity };
  }
  const identity = probe(session.pid);
  const sourceTime = session.startedAt ?? session.statusUpdatedAt;
  if (!identity || identity.ttyDevice === null || !processMatchesProvider(identity, session.backend)
    || sourceTime === undefined || !Number.isFinite(sourceTime) || sourceTime < identity.birthTimeMs) return session;
  return { ...session, processIdentity: identity };
}
