import { describe, expect, test } from "bun:test";
import { failureIdentity, normalizeFailureMessage, SIGNATURE_MESSAGE_MAX } from "../src/failure-signature.ts";

// What makes two failures one ticket (docs/failure-tickets.md). The messages below are shaped like the records conch
// writes, with made-up names: the real ones hold the user's sessions, folders and clients.

describe("a failure's message, without what changes from one occurrence to the next", () => {
  test("the file it couldn't find is not part of the failure", () => {
    expect(normalizeFailureMessage("Couldn't find v0.4.0.md")).toBe("Couldn't find <file>");
    expect(normalizeFailureMessage("Couldn't find brochure-v1-preview.png")).toBe("Couldn't find <file>");
    expect(normalizeFailureMessage("Couldn't find demo-1-on-brand-image.mp4")).toBe("Couldn't find <file>");
  });

  test("paths, URLs and ids become what they are, a path with a space in a folder included", () => {
    expect(normalizeFailureMessage("That's a file on your Mac, not a page: /Users/someone/Projects/Acme Corp/notes/plan.md"))
      .toBe("That's a file on your Mac, not a page: <path>");
    expect(normalizeFailureMessage("iPhone couldn't open ~/Projects/site/index.html."))
      .toBe("iPhone couldn't open <path>.");
    expect(normalizeFailureMessage("Delivered, to a new session Claude Code started from this window (15a3c78f-c6a3-4887-8abd-3abacaeeb417), not the conversation addressed."))
      .toBe("Delivered, to a new session Claude Code started from this window (<id>), not the conversation addressed.");
    expect(normalizeFailureMessage("trust prompt in conch-0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b: never appeared"))
      .toBe("trust prompt in <id>: never appeared");
    expect(normalizeFailureMessage("the page at https://example.test/a?b=1 wouldn't load")).toBe("the page at <url> wouldn't load");
  });

  test("a session's label, or anything else quoted, is the user's words, not the failure's", () => {
    expect(normalizeFailureMessage(`Could not change "Flight to somewhere on the 22nd" to sonnet: the session is waiting on you; answer it first`))
      .toBe(`Could not change "…" to sonnet: the session is waiting on you; answer it first`);
    expect(normalizeFailureMessage("no live session matching “Acme dashboard”")).toBe("no live session matching “…”");
  });

  test("counts and durations go, so a wait of 15 s and one of 20 s are the same failure", () => {
    expect(normalizeFailureMessage("Ctrl-D was sent, but the session is still running after 15 s."))
      .toBe(normalizeFailureMessage("Ctrl-D was sent, but the session is still running after 20 s."));
    expect(normalizeFailureMessage("The Return was lost; the prompt went in after 2 re-sends."))
      .toBe("The Return was lost; the prompt went in after <n> re-sends.");
  });

  test("only the first sentence: the rest is what conch saw, not which failure it was", () => {
    expect(normalizeFailureMessage("Could not deliver the prompt. Review the recovered draft before retrying."))
      .toBe("Could not deliver the prompt.");
    const page = `failed: the words "<target>" aren't visible on the page. What conch got: "Acme — Home" at <url>. Its headings: "One", "Two", "Three".`;
    const other = `failed: the words "<target>" aren't visible on the page. What conch got: "Other" at <url>. Its headings: "Four".`;
    expect(normalizeFailureMessage(page)).toBe(`failed: the words "…" aren't visible on the page.`);
    expect(normalizeFailureMessage(page)).toBe(normalizeFailureMessage(other));
  });

  test("a different cause in brackets stays a different failure", () => {
    expect(normalizeFailureMessage("message landed on clipboard (system-dialog-blocking)"))
      .not.toBe(normalizeFailureMessage("message landed on clipboard (front-window-changed)"));
  });

  test("never longer than a title", () => {
    const long = `${"word ".repeat(80)}end`;
    expect(normalizeFailureMessage(long).length).toBeLessThanOrEqual(SIGNATURE_MESSAGE_MAX);
    expect(normalizeFailureMessage(long).endsWith("…")).toBe(true);
  });
});

describe("a failure's identity", () => {
  test("is where it came from, what conch was doing, and the message: each tells failures apart", () => {
    const inject = failureIdentity("daemon", "inject", "Typed, but the session never took it. The words are on the clipboard.");
    expect(inject.signature).toBe("daemon · inject · Typed, but the session never took it.");
    expect(inject.key).toMatch(/^[0-9a-f]{12}$/);
    expect(failureIdentity("mac", "inject", "Typed, but the session never took it.").key).not.toBe(inject.key);
    expect(failureIdentity("daemon", "question-answer", "Typed, but the session never took it.").key).not.toBe(inject.key);
    // The same failure in another session, another time: the same ticket.
    expect(failureIdentity("daemon", "inject", "Typed, but the session never took it. The words are on the clipboard!").key).toBe(inject.key);
  });

  test("an MCP tool's error doesn't repeat how the call ended", () => {
    const capture = failureIdentity("mcp", "conch_capture failed", "failed: the target is on the page but conch couldn't bring it into view.");
    expect(capture.title).toBe("the target is on the page but conch couldn't bring it into view.");
    expect(capture.signature).toBe("mcp · conch_capture failed · the target is on the page but conch couldn't bring it into view.");
  });

  test("today's Allow: the thrown error is its own ticket, whatever session it was for", () => {
    const allow = failureIdentity("daemon", "inject", "Account profiles must have separate directories");
    expect(allow.title).toBe("Account profiles must have separate directories");
    expect(failureIdentity("daemon", "inject", "Account profiles must have separate directories").key).toBe(allow.key);
  });
});
