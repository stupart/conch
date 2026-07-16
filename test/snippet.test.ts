import { test, expect } from "bun:test";
import { stripMarkdown, firstSentences, lastAssistantText, countCoveredSentences, transcriptMark, userRespondedSince } from "../src/snippet.ts";
import { wavFromRawPcm } from "../src/transcribe.ts";

test("wavFromRawPcm writes a valid 16kHz mono header", () => {
  const pcm = new Uint8Array(32000); // 1s of audio
  const wav = wavFromRawPcm(pcm);
  const v = new DataView(wav.buffer);
  expect(wav.length).toBe(44 + 32000);
  expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
  expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
  expect(v.getUint32(24, true)).toBe(16000); // sample rate
  expect(v.getUint16(22, true)).toBe(1); // mono
  expect(v.getUint32(40, true)).toBe(32000); // data size
});

test("stripMarkdown drops code fences and keeps prose", () => {
  const md = "Done — tests pass.\n\n```ts\nconst x = 1;\n```\n\nSee `foo.ts` for details.";
  expect(stripMarkdown(md)).toBe("Done — tests pass. See foo.ts for details.");
});

test("stripMarkdown flattens links, bold, and headers", () => {
  const md = "## Result\n\n**All good** — see [the docs](https://example.com) for more.";
  expect(stripMarkdown(md)).toBe("Result All good — see the docs for more.");
});

test("firstSentences takes N whole sentences under the cap — no mid-sentence chops", () => {
  const text = "First one. Second one! Third one? Fourth one.";
  expect(firstSentences(text, 2, 350)).toBe("First one. Second one!");
  expect(firstSentences(text, 4, 20)).toBe("First one."); // second wouldn't fit whole
  expect(firstSentences("One giant unbroken sentence with no end", 2, 12)).toBe("One giant un"); // monster still capped
});

test("countCoveredSentences finds where the announcement stopped", () => {
  const sentences = ["First one.", "Second one!", "Third one?"];
  expect(countCoveredSentences("conch: First one. Second one!", sentences)).toBe(2);
  expect(countCoveredSentences("conch: First one. Second on", sentences)).toBe(1); // truncated -> re-read it
  expect(countCoveredSentences("conch: finished, ready for your next prompt", sentences)).toBe(0);
});

test("countCoveredSentences follows the actual announcement, not a configured sentence count", () => {
  const sentences = ["First one.", "Second one!", "Third one?", "Fourth one."];
  // The hook that produced this event announced three sentences. A daemon
  // started with a different announce-sentences value must still resume at 3.
  expect(countCoveredSentences("conch: First one. Second one! Third one?", sentences)).toBe(3);
});

test("firstSentences handles a single unterminated sentence", () => {
  expect(firstSentences("no punctuation here", 2, 350)).toBe("no punctuation here");
});

test("lastAssistantText returns the newest assistant text block", async () => {
  const path = `/tmp/conch-test-${Date.now()}.jsonl`;
  const lines = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "older reply" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "newest reply" }] } }),
    "not json at all",
  ];
  await Bun.write(path, lines.join("\n"));
  expect(await lastAssistantText(path)).toBe("newest reply");
});

test("lastAssistantText returns empty for a missing file", async () => {
  expect(await lastAssistantText("/tmp/does-not-exist.jsonl")).toBe("");
});

test("transcriptMark ignores synthetic task-notification wakeups (not your replies)", async () => {
  const path = `/tmp/conch-test-tasknotif-${Date.now()}.jsonl`;
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }), // a real human prompt
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "on it" }] } }),
    // a finished background agent — Claude Code injects it as a user entry
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" },
      origin: { kind: "task-notification" },
      promptSource: "system",
    }),
    // defensive: the string marker alone (no origin field) must also be skipped
    JSON.stringify({ type: "user", message: { role: "user", content: "<task-notification>x</task-notification>" } }),
  ];
  await Bun.write(path, lines.join("\n"));
  expect(await transcriptMark(path)).toBe(1); // only the human prompt counts
  expect(await userRespondedSince(path, 1)).toBe(false); // a wakeup is not a new reply
});

test("lastAssistantText returns the final message, not interim work notes", async () => {
  const path = `/tmp/conch-test-final-${Date.now()}.jsonl`;
  const lines = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix the bug" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Let me look into it." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Found and fixed it." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "All tests pass." }] } }),
    JSON.stringify({ type: "file-history-snapshot", messageId: "x" }),
  ];
  await Bun.write(path, lines.join("\n"));
  // entries join with a newline (not a space) so a code fence at an entry
  // boundary stays line-anchored for stripMarkdown; sentence-splitting is
  // identical either way.
  expect(await lastAssistantText(path)).toBe("Found and fixed it.\nAll tests pass.");
});

test("lastAssistantText keeps a code fence line-anchored across entry boundaries", async () => {
  const path = `/tmp/conch-test-fence-${Date.now()}.jsonl`;
  const lines = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "how do I clean up?" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Here's the command:" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "```bash\nrm -rf node_modules\n```\nThat fixed the build. Ship it." }] } }),
  ];
  await Bun.write(path, lines.join("\n"));
  // The fence opens at a line start (newline join), so stripMarkdown can drop
  // the code block and the trailing prose survives — a space join glued the
  // fence mid-line, read the code aloud, and dropped "That fixed the build...".
  const text = stripMarkdown(await lastAssistantText(path));
  expect(text).toContain("That fixed the build. Ship it.");
  expect(text).not.toContain("rm -rf");
});
