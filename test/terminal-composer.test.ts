import { describe, expect, test } from "bun:test";
import { TerminalComposer } from "../src/terminal-composer.ts";

describe("TerminalComposer", () => {
  test("captures one session, edits a line, and submits only on Enter", () => {
    const submissions: unknown[] = [];
    const lifecycle: string[] = [];
    const composer = new TerminalComposer({
      controller: {
        submit(target, text) {
          submissions.push([{ ...target }, text]);
          return true;
        },
      },
      onOpen: () => lifecycle.push("open"),
      onClose: () => lifecycle.push("close"),
      onChange() {},
    });
    composer.open({ sessionId: "a", label: "Alpha" });
    composer.handleKey("hello 🌊");
    composer.handleKey("\x7f");
    composer.handleKey("!");
    expect(composer.model()).toMatchObject({
      target: { sessionId: "a", label: "Alpha" },
      text: "hello !",
    });
    expect(submissions).toEqual([]);

    composer.handleKey("\r");
    expect(submissions).toEqual([[{ sessionId: "a", label: "Alpha" }, "hello !"]]);
    expect(composer.isOpen()).toBeFalse();
    expect(lifecycle).toEqual(["open", "close"]);
  });

  test("empty Enter stays open, Escape cancels, and Ctrl-C reaches shutdown", () => {
    const composer = new TerminalComposer({
      controller: { submit: () => true },
      onChange() {},
    });
    composer.open({ sessionId: "a", label: "Alpha" });
    expect(composer.handleKey("\u0003")).toBeFalse();
    composer.handleKey("\r");
    expect(composer.model()?.error).toBe("type a prompt before sending");
    expect(composer.isOpen()).toBeTrue();
    composer.handleKey("\x1b");
    expect(composer.isOpen()).toBeFalse();
  });

  test("published dictation appends once and only to the captured session", () => {
    const composer = new TerminalComposer({
      controller: { submit: () => true },
      onChange() {},
    });
    composer.open({ sessionId: "a", label: "Alpha" }, 4);
    expect(composer.applyDictation({ sessionId: "a", text: "stale", id: 4 })).toBeFalse();
    expect(composer.applyDictation({ sessionId: "b", text: "wrong target", id: 5 })).toBeFalse();
    expect(composer.applyDictation({ sessionId: "a", text: "spoken half", id: 6 })).toBeTrue();
    expect(composer.applyDictation({ sessionId: "a", text: "spoken half", id: 6 })).toBeFalse();
    expect(composer.model()?.text).toBe("spoken half");
  });
});
