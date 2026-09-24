import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";

/**
 * A video's words, from the recording of its sound the phone uploaded beside it, timed, since the model can't watch the
 * video. Tyler (09-25): "vise versa if possible": the phone's own recordings, to the Mac.
 */
const TOKEN = "v".repeat(32);
const scratch = mkdtempSync(join(tmpdir(), "conch-phone-video-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bridge(transcribe: (path: string) => Promise<{ segments: Array<{ start: number; end: number; text: string }>; error?: string }>) {
  const uploads = mkdtempSync(join(scratch, "uploads-"));
  const heard: string[] = [];
  const application = createPhoneBridgeApplication({
    getState: () => ({ rows: [] }),
    forwardControl: async () => "{}",
    replyFor: async () => "",
    acceptUpload: async () => ({ received: 1, total: 1 }),
    uploadsDirectory: uploads,
    transcribe: async (path) => { heard.push(path); return transcribe(path); },
    log: () => {},
  }, { token: TOKEN });
  const ask = async (path: string, authorized = true) => {
    const response = await application.handle(new Request(`https://relay.invalid/transcript?path=${encodeURIComponent(path)}`, {
      headers: authorized ? { authorization: `Bearer ${TOKEN}` } : {},
    })) as Response;
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const put = (name: string, where = uploads) => {
    const path = join(where, name);
    writeFileSync(path, "RIFF");
    chmodSync(path, 0o600);
    return path;
  };
  return { ask, put, uploads, heard };
}

describe("/transcript", () => {
  test("a recording the phone sent comes back as timed words", async () => {
    const { ask, put } = bridge(async () => ({ segments: [{ start: 0.5, end: 2, text: "this button should be blue" }] }));
    expect(await ask(put("abcdef123456.wav"))).toEqual({ status: 200, body: { segments: [{ start: 0.5, end: 2, text: "this button should be blue" }] } });
  });

  test("only a finished recording in the uploads folder: not the video, not a file elsewhere, not a link out", async () => {
    const { ask, put, uploads, heard } = bridge(async () => ({ segments: [] }));
    const elsewhere = put("abcdef123456.wav", mkdtempSync(join(scratch, "elsewhere-")));
    symlinkSync(elsewhere, join(uploads, "linked123456.wav"));
    for (const path of [put("abcdef123456.mp4"), elsewhere, join(uploads, "linked123456.wav"), join(uploads, "missing12345.wav"), "relative.wav"]) {
      expect((await ask(path)).status).toBe(403);
    }
    expect((await ask(put("abcdef123456.wav"), false)).status).toBe(401);
    expect(heard).toEqual([]);
  });

  test("one at a time, and a failure says so", async () => {
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => { finish = resolve; });
    const { ask, put } = bridge(async () => { await slow; return { segments: [] }; });
    const first = ask(put("first1234567.wav"));
    expect(await ask(put("second123456.wav"))).toMatchObject({ status: 429 });
    finish();
    expect((await first).status).toBe(200);
    // Answered at once and kept alive while whisper works, so a failure comes in the body.
    const failing = bridge(async () => ({ segments: [], error: "Cold transcription timed out" }));
    expect(await failing.ask(failing.put("abcdef123456.wav"))).toEqual({ status: 200, body: { error: "Cold transcription timed out" } });
    const throwing = bridge(async () => { throw new Error("whisper went away"); });
    expect(await throwing.ask(throwing.put("abcdef123456.wav"))).toMatchObject({ status: 200, body: { error: expect.stringMatching(/whisper went away/) } });
    expect((await throwing.ask(throwing.put("again1234567.wav"))).status).toBe(200);
  });

  test("the answer starts before the words are ready, and keeps the link alive until they are", () => {
    const route = readFileSync(join(import.meta.dir, "..", "src/phone-bridge.ts"), "utf8");
    const body = route.slice(route.indexOf('if (url.pathname === "/transcript"'), route.indexOf("// Refresh on a deliverable"));
    expect(body).toContain("const alive = setInterval(() => controller.enqueue(new TextEncoder().encode(\" \")), TRANSCRIPT_KEEPALIVE_MS);");
    expect(body).toContain("clearInterval(alive);");
    expect(route).toContain("const TRANSCRIPT_KEEPALIVE_MS = 10_000;");
  });

  test("the daemon hands the bridge whisper's timed transcription", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    expect(daemon).toContain("transcribe: (wavPath) => transcribeWavSegments(cfg, wavPath),");
  });
});
