import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearIdentity,
  readIdentity,
  startedByFromEnv,
  writeIdentity,
} from "../src/daemon-identity.ts";

const scratch = () => join(mkdtempSync(join(tmpdir(), "conch-id-")), "daemon.json");

test("a daemon records who it is", () => {
  const path = scratch();
  const written = writeIdentity(path, { pid: 4242, version: "9.9.9", startedBy: "app" });
  expect(written.pid).toBe(4242);
  const read = readIdentity(path, () => true);
  expect(read?.pid).toBe(4242);
  expect(read?.version).toBe("9.9.9");
  expect(read?.startedBy).toBe("app");
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("a record whose process is gone is no record at all", () => {
  // The whole point. An orphaned file mistaken for a live daemon is how a
  // whisper-server survived from Aug 10, adopted by every daemon since and
  // stopped by none of them.
  const path = scratch();
  writeIdentity(path, { pid: 4242, startedBy: "app" });
  expect(readIdentity(path, () => false)).toBeNull();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("an unknown launcher is treated as someone else's", () => {
  // The conservative direction: conch must not claim ownership of a daemon a
  // person started in their own terminal.
  expect(startedByFromEnv({})).toBe("terminal");
  expect(startedByFromEnv({ CONCH_STARTED_BY: "nonsense" })).toBe("terminal");
  expect(startedByFromEnv({ CONCH_STARTED_BY: "app" })).toBe("app");
  expect(startedByFromEnv({ CONCH_STARTED_BY: "launchd" })).toBe("launchd");
});

test("garbage on disk reads as no identity rather than throwing", () => {
  const path = scratch();
  writeFileSync(path, "{not json");
  expect(readIdentity(path, () => true)).toBeNull();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("clearing is idempotent, so shutdown can always call it", () => {
  const path = scratch();
  writeIdentity(path, { pid: 1 });
  clearIdentity(path);
  expect(readIdentity(path, () => true)).toBeNull();
  expect(() => clearIdentity(path)).not.toThrow();
  rmSync(join(path, ".."), { recursive: true, force: true });
});
