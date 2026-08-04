import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";

/**
 * Structured telemetry for tuning conch by numbers instead of by ear.
 *
 * The human log (`/tmp/conch-daemon.log`) is prose meant to be read live; it is
 * useless for "is this chunk louder than the others" or "how long does a turn
 * actually take". This is the other half: one JSON object per line, one line per
 * measurable event, so a question about behaviour can be answered with awk
 * rather than argued about.
 *
 * Recording is BEST EFFORT and must never break the voice loop — every failure
 * here is swallowed. Telemetry that can take down the daemon is worse than none.
 */

export const TELEMETRY_PATH = "/tmp/conch-telemetry.jsonl";
const MAX_TELEMETRY_BYTES = 8 * 1024 * 1024;

export type TelemetryEvent =
  // audio out
  | "tts.synth"
  | "tts.fallback"
  | "tts.play"
  // audio in
  | "mic.capture"
  | "stt.transcribe"
  // delivery
  | "inject"
  // lifecycle
  | "turn"
  | "recovery";

export interface TelemetrySink {
  record(event: TelemetryEvent, fields: Record<string, unknown>): void;
}

function rotate(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > MAX_TELEMETRY_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {}
}

/**
 * Append one telemetry record. Values are written verbatim, so keep them small
 * and non-sensitive: counts, durations, levels, enums — never transcript text.
 * Dictation is private, and this file exists to be shared when tuning.
 */
export function recordTelemetry(
  event: TelemetryEvent,
  fields: Record<string, unknown>,
  path: string = TELEMETRY_PATH,
): void {
  try {
    rotate(path);
    const line = JSON.stringify({ ts: Date.now(), event, ...fields });
    appendFileSync(path, `${line}\n`);
    // Same reasoning as the daemon log: it lives in a world-readable /tmp.
    try { chmodSync(path, 0o600); } catch {}
  } catch {}
}

/** Round to a fixed precision without dragging float noise into the file. */
export function round(value: number, places = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
