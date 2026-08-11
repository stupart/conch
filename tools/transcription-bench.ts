/**
 * How good is each transcription option, on YOUR voice?
 *
 * Tyler asked the right question — "do we have benchmarks on quality for
 * existing and the options?" — and the honest answer was no. Published word
 * error rates are measured on read newsprint by voice actors, which is not the
 * task: conch hears one person dictating instructions full of words like
 * "Codex", "tmux" and "client-dashboard", often walking, often over a phone
 * mic. A number from someone else's corpus cannot settle it.
 *
 * So this measures the real thing. Record one passage; every engine gets the
 * same audio, and the score is against what you actually said.
 *
 *   1. bun tools/transcription-bench.ts record     — read the passage aloud
 *   2. bun tools/transcription-bench.ts run        — score every local engine
 *
 * The phone's own recogniser cannot be driven from here, so its column is
 * filled by dictating the same passage into conch from the phone and pasting
 * the result — `run` prints exactly where to put it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { transcribePcm } from "../src/transcribe.ts";
import { loadConfig } from "../src/config.ts";

const DIR = join(homedir(), ".cache", "conch", "bench");
const AUDIO = join(DIR, "passage.wav");
const TRUTH = join(DIR, "passage.txt");
const PHONE = join(DIR, "phone.txt");

/**
 * Deliberately hostile in the ways conch is hostile: product names a general
 * model has never seen, a path, an acronym, a number, and two sentences whose
 * meaning depends on where the punctuation lands.
 */
const PASSAGE = [
  "Open the conch daemon and check whether Codex is still holding the tmux pane.",
  "If the asset generator session is working, interrupt it and push the branch instead.",
  "The diff in client-dashboard touches apps slash portal slash storage, about eighteen megabytes.",
  "Kokoro timed out again, so fall back to say for now.",
  "Don't merge it. Wait for me.",
].join(" ");

/** Word error rate: edits needed to turn `heard` into `said`, over its length. */
function wordErrorRate(said: string, heard: string): number {
  const a = normalise(said), b = normalise(heard);
  if (!a.length) return b.length ? 1 : 0;
  // Standard Levenshtein over words, one row at a time.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]!
        : 1 + Math.min(prev[j]!, row[j - 1]!, prev[j - 1]!);
    }
    prev = row;
  }
  return prev[b.length]! / a.length;
}

function normalise(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** The words that actually matter: get "Codex" wrong and the sentence is void. */
const CRITICAL = ["conch", "codex", "tmux", "kokoro", "client", "dashboard", "portal", "diff", "branch"];

function criticalMisses(said: string, heard: string): string[] {
  const heardWords = new Set(normalise(heard));
  return CRITICAL.filter((word) => normalise(said).includes(word) && !heardWords.has(word));
}

async function record(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  console.log("\nRead this aloud, at your normal pace:\n");
  console.log(`  ${PASSAGE.replace(/\. /g, ".\n  ")}\n`);
  console.log("Recording for 30 seconds — press Ctrl-C when you finish.\n");
  writeFileSync(TRUTH, PASSAGE);
  const sox = Bun.spawn(
    ["sox", "-d", "-r", "16000", "-c", "1", "-b", "16", AUDIO, "trim", "0", "30"],
    { stdout: "inherit", stderr: "inherit" },
  );
  await sox.exited;
  console.log(`\nSaved ${AUDIO}\nNow run:  bun tools/transcription-bench.ts run`);
}

async function run(): Promise<void> {
  if (!existsSync(AUDIO)) {
    console.error("No recording yet — run `bun tools/transcription-bench.ts record` first.");
    process.exit(1);
  }
  const said = readFileSync(TRUTH, "utf8");
  const cfg = loadConfig();
  const results: Array<{ engine: string; text: string; ms: number }> = [];

  // The wav's 44-byte header off the front: transcribePcm wants raw PCM16.
  const wav = new Uint8Array(await Bun.file(AUDIO).arrayBuffer());
  const pcm = wav.subarray(44);
  const started = Date.now();
  const whisper = await transcribePcm(cfg, pcm).catch((error) => ({
    text: `«failed: ${error}»`,
  }));
  results.push({
    engine: `whisper (${cfg.whisperModel.split("/").pop()})`,
    text: whisper.text,
    ms: Date.now() - started,
  });

  if (existsSync(PHONE)) {
    results.push({ engine: "iPhone (Apple on-device)", text: readFileSync(PHONE, "utf8"), ms: 0 });
  }

  console.log(`\nSaid:\n  ${said}\n`);
  for (const result of results) {
    const wer = wordErrorRate(said, result.text);
    const missed = criticalMisses(said, result.text);
    console.log(`${result.engine}`);
    console.log(`  heard: ${result.text.trim()}`);
    console.log(
      `  WER ${(wer * 100).toFixed(1)}%`
      + `${result.ms ? ` · ${(result.ms / 1000).toFixed(1)}s` : ""}`
      + `${missed.length ? ` · MISSED: ${missed.join(", ")}` : " · no critical words missed"}`,
    );
    console.log("");
  }

  if (!existsSync(PHONE)) {
    console.log("To score the phone: dictate the same passage into conch from your");
    console.log(`phone, then save exactly what arrived to:\n  ${PHONE}\n`);
  }
}

const command = Bun.argv[2] ?? "run";
if (command === "record") await record();
else await run();
