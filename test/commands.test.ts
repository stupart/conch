import { test, expect } from "bun:test";
import { classify, classifyApproval, classifyReadingGap } from "../src/commands.ts";
import { looksLikeAwaitingReply } from "../src/snippet.ts";

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

test("no-response phrases close the mic", () => {
  expect(classify("No response needed.")).toBe("discard");
  expect(classify("No response.")).toBe("discard");
  expect(classify("Stop listening.")).toBe("discard");
  expect(classify("Stop recording.")).toBe("discard");
});

test("reading-gap commands: stop cuts the reading short", () => {
  expect(classifyReadingGap("Stop.")).toBe("stop");
  expect(classifyReadingGap("Okay, stop.")).toBe("stop");
  expect(classifyReadingGap("Got it.")).toBe("stop");
  expect(classifyReadingGap("No response needed.")).toBe("discard");
  expect(classifyReadingGap("Now fix the header too.")).toBe("prompt");
});

test("permission approval vocabulary", () => {
  expect(classifyApproval("Yes.")).toBe("approve");
  expect(classifyApproval("Yeah, go ahead.")).toBe("approve");
  expect(classifyApproval("Sure.")).toBe("approve");
  expect(classifyApproval("No.")).toBe("deny");
  expect(classifyApproval("Nope.")).toBe("deny");
  expect(classifyApproval("Use the other branch instead.")).toBeNull();
});

test("idle nag filter: only announce when the reply solicits the user", () => {
  expect(looksLikeAwaitingReply("Want me to also fix the header?")).toBe(true);
  expect(looksLikeAwaitingReply("Two options here. Let me know which you prefer.")).toBe(true);
  expect(
    looksLikeAwaitingReply(
      "Implementation's grinding away — I'll ping you when it lands with the gate results and a fresh build for your phone. Enjoy the 4th in the meantime.",
    ),
  ).toBe(false);
  expect(looksLikeAwaitingReply("Done. All tests pass and the branch is merged.")).toBe(false);
});
