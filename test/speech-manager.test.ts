import { expect, test } from "bun:test";
import { loadConfig as loadRealConfig } from "../src/config.ts";
import {
  SpeechManager,
  type SpeechAudioGate,
  type SpeechBackend,
} from "../src/speech-manager.ts";

function loadConfig() {
  return loadRealConfig({ env: {}, settingsPath: `/tmp/conch-speech-manager-test-${process.pid}/settings.json` });
}

const passThroughGate: SpeechAudioGate = async (_operation, task) => task();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("speech manager serializes utterances and quiescent waits for all playback", async () => {
  const cfg = loadConfig();
  const active: Array<ReturnType<typeof deferred<void>>> = [];
  const starts: string[] = [];
  const backend: SpeechBackend = {
    speakCancellable: (_cfg, text) => {
      starts.push(text);
      const d = deferred<void>();
      active.push(d);
      return { done: d.promise, cancel: () => d.resolve() };
    },
    stopSpeaking() {},
  };
  const manager = new SpeechManager(backend, passThroughGate);

  const first = manager.speak(cfg, "first");
  const second = manager.speak(cfg, "second");
  await Promise.resolve();
  expect(starts).toEqual(["first"]);

  let idle = false;
  const quiescent = manager.quiescent().then(() => (idle = true));
  active[0]!.resolve();
  await first;
  await Promise.resolve();
  expect(starts).toEqual(["first", "second"]);
  expect(idle).toBeFalse();

  active[1]!.resolve();
  await Promise.all([second, quiescent]);
  expect(idle).toBeTrue();
});

test("queued speech is gated at actual start after an earlier probe releases", async () => {
  const cfg = loadConfig();
  const order: string[] = [];
  const probe = deferred<void>();
  let normalMicOpen = false;
  let speechStarts = 0;
  const manager = new SpeechManager({
    speakCancellable: () => {
      speechStarts++;
      order.push("speech");
      return { done: Promise.resolve(), cancel() {} };
    },
    stopSpeaking() {},
  }, async (operation, task) => {
    order.push(`gate:${operation}`);
    if (normalMicOpen) throw new Error(`audio gate violation: normal mic open before ${operation}`);
    return task();
  });

  const probing = manager.runProbe(async () => {
    order.push("probe");
    await probe.promise;
  });
  const speaking = manager.speak(cfg, "after");
  const speechResult = speaking.then(
    () => null,
    (error: unknown) => error,
  );
  await Promise.resolve();
  expect(order).toEqual(["gate:TTS readiness probe", "probe"]);

  // Speech was queued while the normal mic was closed. The authoritative gate
  // must check again when that queued task actually reaches the front.
  probe.resolve();
  normalMicOpen = true;
  await probing;
  const error = await speechResult;
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("audio gate violation");
  expect(order).toEqual(["gate:TTS readiness probe", "probe", "gate:TTS"]);
  expect(speechStarts).toBe(0);
  await manager.quiescent();
});

test("cancelAll cancels active playback and skips queued utterances", async () => {
  const cfg = loadConfig();
  const starts: string[] = [];
  let cancels = 0;
  const active = deferred<void>();
  const manager = new SpeechManager({
    speakCancellable: (_cfg, text) => {
      starts.push(text);
      return {
        done: active.promise,
        cancel: () => {
          cancels++;
          active.resolve();
        },
      };
    },
    stopSpeaking() {},
  }, passThroughGate);

  const first = manager.speak(cfg, "first");
  const second = manager.speak(cfg, "never started");
  manager.cancelAll();
  await Promise.all([first, second, manager.quiescent()]);
  expect(cancels).toBe(1);
  expect(starts).toEqual(["first"]);
});

test("close seals the manager against work enqueued after shutdown", async () => {
  const cfg = loadConfig();
  const starts: string[] = [];
  const manager = new SpeechManager({
    speakCancellable: (_cfg, text) => {
      starts.push(text);
      return { done: Promise.resolve(), cancel() {} };
    },
    stopSpeaking() {},
  }, passThroughGate);

  manager.close();
  await manager.speak(cfg, "too late");
  await manager.runProbe(async () => starts.push("probe"));
  await manager.quiescent();
  expect(starts).toEqual([]);
});

test("active probes are abortable and a rejected task does not poison the lane", async () => {
  const cfg = loadConfig();
  let probeAborted = false;
  const starts: string[] = [];
  const manager = new SpeechManager({
    speakCancellable: (_cfg, text) => {
      starts.push(text);
      return { done: Promise.resolve(), cancel() {} };
    },
    stopSpeaking() {},
  }, passThroughGate);

  const probe = manager.runProbe(
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          probeAborted = true;
          resolve();
        });
      }),
  );
  manager.cancelCurrent();
  await probe;
  expect(probeAborted).toBeTrue();

  await expect(manager.runProbe(async () => {
    throw new Error("canary failed");
  })).rejects.toThrow("canary failed");
  await manager.speak(cfg, "still works");
  expect(starts).toEqual(["still works"]);
});

test("interruptible speech holds exclusion through barge recorder cleanup", async () => {
  const cfg = loadConfig();
  const playback = deferred<void>();
  const recorderFinished = deferred<void>();
  const order: string[] = [];
  const manager = new SpeechManager({
    speakCancellable: () => {
      order.push("playback");
      return { done: playback.promise, cancel: () => playback.resolve() };
    },
    stopSpeaking() {},
  }, passThroughGate);

  const interaction = manager.runInterruptible(cfg, "hello", "session", async (startSpeech) => {
    order.push("barge-armed");
    const spoken = startSpeech();
    await spoken.done;
    order.push("playback-done");
    await recorderFinished.promise;
    order.push("barge-clean");
  });
  const recovery = manager.runProbe(async () => {
    order.push("recovery-probe");
  });

  playback.resolve();
  await Bun.sleep(0); // watchdog wrapper settles independently of backend.done
  expect(order).toEqual(["barge-armed", "playback", "playback-done"]);
  recorderFinished.resolve();
  await Promise.all([interaction, recovery]);
  expect(order).toEqual(["barge-armed", "playback", "playback-done", "barge-clean", "recovery-probe"]);
});

test("a queued interruptible interaction reports cancellation without starting", async () => {
  const cfg = loadConfig();
  const gate = deferred<void>();
  let interactionStarted = false;
  const manager = new SpeechManager({
    speakCancellable: () => ({ done: Promise.resolve(), cancel() {} }),
    stopSpeaking() {},
  }, passThroughGate);

  const probe = manager.runProbe(async () => gate.promise);
  const interaction = manager.runInterruptible(cfg, "queued", "session", async () => {
    interactionStarted = true;
    return "finished";
  });
  manager.cancelPendingAudio();
  gate.resolve();

  expect(await interaction).toBeUndefined();
  expect(interactionStarted).toBeFalse();
  await probe;
});

test("a never-resolving backend times out, releases the lane, and later speech runs", async () => {
  const cfg = loadConfig();
  const starts: string[] = [];
  const warnings: string[] = [];
  let cancels = 0;
  const manager = new SpeechManager({
    speakCancellable: (_cfg, text) => {
      starts.push(text);
      if (text === "wedged") {
        return {
          done: new Promise<void>(() => {}),
          cancel: () => { cancels++; }, // deliberately does not settle `done`
        };
      }
      return { done: Promise.resolve(), cancel() {} };
    },
    stopSpeaking() {},
  }, passThroughGate, {
    timeoutForText: () => 8,
    warn: (message) => warnings.push(message),
  });

  const wedged = manager.speak(cfg, "wedged");
  const after = manager.speak(cfg, "after");
  await Promise.all([wedged, after, manager.quiescent()]);

  expect(cancels).toBe(1);
  expect(starts).toEqual(["wedged", "after"]);
  expect(warnings).toEqual(["⚠ TTS timed out after 8ms — cancelled, moving on"]);
});

test("a never-exiting afplay cue is killed and does not retain the audio gate", async () => {
  const cfg = loadConfig();
  const starts: string[] = [];
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  const manager = new SpeechManager({
    speakCancellable: (_cfg, text) => {
      starts.push(text);
      return { done: Promise.resolve(), cancel() {} };
    },
    stopSpeaking() {},
  }, passThroughGate, {
    spawnAudio: () => ({
      exited: new Promise<number>(() => {}),
      kill: (signal) => kills.push(signal),
    }),
    timeoutForText: () => 8,
    warn: () => {},
  });

  const cue = manager.playCue("/fake/bell.aiff", "attention bell");
  const after = manager.speak(cfg, "after cue");
  await Promise.all([cue, after, manager.quiescent()]);

  expect(kills).toEqual(["SIGKILL"]);
  expect(starts).toEqual(["after cue"]);
});

test("normal speech completing inside its budget is not cancelled", async () => {
  const cfg = loadConfig();
  let cancels = 0;
  const warnings: string[] = [];
  const manager = new SpeechManager({
    speakCancellable: () => ({
      done: Promise.resolve(),
      cancel: () => { cancels++; },
    }),
    stopSpeaking() {},
  }, passThroughGate, {
    timeoutForText: () => 25,
    warn: (message) => warnings.push(message),
  });

  await manager.speak(cfg, "normal");
  await manager.quiescent();
  expect(cancels).toBe(0);
  expect(warnings).toEqual([]);
});
