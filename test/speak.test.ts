import { test, expect } from "bun:test";
import {
  availableVoiceRing,
  clearVoiceOverride,
  makeSynthBatches,
  migrateVoiceOverride,
  migrateVoiceOverrideMap,
  resetTtsReadiness,
  runSynthLadderForTest,
  selectVoice,
  setVoiceOverride,
  SYNTH_ATTEMPT_TIMEOUT_MS,
  SYNTH_SENTENCE_BUDGET_MS,
  SYNTH_TIMEOUT_LIMIT,
  speakCancellable,
  trySynth,
  validateVoiceRing,
  voiceFor,
} from "../src/speak.ts";
import { loadConfig as loadRealConfig } from "../src/config.ts";
import { TtsHealthMachine } from "../src/tts-health.ts";
import { TtsWorkerTimeoutError, type TtsWorkerBackend } from "../src/tts-worker.ts";
import { parseWav, trimWav } from "../src/tts-wav.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadConfig() {
  return loadRealConfig({ env: {}, settingsPath: `/tmp/conch-speak-test-${process.pid}/settings.json` });
}

function cfgWithVoices(voices: string[]) {
  const cfg = loadConfig();
  cfg.ttsVoices = voices;
  return cfg;
}

test("voiceFor is stable — same label, same voice, every time", () => {
  const cfg = cfgWithVoices(["a", "b", "c", "d"]);
  const first = voiceFor(cfg, "dayloop");
  for (let i = 0; i < 10; i++) expect(voiceFor(cfg, "dayloop")).toBe(first);
});

test("voiceFor spreads distinct labels across the ring", () => {
  const cfg = cfgWithVoices(["a", "b", "c", "d", "e", "f", "g", "h"]);
  const labels = ["dayloop", "tokenworks", "poaster", "conch", "blueprint", "arch"];
  const used = new Set(labels.map((l) => voiceFor(cfg, l)));
  expect(used.size).toBeGreaterThan(2); // not everyone lands on one voice
});

test("voiceFor falls back sanely with no label or no voices", () => {
  expect(voiceFor(cfgWithVoices(["x", "y"]), "")).toBe("x");
  expect(voiceFor(cfgWithVoices([]), "dayloop")).toBe("af_heart");
});

test("default voice ring parses from config", () => {
  const cfg = loadConfig();
  expect(cfg.ttsVoices.length).toBeGreaterThanOrEqual(4);
  expect(cfg.ttsVoices).toContain("af_heart");
});

test("voice validation removes malformed and unavailable entries", () => {
  expect(validateVoiceRing(["af_heart", "bad voice", "missing", "af_heart"], ["af_heart", "am_adam"]))
    .toEqual(["af_heart"]);
  expect(validateVoiceRing(["missing"], ["am_adam", "af_heart"])).toEqual(["af_heart"]);
});

test("availableVoiceRing uses configured voices without a server list and filters against one when supplied", () => {
  resetTtsReadiness();
  const cfg = cfgWithVoices(["af_heart", "bad voice", "am_adam", "af_heart"]);
  expect(availableVoiceRing(cfg)).toEqual(["af_heart", "am_adam"]);
  expect(availableVoiceRing(cfg, new Set(["am_adam", "bf_emma"]))).toEqual(["am_adam"]);
});

test("voice override reset returns a label to its automatic ring voice", () => {
  resetTtsReadiness();
  const root = mkdtempSync(join(tmpdir(), "conch-voices-"));
  const voicesPath = join(root, "nested", "voices.json");
  const cfg = cfgWithVoices(["af_heart", "am_adam"]);
  try {
    setVoiceOverride("  DayLoop  ", "am_adam", { voicesPath });
    expect(voiceFor(cfg, "dayloop", { voicesPath })).toBe("am_adam");
    expect(clearVoiceOverride("DAYLOOP", { voicesPath })).toBe(true);
    expect(clearVoiceOverride("dayloop", { voicesPath })).toBe(false);
    expect(JSON.parse(readFileSync(voicesPath, "utf8"))).toEqual({});
    expect(availableVoiceRing(cfg, null)).toContain(voiceFor(cfg, "dayloop", { voicesPath }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("voice-pin map migration is a same-key no-op and the migrating pin wins a collision", () => {
  expect(migrateVoiceOverrideMap(
    { old: "am_adam", new: "af_heart", untouched: "bf_emma" },
    " OLD ",
    "New",
  )).toEqual({
    overrides: { new: "am_adam", untouched: "bf_emma" },
    migrated: true,
    voice: "am_adam",
  });
  expect(migrateVoiceOverrideMap({ same: "am_adam" }, "Same", " same ")).toEqual({
    overrides: { same: "am_adam" },
    migrated: false,
  });
});

test("persisted voice-pin migration moves the normalized old key to the new label", () => {
  resetTtsReadiness();
  const root = mkdtempSync(join(tmpdir(), "conch-voice-migrate-"));
  const voicesPath = join(root, "voices.json");
  const cfg = cfgWithVoices(["af_heart", "bf_emma"]);
  try {
    setVoiceOverride("Old Label", "am_adam", { voicesPath });
    // This is the rename hazard: the new label hashes into the ring until its
    // label-keyed pin is explicitly migrated.
    expect(voiceFor(cfg, "New Label", { voicesPath })).not.toBe("am_adam");
    expect(migrateVoiceOverride(" OLD LABEL ", "New Label", { voicesPath })).toBe(true);
    expect(voiceFor(cfg, "New Label", { voicesPath })).toBe("am_adam");
    expect(JSON.parse(readFileSync(voicesPath, "utf8"))).toEqual({ "new label": "am_adam" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid persisted override selects a known ring voice instead", () => {
  const available = ["af_heart", "am_adam"];
  expect(selectVoice(available, "dayloop", "not_on_server", available)).toBeOneOf(available);
  expect(selectVoice(available, "dayloop", "bad voice", available)).toBeOneOf(available);
  expect(selectVoice(available, "dayloop", "am_adam", available)).toBe("am_adam");
});

test("later sentence batching keeps sentence one separate and is disableable", () => {
  const sentences = ["First.", "Two.", "Three.", "A much longer fourth sentence."];
  expect(makeSynthBatches(sentences, 16)).toEqual([
    { text: "First.", originals: ["First."] },
    { text: "Two. Three.", originals: ["Two.", "Three."] },
    { text: "A much longer fourth sentence.", originals: ["A much longer fourth sentence."] },
  ]);
  expect(makeSynthBatches(sentences, 0).map((batch) => batch.originals.length)).toEqual([1, 1, 1, 1]);
});

function pcm16Wav(
  samples: number[],
  { sampleRate = 1000, channels = 1, oddJunk = false }: { sampleRate?: number; channels?: number; oddJunk?: boolean } = {},
): Uint8Array {
  const chunks: Array<{ id: string; body: Uint8Array }> = [];
  if (oddJunk) chunks.push({ id: "JUNK", body: new Uint8Array([7]) });
  const fmt = new Uint8Array(16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, 1, true);
  fv.setUint16(2, channels, true);
  fv.setUint32(4, sampleRate, true);
  fv.setUint32(8, sampleRate * channels * 2, true);
  fv.setUint16(12, channels * 2, true);
  fv.setUint16(14, 16, true);
  chunks.push({ id: "fmt ", body: fmt });
  const data = new Uint8Array(samples.length * 2);
  const dv = new DataView(data.buffer);
  samples.forEach((sample, index) => dv.setInt16(index * 2, sample, true));
  chunks.push({ id: "data", body: data });

  const size = 12 + chunks.reduce((total, chunk) => total + 8 + chunk.body.length + (chunk.body.length & 1), 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, size - 8, true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    out.set(new TextEncoder().encode(chunk.id), offset);
    view.setUint32(offset + 4, chunk.body.length, true);
    out.set(chunk.body, offset + 8);
    offset += 8 + chunk.body.length + (chunk.body.length & 1);
  }
  return out;
}

test("WAV parser walks odd padded chunks and honors nonzero byteOffset", () => {
  const wav = pcm16Wav([0, 1000, -1000, 0], { oddJunk: true });
  const wrapped = new Uint8Array(wav.length + 13);
  wrapped.set(wav, 7);
  const parsed = parseWav(new Uint8Array(wrapped.buffer, 7, wav.length));
  expect(parsed?.sampleRate).toBe(1000);
  expect(parsed?.data.byteLength).toBe(8);
});

test("WAV parser rejects truncated RIFF and a missing odd-byte pad", () => {
  const wav = pcm16Wav([0, 1000], { oddJunk: true });
  expect(parseWav(wav.subarray(0, wav.length - 1))).toBeNull();
  const malformed = wav.slice();
  new DataView(malformed.buffer).setUint32(4, malformed.length - 9, true);
  expect(parseWav(malformed.subarray(0, malformed.length - 1))).toBeNull();
});

test("in-process WAV trim removes lead and retains exactly 0.06s of available tail", () => {
  const wav = pcm16Wav([
    ...new Array(100).fill(0),
    ...new Array(100).fill(2000),
    ...new Array(200).fill(0),
  ]);
  const trimmed = trimWav(wav);
  const parsed = trimmed && parseWav(trimmed);
  expect(parsed).not.toBeNull();
  expect(parsed!.data.byteLength / parsed!.blockAlign).toBe(160); // 100 speech + retained 60ms tail
  expect(trimWav(pcm16Wav(new Array(200).fill(0)))).toBeNull();
});

test("WAV trim scans all stereo channels", () => {
  const frames = [
    ...new Array(40).fill([0, 0]),
    ...new Array(40).fill([0, 2000]),
    ...new Array(100).fill([0, 0]),
  ].flat();
  const trimmed = trimWav(pcm16Wav(frames, { channels: 2 }));
  const parsed = trimmed && parseWav(trimmed);
  expect(parsed!.channels).toBe(2);
  expect(parsed!.data.byteLength / parsed!.blockAlign).toBe(100); // 40 speech + 60ms tail
});

test("health goes down after consecutive transport failures and newer success heals", () => {
  let now = 0;
  const health = new TtsHealthMachine(2, () => ++now);
  health.recordTransportFailure(health.beginAttempt());
  expect(health.snapshot().status).toBe("recovering");
  health.recordTransportFailure(health.beginAttempt());
  expect(health.snapshot().status).toBe("down");
  health.recordSuccess(health.beginAttempt());
  expect(health.snapshot()).toMatchObject({ status: "ready", consecutiveTransportFailures: 0 });
  expect(health.snapshot().lastSuccessAt).toBeGreaterThan(health.snapshot().lastTransportFailureAt!);
});

test("health ignores out-of-order evidence and old server epochs", () => {
  const health = new TtsHealthMachine();
  const older = health.beginAttempt();
  const newer = health.beginAttempt();
  health.recordSuccess(newer);
  expect(health.recordTransportFailure(older)).toBeFalse();
  expect(health.snapshot().status).toBe("ready");
  health.reset();
  expect(health.recordSuccess(newer)).toBeFalse();
  expect(health.snapshot().status).toBe("starting");
});

test("trySynth classifies streamed 200 body errors as inference without marking health down", async () => {
  const health = new TtsHealthMachine();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error("broadcast shapes cannot be aligned"));
    },
  });
  const fetcher = () => Promise.resolve(new Response(stream, { status: 200 }));
  const outcome = await trySynth(loadConfig(), "shape trigger", "af_heart", null, { fetcher, health });
  expect(outcome.kind).toBe("post-header-inference-failure");
  expect(health.snapshot()).toMatchObject({ status: "recovering", consecutiveTransportFailures: 0 });
});

test("trySynth classifies a timed-out 200 body separately and degrades ready health", async () => {
  const health = new TtsHealthMachine();
  health.recordSuccess(health.beginAttempt());
  expect(health.snapshot().status).toBe("ready");

  const fetcher = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        const fail = () => controller.error(signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };

  const outcome = await trySynth(loadConfig(), "hung body", "af_heart", null, {
    fetcher,
    health,
    timeoutMs: 10,
    warn: () => {},
  });
  expect(outcome.kind).toBe("post-header-timeout");
  expect(health.snapshot()).toMatchObject({ status: "recovering", consecutiveTransportFailures: 0 });

  health.recordSuccess(health.beginAttempt());
  expect(health.snapshot().status).toBe("ready");
});

test("synth ladder bails to say after two timeout outcomes", async () => {
  const piece = "This deliberately long sentence has enough words to trigger recursive bisection.";
  const timeout = { kind: "post-header-timeout", status: 200, detail: "TimeoutError" } as const;
  const failures: string[] = [];
  const result = await runSynthLadderForTest(loadConfig(), piece, [timeout], (reason) => failures.push(reason));

  expect(result.attempts).toBe(2);
  expect(result.sayFallbacks).toEqual([piece]);
  expect(failures).toEqual(["synth-timeout"]); // once per utterance, not once per retry
});

test("synth timeout policy caps attempts at 4s inside an 8.5s two-timeout budget", () => {
  expect(SYNTH_ATTEMPT_TIMEOUT_MS).toBe(4_000);
  expect(SYNTH_SENTENCE_BUDGET_MS).toBe(8_500);
  expect(SYNTH_TIMEOUT_LIMIT).toBe(2);
});

test("explicit cancellation wins over a pending body timeout without degrading health", async () => {
  const health = new TtsHealthMachine();
  const outer = new AbortController();
  const fetcher = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    });
    queueMicrotask(() => outer.abort(new DOMException("cancelled", "AbortError")));
    return Promise.resolve(new Response(stream, { status: 200 }));
  };

  const outcome = await trySynth(loadConfig(), "cancel me", "af_heart", null, {
    fetcher,
    health,
    signal: outer.signal,
    timeoutMs: 10,
  });
  expect(outcome.kind).toBe("cancelled");
  expect(health.snapshot()).toMatchObject({ status: "starting", consecutiveTransportFailures: 0 });
});

test("fast inference failures continue through the shape-bisection ladder", async () => {
  const piece = "This deliberately long sentence has enough words to trigger recursive bisection.";
  const inference = {
    kind: "post-header-inference-failure",
    status: 200,
    detail: "broadcast shapes cannot be aligned",
  } as const;
  const failures: string[] = [];
  const result = await runSynthLadderForTest(loadConfig(), piece, [inference], (reason) => failures.push(reason));

  expect(result.attempts).toBeGreaterThan(2);
  expect(result.sayFallbacks.length).toBeGreaterThan(1);
  expect(result.sayFallbacks.join(" ")).toBe(piece);
  expect(failures).toEqual([]); // shape/inference errors do not restart the server
});

test("cancelled and ordinary 4xx synth outcomes do not request a Kokoro restart", async () => {
  const cfg = loadConfig();
  const failures: string[] = [];
  const cancelled = await runSynthLadderForTest(
    cfg,
    "cancel this synthesis",
    [{ kind: "cancelled" }],
    (reason) => failures.push(reason),
  );
  const configFailure = await runSynthLadderForTest(
    cfg,
    "keep the server for this bad request",
    [{ kind: "http-config-failure", status: 422, retryable: false, detail: "bad input" }],
    (reason) => failures.push(reason),
  );

  expect(cancelled.sayFallbacks).toEqual([]);
  expect(configFailure.sayFallbacks).toEqual(["keep the server for this bad request"]);
  expect(failures).toEqual([]);
});

test("trySynth distinguishes transport, config, overload, and recognized HTTP inference failures", async () => {
  const cfg = loadConfig();
  const transportHealth = new TtsHealthMachine();
  const transport = await trySynth(cfg, "x", "af_heart", null, {
    fetcher: () => Promise.reject(new TypeError("connection refused")),
    health: transportHealth,
  });
  expect(transport.kind).toBe("transport-failure");
  expect(transportHealth.snapshot()).toMatchObject({ status: "recovering", consecutiveTransportFailures: 1 });

  const config = await trySynth(cfg, "x", "af_heart", null, {
    fetcher: () => Promise.resolve(new Response("bad voice", { status: 422 })),
    health: new TtsHealthMachine(),
  });
  expect(config).toMatchObject({ kind: "http-config-failure", status: 422, retryable: false });

  const overload = await trySynth(cfg, "x", "af_heart", null, {
    fetcher: () => Promise.resolve(new Response("busy", { status: 503 })),
    health: new TtsHealthMachine(),
  });
  expect(overload).toMatchObject({ kind: "http-config-failure", status: 503, retryable: true });

  const inference = await trySynth(cfg, "x", "af_heart", null, {
    fetcher: () => Promise.resolve(new Response("ValueError: broadcast shape mismatch", { status: 500 })),
    health: new TtsHealthMachine(),
  });
  expect(inference.kind).toBe("post-header-inference-failure");
});

test("trySynth accepts a valid fully consumed WAV and marks health ready", async () => {
  const health = new TtsHealthMachine();
  const wav = pcm16Wav(new Array(40).fill(1000));
  const outcome = await trySynth(loadConfig(), "Ready.", "af_heart", null, {
    fetcher: () => Promise.resolve(new Response(wav, { status: 200 })),
    health,
  });
  expect(outcome.kind).toBe("audio");
  expect(health.snapshot().status).toBe("ready");
});

test("a signal-ignoring Kokoro fetch is still bounded by the watchdog", async () => {
  const warnings: string[] = [];
  const health = new TtsHealthMachine();
  const outcome = await trySynth(loadConfig(), "never returns", "af_heart", null, {
    fetcher: () => new Promise<Response>(() => {}),
    health,
    timeoutMs: 5,
    warn: (message) => warnings.push(message),
  });

  expect(outcome).toMatchObject({ kind: "transport-failure", timedOut: true });
  expect(health.snapshot()).toMatchObject({ status: "recovering", consecutiveTransportFailures: 1 });
  expect(warnings).toEqual(["⚠ kokoro synth request timed out after 5ms — aborted, moving on"]);
});

test("a signal-ignoring Kokoro response body cannot wedge synthesis", async () => {
  const warnings: string[] = [];
  const body = new ReadableStream<Uint8Array>({ start() {} });
  const outcome = await trySynth(loadConfig(), "hung body", "af_heart", null, {
    fetcher: () => Promise.resolve(new Response(body, { status: 200 })),
    health: new TtsHealthMachine(),
    timeoutMs: 5,
    warn: (message) => warnings.push(message),
  });

  expect(outcome.kind).toBe("post-header-timeout");
  expect(warnings).toEqual(["⚠ kokoro synth request timed out after 5ms — aborted, moving on"]);
});

test("a never-exiting say is killed, resolves, and does not poison the next call", async () => {
  const cfg = loadConfig();
  cfg.ttsEngine = "say";
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  const warnings: string[] = [];
  let spawns = 0;
  const spawnAudio = () => {
    spawns++;
    return {
      exited: spawns === 1 ? new Promise<number>(() => {}) : Promise.resolve(0),
      kill: (signal?: number | NodeJS.Signals) => kills.push(signal),
    };
  };
  const runtime = {
    spawnAudio,
    timeoutForText: () => 5,
    warn: (message: string) => warnings.push(message),
  };

  await speakCancellable(cfg, "first", "", runtime).done;
  await speakCancellable(cfg, "second", "", runtime).done;

  expect(spawns).toBe(2);
  expect(kills).toEqual(["SIGKILL"]);
  // Every say is a fallback and is now recorded; the timeout warning still fires.
  expect(warnings.filter((w) => !w.startsWith("tts fallback"))).toEqual([
    "⚠ say timed out after 5ms — killed, moving on",
  ]);
  expect(warnings.filter((w) => w.startsWith("tts fallback"))).toHaveLength(2);
});

test("a failed readiness canary reports recovery once before falling back to say", async () => {
  const cfg = loadConfig();
  cfg.ttsEngine = "server";
  const failures: string[] = [];
  const commands: string[][] = [];
  const originalFetch = globalThis.fetch;
  resetTtsReadiness();
  globalThis.fetch = Object.assign(
    (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/audio/voices")) return Promise.resolve(new Response("missing", { status: 404 }));
      return Promise.resolve(new Response("bad server config", { status: 422 }));
    },
    { preconnect: originalFetch.preconnect },
  );

  try {
    await speakCancellable(cfg, "fallback please", "", {
      spawnAudio: (command) => {
        commands.push(command);
        return { exited: Promise.resolve(0), kill() {} };
      },
      onKokoroFailure: (reason) => failures.push(reason),
      warn: () => {},
    }).done;
  } finally {
    globalThis.fetch = originalFetch;
    resetTtsReadiness();
  }

  expect(failures).toEqual(["readiness-failed"]);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.[0]).toBe("say");
});

test("an unavailable owned worker falls back to say immediately", async () => {
  const cfg = loadConfig();
  cfg.ttsEngine = "worker";
  const commands: string[][] = [];
  const failures: string[] = [];
  const recoveries: string[] = [];
  const worker: TtsWorkerBackend = {
    isReady: () => false,
    availableVoices: () => [],
    synthesize: async () => {
      throw new Error("must not synthesize while unavailable");
    },
    requestRecovery: (reason) => recoveries.push(reason),
  };

  await speakCancellable(cfg, "fallback while warming", "", {
    worker,
    spawnAudio: (command) => {
      commands.push(command);
      return { exited: Promise.resolve(0), kill() {} };
    },
    onKokoroFailure: (reason) => failures.push(reason),
    warn: () => {},
  }).done;

  expect(commands).toHaveLength(1);
  expect(commands[0]?.[0]).toBe("say");
  expect(failures).toEqual(["readiness-failed"]);
  expect(recoveries).toEqual(["speech requested while unavailable"]);
});

test("a worker synthesis timeout requests recovery and uses say", async () => {
  const cfg = loadConfig();
  cfg.ttsEngine = "worker";
  cfg.ttsBatchChars = 0;
  const commands: string[][] = [];
  const failures: string[] = [];
  let attempts = 0;
  const worker: TtsWorkerBackend = {
    isReady: () => true,
    availableVoices: () => ["af_heart"],
    synthesize: async () => {
      attempts++;
      throw new TtsWorkerTimeoutError();
    },
  };

  await speakCancellable(cfg, "fallback after timeout", "", {
    worker,
    spawnAudio: (command) => {
      commands.push(command);
      return { exited: Promise.resolve(0), kill() {} };
    },
    onKokoroFailure: (reason) => failures.push(reason),
    warn: () => {},
  }).done;

  expect(attempts).toBe(2);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.[0]).toBe("say");
  expect(failures).toEqual(["synth-timeout"]);
});
