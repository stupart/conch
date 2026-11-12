/**
 * The start of a capture, on conch Microphone's stream (microphone-helper.ts).
 *
 * sox did three things to the microphone before conch saw a byte: `gain`,
 * `silence 1 0.15 X%` (nothing is written until speech has stayed above X%
 * for 0.15s) and, since 2026-11-11, a 0.3s pre-roll from a delayed copy of the
 * mic, so a soft first word is kept (listen.ts, soxCaptureArgs). The native
 * recorder writes the whole microphone, from the moment it opens, so this does
 * the same three in the daemon, and the capture file still begins the way
 * every reader of it expects: empty until speech starts, then the pre-roll,
 * then the live stream. Speech starting is still "the file grew"
 * (rawCaptureFileGrew), and the end is still conch's own (speech-endpoint.ts).
 *
 * The trigger is sox 14.4.2's, read from its silence.c: the RMS of the last
 * 20ms, recomputed at every sample, against a percentage of full scale, and
 * 0.15s of consecutive samples above it. One difference, on purpose: sox's
 * pre-roll recipe measured that RMS over the live channel interleaved with the
 * delayed one, which is still quiet when speech starts, so it asked for √2
 * times the threshold it was given. The thresholds were tuned on the plain
 * mono `silence` before the pre-roll, so this measures the mono signal, as
 * they were tuned.
 *
 * Unlike sox's delay line, the pre-roll here is a look-back: when speech
 * starts, the 0.3s before it is written at once and the file is live from
 * then on, not 0.3s behind the mic. So nothing has to drain at a stop, and
 * the quiet that ends a capture is measured as it happens (endpointQuietSecs).
 *
 * It also notices a stream that is exact digital zero: a real microphone has a
 * noise floor, and all-zero samples are what macOS hands a recorder it has not
 * allowed (doctor-checks.ts says the same). The recorder owner decides what to
 * do about it (microphone-helper.ts).
 */

const SAMPLE_RATE = 16_000;
/** sox's RMS window: rate / 50 samples, 20ms. */
const WINDOW_SAMPLES = SAMPLE_RATE / 50;

export interface CaptureGateOptions {
  /** sox `silence` start threshold, percent of full scale; 0 opens at the first sample. */
  startPct: number;
  /** How long speech must stay above the threshold: sox's 0.15s. */
  startSecs?: number;
  /** How much of the audio before the trigger's run the capture begins with. */
  prerollSecs: number;
  /** Software gain in dB, applied first, as sox's `gain` was. */
  gainDb?: number;
}

export class CaptureGate {
  readonly #threshold: number;
  readonly #runSamples: number;
  readonly #prerollSamples: number;
  readonly #gain: number;
  /** Squared samples of the last 20ms (sox's window), and their sum. */
  readonly #window = new Float64Array(WINDOW_SAMPLES);
  #windowAt = 0;
  #windowSum = 0;
  /** The gained samples not yet written: enough for the trigger's run and the pre-roll before it. */
  readonly #history: Int16Array;
  #historyAt = 0;
  #historyCount = 0;
  #run = 0;
  #open = false;
  #carry: number | null = null;
  #samples = 0;
  #heardNonZero = false;

  constructor(options: CaptureGateOptions) {
    this.#threshold = (Math.max(0, options.startPct) / 100) * 32_768;
    this.#runSamples = Math.max(1, Math.round((options.startSecs ?? 0.15) * SAMPLE_RATE));
    this.#prerollSamples = Math.max(0, Math.round(options.prerollSecs * SAMPLE_RATE));
    this.#gain = options.gainDb ? 10 ** (options.gainDb / 20) : 1;
    this.#history = new Int16Array(this.#runSamples + this.#prerollSamples + 1);
  }

  /** Speech has started: everything from here on is written. */
  get open(): boolean {
    return this.#open;
  }

  /** Seconds of the microphone's stream this gate has been fed. */
  get seconds(): number {
    return this.#samples / SAMPLE_RATE;
  }

  /** Every sample so far has been exactly zero (and there has been at least one). */
  get digitalSilence(): boolean {
    return this.#samples > 0 && !this.#heardNonZero;
  }

  /**
   * Feed what the recorder wrote (16kHz mono PCM16, in any pieces); returns
   * what the capture file gains: nothing until speech starts, then the
   * pre-roll and the speech so far, then everything.
   */
  push(bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength === 0) return bytes;
    const samples = this.#samplesOf(bytes);
    if (samples.length === 0) return new Uint8Array(0);
    if (this.#open) return toBytes(this.#gained(samples, 0, samples.length));
    for (let index = 0; index < samples.length; index++) {
      const raw = samples[index]!;
      this.#samples++;
      if (raw !== 0) this.#heardNonZero = true;
      const sample = this.#applyGain(raw);
      this.#remember(sample);
      // sox's compute_rms: the window as it would be with this sample in it.
      const square = sample * sample;
      const sum = this.#windowSum - this.#window[this.#windowAt]! + square;
      this.#window[this.#windowAt] = square;
      this.#windowSum = sum;
      this.#windowAt = (this.#windowAt + 1) % WINDOW_SAMPLES;
      if (Math.sqrt(Math.max(0, sum) / WINDOW_SAMPLES) > this.#threshold) {
        if (++this.#run >= this.#runSamples) {
          this.#open = true;
          const head = this.#recent(this.#run + this.#prerollSamples);
          const rest = this.#gained(samples, index + 1, samples.length);
          return toBytes(concatSamples(head, rest));
        }
      } else {
        this.#run = 0;
      }
    }
    return new Uint8Array(0);
  }

  #samplesOf(bytes: Uint8Array): Int16Array {
    let data = bytes;
    if (this.#carry !== null) {
      data = new Uint8Array(bytes.byteLength + 1);
      data[0] = this.#carry;
      data.set(bytes, 1);
      this.#carry = null;
    }
    const whole = data.byteLength - (data.byteLength % 2);
    if (whole < data.byteLength) this.#carry = data[data.byteLength - 1]!;
    const out = new Int16Array(whole / 2);
    const view = new DataView(data.buffer, data.byteOffset, whole);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
    return out;
  }

  #applyGain(sample: number): number {
    if (this.#gain === 1) return sample;
    return Math.max(-32_768, Math.min(32_767, Math.round(sample * this.#gain)));
  }

  #gained(samples: Int16Array, from: number, to: number): Int16Array {
    if (this.#open) {
      for (let i = from; i < to; i++) {
        this.#samples++;
        if (samples[i] !== 0) this.#heardNonZero = true;
      }
    }
    const out = new Int16Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = this.#applyGain(samples[i]!);
    return out;
  }

  #remember(sample: number): void {
    this.#history[this.#historyAt] = sample;
    this.#historyAt = (this.#historyAt + 1) % this.#history.length;
    this.#historyCount = Math.min(this.#history.length, this.#historyCount + 1);
  }

  /** The last `count` samples remembered (fewer when the stream is younger), oldest first. */
  #recent(count: number): Int16Array {
    const n = Math.min(count, this.#historyCount);
    const out = new Int16Array(n);
    const start = (this.#historyAt - n + this.#history.length) % this.#history.length;
    for (let i = 0; i < n; i++) out[i] = this.#history[(start + i) % this.#history.length]!;
    return out;
  }
}

function concatSamples(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Little-endian PCM16 bytes. */
function toBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

/**
 * sox's `gain` on its own, for a recording kept whole (narration, the mic
 * check): every sample, in whatever pieces they arrive, clipped to 16 bits.
 */
export class PcmGain {
  readonly #gain: number;
  #carry: number | null = null;

  constructor(gainDb: number) {
    this.#gain = 10 ** (gainDb / 20);
  }

  push(bytes: Uint8Array): Uint8Array {
    let data = bytes;
    if (this.#carry !== null) {
      data = new Uint8Array(bytes.byteLength + 1);
      data[0] = this.#carry;
      data.set(bytes, 1);
      this.#carry = null;
    }
    const whole = data.byteLength - (data.byteLength % 2);
    if (whole < data.byteLength) this.#carry = data[data.byteLength - 1]!;
    const out = new Uint8Array(whole);
    const input = new DataView(data.buffer, data.byteOffset, whole);
    const output = new DataView(out.buffer);
    for (let i = 0; i < whole; i += 2) {
      output.setInt16(i, Math.max(-32_768, Math.min(32_767, Math.round(input.getInt16(i, true) * this.#gain))), true);
    }
    return out;
  }
}
