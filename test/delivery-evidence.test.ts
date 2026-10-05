import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptSince, normalizePrompt, PROMPT_DIGEST, promptDigest, PromptSubmissions } from "../src/delivery-evidence.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";

describe("a prompt's fingerprint", () => {
  test("the same words make the same fingerprint, however they were spaced", () => {
    expect(promptDigest("fix the  login\nbug ")).toBe(promptDigest("fix the login bug"));
    expect(promptDigest("fix the login bug")).not.toBe(promptDigest("fix the logout bug"));
    expect(promptDigest("anything")).toMatch(PROMPT_DIGEST);
    expect(normalizePrompt("  a\t b\n\nc ")).toBe("a b c");
  });

  test("only the opening counts: Claude Code may add to a prompt after its first words", () => {
    const opening = "x".repeat(64);
    expect(promptDigest(`${opening} and then an attachment`)).toBe(promptDigest(opening));
  });

  test("it never carries the words", () => {
    expect(promptDigest("my secret plan")).not.toContain("secret");
  });

  // Claude Code 2.1.280 writes a long paste down in tags, and conch pastes every long send.
  test("a paste's tags are not part of its words", () => {
    const words = "Need you to do some flight and hotel searches for the trip. ".repeat(20).trim();
    expect(promptDigest(`\n\n<pasted_content id="04a6">\n${words}\n</pasted_content id="04a6">\n`)).toBe(promptDigest(words));
  });
});

describe("what a session's hook said it took", () => {
  test("these words, at or after the send, in this session", () => {
    const seen = new PromptSubmissions();
    seen.note("s1", promptDigest("ship it"), 1_000);
    expect(seen.submitted("s1", 1_000, "ship it")).toBe(true);
    expect(seen.submitted("s1", 1_001, "ship it")).toBe(false); // before the send began
    expect(seen.submitted("s2", 0, "ship it")).toBe(false); // another session
    expect(seen.submitted("s1", 0, "hold it")).toBe(false); // other words
  });

  test("a fingerprint that isn't one is dropped, and old ones age out", () => {
    const seen = new PromptSubmissions();
    seen.note("s1", "not-a-digest", 0);
    seen.note("", promptDigest("x"), 0);
    expect(seen.submitted("s1", 0, "not-a-digest")).toBe(false);
    seen.note("s1", promptDigest("first"), 0);
    seen.note("s1", promptDigest("later"), 11 * 60_000);
    expect(seen.submitted("s1", 0, "first")).toBe(false);
    expect(seen.submitted("s1", 0, "later")).toBe(true);
  });

  // 2026-10-05, Tyler: "just had a message say it failed to send but it worked". A process that starts a new
  // conversation reports the words under the new id, from the same pid the words were typed at.
  test("by process: these words from another session in the process typed at confirm, from another process they don't", () => {
    const seen = new PromptSubmissions();
    seen.note("s2", promptDigest("ship it"), 1_000, 4242);
    expect(seen.submitted("s1", 1_000, "ship it", 4242)).toBe(true);
    expect(seen.submitted("s1", 1_000, "ship it", 5151)).toBe(false); // another process
    expect(seen.submitted("s1", 1_000, "ship it")).toBe(false); // no process named
    expect(seen.submitted("s1", 1_001, "ship it", 4242)).toBe(false); // before the send began
    expect(seen.submitted("s1", 1_000, "hold it", 4242)).toBe(false); // other words
    // The session's own report still counts with no pid, as before.
    expect(seen.submitted("s2", 1_000, "ship it")).toBe(true);
  });

  test("a pid that names no terminal is no process: a background job with no window reports 0", () => {
    const seen = new PromptSubmissions();
    seen.note("job", promptDigest("ship it"), 1_000, 0);
    seen.note("other", promptDigest("ship it"), 1_000, -1);
    expect(seen.submitted("s1", 0, "ship it", 0)).toBe(false);
    expect(seen.submitted("s1", 0, "ship it", -1)).toBe(false);
    expect(seen.submitted("s1", 0, "ship it", Number.NaN)).toBe(false);
  });

  test("a process's reports age out with its sessions'", () => {
    const seen = new PromptSubmissions();
    seen.note("s2", promptDigest("first"), 0, 4242);
    seen.note("s3", promptDigest("later"), 11 * 60_000, 4242);
    expect(seen.submitted("s1", 0, "first", 4242)).toBe(false);
    expect(seen.submitted("s1", 0, "later", 4242)).toBe(true);
  });

  test("a socket event carries a fingerprint only on working, and only a well-formed one", () => {
    const base = { sessionId: "s1", label: "a", announce: "" };
    expect(validateSocketTurnEvent({ ...base, type: "working", promptDigest: promptDigest("x") }).ok).toBe(true);
    expect(validateSocketTurnEvent({ ...base, type: "working", promptDigest: "the words themselves" }).ok).toBe(false);
    expect(validateSocketTurnEvent({ ...base, type: "turn-end", promptDigest: promptDigest("x") }).ok).toBe(false);
  });
});

describe("a transcript read by time", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const file = (...records: unknown[]) => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-evidence-")), "session.jsonl");
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return path;
  };
  const prompt = (ms: number, text: string) => ({ type: "user", timestamp: at(ms), message: { role: "user", content: text } });

  test("a prompt written after the send began is the send's", async () => {
    const since = Date.parse("2026-10-03T10:00:00Z");
    expect(await claudeTranscriptSince(file(prompt(since + 400, "hi")), since, "hi")).toEqual({ submitted: true, queued: false });
    // One from before is an older turn, slack aside.
    expect(await claudeTranscriptSince(file(prompt(since - 60_000, "hi")), since, "hi")).toEqual({ submitted: false, queued: false });
  });

  // 2026-10-05: 3,580 characters typed into a new session were recorded as their last 514. That prompt is
  // the agent's, but it is not these words, and taking it as them would call a lost message delivered.
  test("only a prompt that opens with the words is the send's: a tail of them is not", async () => {
    const since = Date.parse("2026-10-05T18:22:18Z");
    const words = Array.from({ length: 600 }, (_, index) => `word${index}`).join(" ").slice(0, 3_580);
    expect(words).toHaveLength(3_580);
    const tail = words.slice(-514);
    expect(await claudeTranscriptSince(file(prompt(since + 300, tail)), since, words)).toEqual({ submitted: false, queued: false });
    // Someone else's prompt is not the send's either.
    expect((await claudeTranscriptSince(file(prompt(since + 300, "something else entirely")), since, words)).submitted).toBe(false);
    // The tail was a prompt, all the same: the check is about whose words, not whether one landed.
    expect((await claudeTranscriptSince(file(prompt(since + 300, tail)), since, tail)).submitted).toBe(true);
    // The whole words, however Claude Code wrote them down: spaced, in a paste's tags, or as text blocks.
    for (const content of [
      words.replace(/ /g, "  "),
      `\n\n<pasted_content id="6a36">\n${words}\n</pasted_content id="6a36">\n`,
      [{ type: "text", text: words }],
    ]) {
      const record = { type: "user", timestamp: at(since + 300), message: { role: "user", content } };
      expect(await claudeTranscriptSince(file(record), since, words)).toEqual({ submitted: true, queued: false });
    }
    // A long paste queued behind a running turn is matched the same way.
    const enqueue = { type: "queue-operation", operation: "enqueue", timestamp: at(since + 300),
      content: `\n\n<pasted_content id="6a36">\n${words}\n</pasted_content id="6a36">\n` };
    expect(await claudeTranscriptSince(file(enqueue), since, words)).toEqual({ submitted: false, queued: true });
  });

  test("a hook's own words and a task notification are not the user's prompt", async () => {
    const since = Date.parse("2026-10-03T10:00:00Z");
    const meta = { ...prompt(since + 10, "hook text"), isMeta: true };
    expect((await claudeTranscriptSince(file(meta), since, "hi")).submitted).toBe(false);
  });

  test("words queued behind a running turn, matched by their opening", async () => {
    const since = Date.parse("2026-10-03T10:00:00Z");
    const enqueue = { type: "queue-operation", operation: "enqueue", timestamp: at(since + 200), content: "check  the build\nplease" };
    expect(await claudeTranscriptSince(file(enqueue), since, "check the build please")).toEqual({ submitted: false, queued: true });
    expect((await claudeTranscriptSince(file(enqueue), since, "something else")).queued).toBe(false);
  });

  test("no file yet, or a Codex rollout, says nothing", async () => {
    expect(await claudeTranscriptSince(undefined, 0, "hi")).toEqual({ submitted: false, queued: false });
    expect(await claudeTranscriptSince("/nonexistent/session.jsonl", 0, "hi")).toEqual({ submitted: false, queued: false });
    const codex = join(mkdtempSync(join(tmpdir(), "conch-evidence-")), "rollout-2026-10-03T10-00-00-0199.jsonl");
    writeFileSync(codex, "");
    expect(await claudeTranscriptSince(codex, 0, "hi")).toEqual({ submitted: false, queued: false });
  });
});
