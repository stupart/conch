import { test, expect } from "bun:test";
import { classify, classifyApproval, classifyReadingGap, wordOverlapRatio, isSendCommand } from "../src/commands.ts";
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

test("bare stop closes the mic — a finished session can't be told to stop", () => {
  expect(classify("Stop.")).toBe("discard");
  expect(classify("Stop talking.")).toBe("discard");
});

test("echo guard: transcripts of the Mac's own reading score high overlap", () => {
  const chunk = "The daemon spawns and owns the whisper server, and transcription drops from four seconds to under two.";
  expect(wordOverlapRatio("the daemon spawns and owns the whisper server", chunk)).toBeGreaterThan(0.9);
  expect(wordOverlapRatio("okay stop reading now please", chunk)).toBeLessThan(0.4);
  expect(wordOverlapRatio("", chunk)).toBe(0);
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

test("reading-gap: an utterance that STARTS with stop cuts short (trailing words are you continuing to talk)", () => {
  expect(classifyReadingGap("Stop, for some reason it did the wrong thing.")).toBe("stop");
  expect(classifyReadingGap("Wait, go back.")).toBe("stop");
  expect(classifyReadingGap("Hold on.")).toBe("stop");
  // but a real prompt that merely mentions stopping stays a prompt
  expect(classifyReadingGap("Also make it stop retrying on 500s.")).toBe("prompt");
});

test("reading-gap: 'stop, no response needed' in one breath closes the mic (discard)", () => {
  expect(classifyReadingGap("Stop, no response needed.")).toBe("discard");
  expect(classifyReadingGap("Stop. No reply needed.")).toBe("discard");
  expect(classifyReadingGap("No, stop, nothing.")).toBe("discard");
  // plain stop still just stops
  expect(classifyReadingGap("Stop.")).toBe("stop");
});

test("send commands submit held dictation; real content does not", () => {
  expect(isSendCommand("send it")).toBe(true);
  expect(isSendCommand("Go ahead.")).toBe(true);
  expect(isSendCommand("okay send")).toBe(true);
  expect(isSendCommand("that's it")).toBe(true);
  expect(isSendCommand("send the migration to staging")).toBe(false);
  expect(isSendCommand("go look at the config file")).toBe(false);
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
