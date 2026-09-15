import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fchmodSync, openSync } from "node:fs";

export interface SocketOwnership {
  readonly socketPath: string;
  readonly active: boolean;
  release(): void;
}

let flock: ((fd: number, operation: number) => number) | undefined;

/** Keep the lock file: unlinking it would let two owners lock different inodes. */
export function lockSocketPath(socketPath: string): SocketOwnership | null {
  flock ??= dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock;
  const fd = openSync(socketPath + ".lock", constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    // LOCK_EX | LOCK_NB. The kernel drops ownership even after a hard crash.
    if (flock(fd, 2 | 4) !== 0) {
      closeSync(fd);
      return null;
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return {
    socketPath,
    get active() { return !released; },
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
    },
  };
}
