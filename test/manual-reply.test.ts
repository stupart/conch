import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManualReplyListenGuard,
  manualReplyListenBaseline,
  ManualReplyInterrupt,
  watchManualReplyDuringListen,
  watchManualReplyDuringSpeech,
} from "../src/manual-reply.ts";
import {
  DictationReducer,
  type DictationActionReadyEffect,
  type RequestBarrierEffect,
} from "../src/dictation-reducer.ts";
import { userRespondedSince } from "../src/snippet.ts";

const roots: string[] = [];

function fixture(): { path: string; finish: () => void; playback: { done: Promise<void>; cancel: () => void }; cancelled: () => number } {
  const root = mkdtempSync(join(tmpdir(), "conch-manual-reply-test-"));
  roots.push(root);
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, JSON.stringify({ type: "user", message: { content: "initial prompt" } }) + "\n");
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  let cancellations = 0;
  return {
    path,
    finish,
    playback: {
      done,
      cancel() {
        cancellations++;
        finish();
      },
    },
    cancelled: () => cancellations,
  };
}

function appendPrompt(path: string, text: string): void {
  appendFileSync(path, JSON.stringify({ type: "user", message: { content: text } }) + "\n");
}

function readyHeldSend(payload = "spoken reply"): {
  reducer: DictationReducer;
  action: DictationActionReadyEffect;
} {
  const reducer = new DictationReducer({ holdSubmit: true });
  reducer.consume({ type: "transcript", sequence: 1, text: payload, diagnosticId: "spoken" });
  const effects = reducer.consume({ type: "transcript", sequence: 2, text: "send it", diagnosticId: "send" });
  const request = effects.find((effect): effect is RequestBarrierEffect => effect.type === "request-barrier");
  if (!request) throw new Error("expected held send barrier");
  const ready = reducer.consume({
    type: "barrier",
    sequence: 3,
    id: "send-barrier",
    reason: request.reason,
    requestId: request.requestId,
  }).find((effect): effect is DictationActionReadyEffect => effect.type === "action-ready");
  if (!ready) throw new Error("expected held send action");
  return { reducer, action: ready };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for playback cancellation");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("automatic listens retain the hook mark while explicit wakes take a fresh baseline", async () => {
  const f = fixture();
  appendPrompt(f.path, "reply sent before an explicit wake");

  const automatic = await manualReplyListenBaseline({
    type: "turn-end",
    transcriptPath: f.path,
    mark: 1,
  });
  const wake = await manualReplyListenBaseline({
    type: "wake",
    transcriptPath: f.path,
    mark: 1,
  });

  expect(automatic.mark).toBe(1);
  expect(await userRespondedSince(automatic.transcriptPath, automatic.mark)).toBe(true);
  expect(wake.mark).toBe(2);
  expect(await userRespondedSince(wake.transcriptPath, wake.mark)).toBe(false);

  appendPrompt(f.path, "manual reply after the wake mic opens");
  expect(await userRespondedSince(wake.transcriptPath, wake.mark)).toBe(true);
});

test("a human prompt mid-read cancels playback and ends the read before the mic path", async () => {
  const f = fixture();
  let micOpened = false;
  const flow = (async () => {
    await watchManualReplyDuringSpeech(
      { transcriptPath: f.path, mark: 1 },
      f.playback,
      () => true,
      5,
    );
    micOpened = true; // production continues toward mic setup only after this await
  })().catch((error) => error);

  appendFileSync(f.path, JSON.stringify({ type: "user", message: { content: "my typed reply" } }) + "\n");

  await waitUntil(() => f.cancelled() === 1);
  expect(await flow).toBeInstanceOf(ManualReplyInterrupt);
  expect(f.cancelled()).toBe(1);
  expect(micOpened).toBe(false);
});

test("a task-notification mid-read does not cancel playback", async () => {
  const f = fixture();
  const watching = watchManualReplyDuringSpeech(
    { transcriptPath: f.path, mark: 1 },
    f.playback,
    () => true,
    5,
  );
  appendFileSync(f.path, JSON.stringify({
    type: "user",
    message: { content: "<task-notification>done</task-notification>" },
    origin: { kind: "task-notification" },
    promptSource: "system",
  }) + "\n");

  await Bun.sleep(30);
  expect(f.cancelled()).toBe(0);
  f.finish();
  expect(await watching).toBeUndefined();
});

test("interrupt-on-manual-reply=false leaves playback running", async () => {
  const f = fixture();
  const watching = watchManualReplyDuringSpeech(
    { transcriptPath: f.path, mark: 1 },
    f.playback,
    () => false,
    5,
  );
  appendFileSync(f.path, JSON.stringify({ type: "user", message: { content: "my typed reply" } }) + "\n");

  await Bun.sleep(30);
  expect(f.cancelled()).toBe(0);
  f.finish();
  expect(await watching).toBeUndefined();
});

test("a human prompt while listening aborts the scoped session and prevents voice injection", async () => {
  const f = fixture();
  let aborts = 0;
  let voiceInjections = 0;
  const flow = (async () => {
    await watchManualReplyDuringListen(
      { transcriptPath: f.path, mark: 1 },
      {
        async abort() {
          aborts++;
          f.finish();
        },
      },
      f.playback.done,
      () => true,
      5,
    );
    voiceInjections++;
  })().catch((error) => error);

  appendPrompt(f.path, "my out-of-band typed reply");

  await waitUntil(() => aborts === 1);
  expect(await flow).toBeInstanceOf(ManualReplyInterrupt);
  expect(aborts).toBe(1);
  expect(voiceInjections).toBe(0);
});

test("a ready spoken send loses to a manual prompt at the production submit boundary", async () => {
  const f = fixture();
  const cfg = { interruptOnManualReply: false };
  let aborts = 0;
  const voiceInjections: string[] = [];
  const { action } = readyHeldSend("voice payload that must lose");
  const guard = createManualReplyListenGuard(
    { transcriptPath: f.path, mark: 1 },
    {
      async abort() {
        aborts++;
        f.finish();
      },
    },
    f.playback.done,
    () => cfg.interruptOnManualReply,
    () => {},
    5,
  );
  const guardResult = guard.done.catch((error) => error);

  // Disable the immediate probe, then enable and close in this same task so no
  // timer tick can rescue a broken final-boundary implementation.
  cfg.interruptOnManualReply = true;
  appendPrompt(f.path, "manual text wins over ready voice send");
  const mayInject = await guard.closeBeforeSubmit();
  if (mayInject && action.payload) voiceInjections.push(action.payload);

  expect(mayInject).toBe(false);
  expect(await guardResult).toBeInstanceOf(ManualReplyInterrupt);
  expect(aborts).toBe(1);
  expect(voiceInjections).toEqual([]);
});

test("conch's own injected prompt remains visible before dictation cleanup without self-aborting", async () => {
  const f = fixture();
  const cfg = { interruptOnManualReply: true };
  let aborts = 0;
  const voiceInjections: string[] = [];
  let settled = false;
  const { action } = readyHeldSend("normal transcribed voice reply");
  const guard = createManualReplyListenGuard(
    { transcriptPath: f.path, mark: 1 },
    { abort: () => void aborts++ },
    f.playback.done,
    () => cfg.interruptOnManualReply,
    () => {},
    5,
  );
  const watching = guard.done.finally(() => {
    settled = true;
  });

  expect(await guard.closeBeforeSubmit()).toBe(true);
  if (action.payload) {
    voiceInjections.push(action.payload);
    appendPrompt(f.path, action.payload); // exactly what injectText -> Enter writes
  }
  expect(await userRespondedSince(f.path, 1)).toBe(true); // raw provenance is indistinguishable

  await Bun.sleep(30); // own prompt stays visible while deliver confirms submission
  expect(aborts).toBe(0);
  expect(settled).toBe(false);
  expect(voiceInjections).toEqual(["normal transcribed voice reply"]);

  f.finish();
  expect(await watching).toBeUndefined();
  expect(aborts).toBe(0);
});

test("the listen watcher does not copy speech's trailing post-done transcript check", async () => {
  const f = fixture();
  let aborts = 0;
  let enabled = false;
  const watching = watchManualReplyDuringListen(
    { transcriptPath: f.path, mark: 1 },
    { abort: () => void aborts++ },
    f.playback.done,
    () => enabled,
    1_000,
  );

  enabled = true; // the disabled immediate check is synchronous; timer cannot fire yet
  f.finish();
  appendPrompt(f.path, "conch-owned prompt written as dictation settles");

  expect(await watching).toBeUndefined();
  expect(aborts).toBe(0);
});

test("interrupt-on-manual-reply=false leaves the listening session open until normal completion", async () => {
  const f = fixture();
  const cfg = { interruptOnManualReply: false };
  let aborts = 0;
  let settled = false;
  const guard = createManualReplyListenGuard(
    { transcriptPath: f.path, mark: 1 },
    { abort: () => void aborts++ },
    f.playback.done,
    () => cfg.interruptOnManualReply,
    () => {},
    5,
  );
  const watching = guard.done.finally(() => {
    settled = true;
  });
  appendPrompt(f.path, "my typed reply");

  await Bun.sleep(30);
  expect(aborts).toBe(0);
  expect(settled).toBe(false);
  expect(await guard.closeBeforeSubmit()).toBe(true);

  f.finish();
  expect(await watching).toBeUndefined();
  expect(aborts).toBe(0);
});

test("hold-submit keeps watching across segments and aborts a later manual reply exactly once", async () => {
  const f = fixture();
  const reducer = new DictationReducer({ holdSubmit: true });
  let aborts = 0;
  let voiceInjections = 0;
  const guard = createManualReplyListenGuard(
    { transcriptPath: f.path, mark: 1 },
    {
      async abort() {
        aborts++;
        f.finish();
      },
    },
    f.playback.done,
    () => true,
    () => {},
    5,
  );
  const guardResult = guard.done.catch((error) => error);

  reducer.consume({ type: "transcript", sequence: 1, text: "first spoken segment" });
  await Bun.sleep(20);
  reducer.consume({ type: "transcript", sequence: 2, text: "second spoken segment" });
  await Bun.sleep(20);
  expect(aborts).toBe(0);
  expect(reducer.snapshot.buffer.map((segment) => segment.text)).toEqual([
    "first spoken segment",
    "second spoken segment",
  ]);

  appendPrompt(f.path, "manual reply before spoken submit");
  await waitUntil(() => aborts === 1);
  if (await guard.closeBeforeSubmit()) voiceInjections++;

  expect(await guardResult).toBeInstanceOf(ManualReplyInterrupt);
  expect(aborts).toBe(1);
  expect(voiceInjections).toBe(0);
});
