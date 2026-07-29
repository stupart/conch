import { describe, expect, test } from "bun:test";
import { routeVoicePrompt } from "../src/voice-qa.ts";

interface HarnessOptions {
  answer?: string | null;
  askError?: Error;
  readError?: Error;
  canContinue?: () => boolean | Promise<boolean>;
}

function harness(options: HarnessOptions = {}) {
  const asked: Array<{ prompt: string; options: unknown }> = [];
  const spoken: string[] = [];
  const injected: string[] = [];
  return {
    asked,
    spoken,
    injected,
    dependencies: {
      async askClaude(prompt: string, askOptions?: unknown) {
        asked.push({ prompt, options: askOptions });
        if (options.askError) throw options.askError;
        return options.answer ?? null;
      },
      async speak(text: string) {
        spoken.push(text);
      },
      async inject(text: string) {
        injected.push(text);
        return true;
      },
      async readLastAssistantText() {
        if (options.readError) throw options.readError;
        return "The migration passed all 42 tests.\n\n```sh\nbun test\n```";
      },
      canContinue: options.canContinue,
    },
  };
}

describe("voice QA routing", () => {
  test("default-off behavior delivers the exact original utterance", async () => {
    const h = harness({ answer: "unused" });

    expect(await routeVoicePrompt(
      false,
      "conch, did the tests pass?",
      "/tmp/session.jsonl",
      h.dependencies,
    )).toBeTrue();

    expect(h.injected).toEqual(["conch, did the tests pass?"]);
    expect(h.asked).toEqual([]);
    expect(h.spoken).toEqual([]);
  });

  test("ordinary prompts retain the existing injector path when enabled", async () => {
    const h = harness({ answer: "unused" });

    await routeVoicePrompt(
      true,
      "please rerun the tests",
      "/tmp/session.jsonl",
      h.dependencies,
    );

    expect(h.injected).toEqual(["please rerun the tests"]);
    expect(h.asked).toEqual([]);
  });

  test("a prefixed question is answered from the last reply and never injected", async () => {
    const h = harness({ answer: "Yes. All 42 tests passed." });

    expect(await routeVoicePrompt(
      true,
      "Conch, did the tests pass?",
      "/tmp/session.jsonl",
      h.dependencies,
    )).toBeTrue();

    expect(h.injected).toEqual([]);
    expect(h.spoken).toEqual(["Yes. All 42 tests passed."]);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.prompt).toContain("The migration passed all 42 tests.");
    expect(h.asked[0]!.prompt).not.toContain("bun test");
    expect(h.asked[0]!.prompt).toContain("Question: did the tests pass?");
    expect(h.asked[0]!.options).toEqual({ maxChars: 300 });
  });

  test.each([
    // Had a transcript but the model gave nothing back = an honest failure line.
    ["null", { answer: null }, "Something went wrong — I couldn't get an answer."],
    ["throw", { askError: new Error("model unavailable") }, "Something went wrong — I couldn't get an answer."],
    // No transcript to read at all — the model was never asked, so it's a plain can't-check.
    ["transcript failure", { readError: new Error("mid-write") }, "I couldn't check that."],
  ] as const)("%s speaks an honest failure and still never injects", async (_name, options, spoken) => {
    const h = harness(options);

    expect(await routeVoicePrompt(
      true,
      "hey conch what changed",
      "/tmp/session.jsonl",
      h.dependencies,
    )).toBeTrue();

    expect(h.injected).toEqual([]);
    expect(h.spoken).toEqual([spoken]);
  });

  test("a cancellation after the model wait consumes the query without speech or injection", async () => {
    let checks = 0;
    const h = harness({
      answer: "The answer",
      canContinue: () => ++checks === 1,
    });

    expect(await routeVoicePrompt(
      true,
      "conch, status?",
      "/tmp/session.jsonl",
      h.dependencies,
    )).toBeFalse();

    expect(h.asked).toHaveLength(1);
    expect(h.injected).toEqual([]);
    expect(h.spoken).toEqual([]);
  });
});
