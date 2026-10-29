import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkCatalog, isBenchmarkCatalog, isBenchmarksReply, readBenchmarks } from "../src/benchmarks.ts";
import { validateControlResponse } from "../src/settings.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const catalog = () => JSON.parse(readFileSync(join(import.meta.dir, "..", "assets", "benchmarks.json"), "utf8"));

test("the catalog this build carries matches its shape, and every entry is a real https page", () => {
  const read = benchmarkCatalog();
  expect(read.indexes.length).toBeGreaterThanOrEqual(100);
  expect(new Set(read.indexes.map((index) => index.id)).size).toBe(read.indexes.length);
  for (const index of read.indexes) expect(new URL(index.url).protocol).toBe("https:");
  expect(isBenchmarksReply(readBenchmarks(read, "/nowhere"))).toBe(true);
});

test("one bad entry refuses the whole catalog rather than showing part of it", () => {
  const good = catalog();
  expect(isBenchmarkCatalog(good)).toBe(true);
  const broken = (change: (value: any) => void) => { const copy = structuredClone(good); change(copy); return isBenchmarkCatalog(copy); };
  expect(broken((value) => { value.indexes[0].url = "http://example.com"; })).toBe(false);
  expect(broken((value) => { value.indexes[0].kind = "vibes"; })).toBe(false);
  expect(broken((value) => { value.indexes.push({ ...value.indexes[0] }); })).toBe(false);
  expect(broken((value) => { value.report.atlasPath = "../../etc/passwd"; })).toBe(false);
  expect(broken((value) => { delete value.report; })).toBe(true);
  expect(() => benchmarkCatalog(JSON.stringify({ updatedAt: "x", indexes: [{}] }))).toThrow("assets/benchmarks.json");
});

test("the report opens from its copy on this Mac, when an agent has shown it", () => {
  const copies = mkdtempSync(join(tmpdir(), "conch-atlas-"));
  dirs.push(copies);
  const read = benchmarkCatalog();
  expect(readBenchmarks(read, copies).reportCopy).toBeUndefined();
  const file = join(copies, ...read.report!.atlasPath.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file.endsWith(".md") ? file : `${file}.md`, "# Report\n");
  expect(readBenchmarks(read, copies).reportCopy).toBe(file.endsWith(".md") ? file : `${file}.md`);
  expect(validateControlResponse(readBenchmarks(read, copies)).ok).toBe(true);
});

test("the catalog goes a page at a time, each inside a control frame, every index once", () => {
  const read = benchmarkCatalog();
  const seen: string[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = readBenchmarks(read, "/nowhere", offset);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
    expect(page.total).toBe(read.indexes.length);
    expect(page.catalog.report).toEqual(read.report);
    seen.push(...page.catalog.indexes.map((index) => index.id));
    offset = page.next;
  }
  expect(seen).toEqual(read.indexes.map((index) => index.id));
});
