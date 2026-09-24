import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TimedSegment } from "./transcribe.ts";

/**
 * Show's narration. The Mac app's Show (mac-app/conch-mac/CanvasShow.swift)
 * records the screen and never opens the mic; Tyler's voice over it is
 * recorded HERE, so the mic keeps one owner. The daemon holds the mic the way
 * an open dictation holds it (`VoiceLoop.holdNarration`), records a WAV into
 * the canvas's folder, and on stop hands back what was said and when.
 *
 * A lease ends it without anyone asking: the app's connection that started it
 * is held open, and its going away — a crash, a quit — ends the narration, as
 * does the Show's two-minute cap plus a margin. A crashed app never holds the
 * mic.
 */

/** The Show's cap (CanvasStoryboard.longest, 120 s) and a margin for Send to arrive. */
export const NARRATION_LEASE_MS = 150_000;
/** How long a start waits for conch to finish a line before it is refused. */
export const NARRATION_QUIET_WITHIN_MS = 2_000;

export type NarrationRequest = { kind: "narration-start" | "narration-stop" | "narration-cancel"; canvasId: string };

export type NarrationReply =
  | { kind: "narration-started"; canvasId: string; startedAt: number }
  | { kind: "narration-refused"; canvasId: string; reason: string }
  | { kind: "narration-stopped"; canvasId: string; segments: TimedSegment[]; wav: string; error?: string }
  | { kind: "narration-cancelled"; canvasId: string }
  | { kind: "narration-error"; error: string };

/** A canvas's id names its folder, so only a UUID — what the app mints — is taken: nothing else can reach a path. */
const CANVAS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A socket request, or why it is not one; null when it is not a narration request at all. */
export function decodeNarrationRequest(value: unknown): NarrationRequest | { error: string } | null {
  if (!value || typeof value !== "object") return null;
  const { kind, canvasId } = value as Record<string, unknown>;
  if (kind !== "narration-start" && kind !== "narration-stop" && kind !== "narration-cancel") return null;
  if (typeof canvasId !== "string" || !CANVAS_ID.test(canvasId)) return { error: "canvasId must be a canvas's UUID" };
  return { kind, canvasId };
}

/**
 * The app's connection that started a narration, held open once it has: the
 * narration ends when this closes, and closes it when it ends. A refusal is
 * the connection's one answer, and the server closes it with that.
 */
export interface NarrationConnection {
  closed: Promise<void>;
  end(): void;
}

export interface NarrationRecorder {
  exited: Promise<number>;
  stop(): void;
}

export interface NarrationDeps {
  /** The mic, held as an open dictation holds it, or why not (`VoiceLoop.holdNarration`). */
  hold(): Promise<{ release(): void } | { refused: string }>;
  /** Start recording `wav`, for `seconds` at most. */
  record(wav: string, seconds: number): NarrationRecorder;
  transcribe(wav: string): Promise<{ segments: TimedSegment[]; error?: string }>;
  /** `~/.cache/conch/canvas`: a canvas's folder is its id under it. */
  root: string;
  leaseMs?: number;
  log(message: string): void;
}

export interface Narration {
  start(canvasId: string, connection: NarrationConnection): Promise<NarrationReply>;
  stop(canvasId: string): Promise<NarrationReply>;
  cancel(canvasId: string): Promise<NarrationReply>;
}

interface Running {
  canvasId: string;
  wav: string;
  recorder: NarrationRecorder;
  connection: NarrationConnection;
  lease: ReturnType<typeof setTimeout>;
  /** The recorder is gone and the mic released: stopped, cancelled, or killed with every other recorder. */
  ended: Promise<void>;
}

export function createNarration(deps: NarrationDeps): Narration {
  const leaseMs = deps.leaseMs ?? NARRATION_LEASE_MS;
  let running: Running | null = null;
  let starting = false;

  /** Recorder stopped, mic released, lease and connection let go; the entry is no longer running. */
  const end = async (entry: Running): Promise<void> => {
    if (running === entry) running = null;
    clearTimeout(entry.lease);
    entry.recorder.stop();
    await entry.ended;
    entry.connection.end();
  };

  const cancelled = async (entry: Running, why: string): Promise<NarrationReply> => {
    await end(entry);
    rmSync(entry.wav, { force: true });
    deps.log(`narration cancelled — ${why}`);
    return { kind: "narration-cancelled", canvasId: entry.canvasId };
  };

  const notRunning = (canvasId: string): NarrationReply =>
    ({ kind: "narration-error", error: `no narration is running for ${canvasId}` });

  return {
    async start(canvasId, connection) {
      const refused = (reason: string): NarrationReply => {
        deps.log(`narration refused — ${reason}`);
        return { kind: "narration-refused", canvasId, reason };
      };
      if (running || starting) return refused("a narration is already running");
      starting = true;
      try {
        const held = await deps.hold();
        if ("refused" in held) return refused(held.refused);
        const folder = join(deps.root, canvasId);
        const wav = join(folder, "narration.wav");
        let recorder: NarrationRecorder;
        try {
          // For Tyler alone, as the app keeps a canvas: the folders 0700, the file 0600 before sox writes a byte.
          mkdirSync(folder, { recursive: true });
          chmodSync(deps.root, 0o700);
          chmodSync(folder, 0o700);
          writeFileSync(wav, "", { mode: 0o600 });
          chmodSync(wav, 0o600);
          recorder = deps.record(wav, Math.ceil(leaseMs / 1000));
        } catch (error) {
          held.release();
          rmSync(wav, { force: true });
          deps.log(`narration could not record: ${error}`);
          return refused("it couldn't record");
        }
        const entry: Running = {
          canvasId,
          wav,
          recorder,
          connection,
          lease: setTimeout(() => {
            if (running === entry) void cancelled(entry, "its lease ran out");
          }, leaseMs),
          // However the recorder went, the mic is released the moment it has.
          ended: recorder.exited.then(() => {}, () => {}).then(() => {
            held.release();
            if (running === entry) deps.log("narration's recorder stopped before the Show did");
          }),
        };
        running = entry;
        void connection.closed.then(() => {
          if (running === entry) void cancelled(entry, "the app that started it went away");
        });
        deps.log(`narration started for canvas ${canvasId.slice(0, 8)}`);
        return { kind: "narration-started", canvasId, startedAt: Date.now() };
      } finally {
        starting = false;
      }
    },

    async stop(canvasId) {
      const entry = running;
      if (entry?.canvasId !== canvasId) return notRunning(canvasId);
      await end(entry);
      try { chmodSync(entry.wav, 0o600); } catch {}
      const { segments, error } = await deps.transcribe(entry.wav);
      deps.log(`narration stopped — ${segments.length} segment${segments.length === 1 ? "" : "s"}${error ? ` (${error})` : ""}`);
      return { kind: "narration-stopped", canvasId, segments, wav: entry.wav, ...(error ? { error } : {}) };
    },

    async cancel(canvasId) {
      const entry = running;
      if (entry?.canvasId !== canvasId) return notRunning(canvasId);
      return cancelled(entry, "Esc");
    },
  };
}
