import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  stripMarkdown,
  speakable,
  splitSentences,
  firstSentences,
  lastAssistantText,
  createTranscriptReader,
  countCoveredSentences,
  spokenSnippet,
  transcriptMark,
  userRespondedSince,
  parseReviewRequest,
  TRANSCRIPT_READ_CHUNK_BYTES,
  type TranscriptSource,
} from "../src/snippet.ts";
import { wavFromRawPcm } from "../src/transcribe.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TranscriptReadRange {
  offset: number;
  length: number;
  version: string;
}

class MemoryTranscriptSource implements TranscriptSource {
  private bytes: Uint8Array;
  private revision = 1;
  private inode = 1;
  readonly reads: TranscriptReadRange[] = [];
  activeReads = 0;
  maxActiveReads = 0;
  readFailures = 0;
  beforeRead?: (range: TranscriptReadRange) => void | Promise<void>;

  constructor(raw: string) {
    this.bytes = encoder.encode(raw);
  }

  get raw(): string {
    return decoder.decode(this.bytes);
  }

  get size(): number {
    return this.bytes.length;
  }

  append(raw: string): void {
    const appended = encoder.encode(raw);
    const next = new Uint8Array(this.bytes.length + appended.length);
    next.set(this.bytes);
    next.set(appended, this.bytes.length);
    this.bytes = next;
    this.revision++;
  }

  replace(raw: string, replaceIdentity = false): void {
    this.bytes = encoder.encode(raw);
    this.revision++;
    if (replaceIdentity) this.inode++;
  }

  async open() {
    const bytes = this.bytes;
    const version = String(this.revision);
    const inode = String(this.inode);
    return {
      version: {
        size: bytes.length,
        mtimeNs: version,
        dev: "1",
        ino: inode,
      },
      read: async (offset: number, length: number) => {
        const range = { offset, length, version };
        this.reads.push(range);
        this.activeReads++;
        this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
        try {
          if (this.readFailures > 0) {
            this.readFailures--;
            throw new Error("mid-write");
          }
          await this.beforeRead?.(range);
          return bytes.slice(offset, offset + length);
        } finally {
          this.activeReads--;
        }
      },
      close() {},
    };
  }
}

function fullReadOracle(raw: string): { assistant: string; prompts: number } {
  const lines = raw.split("\n");
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "user") break;
    if (entry.type !== "assistant") continue;
    const content: Array<{ type: string; text?: string }> = entry.message?.content ?? [];
    if (content.some((part) => part.type === "tool_use")) break;
    const texts = content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "");
    if (texts.length) collected.unshift(texts.join("\n"));
  }

  let prompts = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.type !== "user") continue;
    if (entry.origin?.kind === "task-notification" || entry.promptSource === "system") continue;
    const content = entry.message?.content;
    if (typeof content === "string" && content.startsWith("<task-notification>")) continue;
    const real = typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content)
        && content.some((block: any) => block?.type === "text" && block.text?.trim());
    if (real) prompts++;
  }
  return { assistant: collected.join("\n"), prompts };
}

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

test("speakable replaces a bare http(s) URL with a short phrase", () => {
  expect(speakable("See https://example.com/a/long/resource?view=full.")).toBe("See a link.");
  expect(speakable("Open (http://localhost:3000/status).")).toBe("Open (a link).");
  expect(stripMarkdown("Open <https://example.com/status>.")).toBe("Open a link.");
});

test("speakable reduces a filesystem path to its basename", () => {
  expect(speakable("Updated /Users/tyler/conch/src/snippet.ts.")).toBe("Updated snippet.ts.");
});

test("speakable drops long CLI flags", () => {
  expect(speakable("Run conch --foo-bar-baz now.")).toBe("Run conch now.");
  expect(speakable("Run conch (--foo-bar-baz=value) now.")).toBe("Run conch now.");
});

test("stripMarkdown keeps underscores in identifiers and applies speakable cleanup", () => {
  expect(stripMarkdown("Use `foo_bar` from /tmp/conch/foo_bar.ts at https://example.com."))
    .toBe("Use foo_bar from foo_bar.ts at a link.");
});

test("splitSentences keeps a numbered-list marker with its sentence", () => {
  expect(splitSentences("Done. 1. Fixed the leak. 2. Added a test."))
    .toEqual(["Done.", "1. Fixed the leak.", "2. Added a test."]);
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

test("parseReviewRequest reads a marker with a link and omits an absent link", () => {
  expect(parseReviewRequest("Done.\nconch:review Review the new dashboard | https://example.com/pr/42"))
    .toEqual({ summary: "Review the new dashboard", link: "https://example.com/pr/42" });
  const withoutLink = parseReviewRequest("conch:review Review the local dashboard");
  expect(withoutLink).toEqual({ summary: "Review the local dashboard" });
  expect(Object.hasOwn(withoutLink!, "link")).toBe(false);
});

test("parseReviewRequest uses the last marker in the final message", () => {
  expect(parseReviewRequest([
    "conch:review Review the first draft | /tmp/first",
    "A correction follows.",
    "conch:review Review the corrected draft | /tmp/final",
  ].join("\n"))).toEqual({
    summary: "Review the corrected draft",
    link: "/tmp/final",
  });
});

test("parseReviewRequest rejects missing markers and empty summaries", () => {
  expect(parseReviewRequest("The implementation is ready for review.")).toBeNull();
  expect(parseReviewRequest("conch:review")).toBeNull();
  expect(parseReviewRequest("conch:review   ")).toBeNull();
});

test("parseReviewRequest rejects prose and markers that do not start on their own line", () => {
  expect(parseReviewRequest("Please review: the implementation is complete.")).toBeNull();
  expect(parseReviewRequest("Status: conch:review Review this | /tmp/review")).toBeNull();
  expect(parseReviewRequest("conch:review\nReview this | /tmp/review")).toBeNull();
});

test("parseReviewRequest trims and sanitizes a summary before capping it at 200 characters", () => {
  const review = parseReviewRequest(`conch:review  \u0000${"x".repeat(201)}\u007f  | /tmp/review`);
  expect(review).toEqual({ summary: "x".repeat(200), link: "/tmp/review" });
});

test("parseReviewRequest matches the marker case-insensitively", () => {
  expect(parseReviewRequest("CONCH:REVIEW Check the uppercase marker | /tmp/review"))
    .toEqual({ summary: "Check the uppercase marker", link: "/tmp/review" });
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
      expect(options).toEqual({ maxChars: 160 });
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

test("tail and incremental reads stay identical to a full-read oracle, including partial-line growth", async () => {
  const assistant = (text: string) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const fillerLine = JSON.stringify({
    type: "file-history-snapshot",
    snapshot: "x".repeat(1_000),
  });
  const fillerCount = Math.ceil((TRANSCRIPT_READ_CHUNK_BYTES * 3) / (fillerLine.length + 1));
  const lines = [
    ...Array.from({ length: fillerCount }, () => fillerLine),
    JSON.stringify({ type: "user", message: { content: "first real prompt" } }),
    JSON.stringify({
      type: "user",
      origin: { kind: "task-notification" },
      message: { content: "origin-only synthetic prompt" },
    }),
    JSON.stringify({
      type: "user",
      promptSource: "system",
      message: { content: "source-only synthetic prompt" },
    }),
    JSON.stringify({
      type: "user",
      message: { content: "<task-notification>marker-only synthetic prompt</task-notification>" },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result" }, { type: "text", text: "array prompt" }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result" }, { type: "text", text: "   " }] },
    }),
    assistant("stale work note"),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "do not collect this interim text" },
          { type: "tool_use", name: "Bash" },
        ],
      },
    }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    assistant("final first entry"),
    JSON.stringify({ type: "file-history-snapshot", messageId: "tail-meta" }),
    assistant("final second entry 🐚"),
    "not json at all",
  ];
  const partialPrompt = '{"type":"user","message":{"content":"typed';
  const source = new MemoryTranscriptSource(`${lines.join("\n")}\n${partialPrompt}`);
  const reader = createTranscriptReader(source);

  const initialOracle = fullReadOracle(source.raw);
  expect(await reader.lastAssistantText("session.jsonl")).toBe(initialOracle.assistant);
  expect(source.reads).toHaveLength(1);
  expect(source.reads[0]!.offset).toBe(source.size - TRANSCRIPT_READ_CHUNK_BYTES);
  expect(source.reads[0]!.offset).toBeGreaterThan(0); // initial reply read touched only the tail

  const readsAfterTail = source.reads.length;
  expect(await reader.countUserPrompts("session.jsonl")).toBe(initialOracle.prompts);
  const initialCountReads = source.reads.slice(readsAfterTail);
  expect(initialCountReads[0]!.offset).toBe(0);
  expect(initialCountReads.reduce((sum, read) => sum + read.length, 0)).toBe(source.size);

  const readsAfterInitialParse = source.reads.length;
  expect(await reader.lastAssistantText("session.jsonl")).toBe(initialOracle.assistant);
  expect(await reader.countUserPrompts("session.jsonl")).toBe(initialOracle.prompts);
  expect(source.reads).toHaveLength(readsAfterInitialParse); // unchanged metadata: no data reread

  const oldSize = source.size;
  const appended = [
    ' reply"}}',
    assistant("grown reply first entry"),
    JSON.stringify({ type: "file-history-snapshot", messageId: "grown-meta" }),
    assistant("grown reply second entry"),
  ].join("\n");
  source.append(appended);
  const grownOracle = fullReadOracle(source.raw);
  expect(await reader.lastAssistantText("session.jsonl")).toBe(grownOracle.assistant);
  expect(await reader.countUserPrompts("session.jsonl")).toBe(grownOracle.prompts);
  expect(source.reads.slice(readsAfterInitialParse).map(({ offset, length }) => ({ offset, length }))).toEqual([
    { offset: oldSize, length: source.size - oldSize },
  ]);

  // A valid final JSON object without LF is provisional. Committing its newline
  // must neither duplicate its text nor recount any prompt.
  const beforeNewline = source.size;
  const readsBeforeNewline = source.reads.length;
  source.append("\n");
  const newlineOracle = fullReadOracle(source.raw);
  expect(await reader.lastAssistantText("session.jsonl")).toBe(newlineOracle.assistant);
  expect(await reader.countUserPrompts("session.jsonl")).toBe(newlineOracle.prompts);
  expect(source.reads.slice(readsBeforeNewline).map(({ offset, length }) => ({ offset, length }))).toEqual([
    { offset: beforeNewline, length: 1 },
  ]);
});

test("unchanged navigation and overlay repaints share one transcript read", async () => {
  let releaseRead!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const raw = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "cached reply" }] },
  });
  const source = new MemoryTranscriptSource(raw);
  source.beforeRead = async () => {
    if (source.reads.length === 1) {
      markStarted();
      await gate;
    }
  };
  const reader = createTranscriptReader(source);

  const repaints = [
    reader.lastAssistantText("session.jsonl"),
    reader.lastAssistantText("session.jsonl"),
    reader.lastAssistantText("session.jsonl"),
  ];
  await started;
  expect(source.reads).toHaveLength(1);
  expect(source.maxActiveReads).toBe(1);
  releaseRead();
  expect(await Promise.all(repaints)).toEqual(["cached reply", "cached reply", "cached reply"]);
  expect(await reader.lastAssistantText("session.jsonl")).toBe("cached reply");
  expect(source.reads).toHaveLength(1);
});

test("a changed transcript waits for the obsolete read instead of overlapping it", async () => {
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const assistantEntry = (text: string) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const source = new MemoryTranscriptSource(assistantEntry("reply 1"));
  source.beforeRead = async (range) => {
    if (range.version === "1") {
      markFirstStarted();
      await firstGate;
    }
  };
  const reader = createTranscriptReader(source);

  const first = reader.lastAssistantText("session.jsonl");
  await firstStarted;
  source.append(`\n${assistantEntry("reply 2")}`);
  const second = reader.lastAssistantText("session.jsonl");
  await Promise.resolve();
  expect(source.reads).toHaveLength(1);
  releaseFirst();

  expect(await first).toBe("reply 1");
  expect(await second).toBe("reply 1\nreply 2");
  expect(source.reads).toHaveLength(2);
  expect(source.maxActiveReads).toBe(1);
});

test("a failed transcript read is retried instead of cached", async () => {
  const source = new MemoryTranscriptSource(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "retry succeeded" }] },
  }));
  source.readFailures = 1;
  const reader = createTranscriptReader(source);

  expect(await reader.lastAssistantText("session.jsonl")).toBe("");
  expect(await reader.lastAssistantText("session.jsonl")).toBe("retry succeeded");
  expect(source.reads).toHaveLength(2);
});

test("parseable schema errors reject exactly like the former full readers", async () => {
  const nullReader = createTranscriptReader(new MemoryTranscriptSource("null"));
  await expect(nullReader.lastAssistantText("null.jsonl")).rejects.toThrow();
  await expect(nullReader.countUserPrompts("null.jsonl")).rejects.toThrow();

  const invalidPrompt = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: 1 }] },
  });
  const countReader = createTranscriptReader(new MemoryTranscriptSource(invalidPrompt));
  await expect(countReader.countUserPrompts("invalid-prompt.jsonl")).rejects.toThrow();

  // Reverse assistant parsing stops at the newest user even when that boundary
  // has no final LF; the older schema error remains visible to full prompt counts.
  const superseded = `null\n${JSON.stringify({ type: "user", message: { content: "new prompt" } })}`;
  const supersededReader = createTranscriptReader(new MemoryTranscriptSource(superseded));
  expect(await supersededReader.lastAssistantText("superseded.jsonl")).toBe("");
  await expect(supersededReader.countUserPrompts("superseded.jsonl")).rejects.toThrow();
});

test("same-size mtime changes invalidate both cached parse results", async () => {
  const first = [
    JSON.stringify({ type: "user", message: { content: "one" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "aaaa" }] } }),
  ].join("\n");
  const second = [
    JSON.stringify({ type: "user", message: { content: "   " } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "bbbb" }] } }),
  ].join("\n");
  expect(encoder.encode(second).length).toBe(encoder.encode(first).length);
  const source = new MemoryTranscriptSource(first);
  const reader = createTranscriptReader(source);

  expect(await reader.countUserPrompts("session.jsonl")).toBe(fullReadOracle(first).prompts);
  expect(await reader.lastAssistantText("session.jsonl")).toBe(fullReadOracle(first).assistant);
  const beforeRewrite = source.reads.length;

  source.replace(second);
  expect(await reader.lastAssistantText("session.jsonl")).toBe(fullReadOracle(second).assistant);
  expect(await reader.countUserPrompts("session.jsonl")).toBe(fullReadOracle(second).prompts);
  expect(source.reads.length).toBeGreaterThan(beforeRewrite);
  expect(source.reads.slice(beforeRewrite).some((read) => read.offset === 0)).toBe(true);
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

test("speakable drops decorative glyphs a voice would announce literally", () => {
  // an arrow used to be read aloud as "right arrow", a star as "star", emoji by name
  expect(speakable("Fixed daemon.ts \u2192 tests pass \u2705")).toBe("Fixed daemon.ts tests pass");
  expect(speakable("\u2b50 Review ready")).toBe("Review ready");
  expect(speakable("Steps: \u25cf one \u25cb two")).toBe("Steps: one two");
  expect(speakable("Done \ud83c\udf89 shipped it!")).toBe("Done shipped it!");
  // real prosody must survive: em dash + ellipsis are how a sentence breathes
  expect(speakable("It works \u2014 really well\u2026 yes.")).toBe("It works \u2014 really well\u2026 yes.");
});

test("a hook-injected turn is not you replying", async () => {
  // A /goal loop re-prompts its own session through the Stop hook. That lands
  // in the transcript as type:"user" with isMeta — and counting it as a real
  // prompt made conch believe the user had answered by keyboard, so it held
  // the mic and discarded whatever they were mid-way through dictating.
  const dir = mkdtempSync("/tmp/conch-meta-prompt-");
  const path = join(dir, "t.jsonl");
  const lines = [
    { type: "user", message: { content: "do the thing" } },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    { type: "user", isMeta: true, message: { content: "Stop hook feedback:\n[keep going]" } },
    { type: "assistant", message: { content: [{ type: "text", text: "still going" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  // One human prompt in that file, not two.
  const mark = await transcriptMark(path);
  expect(mark).toBe(1);
  // And nothing "responded" after the human's own prompt.
  expect(await userRespondedSince(path, 1)).toBe(false);
});
