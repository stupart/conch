import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  armBargeRecorder,
  CAPTURE_WATCHDOG_INTERVAL_MS,
  createDictationSession,
  hasActiveRecorders,
  rawCaptureFileGrew,
  soxCaptureArgs,
  stopSoxProcess,
} from "../src/listen.ts";

test("any raw capture growth starts speech independently of transcription MIN", () => {
  expect(rawCaptureFileGrew(0, 1)).toBeTrue();
  expect(rawCaptureFileGrew(8_000, 8_001)).toBeTrue();
  expect(rawCaptureFileGrew(16_000, 16_000)).toBeFalse();
  expect(rawCaptureFileGrew(16_000, 8_000)).toBeFalse();
});

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

test("stopSoxProcess sends SIGINT so SoX flushes its capture tail", () => {
  let signal: unknown;
  stopSoxProcess({
    kill(received) {
      signal = received;
    },
  });
  expect(signal).toBe("SIGINT");
});

test("runtime session abort closes its recorder through a manual-reply barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-listen-abort-test-"));
  const fakeSox = join(root, "sox");
  const fakeSoxReady = join(root, "sox-ready");
  writeFileSync(fakeSox, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const raw = process.argv[process.argv.indexOf("raw") + 1];
process.on("SIGINT", () => process.exit(0));
writeFileSync(raw, new Uint8Array());
writeFileSync(${JSON.stringify(fakeSoxReady)}, new Uint8Array());
await new Promise(() => {});
`);
  chmodSync(fakeSox, 0o755);
  const bun = Bun as any;
  const originalSpawn = bun.spawn;
  bun.spawn = (command: string[], options: any) => originalSpawn(
    [fakeSox, ...command.slice(1)],
    options,
  );

  try {
    const cfg = loadConfig({ env: {}, settingsPath: join(root, "settings.json") });
    const session = createDictationSession(cfg);
    session.start();
    expect(session.micOpen).toBe(true);
    expect(hasActiveRecorders()).toBeTrue();
    // Deterministically wait for the fake recorder's raw output instead of a fixed sleep.
    for (let attempt = 0; attempt < 400 && !existsSync(fakeSoxReady); attempt++) {
      await Bun.sleep(5);
    }
    expect(existsSync(fakeSoxReady)).toBe(true);

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
    bun.spawn = originalSpawn;
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw growth cancels a 600ms idle deadline before the fallback read gap drains", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-listen-growth-test-"));
  const fakeSox = join(root, "sox");
  const fakeSoxReady = join(root, "sox-ready");
  writeFileSync(fakeSox, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const raw = process.argv[process.argv.indexOf("raw") + 1];
process.on("SIGINT", () => process.exit(0));
writeFileSync(raw, new Uint8Array([1]));
writeFileSync(${JSON.stringify(fakeSoxReady)}, new Uint8Array());
await new Promise(() => {});
`);
  chmodSync(fakeSox, 0o755);
  const bun = Bun as any;
  const originalSpawn = bun.spawn;
  bun.spawn = (command: string[], options: any) => originalSpawn(
    [fakeSox, ...command.slice(1)],
    options,
  );
  let session: ReturnType<typeof createDictationSession> | undefined;

  try {
    expect(CAPTURE_WATCHDOG_INTERVAL_MS).toBeLessThan(600);
    const cfg = loadConfig({ env: {}, settingsPath: join(root, "settings.json") });
    const states: string[] = [];
    session = createDictationSession(
      cfg,
      { onState: (state) => states.push(state) },
      { idleWindowSecs: 0.6 },
    );
    session.start();
    for (let attempt = 0; attempt < 400 && !existsSync(fakeSoxReady); attempt++) {
      await Bun.sleep(5);
    }
    expect(existsSync(fakeSoxReady)).toBe(true);

    // This crosses the exact minimum fallback gap from daemon.ts. The former
    // 700ms watchdog lost this race before it could observe the first byte.
    await Bun.sleep(650);
    expect(states).toContain("capturing");
    expect(session.state).toBe("running");
    expect(session.micOpen).toBe(true);
  } finally {
    if (session && (session.state === "running" || session.state === "draining")) {
      const aborting = session.abort();
      while (true) {
        const event = await session.nextEvent();
        if (event.kind !== "barrier") continue;
        session.acknowledge(event);
        if (event.reason === "manual-reply") break;
      }
      await aborting;
    }
    bun.spawn = originalSpawn;
    rmSync(root, { recursive: true, force: true });
  }
});
