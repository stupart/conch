import { test, expect } from "bun:test";
import {
  stripMarkdown,
  firstSentences,
  lastAssistantText,
  createLastAssistantTextReader,
  countCoveredSentences,
  spokenSnippet,
  transcriptMark,
  userRespondedSince,
} from "../src/snippet.ts";
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

test("recite header covers zero reply sentences so reading starts from sentence 0", () => {
  const sentences = ["First one.", "Second one!", "Third one?"];
  const label = "conch";
  expect(countCoveredSentences(`${label}:`, sentences)).toBe(0);
});

test("a generated summary covers zero source sentences so continue starts from the top", () => {
  const sentences = [
    "Implemented the queue.",
    "Added all regression tests.",
  ];
  expect(countCoveredSentences(
    "conch: The queue shipped with complete regression coverage.",
    sentences,
  )).toBe(0);
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

test("announce summary null falls back to the exact existing spoken snippet", async () => {
  const path = `/tmp/conch-test-summary-null-${Date.now()}.jsonl`;
  const reply = [
    "Implemented the queue with exact ordering guarantees.",
    "Added regression coverage for every failure branch.",
    "The remaining details make this deliberately longer than the speech cap.",
  ].join(" ");
  await Bun.write(path, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: reply }] },
  }));
  const asked: string[] = [];

  const summarized = await spokenSnippet(path, 2, 70, {
    summarize: true,
    askClaude: async (prompt) => {
      asked.push(prompt);
      return null;
    },
  });

  expect(summarized).toBe(firstSentences(stripMarkdown(reply), 2, 70));
  expect(asked).toHaveLength(1);
});

test("announce summary uses one fast-model result for a long reply", async () => {
  const path = `/tmp/conch-test-summary-result-${Date.now()}.jsonl`;
  const reply = "Finished the migration and its tests. ".repeat(12);
  await Bun.write(path, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: reply }] },
  }));

  expect(await spokenSnippet(path, 2, 80, {
    summarize: true,
    askClaude: async (_prompt, options) => {
      expect(options).toEqual({ timeoutMs: 8_000, maxChars: 160 });
      return "Migration finished and all tests now pass.";
    },
  })).toBe("Migration finished and all tests now pass.");
});

test("announce summary never calls the model for a short reply or when default-off", async () => {
  const path = `/tmp/conch-test-summary-short-${Date.now()}.jsonl`;
  const reply = "Short reply.";
  await Bun.write(path, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: reply }] },
  }));
  let calls = 0;
  const askClaude = async () => {
    calls++;
    return "must not run";
  };

  expect(await spokenSnippet(path, 2, 350, {
    summarize: true,
    askClaude,
  })).toBe(reply);
  expect(await spokenSnippet(path, 2, 5, {
    summarize: false,
    askClaude,
  })).toBe("Short");
  expect(calls).toBe(0);
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

test("lastAssistantText invalidates its real file cache when the transcript grows", async () => {
  const path = `/tmp/conch-test-cache-${Date.now()}.jsonl`;
  const entry = (text: string) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  await Bun.write(path, entry("first"));
  expect(await lastAssistantText(path)).toBe("first");

  await Bun.write(path, `${entry("first")}\n${entry("a longer second reply")}`);
  expect(await lastAssistantText(path)).toBe("first\na longer second reply");
});

test("unchanged navigation and overlay repaints share one transcript read", async () => {
  let reads = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  let releaseRead!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const raw = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "cached reply" }] },
  });
  const reader = createLastAssistantTextReader({
    fingerprint: async () => "42:100",
    read: async () => {
      reads++;
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      markStarted();
      await gate;
      activeReads--;
      return raw;
    },
  });

  const repaints = [reader("session.jsonl"), reader("session.jsonl"), reader("session.jsonl")];
  await started;
  expect(reads).toBe(1);
  expect(maxActiveReads).toBe(1);
  releaseRead();
  expect(await Promise.all(repaints)).toEqual(["cached reply", "cached reply", "cached reply"]);
  expect(await reader("session.jsonl")).toBe("cached reply");
  expect(reads).toBe(1);
});

test("a changed transcript waits for the obsolete read instead of overlapping it", async () => {
  let version = 1;
  let reads = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const assistantEntry = (text: string) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const reader = createLastAssistantTextReader({
    fingerprint: async () => `fingerprint-${version}`,
    read: async () => {
      const readVersion = version;
      reads++;
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (readVersion === 1) {
        markFirstStarted();
        await firstGate;
      }
      activeReads--;
      return assistantEntry(`reply ${readVersion}`);
    },
  });

  const first = reader("session.jsonl");
  await firstStarted;
  version = 2;
  const second = reader("session.jsonl");
  await Promise.resolve();
  expect(reads).toBe(1);
  releaseFirst();

  expect(await first).toBe("reply 1");
  expect(await second).toBe("reply 2");
  expect(reads).toBe(2);
  expect(maxActiveReads).toBe(1);
});

test("a failed transcript read is retried instead of cached", async () => {
  let reads = 0;
  const reader = createLastAssistantTextReader({
    fingerprint: async () => "1:1",
    read: async () => {
      reads++;
      if (reads === 1) throw new Error("mid-write");
      return JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "retry succeeded" }] },
      });
    },
  });

  expect(await reader("session.jsonl")).toBe("");
  expect(await reader("session.jsonl")).toBe("retry succeeded");
  expect(reads).toBe(2);
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
