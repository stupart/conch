import { lstatSync, opendirSync, type Dir } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { adapterFor } from "./agent-adapter.ts";
import type { RecordProvider } from "./records-types.ts";

export interface RecordsRoot { provider: RecordProvider; path: string }
export interface RecordsCandidate {
  provider: RecordProvider;
  nativeId: string;
  parentNativeId?: string;
  path: string;
  device: string;
  inode: string;
}

/** These are provider transcript roots, not a general filesystem search. */
export function recordsRoots(options: { claudeHome?: string; codexHome?: string }): RecordsRoot[] {
  const roots: RecordsRoot[] = [];
  for (const [provider, home] of [["claude", options.claudeHome], ["codex", options.codexHome]] as const) {
    if (!home) continue;
    const format = adapterFor(provider).transcriptFormat;
    for (const directory of format === "codex" ? ["sessions", "archived_sessions"] : ["projects"]) {
      roots.push({ provider, path: resolve(home, directory) });
    }
  }
  return roots;
}

export function withinRecordsRoot(root: string, path: string): boolean {
  const part = relative(root, resolve(path));
  return !!part && part !== ".." && !part.startsWith("../") && !part.startsWith("/");
}

export function recordsCandidate(root: RecordsRoot, path: string): RecordsCandidate | undefined {
  if (!withinRecordsRoot(root.path, path)) return;
  const name = basename(path).replace(/\.jsonl(?:\.\d+)?$/, "");
  if (name === basename(path)) return;
  let nativeId = name;
  let parentNativeId: string | undefined;
  if (root.provider === "codex") {
    const match = name.match(/^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (!match) return;
    nativeId = match[1]!;
  } else if (name.startsWith("agent-") && basename(dirname(path)) === "subagents") {
    parentNativeId = basename(dirname(dirname(path)));
    nativeId = `${parentNativeId}/${name}`;
  } else if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name)) {
    return;
  }
  // Check every component so even an explicitly supplied live hint cannot follow a symlink.
  let component = root.path;
  const rootStat = lstatSync(component);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  const parts = relative(root.path, resolve(path)).split("/");
  for (let index = 0; index < parts.length; index++) {
    component = join(component, parts[index]!);
    const stat = lstatSync(component);
    if (stat.isSymbolicLink()) return;
    if (index < parts.length - 1) { if (!stat.isDirectory()) return; }
    else if (stat.isFile()) return {
      provider: root.provider, nativeId, ...(parentNativeId ? { parentNativeId } : {}),
      path: resolve(path), device: String(stat.dev), inode: String(stat.ino),
    };
  }
}

/** One bounded directory slice per call; no recursive list is materialized. */
export class RecordsDiscovery {
  private remaining: RecordsRoot[];
  private stack: { root: RecordsRoot; path: string; directory: Dir }[] = [];
  done = false;
  constructor(readonly roots: RecordsRoot[]) { this.remaining = [...roots]; }

  next(limit = 32): { candidate?: RecordsCandidate; entries: number; errors: number } {
    let entries = 0;
    let errors = 0;
    while (entries < limit) {
      if (!this.stack.length) {
        const root = this.remaining.shift();
        if (!root) { this.done = true; break; }
        entries++;
        try {
          if (!lstatSync(root.path).isDirectory() || lstatSync(root.path).isSymbolicLink()) continue;
          this.stack.push({ root, path: root.path, directory: opendirSync(root.path) });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors++; }
        continue;
      }
      const current = this.stack.at(-1)!;
      entries++;
      try {
        const entry = current.directory.readSync();
        if (!entry) { current.directory.closeSync(); this.stack.pop(); continue; }
        if (entry.isSymbolicLink()) continue;
        const path = join(current.path, entry.name);
        if (entry.isDirectory() && this.stack.length < 8) {
          const stat = lstatSync(path);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          this.stack.push({ root: current.root, path, directory: opendirSync(path) });
        } else if (entry.isFile()) {
          const candidate = recordsCandidate(current.root, path);
          if (candidate) return { candidate, entries, errors };
        }
      } catch {
        errors++;
        try { current.directory.closeSync(); } catch {}
        this.stack.pop();
      }
    }
    return { entries, errors };
  }

  reset(): void { this.close(); this.remaining = [...this.roots]; this.done = false; }
  close(): void {
    for (const entry of this.stack.splice(0)) { try { entry.directory.closeSync(); } catch {} }
    this.remaining = [];
    this.done = true;
  }
}
