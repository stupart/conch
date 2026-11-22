import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWhisperServerOn,
  reapOrphanedWhisper,
  readWhisperRecord,
  recordSpawnedWhisper,
} from "../src/whisper-orphan.ts";

const ARGV = "/opt/homebrew/bin/whisper-server -m ggml.bin -vm silero.bin --vad --host 127.0.0.1 --port 8642 -l en -t 6";

const identityFor = (pid: number) => ({ pid, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/whisper-server", ttyDevice: null });

function recordAt(record: object): string {
  const path = join(mkdtempSync(join(tmpdir(), "conch-whisper-")), "whisper-server.json");
  writeFileSync(path, JSON.stringify(record));
  return path;
}

/** A reaper over fakes: `pids` are alive, `argv` is what `ps` would print. */
function reaper(pids: Set<number>, argv: Record<number, string>) {
  const kills: number[] = [];
  return {
    kills,
    deps: {
      alive: (pid: number) => pids.has(pid),
      identity: (pid: number) => pids.has(pid) ? identityFor(pid) : null,
      command: (pid: number) => (pids.has(pid) ? argv[pid] ?? null : null),
      kill: (pid: number) => { kills.push(pid); pids.delete(pid); },
      sleep: async () => {},
    },
  };
}

describe("reaping a dead daemon's whisper-server", () => {
  test("the record survives a round trip and names the writing daemon", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-whisper-")), "nested", "whisper-server.json");
    recordSpawnedWhisper(4242, 8642, path, identityFor);
    expect(readWhisperRecord(path)).toMatchObject({ pid: 4242, port: 8642, daemonPid: process.pid, identity: identityFor(4242) });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBeTrue();
    expect(readWhisperRecord(join(path, "..", "missing.json"))).toBeNull();
  });

  test("kills exactly the recorded whisper-server once its daemon is dead", async () => {
    const path = recordAt({ pid: 4242, port: 8642, daemonPid: 999, startedAt: 1, identity: identityFor(4242) });
    const r = reaper(new Set([4242]), { 4242: ARGV });
    expect(await reapOrphanedWhisper(8642, path, r.deps)).toBe(4242);
    expect(r.kills).toEqual([4242]);
  });

  test("never kills a stranger: live daemon, other port, reused pid, or no record", async () => {
    const cases: Array<[string, object, Set<number>, Record<number, string>]> = [
      ["its daemon is alive", { pid: 4242, port: 8642, daemonPid: 999 }, new Set([4242, 999]), { 4242: ARGV }],
      ["recorded for another port", { pid: 4242, port: 8643, daemonPid: 999 }, new Set([4242]), { 4242: ARGV }],
      ["pid reused by something else", { pid: 4242, port: 8642, daemonPid: 999 }, new Set([4242]), { 4242: "node server.js --port 8642" }],
      ["pid reused by a whisper-server on another port", { pid: 4242, port: 8642, daemonPid: 999 }, new Set([4242]), { 4242: ARGV.replace("8642", "86420") }],
      ["pid gone", { pid: 4242, port: 8642, daemonPid: 999 }, new Set(), {}],
      ["record malformed", { pid: "4242", port: 8642 }, new Set([4242]), { 4242: ARGV }],
    ];
    for (const [name, record, pids, argv] of cases) {
      const r = reaper(pids, argv);
      expect(await reapOrphanedWhisper(8642, recordAt(record), r.deps), name).toBeNull();
      expect(r.kills, name).toEqual([]);
    }
    expect(await reapOrphanedWhisper(8642, join(tmpdir(), "conch-no-such-record.json"), reaper(new Set(), {}).deps)).toBeNull();
  });

  test("argv must be whisper-server bound to exactly this port", () => {
    expect(isWhisperServerOn(ARGV, 8642)).toBeTrue();
    expect(isWhisperServerOn("whisper-server --port 8642", 8642)).toBeTrue();
    expect(isWhisperServerOn(ARGV, 864)).toBeFalse();
    expect(isWhisperServerOn("whisper-cli --port 8642", 8642)).toBeFalse();
    expect(isWhisperServerOn("/usr/bin/tail -f whisper-server.log --port 8642", 8642)).toBeFalse();
  });
});
