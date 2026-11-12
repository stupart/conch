import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readTranscriptionHardware,
  whisperComputeArgs,
  whisperCrashed,
  whisperThreads,
  whisperVadArgs,
  type SysctlReader,
} from "../src/whisper-args.ts";

/** A Mac's sysctl answers, by core level: [name, physical cores]. */
function sysctl(levels: Array<[string, number]>, arm64 = true): SysctlReader {
  const values: Record<string, string> = {
    "hw.optional.arm64": arm64 ? "1" : "0",
    "hw.physicalcpu": String(levels.reduce((total, [, cores]) => total + cores, 0)),
    "hw.nperflevels": String(levels.length),
  };
  levels.forEach(([name, cores], level) => {
    values[`hw.perflevel${level}.name`] = name;
    values[`hw.perflevel${level}.physicalcpu`] = String(cores);
  });
  return (names) => Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]!]));
}

describe("whisper is sized to the Mac it runs on (seashell 3ad4765)", () => {
  test.each([
    ["M1, four performance cores", sysctl([["Performance", 4], ["Efficiency", 4]]), 4],
    ["M3 Pro", sysctl([["Performance", 6], ["Efficiency", 6]]), 6],
    ["M4 Max", sysctl([["Performance", 12], ["Efficiency", 4]]), 8],
    ["M5, Super and Performance cores", sysctl([["Super", 6], ["Performance", 12]]), 8],
  ])("%s", (_name, read, threads) => {
    const hardware = readTranscriptionHardware(read);
    expect(hardware.appleSilicon).toBeTrue();
    expect(whisperThreads(hardware)).toBe(threads);
    expect(whisperComputeArgs({ hardware })).toEqual(["-t", String(threads)]);
  });

  test("an Intel Mac counts physical cores and runs on the CPU", () => {
    const hardware = readTranscriptionHardware((names) => {
      const values: Record<string, string> = { "hw.optional.arm64": "0", "hw.physicalcpu": "2" };
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]!]));
    });
    expect(hardware).toEqual({ appleSilicon: false, performanceCores: 2 });
    expect(whisperComputeArgs({ hardware })).toEqual(["-t", "2", "-ng"]);
  });

  test("an unreadable sysctl still gives a sane thread count", () => {
    const hardware = readTranscriptionHardware(() => ({}));
    expect(whisperThreads(hardware)).toBeGreaterThanOrEqual(1);
    expect(whisperThreads(hardware)).toBeLessThanOrEqual(8);
  });

  test("after a Metal failure the run is on the CPU", () => {
    const hardware = readTranscriptionHardware(sysctl([["Performance", 4], ["Efficiency", 4]]));
    expect(whisperComputeArgs({ hardware, cpu: true })).toEqual(["-t", "4", "-ng"]);
  });
});

describe("one VAD for the warm server and the cold CLI", () => {
  test("Silero hears speech as short as 100ms and keeps 300ms of padding", () => {
    const args = whisperVadArgs("/models/silero.bin");
    expect(args).toEqual(["-vm", "/models/silero.bin", "--vad", "--vad-speech-pad-ms", "300", "--vad-min-speech-duration-ms", "100"]);
  });

  test("both launch sites use the shared arguments, so they cannot drift", () => {
    const root = join(import.meta.dir, "..", "src");
    for (const file of ["daemon.ts", "transcribe.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).toContain("...whisperVadArgs(cfg.vadModel)");
      expect(source).toContain("...whisperComputeArgs({ cpu");
      expect(source).not.toContain('"-t", "6"');
    }
  });
});

describe("a crashed warm server is told apart from a stopped one", () => {
  test("fault signals and their shell statuses are crashes", () => {
    expect(whisperCrashed({ exitCode: null, signalCode: "SIGSEGV" })).toBeTrue();
    expect(whisperCrashed({ exitCode: null, signalCode: "SIGBUS" })).toBeTrue();
    expect(whisperCrashed({ exitCode: null, signalCode: "SIGABRT" })).toBeTrue();
    expect(whisperCrashed({ exitCode: 139 })).toBeTrue();
  });

  test("conch stopping it, or a clean exit, is not", () => {
    expect(whisperCrashed({ exitCode: null, signalCode: "SIGTERM" })).toBeFalse();
    expect(whisperCrashed({ exitCode: null, signalCode: "SIGKILL" })).toBeFalse();
    expect(whisperCrashed({ exitCode: 137 })).toBeFalse();
    expect(whisperCrashed({ exitCode: 0 })).toBeFalse();
    expect(whisperCrashed({ exitCode: 1 })).toBeFalse();
  });
});
