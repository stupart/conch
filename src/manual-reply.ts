import type { TurnEvent } from "./hook.ts";
import type { CancellableSpeech } from "./speech-manager.ts";
import { transcriptMark, userRespondedSince } from "./snippet.ts";

/** Dedicated control-flow signal: a text reply ends the active read/listen exchange. */
export class ManualReplyInterrupt extends Error {
  constructor(phase: "read-aloud" | "listening" = "read-aloud") {
    super(`manual reply received during ${phase}`);
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
 * so one metadata/append refresh finishes before the next, and the scoped
 * playback handle prevents a late result from cancelling another session's
 * speech. Unchanged polls reuse the transcript reader's parsed count.
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

export interface AbortableListen {
  abort(): void | Promise<void>;
}

export interface ManualReplyListenGuard {
  readonly interrupted: boolean;
  readonly done: Promise<void>;
  /**
   * Serialize behind any active poll, check once more, then make future
   * transcript changes invisible. False means a manual reply won the boundary.
   */
  closeBeforeSubmit(): Promise<boolean>;
}

/** Explicit wakes start a fresh transcript baseline; automatic turns keep their hook-time mark. */
export async function manualReplyListenBaseline(
  event: Pick<TurnEvent, "type" | "transcriptPath" | "mark">,
): Promise<Pick<TurnEvent, "transcriptPath" | "mark">> {
  return event.type === "wake" && event.transcriptPath
    ? { transcriptPath: event.transcriptPath, mark: await transcriptMark(event.transcriptPath) }
    : { transcriptPath: event.transcriptPath, mark: event.mark };
}

/**
 * Poll one turn's transcript while its dictation exchange is live. Unlike the
 * speech watcher, this deliberately has no post-done check: normal submission
 * writes conch's own injected prompt before the exchange's cleanup promise
 * settles. closeBeforeSubmit owns the final serialized check and cutoff.
 */
export function createManualReplyListenGuard(
  event: Pick<TurnEvent, "transcriptPath" | "mark">,
  session: AbortableListen,
  exchangeDone: Promise<void>,
  enabled: () => boolean,
  onInterrupt: () => void = () => {},
  pollMs = 120,
): ManualReplyListenGuard {
  let accepting = true;
  let manualReply = false;
  let checking: Promise<void> | null = null;
  let abortDone: Promise<void> | null = null;
  let interruptError: unknown;

  const checkEnabled = (): boolean => accepting && enabled();

  const beginInterrupt = (): void => {
    if (manualReply) return;
    manualReply = true;
    accepting = false;
    try {
      onInterrupt();
    } catch (error) {
      interruptError = error;
    }
    try {
      abortDone = Promise.resolve(session.abort());
    } catch (error) {
      abortDone = Promise.reject(error);
    }
    // The exchange owns barrier acknowledgement and may not await us until its
    // cleanup finishes. Observe rejection immediately, then surface it via done.
    void abortDone.catch(() => {});
  };

  const check = (): Promise<void> => {
    if (checking) return checking;
    if (manualReply || !checkEnabled()) return Promise.resolve();
    checking = (async () => {
      try {
        if (await manualReplyNow(event, checkEnabled)) beginInterrupt();
      } finally {
        checking = null;
      }
    })();
    return checking;
  };

  void check(); // catch a reply in the handoff between the mic gate and first tick
  const timer = setInterval(() => void check(), pollMs);
  const done = (async (): Promise<void> => {
    let exchangeError: unknown;
    try {
      await exchangeDone;
    } catch (error) {
      exchangeError = error;
    } finally {
      clearInterval(timer);
      if (checking) await checking;
    }

    let abortError: unknown;
    if (abortDone) {
      try {
        await abortDone;
      } catch (error) {
        abortError = error;
      }
    }
    if (interruptError) throw interruptError;
    if (abortError) throw abortError;
    if (manualReply) throw new ManualReplyInterrupt("listening");
    if (exchangeError) throw exchangeError;
  })();

  return {
    get interrupted() {
      return manualReply;
    },
    done,
    async closeBeforeSubmit() {
      if (!accepting) return !manualReply;
      // A poll may already be reading the old transcript. Let it finish while
      // the gate stays open, then run a fresh serialized check of our own.
      if (checking) await checking;
      if (manualReply) return false;
      await check();
      if (manualReply) return false;
      accepting = false;
      return true;
    },
  };
}

export function watchManualReplyDuringListen(
  event: Pick<TurnEvent, "transcriptPath" | "mark">,
  session: AbortableListen,
  done: Promise<void>,
  enabled: () => boolean,
  pollMs = 120,
): Promise<void> {
  return createManualReplyListenGuard(event, session, done, enabled, () => {}, pollMs).done;
}
