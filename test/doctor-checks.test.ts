import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import {
  checkMicrophone,
  checkTts,
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
