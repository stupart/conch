import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import {
  checkConchBinaries,
  checkMicrophone,
  checkTts,
  checkWhisperServer,
  formatDoctorProbe,
  microphoneProbeCommand,
  MICROPHONE_PROBE_DURATION_MS,
  pcm16HasNonZeroSample,
  TTS_PROBE_WORD,
} from "../src/doctor-checks.ts";

function config() {
  return loadConfig({
    env: {},
    settingsPath: `/tmp/conch-doctor-checks-${process.pid}/settings.json`,
  });
}

describe("microphone doctor probe", () => {
  test("uses a finite 300ms mono PCM capture", () => {
    expect(microphoneProbeCommand()).toEqual([
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      "-",
      "trim", "0", "0.3",
    ]);
  });

  test("classifies complete signed 16-bit samples instead of stray bytes", () => {
    expect(pcm16HasNonZeroSample(new Uint8Array([0, 0, 0, 0]))).toBeFalse();
    expect(pcm16HasNonZeroSample(new Uint8Array([1, 0]))).toBeTrue();
    expect(pcm16HasNonZeroSample(new Uint8Array([0, 128]))).toBeTrue();
    expect(pcm16HasNonZeroSample(new Uint8Array([0, 0, 7]))).toBeFalse();
  });

  test("passes nonzero capture and keeps the default probe short", async () => {
    let receivedDuration = 0;
    const result = await checkMicrophone({
      capture: async (durationMs) => {
        receivedDuration = durationMs;
        return { pcm: new Uint8Array([0, 0, 2, 0]) };
      },
    });

    expect(receivedDuration).toBe(MICROPHONE_PROBE_DURATION_MS);
    expect(result).toEqual({
      ok: true,
      label: "microphone",
      message: "microphone captured non-zero audio (300ms)",
    });
  });

  test("all-zero capture reports likely permission denial and the exact settings pane", async () => {
    const result = await checkMicrophone({
      capture: async () => ({ pcm: new Uint8Array(9_600) }),
    });

    expect(result.ok).toBeFalse();
    expect(result.message).toContain("all zeros");
    expect(result.message).toContain("microphone-permission");
    expect(result.action).toContain("System Settings › Privacy & Security › Microphone");
    expect(formatDoctorProbe(result)).toStartWith("⚠️");
  });

  test("capture errors become actionable advisory results", async () => {
    const result = await checkMicrophone({
      capture: async () => { throw new Error("SoX exited with code 1"); },
    });

    expect(result).toMatchObject({ ok: false, label: "microphone" });
    expect(result.message).toContain("SoX exited with code 1");
    expect(result.action).toContain("conch doctor");
  });
});

describe("TTS doctor probe", () => {
  test("speaks one short word through the injected configured-path seam", async () => {
    const cfg = config();
    cfg.speak = false;
    let received: { cfg: typeof cfg; word: string; timeoutMs: number } | undefined;
    const result = await checkTts(cfg, {
      speak: async (receivedCfg, word, timeoutMs) => {
        received = { cfg: receivedCfg, word, timeoutMs };
      },
    });

    expect(received?.cfg).toBe(cfg);
    expect(received?.word).toBe(TTS_PROBE_WORD);
    expect(received?.timeoutMs).toBe(5_000);
    expect(cfg.speak).toBeFalse();
    expect(result).toEqual({ ok: true, label: "TTS", message: "TTS spoke “Ready.”" });
  });

  test("a configured-path error says what to do and remains an advisory warning", async () => {
    const result = await checkTts(config(), {
      speak: async () => { throw new Error("say exited with code 1"); },
    });

    expect(result).toMatchObject({ ok: false, label: "TTS" });
    expect(result.message).toContain("say exited with code 1");
    expect(result.action).toContain("selected sound output and volume");
    expect(result.action).toContain("conch setup");
    expect(formatDoctorProbe(result)).toStartWith("⚠️");
  });
});

describe("conch binaries on PATH", () => {
  const executable = (...files: string[]) => (file: string) => files.includes(file);

  test("names every conch on PATH when there is more than one", () => {
    // The from-source trap: a brew binary and a `bun link`ed checkout both on
    // PATH, so the app and the daemon run different versions and nothing says
    // so. The first on PATH is the one a shell runs.
    const result = checkConchBinaries(
      "/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin",
      executable("/opt/homebrew/bin/conch", "/Users/me/.bun/bin/conch"),
    );
    expect(result).toMatchObject({ ok: false, label: "conch" });
    expect(result.message).toContain("2 on PATH");
    expect(result.message).toContain("/opt/homebrew/bin/conch, /Users/me/.bun/bin/conch");
    expect(result.action).toContain("Pick one install per machine");
    expect(formatDoctorProbe(result)).toStartWith("⚠️");
  });

  test("one conch, or a PATH that repeats its directory, is not a warning", () => {
    // PATH commonly lists /opt/homebrew/bin twice; that is one install.
    const result = checkConchBinaries(
      "/opt/homebrew/bin:/usr/bin::/opt/homebrew/bin",
      executable("/opt/homebrew/bin/conch"),
    );
    expect(result).toEqual({ ok: true, label: "conch", message: "conch: /opt/homebrew/bin/conch" });
    expect(checkConchBinaries("/usr/bin", executable()).ok).toBe(true);
  });

  test("doctor runs the check", () => {
    // The seam: the check is unit-tested above, but only this line makes
    // `conch doctor` print it.
    const source = readFileSync(new URL("../src/install.ts", import.meta.url), "utf8");
    const from = source.indexOf("export async function runDoctor");
    expect(from).toBeGreaterThan(-1);
    const doctor = source.slice(from, source.indexOf("function binaryExists", from));
    expect(doctor).toContain("formatDoctorProbe(checkConchBinaries())");
  });
});

describe("whisper-server state (D2)", () => {
  const cfg = { ...config(), whisperPort: 8642, whisperIdleUnloadMins: 20 };
  const record = { pid: 4242, port: 8642, daemonPid: 999, startedAt: 1 };
  const deps = (listening: boolean, alive: number[], spawn: typeof record | null = record) => ({
    listening: async () => listening,
    record: () => spawn,
    alive: (pid: number) => alive.includes(pid),
  });

  test("says warm (owned or adopted), unloaded, or not listening — never as a fault", async () => {
    const owned = await checkWhisperServer(cfg, deps(true, [4242, 999]));
    expect(owned).toEqual({ ok: true, label: "whisper-server", message: "whisper-server: warm on :8642 (owned by conch daemon 999)" });
    // Listening, but the recorded daemon is dead, or the record is for another port: someone else's.
    expect((await checkWhisperServer(cfg, deps(true, [4242]))).message).toContain("adopted");
    expect((await checkWhisperServer(cfg, deps(true, [4242, 999], { ...record, port: 8643 }))).message).toContain("adopted");
    expect((await checkWhisperServer(cfg, deps(true, [], null))).message).toContain("adopted");
    // Its daemon is up and nothing listens: idle-unloaded (or still warming).
    const unloaded = await checkWhisperServer(cfg, deps(false, [999]));
    expect(unloaded.ok).toBeTrue();
    expect(unloaded.message).toContain("whisper-server: unloaded — daemon 999 is up");
    expect(unloaded.message).toContain("20 min");
    // With the window off nothing was unloaded, so the line must not say so.
    const never = await checkWhisperServer({ ...cfg, whisperIdleUnloadMins: 0 }, deps(false, [999]));
    expect(never.message).not.toContain("unloaded —");
    expect(never.message).toContain("whisper-idle-unload is 0");
    expect((await checkWhisperServer(cfg, deps(false, []))).message).toBe("whisper-server: not listening on :8642 — starts with the daemon");
    expect((await checkWhisperServer({ ...cfg, whisperPort: 0 }, deps(true, [4242, 999]))).message).toContain("cold cli only");
    expect(formatDoctorProbe(unloaded)).toStartWith("✅");
  });

  test("doctor prints it", () => {
    const source = readFileSync(new URL("../src/install.ts", import.meta.url), "utf8");
    const from = source.indexOf("export async function runDoctor");
    expect(from).toBeGreaterThan(-1);
    const doctor = source.slice(from, source.indexOf("function binaryExists", from));
    expect(doctor).toContain("formatDoctorProbe(await checkWhisperServer(cfg))");
  });
});
