import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetKeptTails, hasConversation, readClaudeTitle, readClaudeTitles, readClaudeTitlesIfThere, readContinuedIn,
} from "../src/claude-title.ts";

const dirs: string[] = [];
const transcript = (lines: unknown[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
const filler = (bytes: number) => transcript([{ type: "user", message: { role: "user", content: "x".repeat(bytes) } }]);

function file(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conch-title-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, text);
  return path;
}

afterEach(() => {
  forgetKeptTails();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the kept transcript tail", () => {
  test("a transcript that has not moved is not read again", () => {
    const path = file(transcript([{ type: "ai-title", aiTitle: "Fix the panel" }]));
    expect(readClaudeTitle(path)).toBe("Fix the panel");
    const opens = spyOn(fs, "openSync");
    try {
      expect(readClaudeTitle(path)).toBe("Fix the panel");
      expect(readContinuedIn(path)).toBeUndefined();
      expect(readContinuedIn(path)).toBeUndefined();
      expect(opens).not.toHaveBeenCalled();
    } finally {
      opens.mockRestore();
    }
  });

  test("an append is read from where the file ended, and the answers follow it", () => {
    const path = file(filler(10_000) + transcript([{ type: "ai-title", aiTitle: "First" }]));
    expect(readClaudeTitles(path)).toEqual({ generated: "First" });
    appendFileSync(path, transcript([{ type: "custom-title", customTitle: "Renamed" }]));
    expect(readClaudeTitles(path)).toEqual({ custom: "Renamed", generated: "First" });
    appendFileSync(path, transcript([{ type: "continued-in", continuedInSessionId: "next-id" }]));
    expect(readContinuedIn(path)).toBe("next-id");
    // A reply after the marker: the conversation carried on here.
    appendFileSync(path, transcript([{ type: "assistant", message: { role: "assistant", content: "still here" } }]));
    expect(readContinuedIn(path)).toBeUndefined();
  });

  test("the tail is the last 64 KB, as it always was: a title that scrolled out is gone", () => {
    const path = file(transcript([{ type: "custom-title", customTitle: "Old name" }]));
    expect(readClaudeTitle(path)).toBe("Old name");
    // Each answer after an append is the one the whole file's last 64 KB gives.
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 20; i++) {
      appendFileSync(path, filler(4_000 + i * 37));
      const whole = fs.readFileSync(path);
      const inTail = whole.subarray(Math.max(0, whole.length - 64 * 1024)).includes("Old name");
      const title = readClaudeTitle(path);
      expect(title).toBe(inTail ? "Old name" : undefined);
      seen.add(title);
    }
    expect(seen).toEqual(new Set(["Old name", undefined]));
  });

  test("a rewrite in place is read whole, not appended to what was kept", () => {
    const path = file(filler(2_000) + transcript([{ type: "ai-title", aiTitle: "Before" }]));
    expect(readClaudeTitle(path)).toBe("Before");
    // Longer, the same inode, different bytes where the old end was.
    writeFileSync(path, filler(3_000) + transcript([{ type: "ai-title", aiTitle: "After" }]));
    expect(readClaudeTitle(path)).toBe("After");
    // Shorter.
    writeFileSync(path, transcript([{ type: "ai-title", aiTitle: "Short" }]));
    expect(readClaudeTitle(path)).toBe("Short");
  });

  test("a file replaced by a rename is read again", () => {
    const path = file(transcript([{ type: "ai-title", aiTitle: "One" }]));
    expect(readClaudeTitle(path)).toBe("One");
    const next = `${path}.next`;
    writeFileSync(next, transcript([{ type: "ai-title", aiTitle: "Two" }]));
    renameSync(next, path);
    expect(readClaudeTitle(path)).toBe("Two");
  });

  test("a missing transcript: no titles, nothing there, and a conversation by default", () => {
    const path = join(tmpdir(), "conch-title-missing", "none.jsonl");
    expect(readClaudeTitles(path)).toEqual({});
    expect(readClaudeTitlesIfThere(path)).toBeNull();
    expect(readContinuedIn(path)).toBeUndefined();
    expect(hasConversation(path)).toBe(true);
  });

  test("hasConversation follows the transcript as it gains its first message", () => {
    const path = file(transcript([{ type: "ai-title", aiTitle: "Spare" }]));
    expect(hasConversation(path)).toBe(false);
    appendFileSync(path, transcript([{ type: "user", message: { role: "user", content: "hello" } }]));
    expect(hasConversation(path)).toBe(true);
  });

  test("an answer handed out is a copy", () => {
    const path = file(transcript([{ type: "ai-title", aiTitle: "Kept" }]));
    const titles = readClaudeTitles(path);
    titles.generated = "changed by a caller";
    expect(readClaudeTitles(path)).toEqual({ generated: "Kept" });
  });
});
