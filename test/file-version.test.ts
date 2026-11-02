import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemo } from "../src/file-version.ts";

// The daemon keeps what each live transcript's last megabyte says (context, usage limit, model and effort) in a
// `FileMemo`, so an unchanged transcript is not read and parsed on every render. It must work it out again on
// anything that could change the answer.

const dir = mkdtempSync(join(tmpdir(), "conch-file-memo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function counted(path: string) {
  let computed = 0;
  const memo = new FileMemo<string>();
  const get = (id = "s", key = "k") => memo.get(id, path, key, async () => {
    computed++;
    return `${Bun.file(path).size}`;
  });
  return { memo, get, computed: () => computed };
}

describe("a file memo works a value out again exactly when it could have changed", () => {
  test("not while the file is untouched; again once it is appended to, or the key changes", async () => {
    const path = join(dir, "grows.jsonl");
    writeFileSync(path, "one\n");
    const { get, computed } = counted(path);
    expect(await get()).toBe("4");
    expect(await get()).toBe("4");
    expect(computed()).toBe(1);
    appendFileSync(path, "two\n");
    expect(await get()).toBe("8");
    expect(computed()).toBe(2);
    expect(await get("s", "another window")).toBe("8");
    expect(computed()).toBe(3);
  });

  test("a file replaced by another of the same size and mtime: only the inode moved", async () => {
    const path = join(dir, "replaced.jsonl");
    const second = 1_793_000_000;
    writeFileSync(path, "aaaa\n");
    utimesSync(path, second, second);
    const { get, computed } = counted(path);
    await get();
    const next = join(dir, "replacement.jsonl");
    writeFileSync(next, "bbbb\n");
    utimesSync(next, second, second);
    const old = statSync(path);
    renameSync(next, path);
    expect(statSync(path).mtimeMs).toBe(old.mtimeMs);
    expect(statSync(path).ino).not.toBe(old.ino);
    await get();
    expect(computed()).toBe(2);
  });

  test("a file rewritten in place to the same length: only the mtime moved", async () => {
    const path = join(dir, "rewritten.jsonl");
    writeFileSync(path, "aaaa\n");
    const { get, computed } = counted(path);
    await get();
    const before = statSync(path).mtimeMs;
    writeFileSync(path, "bbbb\n");
    utimesSync(path, new Date(), new Date(before + 5_000));
    await get();
    expect(computed()).toBe(2);
  });

  test("a value that could not be worked out, or a file that is not there, is never kept", async () => {
    const path = join(dir, "flaky.jsonl");
    writeFileSync(path, "x\n");
    const memo = new FileMemo<string>();
    let calls = 0;
    const flaky = () => memo.get("s", path, "k", async () => (++calls === 1 ? null : "read"));
    expect(await flaky()).toBeNull();
    expect(await flaky()).toBe("read");
    expect(calls).toBe(2);
    const missing = () => memo.get("m", join(dir, "absent.jsonl"), "k", async () => "worked out");
    await missing();
    await missing();
    let none = 0;
    await memo.get("n", undefined, "k", async () => `${++none}`);
    await memo.get("n", undefined, "k", async () => `${++none}`);
    expect(none).toBe(2);
  });

  test("an id let go is worked out afresh", async () => {
    const path = join(dir, "retained.jsonl");
    writeFileSync(path, "x\n");
    const { memo, get, computed } = counted(path);
    await get("a");
    await get("b");
    memo.retain(new Set(["a"]));
    await get("a");
    await get("b");
    expect(computed()).toBe(3);
  });
});
