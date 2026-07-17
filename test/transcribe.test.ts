import { describe, expect, test } from "bun:test";
import {
  filterWhisperTranscript,
  isLikelyWhisperHallucination,
  WhisperServerClient,
} from "../src/transcribe.ts";
import type { Config } from "../src/config.ts";

function constantPcm(sample: number, seconds = 1): Uint8Array {
  const pcm = new Uint8Array(16_000 * 2 * seconds);
  const view = new DataView(pcm.buffer);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) view.setInt16(offset, sample, true);
  return pcm;
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
