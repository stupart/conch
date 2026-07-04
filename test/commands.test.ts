import { test, expect } from "bun:test";
import { classify } from "../src/commands.ts";

test("bare commands match despite whisper's punctuation and casing", () => {
  expect(classify("Continue.")).toBe("continue");
  expect(classify("Keep going!")).toBe("continue");
  expect(classify("Read the rest")).toBe("continue");
  expect(classify("Repeat that.")).toBe("repeat");
  expect(classify("Say that again?")).toBe("repeat");
  expect(classify("Never mind.")).toBe("discard");
  expect(classify("Cancel")).toBe("discard");
});

test("real prompts that merely contain command words stay prompts", () => {
  expect(classify("Continue working on the login bug.")).toBe("prompt");
  expect(classify("Can you repeat the migration for staging?")).toBe("prompt");
  expect(classify("No, use the other approach.")).toBe("prompt");
  expect(classify("Stop using the legacy API and switch to v2.")).toBe("prompt");
});

test("filler-wrapped commands still match", () => {
  expect(classify("Oh, continue.")).toBe("continue");
  expect(classify("Okay, keep going.")).toBe("continue");
  expect(classify("Um, repeat that?")).toBe("repeat");
  expect(classify("Continue, please.")).toBe("continue");
  expect(classify("Yes, continue.")).toBe("continue");
  expect(classify("Oh, use the other approach.")).toBe("prompt");
});

test("plausible yes/no replies are never swallowed as commands", () => {
  expect(classify("Yes.")).toBe("prompt");
  expect(classify("No.")).toBe("prompt");
  expect(classify("Stop.")).toBe("prompt");
});
