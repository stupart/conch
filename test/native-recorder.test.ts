import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pcmWavHeader, startNativeRecording } from "../src/native-recorder.ts";

/**
 * One capture through conch Microphone's stdout contract — mono s16le at
 * 16kHz, status on stderr, 77 for a refused permission — against a stand-in
 * process that writes synthetic PCM. No microphone is opened.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-native-recorder-"));
  roots.push(root);
  return root;
}

/**
 * A stand-in for conch-microphone. `--mode` picks what it does; it paces its
 * writes at twice real time and stops on SIGINT or after --seconds, as the
 * helper does.
 */
const STAND_IN = String.raw`
const args = process.argv.slice(2);
const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "speech";
const at = args.indexOf("--seconds");
const limit = at >= 0 ? Number(args[at + 1]) * 16000 : Infinity;
if (mode === "refuse") { process.stderr.write("Microphone access is off for conch Microphone. Allow it in System Settings.\n"); process.exit(77); }
if (mode === "fail") { process.stderr.write("No microphone input is available. Check Sound → Input.\n"); process.exit(1); }
if (mode === "orphan") {
  // Like the helper's relaunched copy: a child that holds the stream and outlives its proxy.
  Bun.spawn(["/bin/sh", "-c", "trap '' INT TERM; while :; do printf '\\000\\001'; sleep 0.05; done"], { stdout: "inherit" });
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  let written = 0;
  process.on("SIGINT", () => process.exit(0));
  const sample = (i) => {
    if (mode === "zeros") return 0;
    const t = i / 16000;
    const floor = ((i * 7919) % 81) - 40;
    return t >= 0.5 && t < 1.5 ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 3277) : floor;
  };
  const timer = setInterval(() => {
    const n = Math.min(1024, limit - written);
    if (n <= 0) { clearInterval(timer); process.exit(0); }
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) out.writeInt16LE(sample(written + i), i * 2);
    written += n;
    process.stdout.write(out);
  }, 32);
}
`;

function standIn(root: string): string {
  const script = join(root, "stand-in.js");
  writeFileSync(script, STAND_IN);
  const path = join(root, "conch Microphone");
  writeFileSync(path, `#!/bin/bash\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

const gate = { kind: "raw" as const, gate: { startPct: 2, prerollSecs: 0.3 } };

describe("a native capture", () => {
  test("the file stays empty through the quiet, then holds the pre-roll and the speech; SIGINT ends it whole", async () => {
    const root = scratch();
    const raw = join(root, "capture.raw");
    const recording = startNativeRecording({ argv: [standIn(root), "--mode", "speech", "--sample-rate", "16000"], path: raw, format: gate });
    expect(statSync(raw).size).toBe(0);
    expect(statSync(raw).mode & 0o777).toBe(0o600);
    // Half a second of floor at twice real time: still nothing.
    await Bun.sleep(150);
    expect(statSync(raw).size).toBe(0);
    while (statSync(raw).size === 0) await Bun.sleep(20);
    await Bun.sleep(700);
    recording.kill("SIGINT");
    expect(await recording.exited).toBe(0);
    const pcm = readFileSync(raw);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    // It begins about 0.3s before the tone (at 0.5s), so about 0.3s of floor leads.
    let first = 0;
    while (first < pcm.byteLength / 2 && Math.abs(view.getInt16(first * 2, true)) <= 40) first++;
    expect(first / 16_000).toBeGreaterThan(0.28);
    expect(first / 16_000).toBeLessThan(0.32);
  });

  test("a stop reads every byte the helper wrote before `exited` settles, and leaves no stream file", async () => {
    const root = scratch();
    const raw = join(root, "capture.raw");
    const recording = startNativeRecording({ argv: [standIn(root), "--mode", "speech"], path: raw, format: { kind: "raw", gate: { startPct: 0, prerollSecs: 0 } } });
    await Bun.sleep(300);
    recording.kill("SIGINT");
    await recording.exited;
    const size = statSync(raw).size;
    await Bun.sleep(100);
    expect(statSync(raw).size).toBe(size);
    expect(size % 2).toBe(0);
    expect(existsSync(`${raw}.stream`)).toBeFalse();
  });

  test("a daemon that stalls loses nothing: the helper's file waits to be read", async () => {
    const root = scratch();
    const raw = join(root, "capture.raw");
    const recording = startNativeRecording({ argv: [standIn(root), "--mode", "speech", "--seconds", "1"], path: raw, format: { kind: "raw", gate: { startPct: 0, prerollSecs: 0 } } });
    // Block this event loop for longer than the whole recording, as a stalled daemon would.
    const until = Date.now() + 1_500;
    while (Date.now() < until) {}
    expect(await recording.exited).toBe(0);
    // Every sample, from the stand-in's first: 1s at 16kHz.
    expect(statSync(raw).size).toBe(32_000);
  });

  test("a refused permission exits 77, says so on stderr, and is reported", async () => {
    const root = scratch();
    let refused = 0;
    const recording = startNativeRecording({
      argv: [standIn(root), "--mode", "refuse"], path: join(root, "c.raw"), format: gate, onPermissionRefused: () => refused++,
    });
    expect(await recording.exited).toBe(77);
    expect(refused).toBe(1);
    expect(recording.stderr()).toContain("Microphone access is off for conch Microphone");
  });

  test("a helper that cannot record exits with its reason on stderr", async () => {
    const root = scratch();
    const recording = startNativeRecording({ argv: [standIn(root), "--mode", "fail"], path: join(root, "c.raw"), format: gate });
    expect(await recording.exited).toBe(1);
    expect(recording.stderr()).toBe("No microphone input is available. Check Sound → Input.");
  });

  test("two seconds of exact zeros is reported as digital silence, once", async () => {
    const root = scratch();
    let silent = 0;
    const recording = startNativeRecording({
      argv: [standIn(root), "--mode", "zeros"], path: join(root, "c.raw"), format: gate, onDigitalSilence: () => silent++,
    });
    // Two seconds of zeros take one at the stand-in's pace, after it starts, which a loaded Mac can stretch: wait for
    // the report rather than a fixed 1.4s, then let more zeros come, which must not report it again.
    const deadline = Date.now() + 10_000;
    while (silent === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(silent).toBe(1);
    await Bun.sleep(300);
    recording.kill("SIGINT");
    await recording.exited;
    expect(silent).toBe(1);
    expect(statSync(join(root, "c.raw")).size).toBe(0);
  });

  test("a copy that outlives its proxy goes with it: the group is killed and the capture ends", async () => {
    const root = scratch();
    const recording = startNativeRecording({
      argv: [standIn(root), "--mode", "orphan"], path: join(root, "c.raw"), format: { kind: "raw", gate: { startPct: 0, prerollSecs: 0 } },
    });
    // Its copy is writing to the helper's stream, so the stand-in has spawned it and is listening for SIGINT. A fixed
    // 300 ms could interrupt a stand-in a loaded Mac had not started yet, which died of the signal (130) instead.
    const stream = join(root, "c.raw.stream");
    const deadline = Date.now() + 10_000;
    while (statSync(stream).size === 0 && Date.now() < deadline) await Bun.sleep(20);
    recording.kill("SIGINT");
    const started = Date.now();
    expect(await recording.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The group went with it: nothing still writes the capture.
    const size = statSync(join(root, "c.raw")).size;
    await Bun.sleep(200);
    expect(statSync(join(root, "c.raw")).size).toBe(size);
  });
});

describe("a recording kept whole", () => {
  test("is a WAV whose header names its length once it ends, ended by --seconds", async () => {
    const root = scratch();
    const wav = join(root, "narration.wav");
    writeFileSync(wav, "", { mode: 0o600 });
    const recording = startNativeRecording({
      argv: [standIn(root), "--mode", "speech", "--sample-rate", "16000", "--seconds", "0.5"], path: wav, format: { kind: "wav" },
    });
    expect(await recording.exited).toBe(0);
    const file = readFileSync(wav);
    expect(file.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(file.readUInt32LE(40)).toBe(8_000 * 2);
    expect(file.readUInt32LE(4)).toBe(36 + 16_000);
    expect(file.byteLength).toBe(44 + 16_000);
    expect(Array.from(file.subarray(0, 36))).toEqual(Array.from(pcmWavHeader(16_000).subarray(0, 36)));
    expect(statSync(wav).mode & 0o777).toBe(0o600);
  });
});
