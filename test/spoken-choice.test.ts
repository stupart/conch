import { describe, expect, test } from "bun:test";
import { classifySpokenChoice } from "../src/dictation-reducer.ts";

/**
 * Answering an agent's multiple-choice question out loud.
 *
 * Nobody reads a label back verbatim. They say "the second one", or "PDF", or
 * "let's do the Linear one" — and a wrong pick here commits the agent down a
 * path the person did not choose, which is worse than asking again.
 */
describe("picking an option by voice", () => {
  const options = [
    { label: "Linear subtask" },
    { label: "Export PDF" },
    { label: "Save to wiki" },
    { label: "Just the file" },
  ];

  test("saying the label picks it", () => {
    expect(classifySpokenChoice("export PDF", options)).toBe(1);
    expect(classifySpokenChoice("let's save to wiki", options)).toBe(2);
  });

  test("saying a position picks it", () => {
    expect(classifySpokenChoice("the third one", options)).toBe(2);
    expect(classifySpokenChoice("option 2", options)).toBe(1);
    expect(classifySpokenChoice("number four", options)).toBe(3);
    expect(classifySpokenChoice("first", options)).toBe(0);
  });

  test("a distinctive word is enough", () => {
    expect(classifySpokenChoice("do the linear one", options)).toBe(0);
    expect(classifySpokenChoice("wiki", options)).toBe(2);
  });

  test("filler around the answer does not defeat it", () => {
    expect(classifySpokenChoice("um yeah let's just go with the PDF please", options)).toBe(1);
  });

  // The cases where being wrong is worse than asking again.
  test("nothing recognisable picks nothing", () => {
    expect(classifySpokenChoice("what do you think", options)).toBeNull();
    expect(classifySpokenChoice("", options)).toBeNull();
    expect(classifySpokenChoice("the ninth one", options)).toBeNull();
  });

  test("a word two options share is an ambiguity, not a guess", () => {
    const shared = [{ label: "Export PDF" }, { label: "Export markdown" }];
    expect(classifySpokenChoice("export", shared)).toBeNull();
  });

  // "Export PDF as draft" must not lose to a shorter label inside it.
  test("the more specific label wins over one contained in it", () => {
    const nested = [{ label: "Export" }, { label: "Export PDF as draft" }];
    expect(classifySpokenChoice("export PDF as draft", nested)).toBe(1);
  });

  test("no options means no answer", () => {
    expect(classifySpokenChoice("anything", [])).toBeNull();
  });
});
