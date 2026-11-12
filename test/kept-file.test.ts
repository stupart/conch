import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetKeptFiles, readKeptFile, settleKeptFiles } from "../src/kept-file.ts";
import { labelOverrides, setLabelOverride } from "../src/sessions.ts";

const dirs: string[] = [];
const parse = (text: string) => JSON.parse(text) as Record<string, string>;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "conch-kept-"));
  dirs.push(dir);
  return dir;
}

/** Written, then dated a minute back: old enough to be trusted. */
function settled(path: string, text: string): void {
  writeFileSync(path, text);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
}

afterEach(() => {
  forgetKeptFiles();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readKeptFile", () => {
  test("a file that has not moved is not read again", () => {
    const path = join(folder(), "labels.json");
    settled(path, JSON.stringify({ a: "one" }));
    expect(readKeptFile(path, parse, {})).toEqual({ a: "one" });
    const reads = spyOn(fs, "readFileSync");
    try {
      expect(readKeptFile(path, parse, {})).toEqual({ a: "one" });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });

  test("a rewrite in place, a replacement by rename and a removal are each seen", () => {
    const dir = folder();
    const path = join(dir, "labels.json");
    settled(path, JSON.stringify({ a: "one" }));
    expect(readKeptFile(path, parse, {})).toEqual({ a: "one" });
    settled(path, JSON.stringify({ a: "two!" }));
    expect(readKeptFile(path, parse, {})).toEqual({ a: "two!" });
    settled(`${path}.tmp`, JSON.stringify({ a: "six" }));
    renameSync(`${path}.tmp`, path);
    expect(readKeptFile(path, parse, {})).toEqual({ a: "six" });
    rmSync(path);
    expect(readKeptFile(path, parse, {})).toEqual({});
  });

  test("a file written just now is read again, so a same-length rewrite in the same tick is not missed", () => {
    const path = join(folder(), "labels.json");
    writeFileSync(path, JSON.stringify({ a: "one" }));
    const at = new Date();
    utimesSync(path, at, at);
    expect(readKeptFile(path, parse, {})).toEqual({ a: "one" });
    // The same length and, on a coarse volume, the same timestamp.
    writeFileSync(path, JSON.stringify({ a: "two" }));
    utimesSync(path, at, at);
    expect(readKeptFile(path, parse, {})).toEqual({ a: "two" });
  });

  test("settled: each file is looked at once until the running code yields, then again", async () => {
    const path = join(folder(), "labels.json");
    settled(path, JSON.stringify({ a: "one" }));
    const stats = spyOn(fs, "statSync");
    try {
      settleKeptFiles();
      expect(readKeptFile(path, parse, {})).toEqual({ a: "one" });
      settled(path, JSON.stringify({ a: "changed during the pass" }));
      expect(readKeptFile(path, parse, {})).toEqual({ a: "one" });
      expect(readKeptFile(join(folder(), "absent.json"), parse, {})).toEqual({});
      expect(readKeptFile(join(folder(), "absent.json"), parse, {})).toEqual({});
      const during = stats.mock.calls.length;
      await Promise.resolve();
      expect(readKeptFile(path, parse, {})).toEqual({ a: "changed during the pass" });
      expect(stats.mock.calls.length).toBeGreaterThan(during);
    } finally {
      stats.mockRestore();
    }
  });

  test("an unreadable or unparseable file gives the fallback", () => {
    const dir = folder();
    expect(readKeptFile(join(dir, "none.json"), parse, {})).toEqual({});
    const path = join(dir, "torn.json");
    settled(path, "{\"a\":");
    expect(readKeptFile(path, parse, { fallback: "yes" })).toEqual({ fallback: "yes" });
  });

  test("labels: a caller changing what it was handed changes nothing kept", () => {
    const labelsPath = join(folder(), "labels.json");
    setLabelOverride("s-1", "First", { labelsPath });
    const handed = labelOverrides({ labelsPath });
    handed["s-1"] = "mutated";
    expect(labelOverrides({ labelsPath })).toEqual({ "s-1": "First" });
    setLabelOverride("s-2", "Second", { labelsPath });
    expect(labelOverrides({ labelsPath })).toEqual({ "s-1": "First", "s-2": "Second" });
  });
});
