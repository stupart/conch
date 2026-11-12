import { describe, expect, test } from "bun:test";
import { CaptureGate, PcmGain } from "../src/capture-gate.ts";
import { SpeechEndpointer } from "../src/speech-endpoint.ts";

/**
 * The start of a capture on conch Microphone's stream: sox's `silence 1 0.15
 * X%` trigger, the 0.3s pre-roll and `gain`, done on synthetic PCM — a noise
 * floor, tones shaped like syllables — never a microphone.
 */

const RATE = 16_000;

/** Deterministic low-level noise (a room's floor, ±`amplitude`), distinct from sample to sample. */
function floor(seconds: number, amplitude = 40, seed = 1): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  let state = seed;
  for (let i = 0; i < out.length; i++) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    out[i] = Math.round(((state / 0x7fffffff) * 2 - 1) * amplitude);
  }
  return out;
}

/** A tone at `level` of full scale (peak), like a voiced syllable. */
function tone(seconds: number, level = 0.1, hz = 220): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * level * 32_767);
  return out;
}

function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function bytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  return out;
}

function samplesOf(data: Uint8Array): Int16Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Int16Array.from({ length: data.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

/** Feed `data` in pieces of `size` bytes (odd sizes split samples) and collect what the file would gain. */
function feed(gate: CaptureGate, data: Uint8Array, size = data.byteLength): Uint8Array {
  const out: number[] = [];
  for (let at = 0; at < data.byteLength; at += size) out.push(...gate.push(data.subarray(at, at + size)));
  return Uint8Array.from(out);
}

const options = { startPct: 2, prerollSecs: 0.3 };

describe("conch Microphone's capture gate", () => {
  test("writes nothing while the room is quiet", () => {
    const gate = new CaptureGate(options);
    expect(feed(gate, bytes(floor(2)))).toHaveLength(0);
    expect(gate.open).toBeFalse();
    expect(gate.seconds).toBeCloseTo(2, 5);
  });

  test("opens after 0.15s above the threshold and begins 0.3s before that run, then writes everything live", () => {
    const quiet = floor(1);
    const speech = tone(1);
    const after = floor(0.5, 40, 7);
    const input = join(quiet, speech, after);
    const gate = new CaptureGate(options);
    const out = samplesOf(feed(gate, bytes(input)));
    expect(gate.open).toBeTrue();
    // Everything from the pre-roll on, unchanged: the file ends where the stream does (no delay line).
    const start = input.length - out.length;
    expect(Array.from(out)).toEqual(Array.from(input.subarray(start)));
    // It begins about 0.3s before the speech: sox's RMS window takes a few samples to cross 2%.
    const lead = (quiet.length - start) / RATE;
    expect(lead).toBeGreaterThan(0.29);
    expect(lead).toBeLessThan(0.31);
  });

  test("speech is noticed as it arrives: the file grows when the 0.15s run completes, not later", () => {
    const gate = new CaptureGate(options);
    const quiet = bytes(floor(1));
    expect(gate.push(quiet)).toHaveLength(0);
    const speech = bytes(tone(0.3));
    // 0.14s of speech is not yet a start...
    expect(gate.push(speech.subarray(0, Math.round(0.14 * RATE) * 2))).toHaveLength(0);
    // ...0.16s is, and the file gets the pre-roll and the run at once.
    const grown = gate.push(speech.subarray(Math.round(0.14 * RATE) * 2, Math.round(0.16 * RATE) * 2));
    expect(grown.byteLength / 2 / RATE).toBeGreaterThan(0.44);
    expect(grown.byteLength / 2 / RATE).toBeLessThan(0.47);
  });

  test("a dip below the threshold starts the 0.15s count again, as sox's start does", () => {
    const gate = new CaptureGate(options);
    // Two 0.1s bursts with a 50ms gap: neither run reaches 0.15s.
    expect(feed(gate, bytes(join(floor(0.5), tone(0.1), floor(0.05), tone(0.1), floor(0.5))))).toHaveLength(0);
    expect(gate.open).toBeFalse();
    expect(feed(gate, bytes(tone(0.2))).byteLength).toBeGreaterThan(0);
  });

  test("a click that is loud for less than 0.15s never opens it", () => {
    const gate = new CaptureGate(options);
    expect(feed(gate, bytes(join(floor(0.5), tone(0.03, 0.9), floor(1))))).toHaveLength(0);
  });

  test("the threshold is the mono signal's, as the thresholds were tuned", () => {
    // A sine's RMS is its peak / √2: 0.03 peak is 2.12% RMS — above 2%; 0.028 peak is 1.98% — below.
    expect(feed(new CaptureGate(options), bytes(tone(0.5, 0.03))).byteLength).toBeGreaterThan(0);
    expect(feed(new CaptureGate(options), bytes(tone(0.5, 0.028)))).toHaveLength(0);
    // A higher threshold (barge-in sits above speaker bleed) needs more.
    expect(feed(new CaptureGate({ ...options, startPct: 6 }), bytes(tone(0.5, 0.06)))).toHaveLength(0);
    expect(feed(new CaptureGate({ ...options, startPct: 6 }), bytes(tone(0.5, 0.1))).byteLength).toBeGreaterThan(0);
  });

  test("pieces of any size, odd ones splitting samples, give the same file as one piece", () => {
    const input = bytes(join(floor(0.7), tone(0.8), floor(0.4, 40, 3)));
    const whole = feed(new CaptureGate(options), input);
    for (const size of [1, 3, 513, 4_096, 8_191]) {
      expect(Array.from(feed(new CaptureGate(options), input, size))).toEqual(Array.from(whole));
    }
  });

  test("a stream younger than the pre-roll begins at its first sample", () => {
    const input = join(floor(0.1), tone(0.5));
    const out = feed(new CaptureGate(options), bytes(input));
    expect(Array.from(samplesOf(out))).toEqual(Array.from(input));
  });

  test("gain comes first, as sox's did: it lifts a quiet voice over the threshold, and clips at full scale", () => {
    const quietVoice = bytes(join(floor(0.5), tone(0.5, 0.02)));
    expect(feed(new CaptureGate(options), quietVoice)).toHaveLength(0);
    const lifted = samplesOf(feed(new CaptureGate({ ...options, gainDb: 6 }), quietVoice));
    expect(lifted.length).toBeGreaterThan(0);
    const loud = samplesOf(feed(new CaptureGate({ ...options, gainDb: 30 }), bytes(tone(0.5, 0.5))));
    expect(Math.max(...loud)).toBe(32_767);
    expect(Math.min(...loud)).toBe(-32_768);
  });

  test("notices a stream of exact zeros, the silence macOS hands a recorder it has not allowed", () => {
    const zeros = new CaptureGate(options);
    feed(zeros, new Uint8Array(RATE * 2 * 2));
    expect(zeros.digitalSilence).toBeTrue();
    const room = new CaptureGate(options);
    feed(room, bytes(floor(2, 2)));
    expect(room.digitalSilence).toBeFalse();
    expect(new CaptureGate(options).digitalSilence).toBeFalse();
  });

  test("what it writes ends like any capture: conch's endpointer hears the pause after the words", () => {
    const gate = new CaptureGate(options);
    const endpointer = new SpeechEndpointer({ quietSecs: 1, thresholdPct: 2 });
    // Syllables with sub-threshold dips, then a pause long enough to end it.
    const said = join(floor(0.5), tone(0.25), floor(0.12), tone(0.3), floor(0.2), tone(0.25), floor(1.5, 40, 9));
    let ended = false;
    for (let at = 0; at < said.length && !ended; at += 1_365) ended = endpointer.feed(gate.push(bytes(said.subarray(at, at + 1_365))));
    expect(ended).toBeTrue();
  });
});

describe("gain on a recording kept whole", () => {
  test("doubles at +6 dB, clips, and carries a split sample over", () => {
    const gain = new PcmGain(20 * Math.log10(2));
    const input = bytes(Int16Array.from([100, -100, 20_000, -20_000]));
    const out = [...gain.push(input.subarray(0, 3)), ...gain.push(input.subarray(3))];
    expect(Array.from(samplesOf(Uint8Array.from(out)))).toEqual([200, -200, 32_767, -32_768]);
  });
});
