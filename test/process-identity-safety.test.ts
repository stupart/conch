import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSession, refreshSessionForClose, startTerminalSession } from "../src/session-lifecycle.ts";
import { reapOrphanedWhisper } from "../src/whisper-orphan.ts";
import { reapOrphanedSox } from "../src/sox-orphan.ts";
import { bindSessionProcess, decodeProcessIdentity, readProcessIdentity, type ProcessIdentity } from "../src/process-identity.ts";
import type { SessionInfo } from "../src/sessions.ts";
import { withUITransaction } from "../src/inject.ts";
import { readIdentity, writeIdentity } from "../src/daemon-identity.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function record(value: object): string {
  const root = fs.mkdtempSync(join(tmpdir(), "conch-process-proof-"));
  roots.push(root);
  const path = join(root, "record.json");
  fs.writeFileSync(path, JSON.stringify(value));
  return path;
}
const identity = { pid: 4242, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/claude", ttyDevice: 7 };
const processResult = () => ({ exited: Promise.resolve(0), stdout: new Response("ok").body, stderr: null, cancel() {} });

test("close refuses a reused PID even when its executable and Terminal tty are identical", async () => {
  const spawned: string[][] = [];
  const deps = {
    processIdentity: () => ({ ...identity, birth: "2000.000001" }),
    ttyForPid: async () => "ttys007", pidIsAlive: async () => false,
    spawn: (args: string[]) => { spawned.push(args); return processResult(); },
  };
  await expect(closeSession({ pid: 4242, processIdentity: identity }, deps))
    .rejects.toThrow("identity");
  expect(spawned).toEqual([]);
});

test.each(["whisper", "sox"])("%s reaping refuses same-command PID reuse and legacy records", async (kind) => {
  for (const storedIdentity of [identity, undefined]) {
    const path = record(kind === "whisper"
      ? { pid: 4242, port: 8642, daemonPid: 999, identity: storedIdentity }
      : { daemonPid: 999, pids: [4242], identities: storedIdentity ? { 4242: storedIdentity } : undefined });
    const killed: number[] = [];
    const deps = {
      alive: (pid: number) => pid === 4242,
      command: () => kind === "whisper" ? "whisper-server --port 8642" : "sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t raw /tmp/conch-test.raw silence -l 1 0.15 2% 1 3.5 2%",
      identity: () => storedIdentity ? { ...storedIdentity, birth: "2000.000001" } : null,
      kill: (pid: number) => { killed.push(pid); }, sleep: async () => {},
    };
    if (kind === "whisper") expect(await reapOrphanedWhisper(8642, path, deps)).toBeNull();
    else expect(await reapOrphanedSox(path, deps)).toEqual([]);
    expect(killed).toEqual([]);
  }
});

test("daemon identity creates only the requested parent directory", () => {
  const path = join(record({}), "..", "nested", "daemon.json");
  const mkdir = fs.mkdirSync;
  const attempted: string[] = [];
  const spy = spyOn(fs, "mkdirSync").mockImplementation(((dir, options) => {
    attempted.push(String(dir));
    if (dir !== join(path, "..")) throw new Error("refusing non-fixture directory");
    return mkdir(dir, options);
  }) as typeof fs.mkdirSync);
  try {
    writeIdentity(path, { pid: 4242 });
    expect(attempted).toEqual([join(path, "..")]);
    expect(readIdentity(path, () => true)?.pid).toBe(4242);
  } finally { spy.mockRestore(); }
});


test("a cached close always refreshes and rejects changed session or provider routes", async () => {
  const expected: SessionInfo = { sessionId: "selected", pid: 4242, backend: "claude", startedAt: 2_000_000, processIdentity: identity };
  for (const patch of [{ pid: 4243 }, { backend: "codex" as const }, { startedAt: 3_000_000 }, { sessionId: "another" }]) {
    let reads = 0;
    await expect(refreshSessionForClose("selected", expected, async () => { reads++; return [{ ...expected, ...patch }]; }))
      .rejects.toThrow(/identity|not live/);
    expect(reads).toBe(1);
  }
  expect(await refreshSessionForClose("selected", expected, async () => [{ ...expected, name: "new label", processIdentity: undefined }]))
    .toEqual({ ...expected, name: "new label" });
  await expect(refreshSessionForClose("selected", undefined, async () => [expected])).rejects.toThrow("identity");
});

test("binding retains the original process birth across repeated stale registry polls", () => {
  const row: SessionInfo = { sessionId: "selected", pid: 4242, startedAt: 2_000_000 };
  const bound = bindSessionProcess(row, undefined, () => identity);
  expect(bound.processIdentity).toEqual(identity);
  expect(bindSessionProcess(row, bound, () => ({ ...identity, birth: "1000.000002" })).processIdentity).toEqual(identity);
  for (const unproven of [{ ...row, startedAt: undefined }, { ...row, startedAt: NaN }, { ...row, startedAt: Infinity }, { ...row, startedAt: identity.birthTimeMs - 1 }, { ...row, backend: "codex" as const }]) {
    expect(bindSessionProcess(unproven, undefined, () => identity).processIdentity).toBeUndefined();
  }
  expect(bindSessionProcess(row, undefined, () => null).processIdentity).toBeUndefined();
});

test("close rechecks after tty lookup and refuses missing proof before UI automation", async () => {
  for (const change of [null, { ...identity, ttyDevice: 8 }, { ...identity, birth: "1000.000002" }, { ...identity, executable: "/opt/bin/codex" }]) {
    let current: ProcessIdentity | null = identity;
    const spawned: string[][] = [];
    await expect(closeSession({ pid: 4242, processIdentity: identity }, {
      processIdentity: () => current,
      ttyForPid: async () => { current = change; return "ttys007"; },
      pidIsAlive: async () => false,
      spawn: (args) => { spawned.push(args); return processResult(); },
    })).rejects.toThrow("identity");
    expect(spawned).toEqual([]);
  }
  await expect(closeSession({ pid: 4242 }, { processIdentity: () => { throw new Error("must not probe an unbound target"); } }))
    .rejects.toThrow("identity");
});

test("kernel decoding distinguishes births one microsecond apart and rejects incomplete reads", () => {
  function bsd(micros = 1n): Buffer {
    const data = Buffer.alloc(136);
    data.writeUInt32LE(4242, 12); data.writeUInt32LE(7, 108);
    data.writeBigUInt64LE(1000n, 120); data.writeBigUInt64LE(micros, 128);
    return data;
  }
  expect(decodeProcessIdentity(4242, bsd(), identity.executable)).toEqual(identity);
  expect(decodeProcessIdentity(4242, bsd(2n), identity.executable)?.birth).not.toBe(identity.birth);
  expect(decodeProcessIdentity(4243, bsd(), identity.executable)).toBeNull();
  expect(decodeProcessIdentity(4242, Buffer.alloc(135), identity.executable)).toBeNull();
  for (const replace of [false, true]) {
    let reads = 0;
    const result = readProcessIdentity(4242, {
      info: (_, buffer) => { bsd(replace && reads++ ? 2n : 1n).copy(buffer); return 136; },
      path: (_, buffer) => { buffer.write(identity.executable); return identity.executable.length; },
    });
    expect(result).toEqual(replace ? null : identity);
  }
});


test("close refuses provider mismatch even when the cached process remains alive", async () => {
  const spawned: string[][] = [];
  await expect(closeSession({ pid: 4242, backend: "codex", processIdentity: identity }, {
    processIdentity: () => identity, ttyForPid: async () => "ttys007", pidIsAlive: async () => false,
    spawn: (args) => { spawned.push(args); return processResult(); },
  })).rejects.toThrow("identity");
  expect(spawned).toEqual([]);
});


test("Close and Start wait for an existing input transaction", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocking = withUITransaction(() => hold);
  const spawned: string[][] = [];
  const deps = {
    processIdentity: () => identity, ttyForPid: async () => "ttys007", pidIsAlive: async () => false,
    which: () => "/fake/claude", isDirectory: () => true,
    spawn: (args: string[]) => { spawned.push(args); return processResult(); },
  };
  const closing = closeSession({ pid: 4242, processIdentity: identity }, deps);
  const starting = startTerminalSession({ backend: "claude", cwd: "/fixture" }, deps);
  try {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(spawned).toHaveLength(0);
  } finally {
    release();
    await Promise.all([blocking, closing, starting]);
  }
  expect(spawned).toHaveLength(2);
});
