import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETTING_DESCRIPTORS,
  SETTING_REGISTRY,
  loadSettingsFile,
  parseSetting,
  resolveSetting,
  unsetSetting,
  validateControlMessage,
  writeSetting,
  type SettingKey,
} from "../src/settings.ts";

const roots: string[] = [];

function parse(key: SettingKey, raw: unknown) {
  return SETTING_REGISTRY.get(key)!.parse(raw);
}

function tempSettings(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "conch-settings-test-"));
  roots.push(root);
  const path = join(root, "settings.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const expected = {
  "end-silence": ["endSilenceSecs", "CONCH_END_SILENCE_SECS", "live", 3.5],
  "mic-gain": ["micGainDb", "CONCH_MIC_GAIN_DB", "live", 0],
  "hold-submit-delay": ["holdSubmitSecs", "CONCH_HOLD_SUBMIT_SECS", "live", 8],
  "listen-window": ["listenWindowSecs", "CONCH_LISTEN_WINDOW_SECS", "live", 30],
  "typing-grace": ["typingGraceSecs", "CONCH_TYPING_GRACE_SECS", "live", 2],
  "barge-threshold": ["bargeThresholdPct", "CONCH_BARGE_THRESHOLD_PCT", "live", 0],
  "voice-speed": ["ttsSpeed", "CONCH_TTS_SPEED", "live", 1.35],
  "read-full": ["readFull", "CONCH_READ_FULL", "live", true],
  "interrupt-on-manual-reply": ["interruptOnManualReply", "CONCH_INTERRUPT_ON_MANUAL_REPLY", "live", true],
  "handoff-order": ["handoffOrder", "CONCH_HANDOFF_ORDER", "live", "oldest"],
  "reveal-on-turn": ["revealOnTurn", "CONCH_REVEAL_ON_TURN", "live", true],
  "working-mic": ["workingMic", "CONCH_WORKING_MIC", "live", false],
  "meeting-autopause": ["meetingAutopause", "CONCH_MEETING_AUTOPAUSE", "live", false],
  "announce-sentences": ["speakSentences", "CONCH_SPEAK_SENTENCES", "hook", 2],
  "announce-max-chars": ["speakMaxChars", "CONCH_SPEAK_MAX_CHARS", "hook", 350],
  "say-rate": ["sayRate", "CONCH_SAY_RATE", "live", 210],
} as const;

describe("settings registry", () => {
  test("contains exactly the 16 curated, default-bearing knobs", () => {
    const keys = [...SETTING_REGISTRY.keys()];
    expect(keys.sort()).toEqual(Object.keys(expected).sort());
    expect(SETTING_DESCRIPTORS).toHaveLength(16);
    for (const [key, [field, env, apply, defaultValue]] of Object.entries(expected)) {
      const descriptor = SETTING_REGISTRY.get(key);
      expect(descriptor).toMatchObject({ field, env, apply, default: defaultValue });
      expect(typeof descriptor?.help).toBe("string");
      expect(descriptor!.help.length).toBeGreaterThan(0);
      expect(descriptor!.bounds).toBeDefined();
    }
  });

  test("does not expose prototype keys as settings", () => {
    expect(SETTING_REGISTRY.get("__proto__")).toBeUndefined();
    expect(SETTING_REGISTRY.get("constructor")).toBeUndefined();
    expect(SETTING_REGISTRY.get("toString")).toBeUndefined();
    expect(parseSetting("__proto__", 1).ok).toBe(false);
    expect(parseSetting("constructor", 1).ok).toBe(false);
  });

  test("presents voice-speed while accepting kokoro-speed as a hidden alias", () => {
    expect(SETTING_REGISTRY.get("voice-speed")?.help).toBe("Kokoro/voice synthesis speed");
    expect(SETTING_REGISTRY.get("kokoro-speed")).toBeUndefined();
    expect(parseSetting("kokoro-speed", "1.2")).toEqual({
      ok: true,
      value: {
        descriptor: SETTING_REGISTRY.get("voice-speed")!,
        value: 1.2,
      },
    });
  });
});

describe("settings parser", () => {
  test("coerces CLI strings and accepts native JSON primitives", () => {
    expect(parse("end-silence", " 2.75 ")).toEqual({ ok: true, value: 2.75 });
    expect(parse("typing-grace", 0)).toEqual({ ok: true, value: 0 });
    expect(parse("read-full", "false")).toEqual({ ok: true, value: false });
    expect(parse("read-full", true)).toEqual({ ok: true, value: true });
    expect(parse("interrupt-on-manual-reply", "false")).toEqual({ ok: true, value: false });
    expect(parse("handoff-order", " OLDEST ")).toEqual({ ok: true, value: "oldest" });
  });

  test("enforces finite positive and zeroable number bounds", () => {
    for (const raw of [0, -1, "NaN", "Infinity", null, true]) {
      expect(parse("end-silence", raw).ok).toBe(false);
      expect(parse("voice-speed", raw).ok).toBe(false);
    }

    expect(parse("barge-threshold", 0)).toEqual({ ok: true, value: 0 });
    expect(parse("barge-threshold", 100)).toEqual({ ok: true, value: 100 });
    expect(parse("barge-threshold", -0.1).ok).toBe(false);
    expect(parse("barge-threshold", 100.1).ok).toBe(false);
    expect(parse("typing-grace", -0.1).ok).toBe(false);
  });

  test("accepts mic gain within bounds and rejects values outside", () => {
    expect(parse("mic-gain", " -20 ")).toEqual({ ok: true, value: -20 });
    expect(parse("mic-gain", 0)).toEqual({ ok: true, value: 0 });
    expect(parse("mic-gain", 12)).toEqual({ ok: true, value: 12 });
    expect(parse("mic-gain", 30)).toEqual({ ok: true, value: 30 });
    for (const raw of [-20.1, 30.1, "NaN", "Infinity", null, true]) {
      expect(parse("mic-gain", raw).ok).toBe(false);
    }
  });

  test("enforces integer-only announce and say values", () => {
    expect(parse("announce-sentences", 1)).toEqual({ ok: true, value: 1 });
    expect(parse("announce-sentences", 0).ok).toBe(false);
    expect(parse("announce-sentences", 1.5).ok).toBe(false);
    expect(parse("announce-max-chars", 1)).toEqual({ ok: true, value: 1 });
    expect(parse("announce-max-chars", 1.5).ok).toBe(false);
    expect(parse("say-rate", 0)).toEqual({ ok: true, value: 0 });
    expect(parse("say-rate", 210)).toEqual({ ok: true, value: 210 });
    expect(parse("say-rate", -1).ok).toBe(false);
    expect(parse("say-rate", 210.5).ok).toBe(false);
  });

  test("boolean parsing is strict", () => {
    expect(parse("reveal-on-turn", "true")).toEqual({ ok: true, value: true });
    expect(parse("reveal-on-turn", "false")).toEqual({ ok: true, value: false });
    expect(parse("working-mic", "1")).toEqual({ ok: true, value: true });
    expect(parse("working-mic", false)).toEqual({ ok: true, value: false });
    expect(parse("meeting-autopause", "true")).toEqual({ ok: true, value: true });
    expect(parse("meeting-autopause", false)).toEqual({ ok: true, value: false });
    expect(parse("interrupt-on-manual-reply", true)).toEqual({ ok: true, value: true });
    expect(parse("reveal-on-turn", "maybe").ok).toBe(false);
    expect(parse("working-mic", "sometimes").ok).toBe(false);
    expect(parse("meeting-autopause", "sometimes").ok).toBe(false);
    expect(parse("meeting-autopause", 1).ok).toBe(false);
    expect(parse("interrupt-on-manual-reply", "sometimes").ok).toBe(false);
    expect(parse("reveal-on-turn", 1).ok).toBe(false);
    expect(parse("reveal-on-turn", null).ok).toBe(false);
  });

  test("handoff-order accepts only the three queue policies", () => {
    expect(parse("handoff-order", "newest")).toEqual({ ok: true, value: "newest" });
    expect(parse("handoff-order", "oldest")).toEqual({ ok: true, value: "oldest" });
    expect(parse("handoff-order", "urgency")).toEqual({ ok: true, value: "urgency" });
    for (const raw of ["fifo", "", true, 1, null]) expect(parse("handoff-order", raw).ok).toBe(false);
  });

  test("parse failures include an actionable error", () => {
    const result = parse("barge-threshold", 101);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected parse failure");
    expect(typeof result.err).toBe("string");
    expect(result.err.length).toBeGreaterThan(0);
  });
});

describe("settings file persistence", () => {
  test("missing and valid files load without inheriting prototype properties", () => {
    const missing = tempSettings();
    const absent = loadSettingsFile(missing);
    expect(absent).toMatchObject({ path: missing, exists: false });
    expect(Object.keys(absent.values)).toEqual([]);
    expect(Object.getPrototypeOf(absent.values)).toBeNull();

    const path = tempSettings('{"read-full":false,"future-setting":{"kept":true}}\n');
    const loaded = loadSettingsFile(path);
    expect(loaded).toMatchObject({ path, exists: true });
    expect(loaded.error).toBeUndefined();
    expect(loaded.values).toEqual({ "read-full": false, "future-setting": { kept: true } });
    expect(Object.getPrototypeOf(loaded.values)).toBeNull();
  });

  test("writes native JSON atomically and preserves unrelated keys", () => {
    const path = tempSettings('{"future-setting":"keep me","read-full":true}\n');
    expect(writeSetting(path, "end-silence", "4.75")).toMatchObject({ value: 4.75 });
    expect(writeSetting(path, "read-full", "false")).toMatchObject({ value: false });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "future-setting": "keep me",
      "read-full": false,
      "end-silence": 4.75,
    });
    expect(readdirSync(join(path, ".."))).toEqual(["settings.json"]); // temp was renamed/cleaned
  });

  test("canonicalizes legacy voice-speed writes and unsets both spellings", () => {
    const path = tempSettings('{"kokoro-speed":1.1,"future-setting":"keep"}\n');
    expect(writeSetting(path, "kokoro-speed", "1.5")).toMatchObject({
      descriptor: { key: "voice-speed" },
      value: 1.5,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "future-setting": "keep",
      "voice-speed": 1.5,
    });

    writeFileSync(path, '{"voice-speed":1.4,"kokoro-speed":1.1,"future-setting":"keep"}\n');
    expect(unsetSetting(path, "kokoro-speed")).toMatchObject({
      descriptor: { key: "voice-speed" },
      changed: true,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "future-setting": "keep" });
  });

  test("unset removes only the requested key and avoids creating an absent file", () => {
    const path = tempSettings('{"end-silence":4.75,"read-full":false}\n');
    expect(unsetSetting(path, "end-silence")).toMatchObject({ changed: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "read-full": false });

    const absent = tempSettings();
    expect(unsetSetting(absent, "end-silence")).toMatchObject({ changed: false });
    expect(existsSync(absent)).toBe(false);
  });

  test("set and unset preserve a corrupt file and report an error", () => {
    const corrupt = "{ definitely not json\n";
    const setPath = tempSettings(corrupt);
    expect(() => writeSetting(setPath, "read-full", false)).toThrow("file left unchanged");
    expect(readFileSync(setPath, "utf8")).toBe(corrupt);

    const unsetPath = tempSettings(corrupt);
    expect(() => unsetSetting(unsetPath, "read-full")).toThrow("file left unchanged");
    expect(readFileSync(unsetPath, "utf8")).toBe(corrupt);
  });

  test("forbidden prototype keys make the file corrupt instead of entering a merge", () => {
    for (const key of ["__proto__", "constructor"]) {
      const raw = `{"${key}":1,"read-full":false}\n`;
      const path = tempSettings(raw);
      const loaded = loadSettingsFile(path);
      expect(loaded.error).toContain("forbidden key");
      expect(Object.keys(loaded.values)).toEqual([]);
      expect(() => writeSetting(path, "read-full", true)).toThrow("file left unchanged");
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });
});

describe("settings resolution", () => {
  function resolved(key: SettingKey, options: Parameters<typeof resolveSetting>[1]) {
    const result = resolveSetting(key, options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.err);
    return result.value;
  }

  test("resolves env > file > default with provenance", () => {
    const path = tempSettings('{"end-silence":4.75}\n');
    expect(resolved("end-silence", { env: { CONCH_END_SILENCE_SECS: "6.5" }, settingsPath: path }))
      .toEqual({ value: 6.5, source: "env" });
    expect(resolved("end-silence", { env: {}, settingsPath: path }))
      .toEqual({ value: 4.75, source: "file" });
    expect(resolved("end-silence", { env: {}, settingsPath: tempSettings() }))
      .toEqual({ value: 3.5, source: "default" });
  });

  test("resolves the legacy speed key only when the canonical key is absent", () => {
    expect(resolved("voice-speed", {
      env: {},
      settingsPath: tempSettings('{"kokoro-speed":1.1}\n'),
    })).toEqual({ value: 1.1, source: "file" });
    expect(resolved("voice-speed", {
      env: {},
      settingsPath: tempSettings('{"voice-speed":1.4,"kokoro-speed":1.1}\n'),
    })).toEqual({ value: 1.4, source: "file" });
    expect(resolved("voice-speed", {
      env: { CONCH_TTS_SPEED: "1.7" },
      settingsPath: tempSettings('{"kokoro-speed":1.1}\n'),
    })).toEqual({ value: 1.7, source: "env" });
  });

  test("reports and skips invalid higher-priority layers", () => {
    const fileFallback = tempSettings('{"end-silence":4.75}\n');
    const fromFile = resolved("end-silence", {
      env: { CONCH_END_SILENCE_SECS: "invalid" },
      settingsPath: fileFallback,
    });
    expect(fromFile).toMatchObject({ value: 4.75, source: "file" });
    expect(fromFile.diagnostic).toContain("CONCH_END_SILENCE_SECS");

    const invalidFile = tempSettings('{"end-silence":0}\n');
    const fromDefault = resolved("end-silence", {
      env: { CONCH_END_SILENCE_SECS: "invalid" },
      settingsPath: invalidFile,
    });
    expect(fromDefault).toMatchObject({ value: 3.5, source: "default" });
    expect(fromDefault.diagnostic).toContain("CONCH_END_SILENCE_SECS");
    expect(fromDefault.diagnostic).toContain("invalid file value");
  });

  test("a corrupt file falls through with a visible diagnostic", () => {
    const resolution = resolved("read-full", { env: {}, settingsPath: tempSettings("not json") });
    expect(resolution).toMatchObject({ value: true, source: "default" });
    expect(resolution.diagnostic).toContain("invalid settings file");
  });
});

describe("control-message validation", () => {
  test("accepts only the three discriminated control shapes and normalizes set values", () => {
    expect(validateControlMessage({ kind: "get-config" })).toEqual({
      ok: true,
      value: { kind: "get-config" },
    });
    expect(validateControlMessage({ kind: "unset-config", key: "read-full" })).toEqual({
      ok: true,
      value: { kind: "unset-config", key: "read-full" },
    });
    expect(validateControlMessage({ kind: "set-config", key: "read-full", value: "false" })).toEqual({
      ok: true,
      value: { kind: "set-config", key: "read-full", value: false },
    });
    expect(validateControlMessage({ kind: "set-config", key: "kokoro-speed", value: "1.25" })).toEqual({
      ok: true,
      value: { kind: "set-config", key: "voice-speed", value: 1.25 },
    });
  });

  test("rejects malformed wire JSON, bad values, and prototype keys", () => {
    for (const value of [
      null,
      [],
      { type: "mute", sessionId: "", label: "", announce: "" },
      { kind: "set-config", key: "read-full" },
      { kind: "set-config", key: "barge-threshold", value: 101 },
      { kind: "set-config", key: "__proto__", value: 1 },
      { kind: "unset-config", key: "constructor" },
      { kind: "surprise-config" },
    ]) {
      expect(validateControlMessage(value).ok).toBe(false);
    }
  });
});
