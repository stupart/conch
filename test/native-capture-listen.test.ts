import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { endpointQuietSecs, listenOnce, spawnNarrationRecorder } from "../src/listen.ts";
import { microphoneRecorders } from "../src/microphone-helper.ts";

/**
 * A whole listening window through conch Microphone's path, end to end: the
 * daemon's recorder choice, the installed copy, the stream, the capture gate,
 * conch's endpointer, and a transcription — with a stand-in helper that
 * writes a synthetic utterance (a floor, a second of tone, a floor) and a
 * stand-in whisper-cli that names what it was given. No microphone, no whisper.
 */

const roots: string[] = [];
const runtimeBefore = process.env.CONCH_MICROPHONE_RUNTIME_DIR;
afterEach(async () => {
  // The recorder choice is the daemon's one instance: leave it as a daemon that never started it.
  await microphoneRecorders.start(null);
  if (runtimeBefore === undefined) delete process.env.CONCH_MICROPHONE_RUNTIME_DIR;
  else process.env.CONCH_MICROPHONE_RUNTIME_DIR = runtimeBefore;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Each test installs its own copy: the installed one is kept while its protocol is the same, by design. */
function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  process.env.CONCH_MICROPHONE_RUNTIME_DIR = join(root, "Runtime");
  return root;
}

const PLIST = `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.blueprintstudio.conch.microphone</string>`
  + `<key>ConchHelperProtocol</key><string>1</string></dict></plist>`;

/** A conch-microphone stand-in: `--status` says allowed; otherwise an utterance at real time, ended by SIGINT or --seconds. */
function standInHelper(root: string): string {
  const script = join(root, "helper.js");
  writeFileSync(script, String.raw`
const args = process.argv.slice(2);
if (args.includes("--status")) { console.log(JSON.stringify({ authorization: "authorized" })); process.exit(0); }
writeFileSync(${JSON.stringify(join(root, "helper-args"))}, args.join(" "));
const at = args.indexOf("--seconds");
const limit = at >= 0 ? Number(args[at + 1]) * 16000 : Infinity;
process.on("SIGINT", () => process.exit(0));
let written = 0;
const timer = setInterval(() => {
  const n = Math.min(1600, limit - written);
  if (n <= 0) { clearInterval(timer); process.exit(0); }
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (written + i) / 16000;
    out.writeInt16LE(t >= 0.4 && t < 1.4 ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 3277) : (((written + i) * 7919) % 61) - 30, i * 2);
  }
  written += n;
  process.stdout.write(out);
}, 100);
function writeFileSync(path, text) { require("node:fs").writeFileSync(path, text); }
`);
  const path = join(root, "conch-microphone");
  writeFileSync(path, `#!/bin/bash\n# ${PLIST}\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A whisper-cli stand-in: says how many bytes of WAV it heard. */
function standInWhisper(root: string): string {
  const path = join(root, "whisper-cli");
  writeFileSync(path, `#!/bin/bash\nwhile [[ $# -gt 0 ]]; do [[ "$1" == "-f" ]] && f="$2"; shift; done\necho "heard $(wc -c < "$f" | tr -d ' ') bytes"\n`);
  chmodSync(path, 0o755);
  return path;
}

test("a listening window records through conch Microphone, starts with the pre-roll, ends on the pause, and is transcribed", async () => {
  const root = scratch("conch-native-listen-");
  // As the app's daemon runs it: the app's own helper, under the app's permission.
  const helper = standInHelper(root);
  await microphoneRecorders.start(helper, "attributed");
  expect(microphoneRecorders.snapshot()).toMatchObject({ path: helper, attribution: "attributed", authorization: "authorized" });

  const cfg = {
    ...loadConfig({ env: {}, settingsPath: join(root, "settings.json") }),
    whisperCli: standInWhisper(root),
    whisperModel: join(root, "model.bin"),
    whisperPort: 0,
    endSilenceSecs: 1,
    listenWindowSecs: 5,
    startThresholdPct: 2,
    endThresholdPct: 2,
  };
  const states: string[] = [];
  const started = Date.now();
  const result = await listenOnce(cfg, { onState: (state) => states.push(state) });
  const elapsed = (Date.now() - started) / 1000;

  expect(readFileSync(join(root, "helper-args"), "utf8")).toBe("--sample-rate 16000 --no-disclaim");
  expect(result.error).toBeUndefined();
  // 0.3s of pre-roll + 1s of tone + the pause up to the endpoint, as a WAV (44-byte header).
  const heard = Number(/^heard (\d+) bytes$/.exec(result.text)?.[1]);
  const seconds = (heard - 44) / 32_000;
  expect(seconds).toBeGreaterThan(1.3 + endpointQuietSecs(cfg, "native") - 0.2);
  expect(seconds).toBeLessThan(1.3 + cfg.endSilenceSecs + 0.6);
  // Armed, speech, and the next recorder armed behind it while this one is transcribed (#553).
  expect(states.slice(0, 2)).toEqual(["armed", "capturing"]);
  // Ended by the pause after the tone (it ends at 1.4s), not by the 5s window.
  expect(elapsed).toBeLessThan(4);
}, 15_000);

test("under launchd, a narration records whole through conch Microphone's installed copy, to its --seconds", async () => {
  const root = scratch("conch-native-narration-");
  await microphoneRecorders.start(standInHelper(root), "own");
  const installed = microphoneRecorders.snapshot().path!;
  expect(installed).toBe(join(root, "Runtime", "conch Microphone"));
  expect(existsSync(installed)).toBeTrue();
  const cfg = loadConfig({ env: {}, settingsPath: join(root, "settings.json") });
  const wav = join(root, "narration.wav");
  const proc = spawnNarrationRecorder(cfg, wav, 1);
  expect(await proc.exited).toBe(0);
  expect(readFileSync(join(root, "helper-args"), "utf8")).toBe("--sample-rate 16000 --seconds 1");
  const file = readFileSync(wav);
  expect(file.readUInt32LE(40)).toBe(32_000);
  expect(file.byteLength).toBe(44 + 32_000);
}, 10_000);
