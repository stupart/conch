import { describe, expect, test } from "bun:test";
import {
  classifySpokenChoice,
  classifySpokenChoices,
} from "../src/dictation-reducer.ts";

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

  test("multi-select returns every explicitly spoken label as a set", () => {
    expect(classifySpokenChoices("linear subtask and save to wiki", options))
      .toEqual(new Set([0, 2]));
  });

  test("multi-select accepts several positions", () => {
    expect(classifySpokenChoices("the first and third", options))
      .toEqual(new Set([0, 2]));
    expect(classifySpokenChoices("options 2 and 4", options))
      .toEqual(new Set([1, 3]));
  });

  test("multi-select refuses a word shared by several labels", () => {
    const shared = [{ label: "Export PDF" }, { label: "Export markdown" }];
    expect(classifySpokenChoices("export", shared)).toBeNull();
  });

  test("single-select refuses speech that names several choices", () => {
    expect(classifySpokenChoice("linear subtask and save to wiki", options)).toBeNull();
  });
});

describe("talking about a question is not answering it", () => {
  const options = [
    { label: "Use Postgres" },
    { label: "Use SQLite" },
    { label: "Ask me later" },
  ];

  test("a sentence that merely contains a position is not a choice", () => {
    // Found while looking at something else, and worse than the gap that led
    // there: "actually neither, lets talk about it first" answered "Use
    // Postgres", because any "first" anywhere selected option one. Answering on
    // someone's behalf with an option they did not pick is the worst failure
    // this classifier has, so it must refuse.
    expect(classifySpokenChoice("actually neither, lets talk about it first", options)).toBeNull();
    expect(classifySpokenChoice("lets discuss first", options)).toBeNull();
    expect(classifySpokenChoice("can we do that first?", options)).toBeNull();
    expect(classifySpokenChoice("wait a second", options)).toBeNull();
    expect(classifySpokenChoice("give me a second to think", options)).toBeNull();
    expect(classifySpokenChoice("give me 2 minutes", options)).toBeNull();
    expect(classifySpokenChoice("that will take 3 days", options)).toBeNull();
  });

  test("the ways people actually pick one still work", () => {
    // The guard has to be narrow. These are all real answers and all of them
    // put the position inside a sentence.
    expect(classifySpokenChoice("first", options)).toBe(0);
    expect(classifySpokenChoice("the first one", options)).toBe(0);
    expect(classifySpokenChoice("lets go with the first", options)).toBe(0);
    expect(classifySpokenChoice("the second one please", options)).toBe(1);
    expect(classifySpokenChoice("I would go with the third", options)).toBe(2);
    expect(classifySpokenChoice("option two", options)).toBe(1);
  });

  test("a distinctive word still answers, positional or not", () => {
    // The guard skips the POSITIONS step; it must not abort the classifier.
    expect(classifySpokenChoice("use postgres", options)).toBe(0);
    expect(classifySpokenChoice("lets talk about sqlite instead", options)).toBe(1);
  });
});
