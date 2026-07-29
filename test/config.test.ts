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
    expect(cfg.micGainDb).toBe(0);
    expect(cfg.sayRate).toBe(210);
    expect(cfg.workingMic).toBe(false);
    expect(cfg.announceSummary).toBe(false);
    expect(cfg.voiceQa).toBe(false);
    expect(cfg.resumeDigest).toBe(false);
    expect(cfg.meetingAutopause).toBe(false);
    expect(cfg.interruptOnManualReply).toBe(true);
    expect(cfg.handoffOrder).toBe("oldest");
  });

  test("loads native numbers and booleans from settings.json", () => {
    const cfg = loadConfig({
      env: {},
      settingsPath: settingsPath({
        "end-silence": 4.25,
        "mic-gain": 12,
        "hold-submit-delay": 9.5,
        "listen-window": 42,
        "typing-grace": 0.75,
        "barge-threshold": 17,
        "kokoro-speed": 1.1, // hidden legacy alias still loads
        "read-full": false,
        "interrupt-on-manual-reply": false,
        "handoff-order": "oldest",
        "reveal-on-turn": false,
        "working-mic": true,
        "announce-summary": true,
        "voice-qa": true,
        "resume-digest": true,
        "meeting-autopause": true,
        "announce-sentences": 4,
        "announce-max-chars": 480,
        "say-rate": 0,
      }),
    });
    expect(cfg).toMatchObject({
      endSilenceSecs: 4.25,
      micGainDb: 12,
      holdSubmitSecs: 9.5,
      listenWindowSecs: 42,
      typingGraceSecs: 0.75,
      bargeThresholdPct: 17,
      ttsSpeed: 1.1,
      readFull: false,
      interruptOnManualReply: false,
      handoffOrder: "oldest",
      revealOnTurn: false,
      workingMic: true,
      announceSummary: true,
      voiceQa: true,
      resumeDigest: true,
      meetingAutopause: true,
      speakSentences: 4,
      speakMaxChars: 480,
      sayRate: 0,
    });
  });

  test("prefers canonical voice-speed when both spellings are present", () => {
    const cfg = loadConfig({
      env: {},
      settingsPath: settingsPath({ "voice-speed": 1.45, "kokoro-speed": 1.1 }),
    });
    expect(cfg.ttsSpeed).toBe(1.45);
  });

  test("valid env overrides file, while an invalid env falls through to file", () => {
    const path = settingsPath({
      "end-silence": 4.25,
      "mic-gain": -3,
      "typing-grace": 1.5,
      "read-full": false,
      "interrupt-on-manual-reply": false,
      "handoff-order": "oldest",
      "working-mic": false,
      "announce-summary": true,
      "voice-qa": false,
      "resume-digest": false,
      "meeting-autopause": true,
    });
    const cfg = loadConfig({
      env: {
        CONCH_END_SILENCE_SECS: "2.75",
        CONCH_MIC_GAIN_DB: "12",
        CONCH_TYPING_GRACE_SECS: "not-a-number",
        CONCH_READ_FULL: "true",
        CONCH_INTERRUPT_ON_MANUAL_REPLY: "true",
        CONCH_HANDOFF_ORDER: "urgency",
        CONCH_WORKING_MIC: "true",
        CONCH_ANNOUNCE_SUMMARY: "false",
        CONCH_VOICE_QA: "true",
        CONCH_RESUME_DIGEST: "true",
        CONCH_MEETING_AUTOPAUSE: "false",
      },
      settingsPath: path,
    });
    expect(cfg.endSilenceSecs).toBe(2.75);
    expect(cfg.micGainDb).toBe(12);
    expect(cfg.typingGraceSecs).toBe(1.5);
    expect(cfg.readFull).toBe(true);
    expect(cfg.interruptOnManualReply).toBe(true);
    expect(cfg.handoffOrder).toBe("urgency");
    expect(cfg.workingMic).toBe(true);
    expect(cfg.announceSummary).toBe(false);
    expect(cfg.voiceQa).toBe(true);
    expect(cfg.resumeDigest).toBe(true);
    expect(cfg.meetingAutopause).toBe(false);

    const invalidMeetingEnv = loadConfig({
      env: { CONCH_MEETING_AUTOPAUSE: "sometimes" },
      settingsPath: path,
    });
    expect(invalidMeetingEnv.meetingAutopause).toBe(true);
  });

  test("invalid file values fall through to the registry default", () => {
    const cfg = loadConfig({
      env: {},
      settingsPath: settingsPath({
        "barge-threshold": 101,
        "announce-sentences": 2.5,
        "read-full": "sometimes",
        "interrupt-on-manual-reply": "sometimes",
        "handoff-order": "random",
        "working-mic": "sometimes",
        "announce-summary": "sometimes",
        "voice-qa": "sometimes",
        "resume-digest": "sometimes",
        "meeting-autopause": "sometimes",
      }),
    });
    expect(cfg.bargeThresholdPct).toBe(0);
    expect(cfg.speakSentences).toBe(2);
    expect(cfg.readFull).toBe(true);
    expect(cfg.interruptOnManualReply).toBe(true);
    expect(cfg.handoffOrder).toBe("oldest");
    expect(cfg.workingMic).toBe(false);
    expect(cfg.announceSummary).toBe(false);
    expect(cfg.voiceQa).toBe(false);
    expect(cfg.resumeDigest).toBe(false);
    expect(cfg.meetingAutopause).toBe(false);
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
