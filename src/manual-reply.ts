import type { TurnEvent } from "./hook.ts";
import type { CancellableSpeech } from "./speech-manager.ts";
import { userRespondedSince } from "./snippet.ts";

/** Dedicated control-flow signal: a text reply ends this read before any mic setup. */
export class ManualReplyInterrupt extends Error {
  constructor() {
    super("manual reply received during read-aloud");
    this.name = "ManualReplyInterrupt";
  }
}

async function manualReplyNow(
  event: Pick<TurnEvent, "transcriptPath" | "mark">,
  enabled: () => boolean,
): Promise<boolean> {
  if (!enabled()) return false;
  try {
    return (await userRespondedSince(event.transcriptPath, event.mark)) && enabled();
  } catch {
    return false; // transcript reads fail safe
  }
}

/** Close the no-playback boundaries between announcement, gaps, and chunks. */
export async function interruptForManualReply(
  event: Pick<TurnEvent, "transcriptPath" | "mark">,
  enabled: () => boolean,
): Promise<void> {
  if (await manualReplyNow(event, enabled)) throw new ManualReplyInterrupt();
}

/**
 * Poll one turn's transcript while its playback is live. Checks are serialized
 * because each one reads the full transcript, and the scoped playback handle
 * prevents a late result from cancelling another session's speech.
 */
export async function watchManualReplyDuringSpeech(
  event: Pick<TurnEvent, "transcriptPath" | "mark">,
  playback: CancellableSpeech,
  enabled: () => boolean,
  pollMs = 120,
): Promise<void> {
  let manualReply = false;
  let checking: Promise<void> | null = null;

  const check = (): Promise<void> => {
    if (checking) return checking;
    if (manualReply || !enabled()) return Promise.resolve();
    checking = (async () => {
      try {
        if (await manualReplyNow(event, enabled)) {
          manualReply = true;
          playback.cancel();
        }
      } finally {
        checking = null;
      }
    })();
    return checking;
  };

  void check(); // close the boundary before the first timer tick
  const timer = setInterval(() => void check(), pollMs);
  let playbackError: unknown;
  let playbackFailed = false;
  try {
    await playback.done;
  } catch (error) {
    playbackFailed = true;
    playbackError = error;
  } finally {
    clearInterval(timer);
    if (checking) await checking;
  }

  // Fold in a reply written as playback settled, before the caller can adopt a
  // barge recorder, start another chunk, or open the normal mic.
  await check();
  if (manualReply) throw new ManualReplyInterrupt();
  if (playbackFailed) throw playbackError;
}
