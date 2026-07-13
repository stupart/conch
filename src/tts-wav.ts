const RIFF = 0x46464952;
const WAVE = 0x45564157;
const FMT = 0x20746d66;
const DATA = 0x61746164;

export interface ParsedWav {
  format: 1 | 3;
  channels: number;
  sampleRate: number;
  bitsPerSample: 8 | 16 | 24 | 32;
  blockAlign: number;
  fmt: Uint8Array;
  data: Uint8Array;
}

function copySlice(bytes: Uint8Array, start: number, end: number): Uint8Array {
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end));
}

/** Parse uncompressed PCM/IEEE-float WAV, walking arbitrary padded RIFF chunks. */
export function parseWav(bytes: Uint8Array): ParsedWav | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WAVE) return null;
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd < 12 || riffEnd !== bytes.byteLength) return null;

  let fmt: Uint8Array | null = null;
  let data: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= riffEnd;) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const end = body + size;
    if (end + (size & 1) > riffEnd || end > bytes.byteLength) return null;
    if (id === FMT && !fmt) fmt = copySlice(bytes, body, end);
    if (id === DATA && !data) data = copySlice(bytes, body, end);
    offset = end + (size & 1);
  }
  if (!fmt || fmt.byteLength < 16 || !data) return null;

  const fv = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  const rawFormat = fv.getUint16(0, true);
  const channels = fv.getUint16(2, true);
  const sampleRate = fv.getUint32(4, true);
  const byteRate = fv.getUint32(8, true);
  const blockAlign = fv.getUint16(12, true);
  const bits = fv.getUint16(14, true);
  let format = rawFormat;
  if (rawFormat === 0xfffe) {
    if (fmt.byteLength < 40 || fv.getUint16(16, true) < 22) return null;
    const guidTail = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    if (guidTail.some((byte, index) => fv.getUint8(28 + index) !== byte)) return null;
    format = fv.getUint32(24, true);
  }
  if (format !== 1 && format !== 3) return null;
  if (!channels || !sampleRate || ![8, 16, 24, 32].includes(bits)) return null;
  if (format === 3 && bits !== 32) return null;
  if (blockAlign !== channels * (bits / 8) || data.byteLength % blockAlign !== 0) return null;
  if (byteRate !== sampleRate * blockAlign) return null;
  if (format === 3) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let offset = 0; offset < data.byteLength; offset += 4) {
      if (!Number.isFinite(dv.getFloat32(offset, true))) return null;
    }
  }

  return {
    format,
    channels,
    sampleRate,
    bitsPerSample: bits as ParsedWav["bitsPerSample"],
    blockAlign,
    fmt,
    data,
  };
}

function sampleMagnitude(view: DataView, offset: number, format: 1 | 3, bits: number): number {
  if (format === 3) return Math.abs(view.getFloat32(offset, true));
  switch (bits) {
    case 8:
      return Math.abs(view.getUint8(offset) - 128) / 128;
    case 16:
      return Math.abs(view.getInt16(offset, true)) / 32768;
    case 24: {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return Math.abs(value) / 8388608;
    }
    case 32:
      return Math.abs(view.getInt32(offset, true)) / 2147483648;
    default:
      return 0;
  }
}

export interface TrimWavOptions {
  threshold?: number;
  leadingSeconds?: number;
  trailingSeconds?: number;
}

/**
 * Trim silence without decoding out-of-process. Detection uses the historical
 * 0.3% amplitude and 0.02s leading window; at most 0.06s of trailing silence
 * is retained so adjacent sentences stay natural without mlx's long pad.
 */
export function trimWav(bytes: Uint8Array, options: TrimWavOptions = {}): Uint8Array | null {
  const wav = parseWav(bytes);
  if (!wav) return null;
  const threshold = options.threshold ?? 0.003;
  const leadingFrames = Math.max(1, Math.round((options.leadingSeconds ?? 0.02) * wav.sampleRate));
  const trailingFrames = Math.max(0, Math.round((options.trailingSeconds ?? 0.06) * wav.sampleRate));
  const frames = wav.data.byteLength / wav.blockAlign;
  const sampleBytes = wav.bitsPerSample / 8;
  const dataView = new DataView(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength);

  const frameStats = (frame: number): [number, number] => {
    const base = frame * wav.blockAlign;
    let energy = 0;
    let peak = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      const magnitude = sampleMagnitude(dataView, base + channel * sampleBytes, wav.format, wav.bitsPerSample);
      energy += magnitude * magnitude;
      peak = Math.max(peak, magnitude);
    }
    return [energy / wav.channels, peak];
  };

  // SoX's silence detector uses an amplitude window rather than requiring each
  // waveform sample (including zero crossings) to stay over threshold.
  const energy = new Float64Array(frames + 1);
  const peaks = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const [frameEnergy, peak] = frameStats(frame);
    energy[frame + 1] = energy[frame]! + frameEnergy;
    peaks[frame] = peak;
  }
  const windowRms = (start: number, count: number): number => {
    return Math.sqrt((energy[start + count]! - energy[start]!) / count);
  };

  let start = -1;
  for (let frame = 0; frame + leadingFrames <= frames; frame++) {
    if (windowRms(frame, leadingFrames) >= threshold) {
      start = frame;
      break;
    }
  }
  if (start < 0) return null;
  while (start < frames && peaks[start]! < threshold) start++;

  let lastSignalEnd = start + leadingFrames;
  for (let frame = frames - leadingFrames; frame >= start; frame--) {
    if (windowRms(frame, leadingFrames) >= threshold) {
      lastSignalEnd = frame + leadingFrames;
      break;
    }
  }
  while (lastSignalEnd > start && peaks[lastSignalEnd - 1]! < threshold) lastSignalEnd--;
  // This is deliberately retained silence, not another detection window.
  const end = Math.min(frames, lastSignalEnd + trailingFrames);
  const trimmedData = wav.data.subarray(start * wav.blockAlign, end * wav.blockAlign);
  if (!trimmedData.byteLength) return null;

  const fmtPad = wav.fmt.byteLength & 1;
  const dataPad = trimmedData.byteLength & 1;
  const total = 12 + 8 + wav.fmt.byteLength + fmtPad + 8 + trimmedData.byteLength + dataPad;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, RIFF, true);
  ov.setUint32(4, total - 8, true);
  ov.setUint32(8, WAVE, true);
  ov.setUint32(12, FMT, true);
  ov.setUint32(16, wav.fmt.byteLength, true);
  out.set(wav.fmt, 20);
  const dataHeader = 20 + wav.fmt.byteLength + fmtPad;
  ov.setUint32(dataHeader, DATA, true);
  ov.setUint32(dataHeader + 4, trimmedData.byteLength, true);
  out.set(trimmedData, dataHeader + 8);
  return out;
}
