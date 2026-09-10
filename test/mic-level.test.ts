import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEVEL_WINDOW_BYTES, pcmLevel, readPcmTail } from "../src/listen.ts";
import { getLiveState, setMicLevel, setState } from "../src/status.ts";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function pcm(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return out;
}
const tone = (amplitude: number, n = 1600): number[] =>
  Array.from({ length: n }, (_, i) => Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000)));

/**
 * The mic button used to pulse identically whether conch was hearing you or
 * hearing nothing (C12). The level is what makes it honest, and it has to
 * be on a dB curve: speech is -30..-15 dBFS, which a linear RMS shows as
 * a meter that barely moves.
 */
test("silence is 0, full scale is 1, speech sits in between on a dB curve", () => {
  expect(pcmLevel(new Uint8Array(0))).toBe(0);
  expect(pcmLevel(pcm(new Array(1600).fill(0)))).toBe(0);
  expect(pcmLevel(pcm(new Array(1600).fill(32767)))).toBeCloseTo(1, 2);
  // A sine at 0.1 peak: RMS is peak/√2, so -23 dBFS, which maps to 0.54.
  const speech = pcmLevel(pcm(tone(0.1)));
  expect(speech).toBeGreaterThan(0.5);
  expect(speech).toBeLessThan(0.58);
  // Ten times the amplitude is +20 dB — higher, but nowhere near ten times.
  const loud = pcmLevel(pcm(tone(1)));
  expect(loud).toBeGreaterThan(speech);
  expect(loud).toBeLessThan(speech * 2);
  // Under the -50 dBFS floor is 0, never negative.
  expect(pcmLevel(pcm(new Array(1600).fill(20)))).toBe(0);
});

test("the tail read returns the last window, or the whole file when shorter", () => {
  const dir = mkdtempSync(join(tmpdir(), "conch-level-"));
  const path = join(dir, "raw.pcm");
  const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
  writeFileSync(path, bytes);
  const tail = readPcmTail(path, LEVEL_WINDOW_BYTES);
  expect(tail.length).toBe(LEVEL_WINDOW_BYTES);
  expect(Array.from(tail)).toEqual(Array.from(bytes.subarray(10_000 - LEVEL_WINDOW_BYTES)));
  writeFileSync(path, bytes.subarray(0, 100));
  expect(readPcmTail(path, LEVEL_WINDOW_BYTES).length).toBe(100);
  expect(readPcmTail(join(dir, "missing"), LEVEL_WINDOW_BYTES).length).toBe(0);
});

/**
 * `setState` rebuilds the live model on every call — and it is called on
 * every partial, several times a second mid-dictation. A level that did not
 * survive those would flicker to nothing between words.
 */
test("the level lives only while the mic is open, and survives partial updates", () => {
  setState("idle");
  setMicLevel(0.5);
  expect(getLiveState().level).toBeUndefined();
  setState("recording", "arch");
  setMicLevel(0.4321);
  expect(getLiveState().level).toBe(0.43);
  setState("recording", "arch", "a partial");
  expect(getLiveState().level).toBe(0.43);
  setMicLevel(1.7);
  expect(getLiveState().level).toBe(1);
  setState("transcribing", "arch");
  expect(getLiveState().level).toBeUndefined();
  setState("idle");
});

test("the recorder reports a level every tick while capturing, from the tail", () => {
  const listen = read("src/listen.ts");
  const at = listen.indexOf("const watchdog = setInterval(() => {");
  expect(at).toBeGreaterThan(-1);
  const end = listen.indexOf("}, CAPTURE_WATCHDOG_INTERVAL_MS);", at);
  expect(end).toBeGreaterThan(-1);
  const tick = listen.slice(at, end);
  expect(tick).toContain(
    "if (speechStartedAt !== null && hooks.onLevel) hooks.onLevel(pcmLevel(readPcmTail(raw, LEVEL_WINDOW_BYTES)));",
  );
  expect(tick).not.toContain("pcmLevel(readPcm(raw))");
});

test("the level reaches the apps", () => {
  expect(read("src/panel.ts")).toContain("...(live.level !== undefined ? { level: live.level } : {}),");
  expect(read("mac-app/conch-mac/Models.swift"))
    .toContain("level = (try? container.decodeIfPresent(Double.self, forKey: .level)) ?? 0");
  const composer = read("mac-app/conch-mac/ComposerView.swift");
  expect(composer).toContain(".animation(.easeOut(duration: 0.12), value: voiceLevel)");
  expect(composer).toContain('.symbolEffect(.variableColor.iterative, isActive: voiceState == "listening")');
});

test("the daemon hands the recorder's level to the live state", () => {
  const daemon = read("src/daemon.ts");
  const at = daemon.indexOf("export function listenHooks(");
  expect(at).toBeGreaterThan(-1);
  const end = daemon.indexOf("\n}\n", at);
  expect(end).toBeGreaterThan(-1);
  const hooks = daemon.slice(at, end);
  expect(hooks).toContain("} = { setState, setTranscriptPrefix, setMicLevel },");
  expect(hooks).toContain("onLevel: (level) => status.setMicLevel?.(level),");
});
