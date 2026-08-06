import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anotherDaemonIsListening } from "../src/daemon.ts";

const scratch = () => join(mkdtempSync(join(tmpdir(), "conch-single-")), "conch.sock");

describe("only one daemon may own the socket", () => {
  test("a live listener is detected", async () => {
    // The whole point: a second daemon used to unlink this and rebind,
    // stealing the socket from a running one. Two daemons means two mics,
    // two speakers, and two writers to the same state file.
    const path = scratch();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      expect(await anotherDaemonIsListening(path)).toBeTrue();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a leftover socket FILE is not an owner", async () => {
    // A unix socket outlives the process that made it, which is exactly why
    // "the file exists" was never evidence and unlink-and-rebind felt safe.
    const path = scratch();
    writeFileSync(path, "");
    expect(await anotherDaemonIsListening(path)).toBeFalse();
  });

  test("no file at all is not an owner", async () => {
    expect(await anotherDaemonIsListening(scratch())).toBeFalse();
  });

  test("a listener that accepts but never speaks still counts as an owner", async () => {
    // Deleting a live daemon's socket is the failure this exists to prevent,
    // so an ambiguous answer must resolve toward OCCUPIED, not stale.
    const path = scratch();
    const server = createServer(() => { /* accept, then say nothing at all */ });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      expect(await anotherDaemonIsListening(path, 50)).toBeTrue();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
