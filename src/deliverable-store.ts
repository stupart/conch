import { readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, chmod, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { conchStoreRoot } from "./conch-store.ts";
import { conchHome } from "./home.ts";
import { inTempFolder, realTempFolders } from "./temp-folders.ts";

/**
 * conch's own copies of deliverables that sat in a temp folder.
 *
 * A deliverable used to be filed by its path alone, and the apps read it from there on every
 * look. reviews.json outlives a reboot; `/tmp` does not (macOS recreates it at every boot), and
 * the per-user temp folder is cleaned of files nobody has opened for days. So a screenshot an
 * agent published from /tmp was "Couldn't find hero.png" on the Mac and a 404 "gone" on the phone
 * the morning after, still listed as ready for review (feedback, 2026-10-03).
 *
 * Now a deliverable in a temp folder is copied here when the daemon files it, and filed against
 * the copy:
 *
 *   <store>/<artifact>/v<version>-<random>/<name>
 *
 * `<store>` is `deliverables` in conch's own store (`~/Library/Application Support/conch`,
 * conch-store.ts), which the publish rule lets through as it does a temp folder, so the phone's
 * `/file`, a document's snapshot and the Mac app read a copy as they read any filed file. Not
 * `~/.config/conch` beside reviews.json: that is hidden, which the rule refuses. 0700 from
 * `deliverables` down, each file 0600. A page or a markdown document brings the folder it is in
 * (its pictures and styles), as the phone reads it; a folder deliverable is the folder. Its marks'
 * images in a temp folder come too. Anything in the session's own folders is never copied: that
 * is live work, and the link follows it as it changes.
 *
 * Nothing here is kept for its own sake. A copy lives exactly as long as a held deliverable names
 * it: removed, pushed out by the six-deliverable cap, or its session forgotten, and the next save
 * of the ledger deletes it (`SessionLedger`); one nothing names at daemon start (a crash between
 * the copy and the save) goes then (`sweepStore`).
 */

/** The most one publication copies: past it, it is filed where it is and the agent is told why. */
export const STORE_MAX_BYTES = 64 * 1024 * 1024;
export const STORE_MAX_FILES = 500;

/** `.html`, `.htm`, `.md`: a deliverable read with the folder it is in (phone-bridge.ts `READS_ITS_FOLDER`). */
const READS_ITS_FOLDER = /\.(html?|md|markdown)$/i;
/** Never copied out of a folder, whatever folder: what `checkLocalFile` refuses to send. */
const SECRET_FILE = /\.(pem|key|p8|p12|pfx|keychain|keychain-db)$/i;

/**
 * Where the copies live: `deliverables` in conch's own store, under the home read at call time
 * (`conchHome`, so the suite's and an e2e's sandboxed home win).
 */
export function deliverableStoreDir(home: string = conchHome()): string {
  return join(conchStoreRoot(home), "deliverables");
}

/** What filing a publication did with its files in temp folders. */
export interface StoredDeliverable {
  /** The version folder holding this filing's copies; absent when nothing was copied. */
  dir?: string;
  /** Each path given (the link, a mark's image) and the copy filed in its place. */
  copies: Map<string, string>;
  /** Why a deliverable in a temp folder was filed where it is instead: over the cap, or the copy failed. */
  notCopied?: string;
}

interface CopyPlan {
  /** What is copied, as a file or a folder, and where it goes inside the version folder. */
  units: Array<{ source: string; folder: boolean; name: string }>;
  /** A path given, the unit that carries it and where it lands inside that unit. */
  places: Array<{ given: string; unit: number; inside: string }>;
}

async function realOf(path: string): Promise<string | null> {
  return realpath(path).catch(() => null);
}

/** Whether `real` sits under one of `roots` (by their real paths), or is one. */
async function underAny(real: string, roots: readonly string[]): Promise<boolean> {
  const reals = await Promise.all(roots.map(realOf));
  return reals.some((root) => root !== null && (real === root || real.startsWith(root.endsWith("/") ? root : `${root}/`)));
}

/**
 * Every regular file a folder copy takes, with its size: no symlink (followed, it could lead out),
 * nothing hidden, no key or certificate. Stops counting once over the cap.
 */
async function folderFiles(folder: string): Promise<{ files: Array<{ path: string; size: number }>; over: boolean }> {
  const files: Array<{ path: string; size: number }> = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(path))) return false;
      } else if (entry.isFile() && !SECRET_FILE.test(entry.name)) {
        const size = (await stat(path).catch(() => null))?.size ?? 0;
        files.push({ path, size });
        bytes += size;
        if (bytes > STORE_MAX_BYTES || files.length > STORE_MAX_FILES) return false;
      }
    }
    return true;
  };
  const complete = await walk(folder);
  return { files, over: !complete };
}

/** A name not yet used in `dir`: `name`, else `2-name`, `3-name`… */
function freeName(taken: Set<string>, name: string): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${n}-${name}`;
  taken.add(candidate);
  return candidate;
}

/**
 * What a publication's files in temp folders need copying, given the link as the daemon vetted it
 * (absolute, or a URL) and its marks' images. A path under one of the session's folders is never
 * copied, even when that folder is itself in a temp folder: it is the session's live work.
 */
async function planCopies(input: {
  link?: string;
  folder: boolean;
  markImages: readonly string[];
  roots: readonly string[];
}): Promise<CopyPlan> {
  const plan: CopyPlan = { units: [], places: [] };
  const names = new Set<string>();
  const temps = realTempFolders();
  const copyable = async (path: string): Promise<string | null> => {
    if (!path.startsWith("/")) return null;
    const real = await realOf(path);
    return real && inTempFolder(real) && !(await underAny(real, input.roots)) ? real : null;
  };
  if (input.link) {
    const real = await copyable(input.link);
    if (real) {
      const parent = dirname(real);
      if (input.folder) {
        plan.units.push({ source: real, folder: true, name: freeName(names, basename(real)) });
        plan.places.push({ given: input.link, unit: 0, inside: "" });
      } else if (READS_ITS_FOLDER.test(real) && !temps.includes(parent)) {
        // A page brings its folder, as the phone reads it. One directly in a temp folder brings
        // nothing beside it: that folder is everyone's, and the phone serves nothing from it either.
        plan.units.push({ source: parent, folder: true, name: freeName(names, basename(parent)) });
        plan.places.push({ given: input.link, unit: 0, inside: relative(parent, real) });
      } else {
        plan.units.push({ source: real, folder: false, name: freeName(names, basename(real)) });
        plan.places.push({ given: input.link, unit: 0, inside: "" });
      }
    }
  }
  for (const image of new Set(input.markImages)) {
    const real = await copyable(image);
    if (!real) continue;
    // Already inside what the link brings (the same file, or a picture in a page's folder).
    const carried = plan.units.findIndex((unit) => unit.source === real || (unit.folder && real.startsWith(`${unit.source}/`)));
    if (carried >= 0) {
      const unit = plan.units[carried]!;
      plan.places.push({ given: image, unit: carried, inside: unit.source === real ? "" : relative(unit.source, real) });
      continue;
    }
    plan.units.push({ source: real, folder: false, name: freeName(names, basename(real)) });
    plan.places.push({ given: image, unit: plan.units.length - 1, inside: "" });
  }
  return plan;
}

/** Bytes and files a plan copies, or why it can't: over the cap. */
async function measure(plan: CopyPlan): Promise<{ files: Array<{ unit: number; path: string }>; over?: string }> {
  const files: Array<{ unit: number; path: string }> = [];
  let bytes = 0;
  for (const [index, unit] of plan.units.entries()) {
    if (unit.folder) {
      const listed = await folderFiles(unit.source);
      if (listed.over) return { files, over: `${unit.source} holds more than ${STORE_MAX_FILES} files or ${STORE_MAX_BYTES / (1024 * 1024)} MB` };
      for (const file of listed.files) {
        files.push({ unit: index, path: file.path });
        bytes += file.size;
      }
    } else {
      files.push({ unit: index, path: unit.source });
      bytes += (await stat(unit.source).catch(() => null))?.size ?? 0;
    }
    if (bytes > STORE_MAX_BYTES || files.length > STORE_MAX_FILES) {
      return { files, over: `it comes to more than ${STORE_MAX_BYTES / (1024 * 1024)} MB or ${STORE_MAX_FILES} files` };
    }
  }
  return { files };
}

/**
 * Copy a publication's files in temp folders into the store, under its artifact and version
 * (`<store>/<artifact>/v<version>-<random>/`), before it is filed. Returns what to file in place
 * of each path given; nothing when nothing is in a temp folder. Over the cap, or when the copy
 * fails, nothing is copied and `notCopied` says why: it is filed where it is, as before.
 */
export async function storeTempDeliverable(input: {
  link?: string;
  folder: boolean;
  markImages: readonly string[];
  roots: readonly string[];
  artifact: string;
  version: number;
  store?: string;
}): Promise<StoredDeliverable> {
  const plan = await planCopies(input);
  if (!plan.units.length) return { copies: new Map() };
  const measured = await measure(plan);
  if (measured.over) {
    return {
      copies: new Map(),
      notCopied: `it was filed where it is, not copied into conch: ${measured.over}, over what conch copies;`
        + " a temp folder can be cleaned (a reboot empties /tmp), and it goes with it",
    };
  }
  const store = input.store ?? deliverableStoreDir();
  const artifactDir = join(store, input.artifact.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "artifact");
  let dir: string | undefined;
  try {
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await chmod(store, 0o700);
    await chmod(artifactDir, 0o700);
    dir = await mkdtemp(join(artifactDir, `v${input.version}-`));
    await chmod(dir, 0o700);
    for (const file of measured.files) {
      const unit = plan.units[file.unit]!;
      const target = unit.folder ? join(dir, unit.name, relative(unit.source, file.path)) : join(dir, unit.name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(file.path, target);
      // A copy to look at, never to run: owner-read/write only, whatever the original was.
      await chmod(target, 0o600);
    }
    // An empty folder deliverable is still a folder.
    for (const unit of plan.units) if (unit.folder) await mkdir(join(dir, unit.name), { recursive: true, mode: 0o700 });
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      copies: new Map(),
      notCopied: `it was filed where it is, not copied into conch: the copy failed (${error instanceof Error ? error.message : String(error)});`
        + " a temp folder can be cleaned (a reboot empties /tmp), and it goes with it",
    };
  }
  const copies = new Map<string, string>();
  for (const place of plan.places) {
    const unit = plan.units[place.unit]!;
    copies.set(place.given, place.inside ? join(dir, unit.name, place.inside) : join(dir, unit.name));
  }
  return { dir, copies };
}

/**
 * The version folder a filed path belongs to, `<store>/<artifact>/<version>`, when it is in the
 * store; null for anything else. By the path as filed, which the store built.
 */
export function storeEntry(path: string, store: string = deliverableStoreDir()): string | null {
  if (!path.startsWith(`${store}/`)) return null;
  const parts = path.slice(store.length + 1).split("/");
  if (parts.length < 3 || parts.slice(0, 2).some((part) => !part || part === "." || part === "..")) return null;
  return join(store, parts[0]!, parts[1]!);
}

/**
 * Delete one version folder of the store, and its artifact's folder once that is empty. Only ever
 * a folder `storeEntry` names: anything else a record names is never touched.
 */
export function discardStoredCopy(dir: string, store: string = deliverableStoreDir()): void {
  if (storeEntry(join(dir, "x"), store) !== dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Gone already, or unreadable: nothing of ours to clean.
  }
  removeIfEmpty(dirname(dir));
}

/** An artifact's folder in the store, once no version is left in it. */
function removeIfEmpty(artifactDir: string): void {
  try {
    if (readdirSync(artifactDir).length === 0) rmSync(artifactDir, { recursive: true, force: true });
  } catch {
    // Gone already.
  }
}

/** Delete every version folder in the store that no held deliverable names (`held`, from `storeEntry`). */
export function sweepStore(held: ReadonlySet<string>, store: string = deliverableStoreDir()): string[] {
  const removed: string[] = [];
  let artifacts: string[];
  try {
    artifacts = readdirSync(store);
  } catch {
    return removed;
  }
  for (const artifact of artifacts) {
    const artifactDir = join(store, artifact);
    if (!statSync(artifactDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const version of readdirSync(artifactDir)) {
      const dir = join(artifactDir, version);
      if (held.has(dir)) continue;
      discardStoredCopy(dir, store);
      removed.push(dir);
    }
    removeIfEmpty(artifactDir);
  }
  return removed;
}
