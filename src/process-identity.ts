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
