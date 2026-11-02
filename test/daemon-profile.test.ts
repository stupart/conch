import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileDaemon, profileReport, requestedProfileMs } from "../src/daemon-profile.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "conch-profile-")); dirs.push(dir); return dir; };

test("the report counts each sample once per function and file, beside the process's own CPU", () => {
  const frame = (name: string, file: string, line: number) => ({ name, sourceURL: `/repo/src/${file}`, line });
  const report = profileReport({
    interval: 0.001,
    traces: [
      { frames: [frame("parse", "records-store.ts", 10), frame("index", "records-indexer.ts", 5), frame("index", "records-indexer.ts", 5)] },
      { frames: [frame("parse", "records-store.ts", 10), frame("publish", "panel.ts", 3)] },
      { frames: [{ name: "spawn", category: "Host" }, frame("probe", "codex-threads.ts", 7)] },
    ],
  }, { ms: 1000, cpuMicros: 50_000, startedAt: "2026-11-02T00:00:00.000Z" });
  expect(report).toContain("Process CPU, every thread: 50 ms (5.0% of one core)");
  expect(report).toContain("JavaScript on the daemon's thread: 3 ms (0.3% of one core), 3 samples");
  expect(report).toContain("| 2 | 66.7% | parse — records-store.ts:10 |");
  // Inclusive: `index` twice in one stack is still one sample.
  expect(report).toContain("| 1 | 33.3% | index — records-indexer.ts:5 |");
  // A native call is put down to the conch file that made it.
  expect(report).toContain("| 1 | 33.3% | codex-threads.ts |");
  expect(report).toContain("| 1 | 33.3% | spawn — (native) |");
});

test("a request file sets how long, once; anything else is 30 s, and never past 5 minutes", () => {
  const dir = scratch();
  expect(requestedProfileMs(dir)).toBe(30_000);
  writeFileSync(join(dir, "request"), "12\n");
  expect(requestedProfileMs(dir)).toBe(12_000);
  expect(existsSync(join(dir, "request"))).toBe(false);
  writeFileSync(join(dir, "request"), "9999\n");
  expect(requestedProfileMs(dir)).toBe(300_000);
});

test("profiling this process for a moment writes a report of what ran", async () => {
  const dir = scratch();
  const busy = setInterval(() => { let s = 0; for (let i = 0; i < 2e5; i++) s += Math.sqrt(i); return s; }, 2);
  try {
    const path = await profileDaemon(dir, 300);
    expect(readFileSync(path, "utf8")).toStartWith("# conch daemon profile");
  } finally {
    clearInterval(busy);
  }
});
