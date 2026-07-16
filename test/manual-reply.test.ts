import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualReplyInterrupt, watchManualReplyDuringSpeech } from "../src/manual-reply.ts";

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
