import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import type { CapturedAudio } from "../src/dictation-controller.ts";
import { createDictationSession, endpointQuietSecs, type DictationRuntime } from "../src/listen.ts";
import { SpeechEndpointer } from "../src/speech-endpoint.ts";

// 2026-11-11, Tyler: "fixing voice so it doesn't end and start transcribing."
// Every fixture here is synthesized: tones shaped like speech, no one's voice.

const RATE = 16_000;

/** 16kHz PCM16 of `secs` seconds at `amplitude` (0..1 of full scale), a 220Hz tone; 0 is digital silence. */
function tone(secs: number, amplitude: number): Int16Array {
  const out = new Int16Array(Math.round(secs * RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return out;
}

/**
 * A spoken phrase as the endpointer sees it: syllables at speaking level with
 * the short dips between them that fall below the 2% threshold — the quiet that
 * SoX 14.4.2's `silence -l` added up until it closed the capture mid-sentence.
 */
function phrase(secs: number): Int16Array[] {
  const parts: Int16Array[] = [];
  for (let t = 0; t < secs; t += 0.25) parts.push(tone(0.19, 0.12), tone(0.06, 0.004));
  return parts;
}

function pcm(parts: Int16Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return new Uint8Array(out.buffer);
}

/** Feed `bytes` in uneven pieces, as a recorder's file grows; the second at which the endpointer ended, or null. */
function endsAt(endpointer: SpeechEndpointer, bytes: Uint8Array, piece = 3_331): number | null {
  for (let at = 0; at < bytes.byteLength; at += piece) {
    if (endpointer.feed(bytes.subarray(at, Math.min(bytes.byteLength, at + piece)))) {
      return Math.min(bytes.byteLength, at + piece) / (RATE * 2);
    }
  }
  return null;
}

/** What the old sox recipe measured: every quiet 20ms frame, never reset by sound. */
function cumulativeQuietSecs(bytes: Uint8Array, thresholdPct: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let quiet = 0;
  for (let frame = 0; frame + 640 <= bytes.byteLength; frame += 640) {
    let sum = 0;
    for (let i = frame; i < frame + 640; i += 2) sum += view.getInt16(i, true) ** 2;
    if (Math.sqrt(sum / 320) <= (thresholdPct / 100) * 32768) quiet++;
  }
  return quiet / 50;
}

describe("conch ends a capture on one unbroken pause, not on the quiet inside speech", () => {
  const options = { quietSecs: endpointQuietSecs({ endSilenceSecs: 3.5 }), thresholdPct: 2 };

  test("a minute of talk with natural pauses stays one capture, and ends on the pause after it", () => {
    // Phrases of 1.5-4s with 0.4-2.5s pauses between them: a person thinking aloud.
    const parts: Int16Array[] = [];
    const pauses = [0.4, 0.8, 1.2, 0.5, 2.5, 0.6, 1.8, 0.4, 2.9, 0.7, 1.0, 0.5, 2.0, 0.6];
    for (const [index, pause] of pauses.entries()) {
      parts.push(...phrase(1.5 + (index % 4) * 0.8), tone(pause, 0));
    }
    parts.push(...phrase(2));
    const speech = pcm(parts);
    const speechSecs = speech.byteLength / (RATE * 2);
    expect(speechSecs).toBeGreaterThan(45);
    // The old recipe would have closed this capture long before the end.
    expect(cumulativeQuietSecs(speech, 2)).toBeGreaterThan(3.5 * 4);

    const endpointer = new SpeechEndpointer(options);
    expect(endsAt(endpointer, speech)).toBeNull();
    // Then the speaker stops: the capture ends once the pause (counted from the
    // last syllable's 60ms dip) reaches the file's share of end-silence.
    const after = endsAt(endpointer, pcm([tone(5, 0)]), 640);
    expect(after).not.toBeNull();
    expect(Math.abs(after! - (options.quietSecs - 0.06))).toBeLessThan(0.03); // within a frame and a half of carry
  });

  test("a pause just short of end-silence keeps the capture open, and sound resets it", () => {
    const endpointer = new SpeechEndpointer(options);
    const almost = options.quietSecs - 0.1;
    expect(endsAt(endpointer, pcm([...phrase(2), tone(almost, 0), ...phrase(1), tone(almost, 0), ...phrase(1)]))).toBeNull();
    expect(endpointer.trailingQuietSecs).toBeLessThan(0.1);
  });

  test("room tone below the threshold counts as quiet; a voice above it does not", () => {
    const endpointer = new SpeechEndpointer(options);
    expect(endsAt(endpointer, pcm([...phrase(2), tone(1, 0.01)]))).toBeNull();
    expect(endpointer.trailingQuietSecs).toBeGreaterThan(0.9);
    expect(endsAt(endpointer, pcm([tone(3, 0.01)]))).not.toBeNull();
  });

  test("samples and frames split across reads are carried over, not lost", () => {
    // Three seconds of syllables, the last ending on its 60ms dip: the pause
    // runs from 2.94s, and ends at the same moment read in frames or 7 bytes at a time.
    const audio = pcm([...phrase(3), tone(4, 0)]);
    const expected = 2.94 + options.quietSecs;
    const byFrame = endsAt(new SpeechEndpointer(options), audio, 640);
    const byOdd = endsAt(new SpeechEndpointer(options), audio, 7);
    expect(Math.abs(byFrame! - expected)).toBeLessThan(0.021);
    expect(Math.abs(byOdd! - byFrame!)).toBeLessThan(0.021);
  });

  test("once ended it stays ended", () => {
    const endpointer = new SpeechEndpointer(options);
    expect(endsAt(endpointer, pcm([tone(4, 0)]))).not.toBeNull();
    expect(endpointer.feed(pcm(phrase(1)))).toBeTrue();
    expect(endpointer.ended).toBeTrue();
  });
});

describe("the mic says transcribing only once it has closed", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  test("between captures the next recorder's state stands; the final drain says transcribing", async () => {
    const states: string[] = [];
    const captures: Array<{ finish(): void; stopped: string[] }> = [];
    const transcribed = deferred<void>();
    const runtime: Partial<DictationRuntime> = {
      armRecorder(_cfg, _tag, _pct, _minimum, _parent, _diagnostic, context, hooks, _partial, speechStarted) {
        const end = deferred<CapturedAudio>();
        const rawPath = `synthetic-${context.sequence}`;
        const stopped: string[] = [];
        hooks.onState?.("armed");
        captures.push({
          stopped,
          finish() {
            speechStarted();
            hooks.onState?.("capturing");
            end.resolve({ rawPath, finalBytes: 32_000, finalizedAt: Date.now() });
          },
        });
        return {
          finished: end.promise,
          hasSpeechStarted: () => true,
          stop(reason) {
            stopped.push(reason);
            end.resolve({ rawPath, finalBytes: 32_000, finalizedAt: Date.now(), cause: reason });
          },
        };
      },
      readCapture: () => new Uint8Array(32_000),
      async transcribe() {
        await transcribed.promise;
        return { text: "words" };
      },
      discard() {},
    };
    const cfg = loadConfig({ env: {}, settingsPath: "/tmp/conch-continuity-test/settings.json" });
    const session = createDictationSession(cfg, { onState: (state) => states.push(state) }, {}, runtime);
    session.start();
    await flush();
    expect(states).toEqual(["armed"]);

    // A capture ends while the speaker is mid-thought: the successor arms first,
    // and its transcription must not paint "transcribing" over the open mic.
    captures[0]!.finish();
    await flush();
    expect(captures).toHaveLength(2);
    expect(session.micOpen).toBeTrue();
    expect(states).toEqual(["armed", "capturing", "armed"]);
    transcribed.resolve();
    await session.nextEvent();
    expect(states.at(-1)).toBe("armed");

    // The dictation ends: no successor, the mic is closed, and now it is transcribing.
    const ticket = session.requestBarrier("dictation-spacebar");
    await flush();
    expect(session.micOpen).toBeFalse();
    expect(states.at(-1)).toBe("transcribing");
    while (true) {
      const event = await session.nextEvent();
      if (event.kind === "barrier") {
        session.acknowledge(event);
        if (event.id === ticket.id) break;
      }
    }
    await ticket.done;
  });
});
