import { expect, test } from "bun:test";
import { TranscriptionGate } from "../src/transcription-gate.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function turns(count = 4): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

test("a final transcription waits for an admitted in-flight partial", async () => {
  let finalWorkerIdle = true;
  const gate = new TranscriptionGate(() => finalWorkerIdle);
  const releasePartial = deferred();
  const calls: string[] = [];

  const partial = gate.tryRunPartial(async () => {
    calls.push("partial-start");
    await releasePartial.promise;
    calls.push("partial-end");
    return "preview";
  });
  await turns();
  finalWorkerIdle = false;
  const final = gate.runFinal(async () => {
    calls.push("final");
    return "authoritative";
  });
  await turns();
  expect(calls).toEqual(["partial-start"]);

  releasePartial.resolve();
  await expect(partial).resolves.toBe("preview");
  await expect(final).resolves.toBe("authoritative");
  expect(calls).toEqual(["partial-start", "partial-end", "final"]);
});

test("a partial cannot enter while final work owns the worker", async () => {
  const gate = new TranscriptionGate(() => false);
  expect(gate.tryRunPartial(async () => "preview")).toBeUndefined();
  await expect(gate.runFinal(async () => "final")).resolves.toBe("final");
});
