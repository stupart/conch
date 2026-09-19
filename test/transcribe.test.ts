import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  filterWhisperTranscript,
  isLikelyWhisperHallucination,
  transcribePcm,
  WhisperServerClient,
} from "../src/transcribe.ts";
import type { Config } from "../src/config.ts";
import type { ColdTranscriptionProcess } from "../src/transcribe.ts";

function constantPcm(sample: number, seconds = 1): Uint8Array {
  const pcm = new Uint8Array(16_000 * 2 * seconds);
  const view = new DataView(pcm.buffer);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) view.setInt16(offset, sample, true);
  return pcm;
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function transcriptionConfig(): Config {
  return {
    whisperPort: 8642,
    whisperCli: "fake-whisper-cli",
    whisperModel: "fake-model.bin",
    vadModel: "fake-vad.bin",
  } as Config;
}

async function readyClient(finalResponse: Response): Promise<WhisperServerClient> {
  const responses = [
    new Response("root", { status: 200 }),
    Response.json({ text: "" }),
    finalResponse,
  ];
  const client = new WhisperServerClient({ request: async () => responses.shift()! });
  expect(await client.probeReadyUnlocked(transcriptionConfig(), 1_000)).toBeTrue();
  return client;
}

describe("Whisper hallucination filtering", () => {
  test("drops curated whole-transcript phantoms on low-energy short captures", () => {
    const quiet = constantPcm(0);
    for (const text of ["Thank you.", " you!!! ", "Thanks for watching.", "Bye."]) {
      expect(isLikelyWhisperHallucination(text, quiet)).toBeTrue();
      expect(filterWhisperTranscript(text, quiet)).toBe("");
    }
  });

  test("keeps genuine short replies and every protected command at low energy and confidence", () => {
    const quiet = constantPcm(0);
    const weak = [{ no_speech_prob: 0.99, avg_logprob: -9 }];
    for (const text of ["yes", "no", "stop", "go", "send", "sounds good"]) {
      expect(isLikelyWhisperHallucination(text, quiet, weak)).toBeFalse();
      expect(filterWhisperTranscript(text, quiet, weak)).toBe(text);
    }
  });

  test("never substring-matches a phantom phrase inside a real utterance", () => {
    const quiet = constantPcm(0);
    expect(filterWhisperTranscript("Thank you for checking that.", quiet)).toBe("Thank you for checking that.");
    expect(filterWhisperTranscript("You can send it now.", quiet)).toBe("You can send it now.");
  });

  test("keeps a blocklisted phrase when energy is credible and metadata is absent or malformed", () => {
    const speechLevel = constantPcm(2_000);
    expect(filterWhisperTranscript("Thank you.", speechLevel)).toBe("Thank you.");
    expect(filterWhisperTranscript("Thank you.", speechLevel, [{ no_speech_prob: "unknown" }])).toBe("Thank you.");
  });

  test("uses verbose segment confidence when a short phantom has credible PCM energy", () => {
    const speechLevel = constantPcm(2_000);
    expect(filterWhisperTranscript(
      "Thanks for watching.",
      speechLevel,
      [{ no_speech_prob: 0.95, avg_logprob: -0.2 }],
    )).toBe("");
    expect(filterWhisperTranscript(
      "Bye.",
      speechLevel,
      [{ no_speech_prob: 0.1, avg_logprob: -2.5 }],
    )).toBe("");
  });

  test("requests verbose confidence for final warm transcription without timestamp/language overhead", async () => {
    const forms: FormData[] = [];
    const responses = [
      new Response("root", { status: 200 }),
      Response.json({ text: "" }),
      Response.json({
        text: "Thank you.",
        segments: [{ no_speech_prob: 0.95, avg_logprob: -0.2 }],
      }),
    ];
    const client = new WhisperServerClient({
      request: async (_url, init) => {
        if (init?.body instanceof FormData) forms.push(init.body);
        return responses.shift()!;
      },
    });
    const cfg = { whisperPort: 8642 } as Config;
    expect(await client.probeReadyUnlocked(cfg, 1_000)).toBeTrue();
    const result = await client.transcribeWarm(cfg, new Uint8Array(44), 1_000);

    expect(result).toMatchObject({
      status: "ok",
      body: { segments: [{ no_speech_prob: 0.95, avg_logprob: -0.2 }] },
    });
    expect(forms).toHaveLength(2);
    expect(forms[0]!.get("response_format")).toBe("json"); // readiness stays cheap
    expect(forms[1]!.get("response_format")).toBe("verbose_json");
    expect(forms[1]!.get("no_timestamps")).toBe("true");
    expect(forms[1]!.get("no_language_probabilities")).toBe("true");
  });

  test("fails open for long captures even when a known phrase has weak evidence", () => {
    const longQuiet = constantPcm(0, 9);
    const weak = [{ no_speech_prob: 0.99, avg_logprob: -9 }];
    expect(filterWhisperTranscript("Thank you.", longQuiet, weak)).toBe("Thank you.");
  });
});

describe("cold transcription recovery", () => {
  test("runs the cold CLI once after a warm error and returns the recovered tail", async () => {
    const client = await readyClient(new Response("warm down", { status: 503 }));
    const commands: string[][] = [];
    const engines: string[] = [];
    const result = await transcribePcm(
      transcriptionConfig(),
      constantPcm(2_000),
      (engine) => engines.push(engine),
      {
        client,
        spawnCold: (command) => {
          commands.push(command);
          return {
            stdout: stream("recovered tail\n"),
            exited: Promise.resolve(0),
            kill() {},
          };
        },
      },
    );

    expect(result).toEqual({ text: "recovered tail" });
    expect(engines).toEqual(["cold"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]![0]).toBe("fake-whisper-cli");
    const inputIndex = commands[0]!.indexOf("-f");
    expect(inputIndex).toBeGreaterThan(0);
    expect(existsSync(commands[0]![inputIndex + 1]!)).toBeFalse();
  });

  test("bounds one cold attempt when stdout completes but process exit wedges", async () => {
    const client = await readyClient(new Response("warm down", { status: 503 }));
    const kills: Array<number | NodeJS.Signals | undefined> = [];
    const warnings: string[] = [];
    let spawns = 0;
    let unrefs = 0;
    let coldInput = "";
    const hung: ColdTranscriptionProcess = {
      stdout: stream(""),
      exited: new Promise<number>(() => {}),
      kill: (signal) => kills.push(signal),
      unref: () => { unrefs++; },
    };

    const result = await transcribePcm(transcriptionConfig(), constantPcm(2_000), undefined, {
      client,
      spawnCold: (command) => {
        spawns++;
        coldInput = command[command.indexOf("-f") + 1]!;
        return hung;
      },
      coldTimeoutMs: 5,
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ text: "", error: "Cold transcription timed out" });
    expect(spawns).toBe(1);
    expect(kills).toEqual(["SIGKILL"]);
    expect(unrefs).toBe(1);
    expect(warnings).toEqual(["⚠ cold transcription timed out after 5ms — killed, moving on"]);
    expect(existsSync(coldInput)).toBeFalse();
  });

  test("bounds one cold attempt when process exit completes but stdout wedges", async () => {
    const client = await readyClient(new Response("warm down", { status: 503 }));
    const kills: Array<number | NodeJS.Signals | undefined> = [];
    let unrefs = 0;
    let spawns = 0;
    const result = await transcribePcm(transcriptionConfig(), constantPcm(2_000), undefined, {
      client,
      spawnCold: () => {
        spawns++;
        return {
          stdout: new ReadableStream<Uint8Array>({ start() {} }),
          exited: Promise.resolve(0),
          kill: (signal) => kills.push(signal),
          unref: () => { unrefs++; },
        };
      },
      coldTimeoutMs: 5,
      warn() {},
    });

    expect(result).toEqual({ text: "", error: "Cold transcription timed out" });
    expect(spawns).toBe(1);
    expect(kills).toEqual(["SIGKILL"]);
    expect(unrefs).toBe(1);
  });

  test("disposes the cold child when stdout rejects before process exit", async () => {
    const client = await readyClient(new Response("warm down", { status: 503 }));
    const kills: Array<number | NodeJS.Signals | undefined> = [];
    let unrefs = 0;
    const result = await transcribePcm(transcriptionConfig(), constantPcm(2_000), undefined, {
      client,
      spawnCold: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error("stdout failed")); },
        }),
        exited: new Promise<number>(() => {}),
        kill: (signal) => kills.push(signal),
        unref: () => { unrefs++; },
      }),
      coldTimeoutMs: 1_000,
      warn() {},
    });

    expect(result).toEqual({ text: "", error: "Cold transcription failed" });
    expect(kills).toEqual(["SIGKILL"]);
    expect(unrefs).toBe(1);
  });

  test("a warm timeout falls through to exactly one cold recovery attempt", async () => {
    let requests = 0;
    const warmNever = new Promise<Response>(() => {});
    const client = new WhisperServerClient({
      request: async () => {
        requests++;
        if (requests === 1) return new Response("root", { status: 200 });
        if (requests === 2) return Response.json({ text: "" });
        return warmNever;
      },
    });
    expect(await client.probeReadyUnlocked(transcriptionConfig(), 1_000)).toBeTrue();
    let coldSpawns = 0;
    const result = await transcribePcm(transcriptionConfig(), constantPcm(2_000), undefined, {
      client,
      warmTimeoutMs: 5,
      spawnCold: () => {
        coldSpawns++;
        return { stdout: stream("timeout tail"), exited: Promise.resolve(0), kill() {} };
      },
    });

    expect(result).toEqual({ text: "timeout tail" });
    expect(coldSpawns).toBe(1);
  });

  test("a failed warm request with empty cold output remains a single empty result", async () => {
    const client = await readyClient(new Response("warm down", { status: 503 }));
    let coldSpawns = 0;
    const engines: string[] = [];
    const result = await transcribePcm(
      transcriptionConfig(),
      constantPcm(0),
      (engine) => engines.push(engine),
      {
        client,
        spawnCold: () => {
          coldSpawns++;
          return { stdout: stream(""), exited: Promise.resolve(0), kill() {} };
        },
      },
    );

    expect(result).toEqual({ text: "" });
    expect(engines).toEqual(["cold"]);
    expect(coldSpawns).toBe(1);
  });

  test("keeps a successful empty warm result empty without starting cold", async () => {
    const client = await readyClient(Response.json({ text: "", segments: [] }));
    let coldSpawns = 0;
    const engines: string[] = [];
    const result = await transcribePcm(
      transcriptionConfig(),
      constantPcm(0),
      (engine) => engines.push(engine),
      {
        client,
        spawnCold: () => {
          coldSpawns++;
          throw new Error("cold path must not run for warm silence");
        },
      },
    );

    expect(result).toEqual({ text: "" });
    expect(engines).toEqual(["warm"]);
    expect(coldSpawns).toBe(0);
  });
});

/**
 * Finding: Whisper's own repetition loop (2026-09-19).
 *
 * Read back out of /tmp/conch-sessions.json, the published dictation held this
 * clause SIX times — five array elements space-joined by the draft recovery,
 * the first of which was a single transcript Whisper had already doubled with
 * no separator at all ("...what we should fix" + "also theres..."). The
 * recovery's dedupe collapses the identical siblings; this collapses the one
 * element that arrived doubled inside a single transcript.
 */
describe("Whisper self-repetition", () => {
  // The exact clause from the incident: 83 characters, 17 words, no punctuation.
  const clause = "also theres a weird select outline that forms when i click on it what we should fix";
  const heard = () => constantPcm(0);

  test("a clause Whisper emitted twice with no separator is recovered once", () => {
    // Precisely the shape found in the snapshot: the transcript IS the clause doubled.
    expect(filterWhisperTranscript(clause + clause, heard())).toBe(clause);
  });

  test("the same loop separated by single spaces, and repeated more than twice", () => {
    expect(filterWhisperTranscript([clause, clause].join(" "), heard())).toBe(clause);
    // Four copies collapse to one, not to two.
    expect(filterWhisperTranscript([clause, clause, clause, clause].join(" "), heard())).toBe(clause);
  });

  test("deliberate repetition survives — short phrases are never touched", () => {
    // The units here are 2 and 4 characters: far under the floor, by design.
    expect(filterWhisperTranscript("no no no", heard())).toBe("no no no");
    expect(filterWhisperTranscript("very very", heard())).toBe("very very");
    expect(filterWhisperTranscript("that's it that's it", heard())).toBe("that's it that's it");
  });

  test("a repeated clause survives when anything sits between the copies", () => {
    // Not one span repeated end to end, so the rule does not apply at all.
    const spaced = `${clause} and then ${clause}`;
    expect(filterWhisperTranscript(spaced, heard())).toBe(spaced);
  });

  test("a repetition split by a sentence boundary survives", () => {
    // A full stop is a pause: someone said it twice, the decoder did not loop.
    const punctuated = "I will check that for you right now. I will check that for you right now.";
    expect(filterWhisperTranscript(punctuated, heard())).toBe(punctuated);
  });

  test("an ordinary utterance that merely repeats a word is untouched", () => {
    const real = "the select outline shows up when i click it and then it shows up again";
    expect(filterWhisperTranscript(real, heard())).toBe(real);
    expect(filterWhisperTranscript(clause, heard())).toBe(clause);
  });
});
