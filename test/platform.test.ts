import { test, expect } from "bun:test";
import {
  captureEnv,
  clipboardArgs,
  defaultBellSound,
  defaultCueSounds,
  platform,
  playFileArgs,
  serviceManager,
  speakArgs,
  supportsHidIdle,
  supportsUiScripting,
} from "../src/platform.ts";

const OPTS = { voice: "", sayRate: 0, sayVolume: 0.4 };

test("CONCH_PLATFORM forces the platform answer", () => {
  expect(platform({ CONCH_PLATFORM: "darwin" })).toBe("darwin");
  expect(platform({ CONCH_PLATFORM: "wsl" })).toBe("wsl");
  expect(platform({ CONCH_PLATFORM: "linux" })).toBe("linux");
  // junk values fall through to real detection instead of crashing
  expect(["darwin", "wsl", "linux"]).toContain(platform({ CONCH_PLATFORM: "beos" }));
});

test("darwin speakArgs is say with [[volm]] and stripped say-commands", () => {
  const args = speakArgs({ voice: "Samantha", sayRate: 200, sayVolume: 0.4 }, "hi [[slnc 500]] there", "darwin");
  expect(args).toEqual(["say", "-v", "Samantha", "-r", "200", "--", "[[volm 0.4]] hi slnc 500 there"]);
});

test("darwin speakArgs omits voice/rate flags when unset", () => {
  const args = speakArgs(OPTS, "hello", "darwin");
  expect(args).toEqual(["say", "--", "[[volm 0.4]] hello"]);
});

test("wsl speakArgs runs SAPI via powershell with base64 text", () => {
  const args = speakArgs(OPTS, "hello 'world' \"quotes\" — ünïcode", "wsl");
  expect(args[0]).toBe("powershell.exe");
  expect(args).toContain("-NoProfile");
  const script = args[args.length - 1]!;
  expect(script).toContain("System.Speech.Synthesis.SpeechSynthesizer");
  // the text itself never appears raw in the command — only its base64
  expect(script).not.toContain("hello 'world'");
  const b64 = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  expect(b64).toBeDefined();
  expect(Buffer.from(b64!, "base64").toString("utf8")).toBe("hello 'world' \"quotes\" — ünïcode");
});

test("wsl speakArgs maps wpm to SAPI rate and sayVolume to 0-100", () => {
  const def = speakArgs(OPTS, "x", "wsl").at(-1)!;
  expect(def).toContain("$s.Volume = 100"); // 0.4 (the say-calibrated default) = full volume
  expect(def).toContain("$s.Rate = 0");
  const fast = speakArgs({ ...OPTS, sayRate: 250, sayVolume: 0.2 }, "x", "wsl").at(-1)!;
  expect(fast).toContain("$s.Volume = 50");
  expect(fast).toContain("$s.Rate = 5");
  const clamped = speakArgs({ ...OPTS, sayRate: 500, sayVolume: 1 }, "x", "wsl").at(-1)!;
  expect(clamped).toContain("$s.Rate = 10");
  expect(clamped).toContain("$s.Volume = 100");
});

test("wsl speakArgs escapes single quotes in the voice name", () => {
  const script = speakArgs({ ...OPTS, voice: "O'Brien" }, "x", "wsl").at(-1)!;
  expect(script).toContain("SelectVoice('O''Brien')");
  expect(script).toContain("catch"); // unknown voice must not kill the utterance
});

test("linux speakArgs uses espeak-ng with -- guarding the text", () => {
  const args = speakArgs({ ...OPTS, sayRate: 180 }, "-dash first", "linux");
  expect(args[0]).toBe("espeak-ng");
  expect(args).toContain("-s");
  const dd = args.indexOf("--");
  expect(dd).toBeGreaterThan(0);
  expect(args[dd + 1]).toBe("-dash first");
});

test("playFileArgs: afplay on darwin, paplay elsewhere", () => {
  expect(playFileArgs("/a.wav", "darwin")).toEqual(["afplay", "/a.wav"]);
  expect(playFileArgs("/a.wav", "wsl")).toEqual(["paplay", "/a.wav"]);
  expect(playFileArgs("/a.wav", "linux")).toEqual(["paplay", "/a.wav"]);
});

test("captureEnv steers sox to pulseaudio off darwin", () => {
  expect(captureEnv("darwin")).toEqual({});
  expect(captureEnv("wsl")).toEqual({ AUDIODRIVER: "pulseaudio" });
  expect(captureEnv("linux")).toEqual({ AUDIODRIVER: "pulseaudio" });
});

test("clipboardArgs: pbcopy on darwin, clip.exe on wsl", () => {
  expect(clipboardArgs("darwin")).toEqual(["pbcopy"]);
  expect(clipboardArgs("wsl")).toEqual(["clip.exe"]);
  // bare linux probes for a tool; either finds one or reports none
  const linux = clipboardArgs("linux");
  if (linux) expect(["wl-copy", "xclip", "xsel"]).toContain(linux[0]!);
});

test("sound defaults are per-platform and cover all three cues", () => {
  expect(defaultBellSound("darwin")).toBe("/System/Library/Sounds/Glass.aiff");
  expect(defaultBellSound("wsl")).toContain("/mnt/c/Windows/Media/");
  expect(defaultBellSound("linux")).toContain("/usr/share/sounds/");
  for (const os of ["darwin", "wsl", "linux"] as const) {
    const cues = defaultCueSounds(os);
    expect(cues.open).toBeTruthy();
    expect(cues.close).toBeTruthy();
    expect(cues.sent).toBeTruthy();
  }
});

test("capability flags: UI scripting + HID idle are darwin-only, services map to the OS", () => {
  expect(supportsUiScripting("darwin")).toBe(true);
  expect(supportsUiScripting("wsl")).toBe(false);
  expect(supportsHidIdle("darwin")).toBe(true);
  expect(supportsHidIdle("linux")).toBe(false);
  expect(serviceManager("darwin")).toBe("launchd");
  expect(serviceManager("wsl")).toBe("systemd");
});
