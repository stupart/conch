/**
 * The words of a video dropped on the Mac's composer, timed, since the model can't watch the video.
 *
 * Tyler, 2026-10-11: "we should be able to attach videos via drag and drop and based i just tried and it failed." The
 * phone already sends a video as a contact sheet and a timed transcript: it writes the video's sound as whisper takes
 * it, uploads it, and asks `/transcript` (phone-bridge.ts) for the words. The Mac app does the same work on its side
 * (`VideoStoryboard.speech`, the phone's own code) and writes the recording straight into the same uploads folder, so
 * this is `/transcript` for the app on this Mac: the same rule for what may be transcribed (a recording in conch's
 * uploads folder, `ownUpload`), the same whisper (`transcribeWavSegments`). The Mac app's alone (phone-bridge.ts
 * `MAC_APP_ONLY_DECODERS`): the phone has its own route.
 */
import { ownUpload } from "./phone-uploads.ts";
import type { TimedSegment } from "./transcribe.ts";

export const VIDEO_TRANSCRIPT_KIND = "video-transcript";

export interface VideoTranscriptRequest {
  kind: typeof VIDEO_TRANSCRIPT_KIND;
  /** The recording of the video's sound, in conch's uploads folder. */
  path: string;
}

export type VideoTranscriptReply =
  | { kind: "video-transcript"; segments: TimedSegment[] }
  | { kind: "video-transcript-error"; error: string };

/** Null when `value` is not this request; an error when it is one, malformed. */
export function decodeVideoTranscriptRequest(value: unknown): VideoTranscriptRequest | { error: string } | null {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== VIDEO_TRANSCRIPT_KIND) return null;
  const path = (value as { path?: unknown }).path;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096) return { error: "path must be a recording's absolute path" };
  return { kind: VIDEO_TRANSCRIPT_KIND, path };
}

export interface VideoTranscriptDeps {
  /** conch's uploads folder (`PhoneUploads.directory`). */
  uploads: string;
  transcribe(wavPath: string): Promise<{ segments: TimedSegment[]; error?: string }>;
}

export interface VideoTranscripts {
  handle(request: VideoTranscriptRequest): Promise<VideoTranscriptReply>;
}

/**
 * One at a time, as `/transcript` does, because whisper is the voice loop's too; but a second waits its turn rather
 * than being turned away: two videos dropped together each get their words.
 */
export function createVideoTranscripts(deps: VideoTranscriptDeps): VideoTranscripts {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async handle(request) {
      const real = await ownUpload(request.path, deps.uploads);
      if (!real?.endsWith(".wav")) return { kind: "video-transcript-error", error: "not a recording in conch's uploads folder" };
      const turn = queue.then(() => deps.transcribe(real).catch((error) => ({ segments: [], error: String(error) })));
      queue = turn.catch(() => {});
      const { segments, error } = await turn;
      return error && !segments.length ? { kind: "video-transcript-error", error } : { kind: "video-transcript", segments };
    },
  };
}
