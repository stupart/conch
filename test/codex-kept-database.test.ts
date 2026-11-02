import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexDatabase } from "../src/codex-threads.ts";

// Codex's databases are now read through a connection kept open between renders (`readCodexDatabase`). Codex writes
// them the whole time, so a kept connection must see every commit, must never hold a lock between reads, and must
// not go on reading a file that was replaced.

const root = mkdtempSync(join(tmpdir(), "conch-codex-kept-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function database(name: string, mode: "delete" | "wal"): { path: string; writer: Database } {
  const path = join(root, name);
  const writer = new Database(path);
  writer.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT);`);
  writer.query("INSERT INTO threads VALUES ('t0', 'first')").run();
  // A writer that gives up at once: any lock a reader still held would fail it.
  writer.exec("PRAGMA busy_timeout = 0");
  return { path, writer };
}

const names = (path: string) =>
  readCodexDatabase(path, (db) => (db.query("SELECT name FROM threads ORDER BY id").all() as Array<{ name: string }>).map((row) => row.name));
const first = (path: string) =>
  readCodexDatabase(path, (db) => (db.query("SELECT name FROM threads ORDER BY id").get() as { name: string }).name);

describe("a kept connection to a Codex database", () => {
  for (const mode of ["delete", "wal"] as const) {
    test(`${mode} journal: sees each commit, and holds no lock between reads`, () => {
      const { path, writer } = database(`state-${mode}.sqlite`, mode);
      expect(names(path)).toEqual(["first"]);
      // A `get` stops after one row; the statement is still reset, so the writer goes straight through.
      expect(first(path)).toBe("first");
      writer.query("INSERT INTO threads VALUES ('t1', 'second')").run();
      expect(names(path)).toEqual(["first", "second"]);
      writer.query("UPDATE threads SET name = 'renamed' WHERE id = 't0'").run();
      expect(names(path)).toEqual(["renamed", "second"]);
      writer.close();
    });
  }

  test("a database replaced by a new file is read from the new file", () => {
    const { path, writer } = database("state-replaced.sqlite", "delete");
    expect(names(path)).toEqual(["first"]);
    writer.close();
    const next = database("state-next.sqlite", "delete");
    next.writer.query("UPDATE threads SET name = 'from the new file'").run();
    next.writer.close();
    const ino = statSync(path).ino;
    renameSync(next.path, path);
    expect(statSync(path).ino).not.toBe(ino);
    expect(names(path)).toEqual(["from the new file"]);
  });

  test("a read that fails is thrown to the caller, and does not spoil the next", () => {
    const { path, writer } = database("state-failing.sqlite", "delete");
    expect(() => readCodexDatabase(path, (db) => db.query("SELECT * FROM no_such_table").all())).toThrow();
    writer.exec("CREATE TABLE no_such_table (x)");
    writer.query("INSERT INTO no_such_table VALUES (1)").run();
    expect(readCodexDatabase(path, (db) => db.query("SELECT x FROM no_such_table").all())).toEqual([{ x: 1 }]);
    writer.close();
  });

  test("a missing database throws for the caller to treat as unreadable, as an open did", () => {
    expect(() => names(join(root, "absent.sqlite"))).toThrow();
  });
});
