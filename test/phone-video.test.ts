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

  test("the answer starts before the words are ready, and keeps the link alive until they are", async () => {
    const uploads = mkdtempSync(join(scratch, "uploads-"));
    const recording = join(uploads, "abcdef123456.wav");
    writeFileSync(recording, "RIFF");
    const application = createPhoneBridgeApplication({
      getState: () => ({ rows: [] }), forwardControl: async () => "{}", replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }), uploadsDirectory: uploads, log: () => {},
      transcribe: () => new Promise((resolve) => setTimeout(() => resolve({ segments: [{ start: 1, end: 2, text: "here" }] }), 150)),
    }, { token: TOKEN, transcriptKeepaliveMs: 20 });
    const started = Date.now();
    const response = await application.handle(new Request(`https://relay.invalid/transcript?path=${encodeURIComponent(recording)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })) as Response;
    // Answered at once, not when whisper is done.
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(100);
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) chunks.push(new TextDecoder().decode(read.value));
    // Spaces while it waits, then the words; JSON takes the spaces in front of its value.
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toBe(" ");
    expect(JSON.parse(chunks.join(""))).toEqual({ segments: [{ start: 1, end: 2, text: "here" }] });
    // The default stays well inside the 30 s a relay request may go without progress before the phone calls it stalled.
    const route = readFileSync(join(import.meta.dir, "..", "src/phone-bridge.ts"), "utf8");
    expect(Number(/const TRANSCRIPT_KEEPALIVE_MS = ([\d_]+);/.exec(route)?.[1]?.replaceAll("_", ""))).toBeLessThanOrEqual(10_000);
  });

  /**
   * The phone can go before the words come: backgrounded (the relay sends a cancel, the LAN socket closes), its relay
   * rekeyed, its own wait run out. The answer's stream is closed then, and writing to it threw, from a timer, which
   * ended the daemon. Each case runs in its own process, since what is being checked is that the process lives.
   */
  const survives = (script: string) => {
    const file = join(mkdtempSync(join(scratch, "survives-")), "run.ts");
    writeFileSync(file, `import { createPhoneBridgeApplication, createPhoneBridgeServer } from ${JSON.stringify(join(import.meta.dir, "..", "src/phone-bridge.ts"))};
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const uploads = mkdtempSync(join(${JSON.stringify(scratch)}, "uploads-"));
const recording = join(uploads, "abcdef123456.wav");
writeFileSync(recording, "RIFF");
const TOKEN = ${JSON.stringify(TOKEN)};
const application = createPhoneBridgeApplication({
  getState: () => ({ rows: [] }), forwardControl: async () => "{}", replyFor: async () => "",
  acceptUpload: async () => ({ received: 1, total: 1 }), uploadsDirectory: uploads, log: () => {},
  transcribe: () => new Promise((resolve) => setTimeout(() => resolve({ segments: [{ start: 0, end: 1, text: "words" }] }), 300)),
}, { token: TOKEN, transcriptKeepaliveMs: 40 });
${script}
console.log("alive");
process.exit(0);
`);
    const run = Bun.spawnSync([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
    return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() };
  };

  test("over the LAN: the phone hangs up while whisper works, and the daemon lives on", () => {
    const run = survives(`
const server = createPhoneBridgeServer(application, { log: () => {} }, { port: 0, hostname: "127.0.0.1" });
const abort = new AbortController();
const response = await fetch(\`http://127.0.0.1:\${server.port}/transcript?path=\${encodeURIComponent(recording)}\`, {
  headers: { authorization: \`Bearer \${TOKEN}\` }, signal: abort.signal,
});
await response.body!.getReader().read();
abort.abort();
// Past several keepalives, and past the words.
await Bun.sleep(700);
server.stop();
`);
    expect(run.err).not.toContain("Controller is already closed");
    expect(run).toMatchObject({ code: 0, out: "alive" });
  }, 20_000);

  test("over the relay: the phone cancels the answer while whisper works, the daemon lives on, and the next recording is taken", () => {
    const run = survives(`
const ask = () => application.handle(new Request(\`https://relay.invalid/transcript?path=\${encodeURIComponent(recording)}\`, {
  headers: { authorization: \`Bearer \${TOKEN}\` },
})) as Promise<Response>;
// What MacRelayPeer does on the phone's cancel frame, a rekey or a closed socket.
await (await ask()).body!.getReader().cancel();
await Bun.sleep(700);
const again = await ask();
console.log(\`\${again.status} \${JSON.stringify(await again.json())}\`);
`);
    expect(run.err).not.toContain("Controller is already closed");
    expect(run).toMatchObject({ code: 0, out: '200 {"segments":[{"start":0,"end":1,"text":"words"}]}\nalive' });
  }, 20_000);

  test("the daemon hands the bridge whisper's timed transcription", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    expect(daemon).toContain("transcribe: (wavPath) => transcribeWavSegments(cfg, wavPath),");
  });
});
