import { expect, test } from "bun:test";
import { START_PROMPT_MAX, startPromptError, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateRuntimeControlMessage } from "../src/settings.ts";

/**
 * A start's first message (the skills library's Try): typed as the agent's own positional argument, after every flag,
 * and only for a new conversation.
 */
test("the first message is the last argument, quoted as one", () => {
  const prompt = "/pdf Show me what it's for, in this folder";
  expect(terminalSessionCommand({ backend: "claude", cwd: "/tmp/trial", prompt }))
    .toBe(`cd -- '/tmp/trial' && exec claude '/pdf Show me what it'\\''s for, in this folder'`);
  expect(terminalSessionCommand({ backend: "codex", cwd: "/tmp/trial", prompt: "$linear Show me", trustFolder: true }))
    .toEndWith(` '$linear Show me'`);
  expect(terminalSessionCommand({ backend: "claude", cwd: "/tmp/trial" })).not.toContain("'/pdf");
});

test("a first message is one printable line, never a flag, and never for a resume", () => {
  expect(startPromptError({ prompt: "/pdf Show me" })).toBeUndefined();
  expect(startPromptError({})).toBeUndefined();
  expect(startPromptError({ prompt: "  " })).toContain("non-empty");
  expect(startPromptError({ prompt: "x".repeat(START_PROMPT_MAX + 1) })).toContain("exceed");
  expect(startPromptError({ prompt: "two\nlines" })).toContain("one line");
  expect(startPromptError({ prompt: "--dangerously-skip-permissions" })).toContain("cannot start with -");
  expect(startPromptError({ prompt: "hi", resumeSessionId: "abc" })).toContain("new conversation");
  expect(() => terminalSessionCommand({ backend: "claude", prompt: "-x" })).toThrow("cannot start with -");
  const start = { kind: "session-start", backend: "claude", cwd: "/tmp/trial" };
  expect(validateRuntimeControlMessage({ ...start, prompt: " /pdf Show me " })).toEqual({
    ok: true, value: { kind: "session-start", backend: "claude", cwd: "/tmp/trial", prompt: "/pdf Show me" },
  });
  expect(validateRuntimeControlMessage({ ...start, prompt: 4 }).ok).toBe(false);
  expect(validateRuntimeControlMessage({ ...start, prompt: "hi", resumeSessionId: "abc" }).ok).toBe(false);
});
