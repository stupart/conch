/**
 * Kokoro's model in the Hugging Face cache, checked file by file, and only what is broken removed so the next fetch
 * brings back just that.
 *
 * The cache is content-addressed: `hub/models--<org>--<name>/snapshots/<commit>/<path>` are links into `blobs/<etag>`,
 * and a large (LFS) file's etag is the sha256 of its bytes. So every weight and voice file can be proved against its
 * own name, offline, without trusting a record: a download cut short, a disk error or a stray edit shows up as a hash
 * that doesn't match. Small files (config.json) are named by git's hash, which huggingface_hub does not promise, so they
 * are checked for what they must be instead: there, non-empty, and JSON that parses when they are JSON.
 *
 * Nothing outside the one model's folder is read, and nothing that proves good is touched. A `.incomplete` blob is
 * huggingface_hub's own resume point for a download in progress, and is left alone.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Where huggingface_hub keeps models, by its own rules: HF_HUB_CACHE, then HF_HOME/hub, then XDG, then ~/.cache. */
export function hubCacheDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HUGGINGFACE_HUB_CACHE) return env.HUGGINGFACE_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, "hub");
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "huggingface", "hub");
}

export function modelRepoDir(hub: string, model: string): string {
  return join(hub, `models--${model.split("/").join("--")}`);
}

export interface ModelCacheCheck {
  /** A snapshot is there, and every file in it is present and proves good. */
  ok: boolean;
  /**
   * Every large file failed its hash at once: more likely a cache named some other way than all of Kokoro damaged
   * together, so nothing was removed for that alone (unless `force`, after the worker failed on the model itself).
   */
  unverifiable?: boolean;
  /** No snapshot yet: nothing downloaded, or the cache was cleared. */
  absent: boolean;
  files: number;
  /** Snapshot paths that were broken: a link to nothing, or bytes that don't match their hash. */
  broken: string[];
  /** What was removed (links and blobs), so the next fetch brings back only those. */
  removed: string[];
}

function snapshotDir(repo: string): string | null {
  let commit = "";
  try { commit = readFileSync(join(repo, "refs", "main"), "utf8").trim(); } catch {}
  if (commit && existsSync(join(repo, "snapshots", commit))) return join(repo, "snapshots", commit);
  // No ref (a revision pinned by hash): the only snapshot there is.
  try {
    const snapshots = readdirSync(join(repo, "snapshots"));
    if (snapshots.length === 1) return join(repo, "snapshots", snapshots[0]!);
  } catch {}
  return null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

async function sha256Of(path: string, signal?: AbortSignal): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digest("hex");
}

/** A small (non-LFS) file: there, non-empty, and JSON that parses when it says it is JSON. */
function smallFileSound(path: string, name: string): boolean {
  try {
    const size = statSync(path).size;
    if (size <= 0) return false;
    if (name.endsWith(".json")) JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check one model's snapshot. With `repair`, a broken file's link and blob are removed, so huggingface_hub fetches
 * that file, and only that file, the next time the model loads. A link to nothing, or a small file that isn't sound,
 * is certainly broken; a hash mismatch is too — unless every large file mismatched at once (`unverifiable`), which only
 * `force` repairs.
 */
export async function verifyModelCache(options: {
  hub: string;
  model: string;
  repair: boolean;
  force?: boolean;
  signal?: AbortSignal;
}): Promise<ModelCacheCheck> {
  const repo = modelRepoDir(options.hub, options.model);
  const snapshot = existsSync(repo) ? snapshotDir(repo) : null;
  if (!snapshot) return { ok: false, absent: true, files: 0, broken: [], removed: [] };
  const blobs = join(repo, "blobs");
  const found: Array<{ entry: string; relative: string; target: string; why: "missing" | "hash" | "small" }> = [];
  let files = 0;
  let hashed = 0;
  for (const entry of walk(snapshot)) {
    files++;
    const relative = entry.slice(snapshot.length + 1);
    let target = entry;
    let etag = "";
    if (lstatSync(entry).isSymbolicLink()) {
      target = resolve(dirname(entry), readlinkSync(entry));
      etag = basename(target);
    }
    if (!existsSync(target)) {
      found.push({ entry, relative, target, why: "missing" });
    } else if (/^[0-9a-f]{64}$/.test(etag)) {
      hashed++;
      if ((await sha256Of(target, options.signal)) !== etag) found.push({ entry, relative, target, why: "hash" });
    } else if (!smallFileSound(target, relative)) {
      found.push({ entry, relative, target, why: "small" });
    }
  }
  const mismatched = found.filter((item) => item.why === "hash").length;
  const unverifiable = hashed >= 2 && mismatched === hashed && !options.force;
  const broken = unverifiable ? found.filter((item) => item.why !== "hash") : found;
  const removed: string[] = [];
  if (options.repair) {
    for (const item of broken) {
      try { unlinkSync(item.entry); removed.push(item.entry); } catch {}
      // Only a blob inside this model's own folder, and only the one this link named.
      if (item.target !== item.entry && dirname(item.target) === blobs && existsSync(item.target)) {
        try { unlinkSync(item.target); removed.push(item.target); } catch {}
      }
    }
  }
  return {
    ok: files > 0 && broken.length === 0,
    absent: files === 0,
    files,
    broken: broken.map((item) => item.relative),
    removed,
    ...(unverifiable ? { unverifiable: true } : {}),
  };
}

/** Bytes of the model on disk so far, partial downloads included: how far a fetch has got. */
export function modelCacheBytes(hub: string, model: string): number {
  const blobs = join(modelRepoDir(hub, model), "blobs");
  let total = 0;
  try {
    for (const name of readdirSync(blobs)) {
      try { total += statSync(join(blobs, name)).size; } catch {}
    }
  } catch {}
  return total;
}
