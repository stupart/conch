/**
 * End-of-speech for a capture, decided by conch rather than by sox.
 *
 * 2026-11-11, Tyler: "fixing voice so it doesn't end and start transcribing."
 * sox's `silence` effect ended every capture, and SoX 14.4.2 with `-l` never
 * ends a pause when sound resumes: every quiet 20ms inside speech (the gap
 * between words, a stop consonant, a breath) adds to one running total, and the
 * capture closes once that total reaches `end-silence`. Through conch.app's own
 * sox, a 34s recording of 1.2s phrases with 0.5s pauses stopped at 13.25s. In
 * live dictation every capture ran 4–7s while the speaker talked straight
 * through, and each cut flipped the composer to "Transcribing…" mid-sentence.
 *
 * So sox only finds the start now, and this counts the quiet that follows:
 * the same measure sox uses (RMS over 20ms against a percentage of full scale),
 * but the count starts again at every frame above the threshold, so only an
 * unbroken pause of `quietSecs` ends the capture. It reads 16kHz mono PCM16 in
 * whatever pieces the recorder's file grows by, carrying split samples and
 * part-frames over to the next piece.
 */
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = SAMPLE_RATE / 50; // 20ms, sox's RMS window
const FRAME_BYTES = FRAME_SAMPLES * 2;

export interface SpeechEndpointOptions {
  /** An unbroken pause this long ends the capture. */
  quietSecs: number;
  /** A 20ms frame at or below this RMS, in percent of full scale, is quiet (sox's `silence` unit). */
  thresholdPct: number;
}

export class SpeechEndpointer {
  readonly #quietFrames: number;
  readonly #threshold: number;
  #carry = new Uint8Array(0);
  #trailingQuiet = 0;
  #ended = false;

  constructor(options: SpeechEndpointOptions) {
    this.#quietFrames = Math.max(1, Math.round(options.quietSecs * 50));
    this.#threshold = (Math.max(0, options.thresholdPct) / 100) * 32768;
  }

  /** Seconds of unbroken quiet at the end of what has been fed. */
  get trailingQuietSecs(): number {
    return this.#trailingQuiet / 50;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /**
   * Feed the bytes the capture grew by; true once the pause that ends it has
   * been heard. The quiet before the first word counts too, as it did in sox:
   * sox writes nothing until its start threshold is crossed, so that is only
   * the pre-roll, far shorter than any pause that ends a capture, and a click
   * that started a capture with nothing after it still ends like one.
   */
  feed(bytes: Uint8Array): boolean {
    if (this.#ended || bytes.byteLength === 0) return this.#ended;
    const data = this.#carry.byteLength ? concat(this.#carry, bytes) : bytes;
    const whole = data.byteLength - (data.byteLength % FRAME_BYTES);
    const view = new DataView(data.buffer, data.byteOffset, whole);
    for (let frame = 0; frame < whole; frame += FRAME_BYTES) {
      let sum = 0;
      for (let offset = frame; offset < frame + FRAME_BYTES; offset += 2) {
        const sample = view.getInt16(offset, true);
        sum += sample * sample;
      }
      if (Math.sqrt(sum / FRAME_SAMPLES) > this.#threshold) {
        this.#trailingQuiet = 0;
      } else if (++this.#trailingQuiet >= this.#quietFrames) {
        this.#ended = true;
        break;
      }
    }
    this.#carry = data.slice(whole);
    return this.#ended;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
