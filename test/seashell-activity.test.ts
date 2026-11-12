import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { SeashellActivity, seashellLibraryDir, seashellStatusRecording, type TranscriptionPolicy } from "../src/seashell-activity.ts";
import { transcribePcm, WhisperServerClient, type ColdTranscriptionProcess } from "../src/transcribe.ts";
import { whisperThreads } from "../src/whisper-args.ts";

/**
 * While seashell records a meeting, conch's transcription stays small and
 * behind it. Seashell's status is read as seashell's own reader reads it
 * (src/background-watch-status.ts); these are fixtures, never its live file.
 */

const NOW = 1_800_000_000_000;
const status = (fields: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, pid: 4242, updatedAtUnixMs: NOW - 5_000, ...fields });
const alive = (pid: number) => pid === 4242;

describe("seashell's background watch status", () => {
  test("recording, from a live watcher, refreshed within 30s, is recording", () => {
    expect(seashellStatusRecording(status({ phase: "recording", sessionId: "s1" }), NOW, alive)).toBeTrue();
  });

  test("any other phase, a stale or future status, a dead watcher or a damaged file is not", () => {
    for (const phase of ["watching", "awaiting-consent", "stopped", "unavailable"]) {
      expect(seashellStatusRecording(status({ phase }), NOW, alive)).toBeFalse();
    }
    expect(seashellStatusRecording(status({ phase: "recording", updatedAtUnixMs: NOW - 31_000 }), NOW, alive)).toBeFalse();
    expect(seashellStatusRecording(status({ phase: "recording", updatedAtUnixMs: NOW + 1_000 }), NOW, alive)).toBeFalse();
    expect(seashellStatusRecording(status({ phase: "recording", pid: 99 }), NOW, alive)).toBeFalse();
    expect(seashellStatusRecording(status({ phase: "recording", schemaVersion: 2 }), NOW, alive)).toBeFalse();
    expect(seashellStatusRecording("{not json", NOW, alive)).toBeFalse();
  });

  test("lives in seashell's library: its variable, its config's libraryDir, or Documents/Sea Shell/Transcripts", () => {
    expect(seashellLibraryDir({ SEASHELL_LIBRARY_DIR: "~/Meetings" }, "/Users/someone")).toBe("/Users/someone/Meetings");
    expect(seashellLibraryDir({ SEASHELL_CONFIG: "/nonexistent/config.json" }, "/Users/someone")).toBe("/Users/someone/Documents/Sea Shell/Transcripts");
  });
});

describe("the transcription policy", () => {
  function activity(text: () => string | null, now = { at: NOW }) {
    const lines: string[] = [];
    const reads: string[] = [];
    const a = new SeashellActivity({
      statusPath: () => "/library/.background-watch.json",
      read: (path) => {
        reads.push(path);
        return text();
      },
      now: () => now.at,
      alive,
      log: (line) => lines.push(line),
    });
    return { a, lines, reads, now };
  }

  test("with seashell idle, nothing changes: previews on, every thread, no nice", () => {
    const { a } = activity(() => status({ phase: "watching" }));
    expect(a.policy()).toEqual({ route: "own", partials: true, coldThreads: whisperThreads(), coldNice: 0, yielding: false });
    expect(activity(() => null).a.policy().yielding).toBeFalse();
  });

  test("while seashell records: no previews, a cold run with half the threads at nice 10, and finals still on conch's own engine", () => {
    const { a, lines } = activity(() => status({ phase: "recording" }));
    expect(a.policy()).toEqual({
      route: "own",
      partials: false,
      coldThreads: Math.max(2, Math.floor(whisperThreads() / 2)),
      coldNice: 10,
      yielding: true,
    });
    expect(lines).toEqual(["seashell is recording a meeting — conch's live previews pause and a cold transcription runs at low priority until it stops"]);
  });

  test("reads the file at most every 2s, and says when seashell stops", () => {
    let phase = "recording";
    const { a, lines, reads, now } = activity(() => status({ phase, updatedAtUnixMs: now.at - 1_000 }));
    expect(a.recording()).toBeTrue();
    phase = "watching";
    now.at += 1_000;
    expect(a.recording()).toBeTrue();
    expect(reads).toHaveLength(1);
    now.at += 1_000;
    expect(a.recording()).toBeFalse();
    expect(reads).toHaveLength(2);
    expect(lines.at(-1)).toBe("seashell stopped recording — conch's live previews are back");
  });
});

describe("a cold run while seashell records", () => {
  const cfg = { whisperPort: 0, whisperCli: "fake-whisper-cli", whisperModel: "fake-model.bin", vadModel: "fake-vad.bin" } as Config;
  const finished = (): ColdTranscriptionProcess => ({ stdout: new Blob(["hello there"]).stream(), exited: Promise.resolve(0), kill: () => {} });
  const pcm = new Uint8Array(32_000).map((_, i) => (i % 2 ? 4 : 0));

  test("runs under nice with fewer threads; without seashell it runs as before", async () => {
    const commands: string[][] = [];
    const yielding: TranscriptionPolicy = { route: "own", partials: false, coldThreads: 2, coldNice: 10, yielding: true };
    const result = await transcribePcm(cfg, pcm, undefined, {
      client: new WhisperServerClient(),
      policy: yielding,
      spawnCold: (command) => (commands.push(command), finished()),
    });
    expect(result.text).toBe("hello there");
    expect(commands[0]!.slice(0, 4)).toEqual(["/usr/bin/nice", "-n", "10", "fake-whisper-cli"]);
    expect(commands[0]![commands[0]!.indexOf("-t") + 1]).toBe("2");

    const idle: TranscriptionPolicy = { route: "own", partials: true, coldThreads: whisperThreads(), coldNice: 0, yielding: false };
    await transcribePcm(cfg, pcm, undefined, { client: new WhisperServerClient(), policy: idle, spawnCold: (command) => (commands.push(command), finished()) });
    expect(commands[1]![0]).toBe("fake-whisper-cli");
    expect(commands[1]![commands[1]!.indexOf("-t") + 1]).toBe(String(whisperThreads()));
  });
});
