import { dlopen, FFIType } from "bun:ffi";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The temp folders a deliverable may sit in, named the same way in every process that checks one.
 *
 * Each process used to add its OWN `os.tmpdir()`, which is `$TMPDIR`: the agent's MCP server
 * read the agent's environment and the daemon read its own. When they differed (an agent run
 * with a TMPDIR of its own, a daemon started from a shell that had one), `review_to_front` said
 * "accepted" for a file the daemon then refused and dropped without a word. So the list no longer
 * depends on the environment: `/tmp`, and macOS's per-user temp folder
 * (`/private/var/folders/<xx>/<yy>/T`), which the system names for this user whatever TMPDIR says
 * (`confstr(_CS_DARWIN_USER_TEMP_DIR)`, what `getconf DARWIN_USER_TEMP_DIR` prints). Only where
 * the system can't say (not macOS) does `os.tmpdir()` stand in for it.
 *
 * Both are wiped: /private/tmp at every boot, the per-user folder by macOS's cleanup of files
 * nobody has opened for days. That is why a deliverable in one is copied into conch's own store
 * when it is filed (deliverable-store.ts).
 */

/** `<unistd.h>`: `_CS_DARWIN_USER_TEMP_DIR`. */
const CS_DARWIN_USER_TEMP_DIR = 65537;

let userTemp: string | null | undefined;

/** macOS's per-user temp folder as the system names it, with no trailing slash; null where it can't say. */
export function darwinUserTempDir(): string | null {
  if (userTemp !== undefined) return userTemp;
  userTemp = null;
  if (process.platform !== "darwin") return userTemp;
  try {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      confstr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
    } as const);
    try {
      const buffer = Buffer.alloc(1024);
      // The length it needs, terminator included; 0 when the name is unknown.
      const needed = Number(library.symbols.confstr(CS_DARWIN_USER_TEMP_DIR, buffer, buffer.length));
      if (needed > 1 && needed <= buffer.length) {
        const path = buffer.subarray(0, needed - 1).toString("utf8").replace(/\/+$/, "");
        if (path.startsWith("/")) userTemp = path;
      }
    } finally {
      library.close();
    }
  } catch {
    // No libSystem to ask: tmpdir() stands in (`tempFolders`).
  }
  return userTemp;
}

/**
 * The temp folders, as a person reads them: `/tmp`, then the per-user one. The same list in the
 * MCP server, the hooks and the daemon, whatever each one's `$TMPDIR`.
 *
 * `CONCH_USER_TEMP_DIR` stands in for the per-user folder, and only the test suite sets it
 * (test/preload.ts): every fixture a test makes lives under the system's per-user temp folder, so
 * without it no test could build a folder that is NOT a temp folder. It is conch's own name, which
 * nothing else sets, unlike TMPDIR, which every tool may.
 */
export function tempFolders(): string[] {
  const own = process.env.CONCH_USER_TEMP_DIR?.replace(/\/+$/, "");
  return ["/tmp", own || (darwinUserTempDir() ?? tmpdir().replace(/\/+$/, ""))];
}

/** The same folders by their real paths (`/private/tmp`, `/private/var/folders/…/T`), for comparing real paths. */
export function realTempFolders(): string[] {
  const reals = tempFolders().map((folder) => {
    try {
      return realpathSync(folder);
    } catch {
      return null;
    }
  });
  return reals.filter((folder, index): folder is string => folder !== null && reals.indexOf(folder) === index);
}

/** Whether a real path is inside one of the temp folders (not the folder itself). */
export function inTempFolder(real: string): boolean {
  return realTempFolders().some((folder) => real.startsWith(`${folder}/`));
}

/** How a refusal names them: "the temp folders (/tmp, /var/folders/…/T)". */
export function describeTempFolders(): string {
  return `the temp folders (${tempFolders().join(", ")})`;
}
