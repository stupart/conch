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
      command: (pid: number) => (pids.has(pid) ? argv[pid] ?? null : null),
      kill: (pid: number) => { kills.push(pid); pids.delete(pid); },
      sleep: async () => {},
    },
  };
}

describe("reaping a dead daemon's whisper-server", () => {
  test("the record survives a round trip and names the writing daemon", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-whisper-")), "nested", "whisper-server.json");
    recordSpawnedWhisper(4242, 8642, path);
    expect(readWhisperRecord(path)).toMatchObject({ pid: 4242, port: 8642, daemonPid: process.pid });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBeTrue();
    expect(readWhisperRecord(join(path, "..", "missing.json"))).toBeNull();
  });

  test("kills exactly the recorded whisper-server once its daemon is dead", async () => {
    const path = recordAt({ pid: 4242, port: 8642, daemonPid: 999, startedAt: 1 });
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

/**
 * `runDaemon` runs in no test, so its two lines of wiring are pinned as text.
 * Presence first: `indexOf` returns -1 for a missing marker, and -1 sorts
 * before everything.
 */
test("the daemon records the whisper-server it spawns and reaps a dead daemon's orphan before adopting", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

  const spawnAt = daemon.indexOf("cfg.whisperServerBin,\n");
  expect(spawnAt).toBeGreaterThan(-1);
  const closureEnd = daemon.indexOf("resetReadiness: () => whisperServerClient.resetHealth(),", spawnAt);
  expect(closureEnd).toBeGreaterThan(spawnAt);
  expect(daemon.slice(spawnAt, closureEnd)).toContain("recordSpawnedWhisper(child.pid, cfg.whisperPort);");

  // The reap runs after the socket race is won (a loser exits, and must not
  // touch the winner's server) and before the supervisor's first inspection.
  const socketAt = daemon.indexOf("if (!await controlServer.start()) {");
  expect(socketAt).toBeGreaterThan(-1);
  const reapAt = daemon.indexOf("void reapOrphanedWhisper(cfg.whisperPort)");
  expect(reapAt).toBeGreaterThan(socketAt);
  const startAt = daemon.indexOf(".then(() => supervisor.start())", reapAt);
  expect(startAt).toBeGreaterThan(reapAt);
});
