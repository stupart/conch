import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (name: string) => readFileSync(join(import.meta.dir, "..", "src", name), "utf8");

describe("terminal Phase 1 and 2 wiring", () => {
  const daemon = source("daemon.ts");
  const status = source("status.ts");

  test("the prompt line injects into its captured session", () => {
    expect(daemon).toContain('c === "i"');
    expect(daemon).toContain("terminalComposer?.open");
    expect(daemon).toContain("controller: { submit: injectTerminalPrompt }");
    expect(daemon).toMatch(/const injectTerminalPrompt[\s\S]*type: "inject"[\s\S]*sessionId: session\.sessionId/);
    expect(daemon).toMatch(/function dictateToTerminalComposer[\s\S]*compose: true/);
    expect(daemon).toContain("terminalComposer?.applyDictation(committedLiveState.dictated)");
    expect(status).toContain("prompt → ${composer.target.label}");
  });

  test("questions own number keys before legacy numbered wake shortcuts", () => {
    const questionRoute = daemon.indexOf("terminalQuestionController?.handleKey");
    const numberedWake = daemon.indexOf('c >= "1" && c <= "9"');
    expect(questionRoute).toBeGreaterThan(-1);
    expect(questionRoute).toBeLessThan(numberedWake);
    expect(status).toContain("answerableTerminalQuestion(model)");
    expect(status).toContain('"1-9 answer"');
  });

  test("new, interrupt, clean close, and restore all have terminal routes", () => {
    expect(daemon).toContain('c === "n"');
    expect(daemon).toContain("sessionStartOverlay?.open()");
    expect(daemon).toContain('c === "x"');
    expect(daemon).toMatch(/c === "x"[\s\S]*type: "interrupt"/);
    expect(daemon).toContain("close: closeLiveSession");
    expect(daemon).toContain("restoreSessionsOverlay?.open");
  });
});
