import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { renderSupervisorScript, serviceRestartCommands } from "../src/install.ts";

const roots: string[] = [];

function settingsPath(settings: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "conch-config-test-"));
  roots.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadConfig tunable layering", () => {
  test("uses the registry defaults, including barge off", () => {
    const cfg = loadConfig({ env: {}, settingsPath: settingsPath() });
    expect(cfg.bargeThresholdPct).toBe(0);
    expect(cfg.sayRate).toBe(210);
    expect(cfg.workingMic).toBe(false);
  });

  test("loads native numbers and booleans from settings.json", () => {
    const cfg = loadConfig({
      env: {},
      settingsPath: settingsPath({
        "end-silence": 4.25,
        "hold-submit-delay": 9.5,
        "listen-window": 42,
        "typing-grace": 0.75,
        "barge-threshold": 17,
        "kokoro-speed": 1.1,
        "read-full": false,
        "reveal-on-turn": false,
        "working-mic": true,
        "announce-sentences": 4,
        "announce-max-chars": 480,
        "say-rate": 0,
      }),
    });
    expect(cfg).toMatchObject({
      endSilenceSecs: 4.25,
      holdSubmitSecs: 9.5,
      listenWindowSecs: 42,
      typingGraceSecs: 0.75,
      bargeThresholdPct: 17,
      ttsSpeed: 1.1,
      readFull: false,
      revealOnTurn: false,
      workingMic: true,
      speakSentences: 4,
      speakMaxChars: 480,
      sayRate: 0,
    });
  });

  test("valid env overrides file, while an invalid env falls through to file", () => {
    const path = settingsPath({
      "end-silence": 4.25,
      "typing-grace": 1.5,
      "read-full": false,
      "working-mic": false,
    });
    const cfg = loadConfig({
      env: {
        CONCH_END_SILENCE_SECS: "2.75",
        CONCH_TYPING_GRACE_SECS: "not-a-number",
        CONCH_READ_FULL: "true",
        CONCH_WORKING_MIC: "true",
      },
      settingsPath: path,
    });
    expect(cfg.endSilenceSecs).toBe(2.75);
    expect(cfg.typingGraceSecs).toBe(1.5);
    expect(cfg.readFull).toBe(true);
    expect(cfg.workingMic).toBe(true);
  });

  test("invalid file values fall through to the registry default", () => {
    const cfg = loadConfig({
      env: {},
      settingsPath: settingsPath({
        "barge-threshold": 101,
        "announce-sentences": 2.5,
        "read-full": "sometimes",
        "working-mic": "sometimes",
      }),
    });
    expect(cfg.bargeThresholdPct).toBe(0);
    expect(cfg.speakSentences).toBe(2);
    expect(cfg.readFull).toBe(true);
    expect(cfg.workingMic).toBe(false);
  });

  test("zeroable env knobs preserve zero", () => {
    const cfg = loadConfig({
      env: {
        CONCH_TYPING_GRACE_SECS: "0",
        CONCH_BARGE_THRESHOLD_PCT: "0",
        CONCH_SAY_RATE: "0",
      },
      settingsPath: settingsPath({
        "typing-grace": 2,
        "barge-threshold": 25,
        "say-rate": 220,
      }),
    });
    expect(cfg.typingGraceSecs).toBe(0);
    expect(cfg.bargeThresholdPct).toBe(0);
    expect(cfg.sayRate).toBe(0);
  });
});

test("supervisor sources do not force the barge threshold", () => {
  const root = join(import.meta.dir, "..");
  const forcedBarge = /CONCH_BARGE_THRESHOLD_PCT\s*=/;
  expect(renderSupervisorScript("/opt/homebrew/bin/tmux", "conch daemon")).not.toMatch(forcedBarge);
  expect(readFileSync(join(root, "bin", "conch-supervisor.sh"), "utf8")).not.toMatch(forcedBarge);
  expect(readFileSync(join(root, "src", "install.ts"), "utf8")).not.toMatch(forcedBarge);
});

test("service install restarts the detached daemon before kicking its supervisor", () => {
  expect(serviceRestartCommands("/opt/homebrew/bin/tmux", 502)).toEqual([
    ["/opt/homebrew/bin/tmux", "kill-session", "-t", "conch"],
    ["launchctl", "kickstart", "-k", "gui/502/com.conch.daemon"],
  ]);
});
