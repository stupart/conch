import { afterEach, describe, expect, test } from "bun:test";
import { parseVocabularyTerms, projectName, setSessionVocabulary, transcriptionPrompt } from "../src/vocabulary.ts";

const HOME = "/Users/someone";

afterEach(() => setSessionVocabulary([]));

describe("dictation vocabulary", () => {
  test("is one plain sentence that always carries conch's own names", () => {
    expect(transcriptionPrompt({ vocabulary: "" })).toBe("Dictating to Claude Code and Codex about conch.");
  });

  test("adds the user's words once, in order, whatever their case or spacing", () => {
    expect(parseVocabularyTerms(" Seashell,Humain\n  HoneyB  , ,codex")).toEqual(["Seashell", "Humain", "HoneyB", "codex"]);
    expect(transcriptionPrompt({ vocabulary: "Seashell, Humain, codex" }))
      .toBe("Dictating to Claude Code and Codex about conch, Seashell and Humain.");
  });

  test("names a session's project by its folder, and a worktree by its repository", () => {
    expect(projectName("/Users/someone/Projects/Seashell", HOME)).toBe("Seashell");
    expect(projectName("/Users/someone/Projects/Conch/.worktrees/dictation-quality", HOME)).toBe("Conch");
    expect(projectName("/Users/someone/Projects/Humain/", HOME)).toBe("Humain");
  });

  test("names a folder the way it is said, so whisper is not taught to glue words", () => {
    expect(projectName("/Users/someone/Projects/HomebrewTap", HOME)).toBe("Homebrew Tap");
    expect(projectName("/Users/someone/Projects/linear-pulse", HOME)).toBe("linear pulse");
  });

  test("a home directory, a generic folder or a hidden one names no project", () => {
    expect(projectName("/Users/someone", HOME)).toBeUndefined();
    expect(projectName("/Users/someone/Desktop", HOME)).toBeUndefined();
    expect(projectName("/Users/someone/Projects", HOME)).toBeUndefined();
    expect(projectName("/Users/someone/.config", HOME)).toBeUndefined();
  });

  test("open projects join the prompt and leave it when their sessions close", () => {
    setSessionVocabulary([
      { cwd: "/Users/someone/Projects/Seashell" },
      { cwd: "/Users/someone", workDirs: ["/Users/someone/Projects/Humain/.worktrees/fix"] },
      { cwd: "/Users/someone/Projects/Seashell" },
    ], HOME);
    expect(transcriptionPrompt({ vocabulary: "" })).toBe("Dictating to Claude Code and Codex about conch, Humain and Seashell.");
    setSessionVocabulary([], HOME);
    expect(transcriptionPrompt({ vocabulary: "" })).toBe("Dictating to Claude Code and Codex about conch.");
  });

  test("stays inside whisper's prompt budget without cutting a name in half", () => {
    const many = Array.from({ length: 200 }, (_, index) => `Project${index}`).join(", ");
    const prompt = transcriptionPrompt({ vocabulary: many });
    expect(prompt.length).toBeLessThanOrEqual(605);
    expect(prompt).toMatch(/^Dictating to Claude Code and Codex about conch, (Project\d+, )*Project\d+ and Project\d+\.$/);
  });
});
