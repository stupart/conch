import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { SpeechManager, type SpeechBackend } from "../src/speech-manager.ts";

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
  const manager = new SpeechManager(backend);

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

test("probe, regular microphone capture, and speech share one exclusion lane", async () => {
  const cfg = loadConfig();
  const order: string[] = [];
  const probe = deferred<void>();
  const mic = deferred<void>();
  const playback = deferred<void>();
  const manager = new SpeechManager({
    speakCancellable: () => {
      order.push("speech");
      return { done: playback.promise, cancel: () => playback.resolve() };
    },
    stopSpeaking() {},
  });

  const probing = manager.runProbe(async () => {
    order.push("probe");
    await probe.promise;
  });
  const listening = manager.withMicrophone(async () => {
    order.push("mic");
    await mic.promise;
  }, () => mic.resolve());
  const speaking = manager.speak(cfg, "after");
  await Promise.resolve();
  expect(order).toEqual(["probe"]);

  probe.resolve();
  await probing;
  await Promise.resolve();
  expect(order).toEqual(["probe", "mic"]);

  mic.resolve();
  await listening;
  await Promise.resolve();
  expect(order).toEqual(["probe", "mic", "speech"]);
  playback.resolve();
  await speaking;
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
  });

  const first = manager.speak(cfg, "first");
  const second = manager.speak(cfg, "never started");
  manager.cancelAll();
  await Promise.all([first, second, manager.quiescent()]);
  expect(cancels).toBe(1);
  expect(starts).toEqual(["first"]);
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
  });

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
  });

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
  await Promise.resolve();
  expect(order).toEqual(["barge-armed", "playback", "playback-done"]);
  recorderFinished.resolve();
  await Promise.all([interaction, recovery]);
  expect(order).toEqual(["barge-armed", "playback", "playback-done", "barge-clean", "recovery-probe"]);
});
