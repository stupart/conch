import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { narrationSoxArgs } from "../src/listen.ts";
import {
  createNarration,
  decodeNarrationRequest,
  type NarrationConnection,
  type NarrationDeps,
} from "../src/narration.ts";
import { isConchSox } from "../src/sox-orphan.ts";

/**
 * Show's narration: the lease that holds the mic for it, executed over fakes —
 * a hold that counts, a recorder that exits when told, a transcriber that
 * answers — and over a real socket, where the connection is the lease. No sox,
 * no whisper. The hold itself (the voice loop's gate) is in voice-loop.test.ts.
 */

const ID = "5B3F0D2E-9C41-4E7A-8F10-2D6B7A1C9E44";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(what: string, condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rig(options: { refuse?: string; leaseMs?: number; recordThrows?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "conch-narration-"));
  roots.push(root);
  const canvas = join(root, "canvas");
  const counts = { holds: 0, releases: 0, stops: 0 };
  /** How many releases there had been when each transcription began: the mic closes before the words are read. */
  const releasedAtTranscribe: number[] = [];
  const recorded: Array<{ wav: string; seconds: number }> = [];
  const transcribed: string[] = [];
  const logs: string[] = [];
  let exit = deferred<number>();
  const deps: NarrationDeps = {
    hold: async () => {
      counts.holds++;
      if (options.refuse) return { refused: options.refuse };
      return { release: () => void counts.releases++ };
    },
    record: (wav, seconds) => {
      if (options.recordThrows) throw new Error("no sox");
      recorded.push({ wav, seconds });
      exit = deferred<number>();
      return { exited: exit.promise, stop: () => { counts.stops++; exit.resolve(0); } };
    },
    transcribe: async (wav) => {
      transcribed.push(wav);
      releasedAtTranscribe.push(counts.releases);
      return { segments: [{ start: 0.4, end: 1.9, text: "make this bigger" }] };
    },
    root: canvas,
    leaseMs: options.leaseMs ?? 60_000,
    log: (line) => void logs.push(line),
  };
  const narration = createNarration(deps);
  /** A connection the test can close, as an app quitting would. */
  const connection = () => {
    const closed = deferred();
    const state = { ended: 0, close: () => closed.resolve() };
    const value: NarrationConnection = { closed: closed.promise, end: () => void state.ended++ };
    return { value, state };
  };
  return {
    narration, canvas, counts, recorded, transcribed, releasedAtTranscribe, logs, connection,
    /** The recorder dies on its own, as `killActiveRecorders` kills it when the phone claims the audio. */
    killRecorder: () => exit.resolve(137),
  };
}

describe("the request", () => {
  test("a canvas's id is a UUID and nothing else: it names a folder", () => {
    expect(decodeNarrationRequest({ kind: "narration-start", canvasId: ID })).toEqual({ kind: "narration-start", canvasId: ID });
    expect(decodeNarrationRequest({ kind: "narration-stop", canvasId: ID.toLowerCase() })).toEqual({ kind: "narration-stop", canvasId: ID.toLowerCase() });
    for (const canvasId of ["../../etc", `${ID}/..`, "", "abc", 7, undefined, `${ID} `]) {
      expect(decodeNarrationRequest({ kind: "narration-cancel", canvasId })).toEqual({ error: "canvasId must be a canvas's UUID" });
    }
    // Not a narration request at all: left for the rest of the socket.
    expect(decodeNarrationRequest({ kind: "screen-observation" })).toBeNull();
    expect(decodeNarrationRequest({ type: "wake" })).toBeNull();
    expect(decodeNarrationRequest(null)).toBeNull();
  });
});

describe("the lease", () => {
  test("start holds the mic and records into the canvas's folder, for Tyler alone; stop releases it, then transcribes", async () => {
    const r = rig();
    const c = r.connection();
    const started = await r.narration.start(ID, c.value);
    expect(started).toMatchObject({ kind: "narration-started", canvasId: ID });
    expect(started.kind === "narration-started" && Math.abs(started.startedAt - Date.now()) < 1_000).toBe(true);
    const wav = join(r.canvas, ID, "narration.wav");
    // Capped where the lease is, in the recorder itself.
    expect(r.recorded).toEqual([{ wav, seconds: 60 }]);
    expect(statSync(r.canvas).mode & 0o777).toBe(0o700);
    expect(statSync(join(r.canvas, ID)).mode & 0o777).toBe(0o700);
    expect(statSync(wav).mode & 0o777).toBe(0o600);
    expect(r.counts).toEqual({ holds: 1, releases: 0, stops: 0 });

    expect(await r.narration.stop(ID)).toEqual({
      kind: "narration-stopped", canvasId: ID, wav, segments: [{ start: 0.4, end: 1.9, text: "make this bigger" }],
    });
    // The mic closed before the words were read: recorder stopped, reservation released, then the transcript.
    expect(r.counts).toEqual({ holds: 1, releases: 1, stops: 1 });
    expect(r.transcribed).toEqual([wav]);
    expect(r.releasedAtTranscribe).toEqual([1]);
    expect(c.state.ended).toBe(1);
    expect(existsSync(wav)).toBe(true);
    // Once: a second stop finds nothing, and the app closing its connection now changes nothing.
    expect(await r.narration.stop(ID)).toEqual({ kind: "narration-error", error: `no narration is running for ${ID}` });
    c.state.close();
    await Bun.sleep(10);
    expect(existsSync(wav)).toBe(true);
    expect(r.counts.releases).toBe(1);
  });

  test("refused while one runs, and when the hold is refused — nothing recorded, nothing held", async () => {
    const r = rig();
    const first = r.connection();
    await r.narration.start(ID, first.value);
    const other = "0F1E2D3C-4B5A-4968-8776-A5B4C3D2E1F0";
    expect(await r.narration.start(other, r.connection().value)).toEqual({
      kind: "narration-refused", canvasId: other, reason: "a narration is already running",
    });
    expect(r.counts.holds).toBe(1);
    expect(r.recorded).toHaveLength(1);
    // A stop or a cancel for another canvas is not this one's.
    expect((await r.narration.cancel(other)).kind).toBe("narration-error");
    expect(r.counts.releases).toBe(0);

    const phone = rig({ refuse: "the phone has the audio" });
    expect(await phone.narration.start(ID, phone.connection().value)).toEqual({
      kind: "narration-refused", canvasId: ID, reason: "the phone has the audio",
    });
    expect(phone.recorded).toEqual([]);
    expect(existsSync(join(phone.canvas, ID))).toBe(false);
  });

  test("a recorder that can't start releases the mic it was given", async () => {
    const r = rig({ recordThrows: true });
    expect(await r.narration.start(ID, r.connection().value)).toEqual({
      kind: "narration-refused", canvasId: ID, reason: "it couldn't record",
    });
    expect(r.counts).toEqual({ holds: 1, releases: 1, stops: 0 });
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
  });

  test("Esc cancels: the mic released and what was recorded deleted", async () => {
    const r = rig();
    const c = r.connection();
    await r.narration.start(ID, c.value);
    expect(await r.narration.cancel(ID)).toEqual({ kind: "narration-cancelled", canvasId: ID });
    expect(r.counts).toEqual({ holds: 1, releases: 1, stops: 1 });
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
    expect(c.state.ended).toBe(1);
    expect(r.transcribed).toEqual([]);
  });

  test("it ends on its own at the lease: a Show that never stops can't hold the mic", async () => {
    const r = rig({ leaseMs: 40 });
    const c = r.connection();
    await r.narration.start(ID, c.value);
    expect(r.recorded[0]!.seconds).toBe(1);
    await waitFor("the lease", () => r.counts.releases === 1);
    expect(r.counts.stops).toBe(1);
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
    expect(c.state.ended).toBe(1);
    expect(r.logs).toContain("narration cancelled — its lease ran out");
    expect((await r.narration.stop(ID)).kind).toBe("narration-error");
  });

  test("it ends when the app's connection that started it goes away", async () => {
    const r = rig();
    const c = r.connection();
    await r.narration.start(ID, c.value);
    c.state.close();
    await waitFor("the cancel", () => r.counts.releases === 1);
    expect(r.counts.stops).toBe(1);
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
    expect(r.logs).toContain("narration cancelled — the app that started it went away");
  });

  test("an app gone before it was answered: the narration it asked for ends at once", async () => {
    const r = rig();
    const c = r.connection();
    c.state.close();
    expect((await r.narration.start(ID, c.value)).kind).toBe("narration-started");
    await waitFor("the cancel", () => r.counts.releases === 1);
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
  });

  test("a recorder killed with the rest — a phone claim, a yield, shutdown — releases the mic at once; stop still reads what it got", async () => {
    const r = rig();
    await r.narration.start(ID, r.connection().value);
    r.killRecorder();
    await waitFor("the release", () => r.counts.releases === 1);
    expect(r.logs).toContain("narration's recorder stopped before the Show did");
    const stopped = await r.narration.stop(ID);
    expect(stopped.kind).toBe("narration-stopped");
    expect(r.counts.releases).toBe(1);
  });
});

describe("over the socket, the connection is the lease", () => {
  const servers: ControlServer[] = [];
  const clients: Socket[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    for (const server of servers.splice(0)) await server.close();
  });

  async function serve(r: ReturnType<typeof rig>) {
    const root = mkdtempSync("/tmp/conch-narr-");
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const unused = () => { throw new Error("not a narration"); };
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: unused, current: unused },
      application: { configuration: unused, session: unused, runtime: unused, turn: unused, device: unused },
      narration: r.narration,
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    /** One connection: its reply lines, and whether the daemon has closed it. */
    const open = async (request: unknown) => {
      const socket = connect({ path: socketPath, allowHalfOpen: true });
      clients.push(socket);
      const state = { lines: [] as unknown[], ended: false };
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        const lines = data.split("\n");
        data = lines.pop()!;
        for (const line of lines) state.lines.push(JSON.parse(line));
      });
      socket.on("end", () => { state.ended = true; });
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(JSON.stringify(request) + "\n");
      await waitFor("a reply", () => state.lines.length > 0);
      return { socket, state };
    };
    return { open, socketPath };
  }

  test("a start is answered and held open; the app quitting — its socket closed — cancels it", async () => {
    const r = rig();
    const { open } = await serve(r);
    const start = await open({ kind: "narration-start", canvasId: ID });
    expect(start.state.lines[0]).toMatchObject({ kind: "narration-started", canvasId: ID });
    await Bun.sleep(20);
    expect(start.state.ended).toBe(false);
    expect(r.counts.releases).toBe(0);
    start.socket.destroy();
    await waitFor("the cancel", () => r.counts.releases === 1);
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
  });

  test("an app that crashes holding it — killed, its socket closed by the kernel — takes its narration with it", async () => {
    const r = rig();
    const { socketPath } = await serve(r);
    // A real process holding the lease, as the app does, then SIGKILLed: nothing of it gets to say goodbye.
    const app = Bun.spawn(["bun", "-e", `
      const socket = require("node:net").connect({ path: process.env.SOCK });
      socket.on("connect", () => socket.write(JSON.stringify({ kind: "narration-start", canvasId: process.env.ID }) + "\\n"));
      socket.on("data", (chunk) => process.stdout.write(chunk));
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, SOCK: socketPath, ID }, stdout: "pipe", stderr: "ignore" });
    try {
      const reader = app.stdout.getReader();
      const { value } = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(value))).toMatchObject({ kind: "narration-started", canvasId: ID });
      await Bun.sleep(20);
      expect(r.counts.releases).toBe(0);
      app.kill("SIGKILL");
      await app.exited;
      await waitFor("the cancel", () => r.counts.releases === 1);
      expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
    } finally {
      app.kill("SIGKILL");
    }
  });

  test("so does the app closing its side of it, and nothing more: a half-close is the app gone", async () => {
    const r = rig();
    const { open } = await serve(r);
    const start = await open({ kind: "narration-start", canvasId: ID });
    start.socket.end();
    await waitFor("the cancel", () => r.counts.releases === 1);
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(false);
  });

  test("stop on its own connection answers the segments and the WAV, and the daemon closes the lease", async () => {
    const r = rig();
    const { open } = await serve(r);
    const start = await open({ kind: "narration-start", canvasId: ID });
    const stop = await open({ kind: "narration-stop", canvasId: ID });
    expect(stop.state.lines[0]).toEqual({
      kind: "narration-stopped", canvasId: ID, wav: join(r.canvas, ID, "narration.wav"),
      segments: [{ start: 0.4, end: 1.9, text: "make this bigger" }],
    });
    await waitFor("the lease closed", () => start.state.ended);
    expect(r.counts).toEqual({ holds: 1, releases: 1, stops: 1 });
    expect(existsSync(join(r.canvas, ID, "narration.wav"))).toBe(true);
  });

  test("a refusal is the one answer, and closes; a bad id never reaches the lease", async () => {
    const r = rig({ refuse: "conch is speaking" });
    const { open } = await serve(r);
    const start = await open({ kind: "narration-start", canvasId: ID });
    expect(start.state.lines[0]).toEqual({ kind: "narration-refused", canvasId: ID, reason: "conch is speaking" });
    await waitFor("closed", () => start.state.ended);
    const bad = await open({ kind: "narration-start", canvasId: "../../Library" });
    expect(bad.state.lines[0]).toEqual({ kind: "narration-error", error: "canvasId must be a canvas's UUID" });
    expect(r.counts.holds).toBe(1);
  });
});

describe("the recorder", () => {
  test("owned like every capture: shutdown, a phone claim and a yield kill it with the rest, and the next daemon can reap it", () => {
    // Spawning it opens the real mic, so this reads the source: registered where `killActiveRecorders` looks, and
    // recorded where `reapOrphanedSox` looks, until it exits.
    const listen = readFileSync(join(import.meta.dir, "../src/listen.ts"), "utf8");
    const start = listen.indexOf("export function spawnNarrationRecorder(");
    const body = listen.slice(start, listen.indexOf("\n}\n", start));
    expect(body).toContain("Bun.spawn(narrationSoxArgs(cfg, wav, seconds)");
    expect(body).toContain("activeRecorders.add(proc);");
    expect(body).toContain("recordSpawnedSox(proc.pid);");
    expect(body).toContain("activeRecorders.delete(proc);");
    expect(body).toContain("forgetSox(proc.pid);");
    const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
    expect(daemon).toContain("const proc = spawnNarrationRecorder(cfg, wav, seconds);\n      return { exited: proc.exited, stop: () => stopSoxProcess(proc) };");
  });

  test("the capture's device, rate and gain, kept whole as a WAV and capped by sox itself; the next daemon can reap it", () => {
    const wav = `/Users/someone/.cache/conch/canvas/${ID}/narration.wav`;
    const argv = narrationSoxArgs({ micGainDb: 6 }, wav, 150);
    expect(argv).toEqual([
      "sox", "-d", "-q", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "wav",
      wav, "gain", "6", "trim", "0", "150",
    ]);
    expect(argv).not.toContain("silence");
    expect(isConchSox(argv.join(" "))).toBe(true);
    expect(isConchSox("/opt/homebrew/bin/" + narrationSoxArgs({ micGainDb: 0 }, wav, 150).join(" "))).toBe(true);
    // Not conch's: another folder, another name, another recipe.
    expect(isConchSox(narrationSoxArgs({ micGainDb: 0 }, "/tmp/narration.wav", 150).join(" "))).toBe(false);
    expect(isConchSox(narrationSoxArgs({ micGainDb: 0 }, wav.replace("narration.wav", "song.wav"), 150).join(" "))).toBe(false);
    expect(isConchSox(`sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t wav ${wav} trim 0 150 extra`)).toBe(false);
  });
});
