import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordsDiscovery, recordsRoots } from "../src/records-discovery.ts";

const roots: string[] = [];
const scans: RecordsDiscovery[] = [];
afterEach(() => {
  for (const scan of scans.splice(0)) scan.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ID = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conch-record-discovery-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const write = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "{}\n"); };
  const scan = new RecordsDiscovery(recordsRoots({ claudeHome, codexHome }));
  scans.push(scan);
  return { root, claudeHome, codexHome, write, scan };
}

test("bounded discovery includes archived rollouts, rotated segments and distinct Claude sidechains", () => {
  const f = fixture();
  f.write(join(f.claudeHome, "projects", "project", `${ID}.jsonl`));
  f.write(join(f.claudeHome, "projects", "project", `${ID}.jsonl.1`));
  f.write(join(f.claudeHome, "projects", "project", ID, "subagents", "agent-child.jsonl"));
  f.write(join(f.codexHome, "archived_sessions", `rollout-2026-09-16-${ID}.jsonl`));
  const found = [];
  for (let step = 0; step < 100 && !f.scan.done; step++) {
    const result = f.scan.next(2);
    expect(result.entries).toBeLessThanOrEqual(2);
    if (result.candidate) found.push(result.candidate);
  }
  expect(f.scan.done).toBe(true);
  expect(found).toHaveLength(4);
  expect(found.find((entry) => entry.parentNativeId)).toMatchObject({ nativeId: `${ID}/agent-child`, parentNativeId: ID });
  expect(found.find((entry) => entry.provider === "codex")?.nativeId).toBe(ID);
});

test("only configured transcript roots are scanned and symlinks are skipped", () => {
  const f = fixture();
  const outside = join(f.root, "outside", `${ID}.jsonl`);
  f.write(outside);
  const project = join(f.claudeHome, "projects", "project");
  mkdirSync(project, { recursive: true });
  symlinkSync(outside, join(project, `${ID}.jsonl`));
  symlinkSync(join(f.root, "outside"), join(project, "linked"));
  f.write(join(project, "not-a-transcript.jsonl"));
  const found = [];
  for (let step = 0; step < 100 && !f.scan.done; step++) {
    const result = f.scan.next(4);
    if (result.candidate) found.push(result.candidate);
  }
  expect(found).toEqual([]);
  expect(recordsRoots({})).toEqual([]);
});
