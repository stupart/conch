import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { forwardToDaemonSocket } from "../src/phone-bridge.ts";
import type { TimedSegment } from "../src/transcribe.ts";
import { createVideoTranscripts, decodeVideoTranscriptRequest, VIDEO_TRANSCRIPT_KIND } from "../src/video-transcript.ts";

/**
 * The words of a video dropped on the Mac's composer, timed: `/transcript` (phone-video.test.ts) for the app on this
 * Mac. Tyler, 2026-10-11: "we should be able to attach videos via drag and drop and based i just tried and it failed."
 * The app writes the video's sound into conch's uploads folder (`ComposerVideoPrep`) and asks for the words by its path.
 */
const scratch = mkdtempSync(join(tmpdir(), "conch-video-transcript-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function uploads() {
  const folder = mkdtempSync(join(scratch, "uploads-"));
  const put = (name: string, where = folder, mode = 0o600) => {
    const path = join(where, name);
    writeFileSync(path, "RIFF");
    chmodSync(path, mode);
    return path;
  };
  return { folder, put };
}

describe("the request", () => {
  test("is only its own kind, with a recording's absolute path", () => {
    expect(decodeVideoTranscriptRequest({ kind: "narration-stop", path: "/x.wav" })).toBeNull();
    expect(decodeVideoTranscriptRequest(null)).toBeNull();
    expect(decodeVideoTranscriptRequest({ kind: VIDEO_TRANSCRIPT_KIND, path: "/u/mac-1.wav" })).toEqual({ kind: VIDEO_TRANSCRIPT_KIND, path: "/u/mac-1.wav" });
    for (const path of [undefined, "", "relative.wav", 7, `/${"a".repeat(5000)}.wav`]) {
      expect(decodeVideoTranscriptRequest({ kind: VIDEO_TRANSCRIPT_KIND, path }), String(path)).toHaveProperty("error");
    }
  });
});

describe("what is transcribed", () => {
  test("a recording in conch's uploads folder comes back as timed words", async () => {
    const { folder, put } = uploads();
    const heard: string[] = [];
    const transcripts = createVideoTranscripts({
      uploads: folder,
      transcribe: async (path) => { heard.push(path); return { segments: [{ start: 0.4, end: 1.9, text: "this button should be blue" }] }; },
    });
    const wav = put("mac-0F3C1A2B-4D5E-4F60-8A7B-9C0D1E2F3A4B.wav");
    expect(await transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path: wav })).toEqual({
      kind: "video-transcript",
      segments: [{ start: 0.4, end: 1.9, text: "this button should be blue" }],
    });
    expect(heard.length).toBe(1);
  });

  test("only a recording there: not the video, not a file elsewhere, not a link out, not one that isn't there", async () => {
    const { folder, put } = uploads();
    const heard: string[] = [];
    const transcripts = createVideoTranscripts({ uploads: folder, transcribe: async (path) => { heard.push(path); return { segments: [] }; } });
    const elsewhere = put("abcdef123456.wav", mkdtempSync(join(scratch, "elsewhere-")));
    symlinkSync(elsewhere, join(folder, "linked123456.wav"));
    mkdirSync(join(folder, "nested"));
    const nested = put("nested123456.wav", join(folder, "nested"));
    for (const path of [put("mac-123456.mp4"), elsewhere, join(folder, "linked123456.wav"), join(folder, "missing12345.wav"), nested, put("runnable1234.wav", folder, 0o700)]) {
      expect(await transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path }), path).toEqual({
        kind: "video-transcript-error",
        error: "not a recording in conch's uploads folder",
      });
    }
    expect(heard).toEqual([]);
  });

  test("a failure says so; words that came with one are kept", async () => {
    const { folder, put } = uploads();
    const answers: Array<{ segments: TimedSegment[]; error?: string } | Error> = [
      { segments: [], error: "whisper isn't installed" },
      new Error("whisper crashed"),
      { segments: [{ start: 0, end: 1, text: "partly" }], error: "Transcription failed" },
    ];
    const transcripts = createVideoTranscripts({
      uploads: folder,
      transcribe: async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; },
    });
    const wav = put("mac-failure1.wav");
    expect(await transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path: wav })).toEqual({ kind: "video-transcript-error", error: "whisper isn't installed" });
    expect(await transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path: wav })).toEqual({ kind: "video-transcript-error", error: "Error: whisper crashed" });
    expect(await transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path: wav })).toEqual({ kind: "video-transcript", segments: [{ start: 0, end: 1, text: "partly" }] });
  });

  test("one at a time, as whisper is the voice loop's too, and a second waits its turn rather than being turned away", async () => {
    const { folder, put } = uploads();
    let running = 0, most = 0;
    const releases: Array<() => void> = [];
    const transcripts = createVideoTranscripts({
      uploads: folder,
      transcribe: async (path) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return { segments: [{ start: 0, end: 1, text: path.endsWith("first1.wav") ? "first" : "second" }] };
      },
    });
    const first = transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path: put("mac-first1.wav") });
    const second = transcripts.handle({ kind: VIDEO_TRANSCRIPT_KIND, path: put("mac-second.wav") });
    while (releases.length < 1) await Bun.sleep(1);
    await Bun.sleep(10);
    expect(releases.length).toBe(1);
    releases.shift()!();
    while (releases.length < 1) await Bun.sleep(1);
    releases.shift()!();
    expect(await first).toEqual({ kind: "video-transcript", segments: [{ start: 0, end: 1, text: "first" }] });
    expect(await second).toEqual({ kind: "video-transcript", segments: [{ start: 0, end: 1, text: "second" }] });
    expect(most).toBe(1);
  });
});

describe("over the Mac app's socket", () => {
  const servers: ControlServer[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function serve(videoTranscripts?: ReturnType<typeof createVideoTranscripts>): Promise<string> {
    // A short private path: a Unix socket's is capped near 104 bytes.
    const dir = mkdtempSync("/tmp/conch-vt-");
    dirs.push(dir);
    const socketPath = join(dir, "c.sock");
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: true, label: "a" }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      ...(videoTranscripts ? { videoTranscripts } : {}),
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    return socketPath;
  }

  test("asked as `ComposerVideoPrep.transcript` asks, it answers with the words, before any session is looked for", async () => {
    const { folder, put } = uploads();
    const wav = put("mac-socket01.wav");
    const socketPath = await serve(createVideoTranscripts({
      uploads: folder,
      transcribe: async () => ({ segments: [{ start: 1, end: 2.5, text: "watch the footer" }] }),
    }));
    const reply = JSON.parse(await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: VIDEO_TRANSCRIPT_KIND, path: wav })));
    expect(reply).toEqual({ kind: "video-transcript", segments: [{ start: 1, end: 2.5, text: "watch the footer" }] });
    // A malformed one is answered as one, not handed on as a session command.
    expect(JSON.parse(await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: VIDEO_TRANSCRIPT_KIND, path: "x.wav" }))))
      .toEqual({ kind: "video-transcript-error", error: "path must be a recording's absolute path" });
  });

  test("a daemon that can't transcribe says so, and the app sends the video without words", async () => {
    const socketPath = await serve();
    expect(JSON.parse(await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: VIDEO_TRANSCRIPT_KIND, path: "/u/mac-1.wav" }))))
      .toEqual({ kind: "video-transcript-error", error: "this conch can't transcribe" });
  });
});
