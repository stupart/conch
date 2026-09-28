import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFetchFailure,
  MODEL_FETCH_HEADROOM_BYTES,
  SpeechEngineManager,
  type PinnedModel,
  type SpeechEngine,
  type SpeechEngineStatus,
} from "../src/speech-engine.ts";
import {
  VOICE_ENV_NEEDS_BYTES,
  VOICE_LOCK,
  VOICE_SETUP_STEPS,
  VoiceEnvManager,
  voiceEnvPaths,
  type NaturalVoicesStatus,
} from "../src/voice-env.ts";

// What setup's downloads tray reads from the published status (setup, README §5 Wave A): the natural voices' build
// step as numbers, not "(3/4)" in a sentence; and a speech-recognition download that is offline, or out of room, said
// as such, with its place kept while it waits. And a download that gave up can be tried again from setup.

const roots: string[] = [];
const closers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const closer of closers.splice(0)) closer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-setup-downloads-"));
  roots.push(root);
  return root;
}

// MARK: - Speech recognition

const pin: PinnedModel = { file: "whisper.bin", url: "http://example.invalid/w", sha256: "b".repeat(64), bytes: 1_000_000, label: "whisper" };

function engine(root: string): SpeechEngine {
  const found = (path: string) => ({ path, source: "conch.app" as const, found: true });
  return {
    whisperCli: found("/app/whisper-cli"),
    whisperServer: found("/app/whisper-server"),
    whisperModel: { path: join(root, "models", "whisper.bin"), source: "missing", found: false },
    vadModel: found("/app/vad.bin"),
    sox: found("/app/sox"),
  };
}

function speech(root: string, options: { fetch: (dest: string) => Promise<void>; freeBytes?: (path: string) => number | null; now?: () => number }) {
  const statuses: SpeechEngineStatus[] = [];
  const fetches: string[] = [];
  const manager = new SpeechEngineManager({
    engine: engine(root),
    daemon: { version: "9.9.9", path: "/app/conch-daemon" },
    log: () => {},
    onStatus: (status) => statuses.push(status),
    statusPath: join(root, "speech-engine.json"),
    failuresPath: join(root, "models", "fetch-failures.json"),
    whisperModel: pin,
    tmux: () => ({ path: "tmux", source: "missing", found: false }),
    fetchModel: async (_model, dest) => {
      fetches.push(dest);
      await options.fetch(dest);
    },
    sleep: async () => true,
    progressEveryMs: 0,
    now: options.now ?? (() => 1_000_000),
    ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}),
  });
  closers.push(manager);
  return { manager, statuses, fetches };
}

describe("speech recognition's download says offline and out of room as such", () => {
  test("an error is offline, out of room, or neither, by its words alone", () => {
    for (const offline of ["Unable to connect. Is the computer able to access the url?", "getaddrinfo ENOTFOUND huggingface.co",
      "The socket connection was closed unexpectedly", "connect ENETUNREACH", "no bytes for 60s: stalled", "fetch failed"]) {
      expect(classifyFetchFailure(offline), offline).toBe("offline");
    }
    expect(classifyFetchFailure("ENOSPC: no space left on device, write")).toBe("no-space");
    expect(classifyFetchFailure("not enough free space: needs 800 MB, this Mac has 300 MB")).toBe("no-space");
    expect(classifyFetchFailure("HTTP 404 from https://huggingface.co/…")).toBeNull();
    expect(classifyFetchFailure("sha256 mismatch")).toBeNull();
  });

  test("offline: the wait says so, keeps the bytes already here, and when it tries again", async () => {
    const root = scratch();
    const h = speech(root, {
      fetch: async (dest) => {
        mkdirSync(join(root, "models"), { recursive: true });
        writeFileSync(`${dest}.part`, new Uint8Array(212_000));
        throw new Error("Unable to connect. Is the computer able to access the url?");
      },
    });
    await h.manager.start();
    const waiting = h.statuses.filter((status) => status.state === "downloading" && status.retryAt);
    expect(waiting.length).toBe(2);
    expect(waiting[0]).toMatchObject({ problem: { kind: "offline" }, progress: { bytes: 212_000, total: pin.bytes }, retryAt: 1_000_000 + 60_000 });
    // A fresh attempt resumes from the partial, and its bar starts there.
    const attempts = h.statuses.filter((status) => status.state === "downloading" && !status.retryAt);
    expect(attempts.at(-1)!.progress).toEqual({ bytes: 212_000, total: pin.bytes });
    expect(h.statuses.at(-1)).toMatchObject({ state: "off", reason: "download failed", problem: { kind: "offline" } });
  });

  test("no room: it doesn't start, and says what it needs and what the Mac has", async () => {
    const root = scratch();
    const h = speech(root, { fetch: async () => { throw new Error("should not fetch"); }, freeBytes: () => 300_000 });
    await h.manager.start();
    expect(h.fetches).toEqual([]);
    const needs = pin.bytes + MODEL_FETCH_HEADROOM_BYTES;
    expect(h.statuses.find((status) => status.retryAt)).toMatchObject({ problem: { kind: "no-space", needs, free: 300_000 } });
    expect(h.statuses.at(-1)).toMatchObject({ state: "off", problem: { kind: "no-space", needs, free: 300_000 } });
  });

  test("a download that gave up is tried again from setup's Retry, and lands", async () => {
    const root = scratch();
    let online = false;
    const h = speech(root, {
      fetch: async (dest) => {
        if (!online) throw new Error("fetch failed");
        mkdirSync(join(root, "models"), { recursive: true });
        writeFileSync(dest, "model");
      },
    });
    await h.manager.start();
    expect(h.statuses.at(-1)!.state).toBe("off");
    online = true;
    expect(h.manager.retry()).toBe(true);
    await h.manager.settled();
    expect(h.statuses.at(-1)).toMatchObject({ state: "ready" });
    expect(h.statuses.at(-1)!.problem).toBeUndefined();
    expect(h.manager.retry()).toBe(false);
  });
});

// MARK: - The natural voices

function voices(options: { build?: (progress: (step: string, at?: { step: number; steps: number }) => void) => Promise<void>; freeBytes?: () => number | null } = {}) {
  const paths = voiceEnvPaths(scratch());
  const statuses: NaturalVoicesStatus[] = [];
  let own: "missing" | "good" = "missing";
  let builds = 0;
  const versions: Record<string, string> = {};
  for (const lockPin of VOICE_LOCK.pins.values()) versions[lockPin.name] = lockPin.version;
  const manager = new VoiceEnvManager({
    engine: "worker",
    explicitPython: "",
    serverBin: "mlx_audio.server",
    model: "mock/Kokoro",
    voices: ["af_heart"],
    speed: 1.35,
    usePython: () => {},
    log: () => {},
    onStatus: (status) => statuses.push(status),
    paths,
    appleSilicon: () => true,
    findUv: () => ({ path: "/fake/uv", source: "CONCH_UV" }),
    resolveExplicit: (value) => value,
    resolveLegacy: () => null,
    probe: async (python) => (python === paths.python && own === "good"
      ? { report: { python: `${VOICE_LOCK.python}.14`, versions, import_error: null } }
      : { error: "is not set up yet" }),
    build: async (_uv, progress) => {
      builds++;
      await (options.build ?? (async (report) => {
        for (let step = 1; step <= VOICE_SETUP_STEPS; step++) report(`step ${step} (${step}/${VOICE_SETUP_STEPS})`, { step, steps: VOICE_SETUP_STEPS });
      }))(progress);
      own = "good";
    },
    prefetch: async () => {},
    probeNetwork: async () => true,
    sleep: async () => true,
    freeBytes: options.freeBytes ?? (() => null),
  });
  closers.push(manager);
  return { manager, statuses, builds: () => builds, paths };
}

describe("the natural voices publish their step as numbers", () => {
  test("each build step is `step` of `steps`, then the voices' own download is its own stage", async () => {
    const h = voices();
    await h.manager.start();
    await h.manager.settled();
    const building = h.statuses.filter((status) => status.state === "setting-up" && status.step);
    expect(building.map((status) => [status.step, status.steps])).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    // Then Kokoro's own model: no build step, its own stage.
    const prefetch = h.statuses.findIndex((status) => status.stage === "prefetch");
    expect(prefetch).toBeGreaterThan(h.statuses.indexOf(building.at(-1)!));
    expect(h.statuses[prefetch]!.step).toBeUndefined();
    expect(h.statuses.at(-1)!.state).toBe("ready");
    expect(h.statuses.at(-1)!.step).toBeUndefined();
  });

  test("with no room it doesn't start a build: it says what it needs, waits, and tries again", async () => {
    let free = 900_000_000;
    const h = voices({ freeBytes: () => free });
    await h.manager.start();
    await h.manager.settled();
    expect(h.builds()).toBe(0);
    const waiting = h.statuses.find((status) => status.space);
    expect(waiting).toMatchObject({ state: "setting-up", space: { needs: VOICE_ENV_NEEDS_BYTES, free: 900_000_000 } });
    // It never gives up for want of room (that is never counted): it waits, and says so.
    expect(h.statuses.at(-1)).toMatchObject({ state: "setting-up", waiting: "space", space: { needs: VOICE_ENV_NEEDS_BYTES, free: 900_000_000 } });
    // Room made, setup's Retry builds them at once (and so would the watch, by itself).
    free = 50_000_000_000;
    expect(h.manager.retry()).toBe(true);
    await h.manager.settled();
    expect(h.builds()).toBe(1);
    expect(h.statuses.at(-1)!.state).toBe("ready");
    expect(h.statuses.at(-1)!.space).toBeUndefined();
    expect(h.manager.retry()).toBe(false);
  });
});
