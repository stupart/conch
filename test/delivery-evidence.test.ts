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
