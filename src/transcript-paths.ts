import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a Claude session's transcript is, found once and kept.
 *
 * Claude Code writes `<claudeDir>/projects/<folder>/<id>.jsonl` and the registry never says which folder, so finding
 * one meant listing every project folder and asking each one: on this Mac 218 folders on 2026-11-11 (75 on
 * 2026-11-02), and the daemon asks for every session several times a render. `conch evals` counted 27,848 file calls
 * a minute from this lookup alone in its scripted load (12 sessions, 12 folders, 4 renders a second).
 *
 * A transcript does not move while its session lives, so the answer is kept and checked with one `existsSync` each
 * time it is handed out: a kept path that has gone is a miss, and the folders are searched again. A miss is never
 * kept: a session's transcript appears with its first message, and the next render has to find it. A session whose
 * registry entry changes folder or process (`noteRegistryEntry`) is searched again too, so a conversation resumed
 * somewhere else is found where the search would find it.
 */
const KEPT_MAX = 1024;
const kept = new Map<string, string>();
const registered = new Map<string, string>();

const keyOf = (claudeDir: string, sessionId: string) => `${claudeDir}\u0000${sessionId}`;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > KEPT_MAX) map.delete(map.keys().next().value!);
}

function search(claudeDir: string, sessionId: string): string | undefined {
  const projects = join(claudeDir, "projects");
  try {
    // `existsSync`, not a `statSync` that throws: every project but one misses. Each miss built an exception.
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return undefined;
}

export function claudeTranscriptPath(claudeDir: string, sessionId: string): string | undefined {
  const key = keyOf(claudeDir, sessionId);
  const known = kept.get(key);
  if (known !== undefined) {
    if (existsSync(known)) return known;
    kept.delete(key);
  }
  const path = search(claudeDir, sessionId);
  if (path) remember(kept, key, path);
  return path;
}

/**
 * The registry's entries, as `registrySnapshot` reads them: a session whose entries moved to another folder or process
 * since the last read has its kept transcript forgotten. All of an id's entries at once, since two windows can share
 * one id (window-key.ts) and each would otherwise undo the other's on every read.
 */
export function noteRegistryEntries(claudeDir: string, entries: Iterable<{ sessionId?: unknown; cwd?: unknown; pid?: unknown }>): void {
  const byId = new Map<string, string[]>();
  for (const entry of entries) {
    if (typeof entry.sessionId !== "string" || !entry.sessionId) continue;
    const signature = `${typeof entry.cwd === "string" ? entry.cwd : ""}\u0000${typeof entry.pid === "number" ? entry.pid : ""}`;
    byId.set(entry.sessionId, [...(byId.get(entry.sessionId) ?? []), signature]);
  }
  for (const [sessionId, signatures] of byId) {
    const key = keyOf(claudeDir, sessionId);
    const signature = signatures.sort().join("\u0001");
    const previous = registered.get(key);
    if (previous === signature) continue;
    if (previous !== undefined) kept.delete(key);
    remember(registered, key, signature);
  }
}

/** For tests: what is kept. */
export function forgetClaudeTranscriptPaths(): void {
  kept.clear();
  registered.clear();
}
