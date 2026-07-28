import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  armBargeRecorder,
  createDictationSession,
  hasActiveRecorders,
  soxCaptureArgs,
} from "../src/listen.ts";

describe("sox capture arguments", () => {
  test("puts configured mic gain immediately before silence", () => {
    const args = soxCaptureArgs(
      { micGainDb: 12, endSilenceSecs: 3.5, endThresholdPct: 2 },
      "/tmp/conch-test.raw",
      2,
    );

    expect(args).toEqual([
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      "/tmp/conch-test.raw",
      "gain", "12",
      "silence", "-l",
      "1", "0.15", "2%",
      "1", "3.5", "2%",
    ]);
  });

  test("keeps the existing arguments unchanged when mic gain is zero", () => {
    const args = soxCaptureArgs(
      { micGainDb: 0, endSilenceSecs: 3.5, endThresholdPct: 2 },
      "/tmp/conch-test.raw",
      2,
    );

    expect(args).toEqual([
      "sox", "-d", "-q",
      "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw",
      "/tmp/conch-test.raw",
      "silence", "-l",
      "1", "0.15", "2%",
      "1", "3.5", "2%",
    ]);
    expect(args).not.toContain("gain");
  });
});

test("runtime session abort closes its recorder through a manual-reply barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-listen-abort-test-"));
  const fakeSox = join(root, "sox");
  writeFileSync(fakeSox, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const raw = process.argv[process.argv.indexOf("raw") + 1];
writeFileSync(raw, new Uint8Array());
await new Promise(() => {});
`);
  chmodSync(fakeSox, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath ?? ""}`;

  try {
    const cfg = loadConfig({ env: {}, settingsPath: join(root, "settings.json") });
    const session = createDictationSession(cfg);
    session.start();
    expect(session.micOpen).toBe(true);
    expect(hasActiveRecorders()).toBeTrue();
    await Bun.sleep(50); // let the fake recorder create its raw output

    const aborting = session.abort();
    expect(session.abort()).toBe(aborting); // scoped abort is idempotent
    let barrierReason = "";
    while (!barrierReason) {
      const event = await session.nextEvent();
      if (event.kind === "barrier") {
        barrierReason = event.reason;
        session.acknowledge(event);
      }
    }

    await aborting;
    expect(barrierReason).toBe("manual-reply");
    expect(session.micOpen).toBe(false);
    expect(session.state).toBe("idle");
    expect(hasActiveRecorders()).toBeFalse();

    const barge = armBargeRecorder(cfg);
    expect(hasActiveRecorders()).toBeTrue();
    await barge.abort();
    expect(hasActiveRecorders()).toBeFalse();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
