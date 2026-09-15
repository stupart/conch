import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { FRONT_TTY_SCRIPT, injectText, PASTE_OVER_CHARS } from "../src/inject.ts";
import { injectProviderCommand, type ProviderRenameInjector } from "../src/provider-rename.ts";

const config = { autoSubmit: false, keystrokeFallback: true } as Config;

// Exercise the real provider-command -> injector path. Only the external
// boundaries are fake: no process probing, tmux, AppleScript, or pasteboard I/O.
function terminal(focusable = true) {
  const originalClipboard = "clipboard sentinel: never submit this";
  let clipboard = originalClipboard;
  let input = "";
  const pasted: string[] = [];
  const submitted: string[] = [];
  const copies: string[] = [];
  let changeCount = 0;
  const write = (value: string) => { copies.push(value); clipboard = value; changeCount++; };
  const pasteboard = {
    prepare: async (value: string) => {
      const items = [{ text: clipboard }];
      write(value);
      return { items, changeCount };
    },
    restore: async (lease: { items: Array<Record<string, string>>; changeCount: number }) => {
      if (lease.changeCount !== changeCount) return false;
      write(lease.items[0]?.text ?? "");
      return true;
    },
  };
  const inject: ProviderRenameInjector = (cfg, pid, text, before, commandOptions) => injectText(
    cfg, pid, text, before, {
      findTmuxPane: async () => null,
      ttyForPid: async () => "ttys-test",
      pasteboard,
      sleep: async () => {},
      copyToClipboard: async (value) => { write(value); },
      osa: async (lines, argv = []) => {
        const script = lines.join("\n");
        if (script === FRONT_TTY_SCRIPT) return { text: "/dev/ttys-test", timedOut: false };
        if (script.includes('keystroke "v" using command down')) {
          pasted.push(clipboard);
          input += clipboard;
        } else if (script.includes("keystroke (item 1 of argv)")) {
          input += argv[0];
        } else if (script.includes("key code 36")) {
          submitted.push(input);
          input = "";
        } else if (script.includes('tell application "Terminal"')) {
          return { text: focusable ? "ok" : "notfound", timedOut: false };
        } else {
          throw new Error(`Unexpected fake AppleScript: ${script}`);
        }
        return { text: "", timedOut: false };
      },
      ...commandOptions,
    },
  );
  return { inject, pasted, submitted, copies, originalClipboard, clipboard: () => clipboard };
}

describe("provider commands through the real paste route", () => {
  for (const [kind, command] of [
    ["long", `/compact ${"a".repeat(PASTE_OVER_CHARS)}`],
    ["multiline", "/compact first line\nsecond line"],
  ] as const) {
    test(`${kind} command pastes and submits its own text, then restores the clipboard`, async () => {
      const t = terminal();
      expect(await injectProviderCommand(config, { pid: 7 }, command, t.inject))
        .toEqual({ kind: "delivered", via: "osascript-focused" });
      expect(t.pasted).toEqual([command]);
      expect(t.submitted).toEqual([command]);
      expect(t.copies).toEqual([command, t.originalClipboard]);
      expect(t.clipboard()).toBe(t.originalClipboard);
    });
  }

  test("an unreachable command leaves the clipboard alone and reports failure", async () => {
    const t = terminal(false);
    expect(await injectProviderCommand(config, { pid: 7 }, "/compact", t.inject))
      .toEqual({ kind: "unroutable", reason: "window-not-focusable" });
    expect(t.pasted).toEqual([]);
    expect(t.submitted).toEqual([]);
    expect(t.copies).toEqual([]);
    expect(t.clipboard()).toBe(t.originalClipboard);
  });
});
