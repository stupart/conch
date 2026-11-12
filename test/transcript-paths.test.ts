import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptPath, forgetClaudeTranscriptPaths, noteRegistryEntries } from "../src/transcript-paths.ts";

const ID = "7d0c0f4e-1111-4000-8000-000000000001";
const dirs: string[] = [];

function claudeDir(): { dir: string; projects: string } {
  const dir = mkdtempSync(join(tmpdir(), "conch-paths-"));
  dirs.push(dir);
  const projects = join(dir, "projects");
  for (const name of ["-a", "-b", "-c"]) mkdirSync(join(projects, name), { recursive: true });
  return { dir, projects };
}

afterEach(() => {
  forgetClaudeTranscriptPaths();
  for (const dir of dirs.splice(0)) {
    try { chmodSync(join(dir, "projects"), 0o755); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claudeTranscriptPath", () => {
  test("keeps what it found, without listing the folders again", () => {
    const { dir, projects } = claudeDir();
    const path = join(projects, "-b", `${ID}.jsonl`);
    writeFileSync(path, "{}\n");
    expect(claudeTranscriptPath(dir, ID)).toBe(path);
    // Listing the folders now fails; reaching a file in them still works.
    chmodSync(projects, 0o100);
    expect(claudeTranscriptPath(dir, ID)).toBe(path);
    expect(claudeTranscriptPath(dir, "someone-else")).toBeUndefined();
  });

  test("a kept path that has gone is a miss, and the folders are searched again", () => {
    const { dir, projects } = claudeDir();
    const first = join(projects, "-a", `${ID}.jsonl`);
    writeFileSync(first, "{}\n");
    expect(claudeTranscriptPath(dir, ID)).toBe(first);
    const moved = join(projects, "-c", `${ID}.jsonl`);
    renameSync(first, moved);
    expect(claudeTranscriptPath(dir, ID)).toBe(moved);
    rmSync(moved);
    expect(claudeTranscriptPath(dir, ID)).toBeUndefined();
  });

  test("a miss is never kept: a transcript that appears is found on the next look", () => {
    const { dir, projects } = claudeDir();
    expect(claudeTranscriptPath(dir, ID)).toBeUndefined();
    const path = join(projects, "-c", `${ID}.jsonl`);
    writeFileSync(path, "{}\n");
    expect(claudeTranscriptPath(dir, ID)).toBe(path);
  });

  test("a session whose registry entry moved is searched for again", () => {
    const { dir, projects } = claudeDir();
    const path = join(projects, "-a", `${ID}.jsonl`);
    writeFileSync(path, "{}\n");
    noteRegistryEntries(dir, [{ sessionId: ID, cwd: "/a", pid: 100 }]);
    expect(claudeTranscriptPath(dir, ID)).toBe(path);
    chmodSync(projects, 0o100);
    // The same entries, or the same two windows in another order: kept.
    noteRegistryEntries(dir, [{ sessionId: ID, cwd: "/a", pid: 100 }]);
    expect(claudeTranscriptPath(dir, ID)).toBe(path);
    noteRegistryEntries(dir, [{ sessionId: ID, cwd: "/a", pid: 100 }, { sessionId: ID, cwd: "/b", pid: 200 }]);
    noteRegistryEntries(dir, [{ sessionId: ID, cwd: "/b", pid: 200 }, { sessionId: ID, cwd: "/a", pid: 100 }]);
    // The second window's arrival was a change: searched again, and the folders can't be listed.
    expect(claudeTranscriptPath(dir, ID)).toBeUndefined();
  });
});
