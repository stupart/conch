import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { FRONT_TTY_SCRIPT, injectKey, injectText, pasteIntoTmuxPane, revealSessionWindow, TMUX_PASTE_OVER_CHARS, TMUX_SUBMIT_GAP_MS, tmuxPastes, withUITransaction } from "../src/inject.ts";
import { conchTmux } from "../src/tmux-binary.ts";
import { runUICommand } from "../src/pasteboard.ts";

const cfg = { autoSubmit: true, keystrokeFallback: true } as Config;
type Items = Array<Record<string, string>>;
const textItems = (text: string): Items => [{ "public.utf8-plain-text": text }];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

function fakeUI(initial: Items = textItems("original")) {
  let items = structuredClone(initial);
  let changeCount = 0;
  let front = "";
  const actions: string[] = [];
  let keyFailure: { text: string; timedOut: boolean; exitCode: number } | undefined;
  let afterPaste: (() => void) | undefined;
  let onFocus: (() => Promise<void>) | undefined;
  let afterPrepare: (() => void) | undefined;
  let afterLook: (() => void) | undefined;
  const replace = (next: Items) => { items = structuredClone(next); changeCount++; };
  const pasteboard = {
    prepare: async (text: string) => {
      const previous = structuredClone(items);
      replace(textItems(text));
      afterPrepare?.();
      return { items: previous, changeCount };
    },
    restore: async (lease: { items: Items; changeCount: number }) => {
      if (lease.changeCount !== changeCount) return false;
      replace(lease.items);
      return true;
    },
  };
  const options = (pid: number) => ({
    clipboardFallback: false,
    findTmuxPane: async () => null,
    ttyForPid: async () => `tty${pid}`,
    sleep: async () => {},
    pasteboard,
    // Legacy seams expose the pre-fix loss of empty/rich clipboard data.
    readClipboard: async () => items[0]?.["public.utf8-plain-text"] ?? "",
    copyToClipboard: async (text: string) => replace(textItems(text)),
    osa: async (lines: string[], argv: string[] = []) => {
      const script = lines.join("\n");
      if (script === FRONT_TTY_SCRIPT) {
        afterLook?.();
        return { text: front, timedOut: false, exitCode: 0 };
      }
      if (script.includes("AXRaise")) {
        actions.push(`reveal:${pid}`);
        return { text: "ok", timedOut: false, exitCode: 0 };
      }
      if (script.includes("activate")) {
        front = `/dev/tty${pid}`;
        actions.push(`focus:${pid}`);
        await onFocus?.();
        return { text: "ok", timedOut: false, exitCode: 0 };
      }
      if (script.includes("if frontTty is not") && front !== `/dev/tty${pid}`) {
        return { text: "front-window-changed", timedOut: false, exitCode: 0 };
      }
      // The version conch takes for itself after writing the clipboard (the degraded paste).
      if (script.includes("changeCount") && !script.includes("conch-focus-guard")) {
        return { text: String(changeCount), timedOut: false, exitCode: 0 };
      }
      if (script.includes("pasteboard\'s changeCount") && Number(argv[0]) !== changeCount) {
        return { text: "clipboard-changed", timedOut: false, exitCode: 0 };
      }
      if (keyFailure) return keyFailure;
      if (script.includes('keystroke "v"')) {
        actions.push(`paste:${pid}:${items[0]?.["public.utf8-plain-text"]}`);
        afterPaste?.();
      } else if (script.includes("keystroke")) {
        actions.push(`type:${pid}:${argv[0]}`);
      } else if (script.includes("key code")) {
        actions.push(`key:${pid}`);
      } else throw new Error("Unexpected fake script");
      return { text: "ok", timedOut: false, exitCode: 0 };
    },
  });
  return {
    options, actions, items: () => items, replace,
    failKey: (value: NonNullable<typeof keyFailure>) => { keyFailure = value; },
    afterPaste: (fn: () => void) => { afterPaste = fn; },
    onFocus: (fn: () => Promise<void>) => { onFocus = fn; },
    afterPrepare: (fn: () => void) => { afterPrepare = fn; },
    afterLook: (fn: () => void) => { afterLook = fn; },
    front: (value: string) => { front = value; },
  };
}

describe("UI injection transactions", () => {
  test("another session cannot focus until the first complete text/Return transaction finishes", async () => {
    const ui = fakeUI();
    const entered = deferred();
    const release = deferred();
    let first = true;
    ui.onFocus(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
    const a = injectText(cfg, 1, "alpha", undefined, ui.options(1));
    await entered.promise;
    const b = injectText(cfg, 2, "beta", undefined, ui.options(2));
    await Promise.resolve();
    await Promise.resolve();
    const during = [...ui.actions];
    release.resolve();
    await Promise.all([a, b]);
    expect(during).toEqual(["focus:1"]);
    expect(ui.actions).toEqual(["focus:1", "type:1:alpha", "focus:1", "key:1", "focus:2", "type:2:beta", "focus:2", "key:2"]);
  });

  test("interrupt keys and background reveals wait for the active input transaction", async () => {
    const ui = fakeUI();
    const entered = deferred();
    const release = deferred();
    let first = true;
    ui.onFocus(async () => { if (first) { first = false; entered.resolve(); await release.promise; } });
    const a = injectText(cfg, 1, "alpha", undefined, ui.options(1));
    await entered.promise;
    const b = injectKey(cfg, 2, "Escape", undefined, ui.options(2));
    const c = revealSessionWindow(3, ui.options(3).osa, async () => "tty3");
    await Promise.resolve();
    const during = [...ui.actions];
    release.resolve();
    await Promise.all([a, b, c]);
    expect(during).toEqual(["focus:1"]);
    expect(ui.actions).toEqual(["focus:1", "type:1:alpha", "focus:1", "key:1", "focus:2", "key:2", "reveal:3"]);
  });

  for (const [name, original] of [
    ["empty", []],
    ["rich", [{ "public.utf8-plain-text": "original", "public.rtf": "rich-data", "public.png": "image-data" }, { "public.file-url": "file-data" }]],
  ] as Array<[string, Items]>) {
    test(`${name} clipboard survives a multiline paste`, async () => {
      const ui = fakeUI(original);
      await injectText(cfg, 1, "first\nsecond", undefined, ui.options(1));
      expect(ui.items()).toEqual(original);
    });
  }

  test("an intervening user copy survives cleanup", async () => {
    const ui = fakeUI();
    ui.afterPaste(() => ui.replace(textItems("user copied this")));
    await injectText(cfg, 1, "first\nsecond", undefined, ui.options(1));
    expect(ui.items()).toEqual(textItems("user copied this"));
  });

  for (const result of [
    { text: "", timedOut: false, exitCode: 1 },
    { text: "", timedOut: true, exitCode: 0 },
  ]) {
    test(`failed single key is unsuccessful (timeout=${result.timedOut})`, async () => {
      const ui = fakeUI();
      ui.failKey(result);
      expect((await injectKey(cfg, 1, "Enter", undefined, ui.options(1))).via).toBe("none");
    });
  }

  test("approval invalidated during focus sends no key", async () => {
    const ui = fakeUI();
    let allowed = true;
    ui.onFocus(async () => { allowed = false; });
    expect(await injectKey(cfg, 1, "Enter", () => allowed, ui.options(1)))
      .toMatchObject({ via: "none", interrupted: true });
    expect(ui.actions).toEqual(["focus:1"]);
  });

  test("approval invalidated during pasteboard preparation sends no paste or Return", async () => {
    const ui = fakeUI();
    let allowed = true;
    ui.afterPrepare(() => { allowed = false; });
    expect(await injectText(cfg, 1, "first\nsecond", () => allowed, ui.options(1)))
      .toMatchObject({ via: "none", interrupted: true });
    expect(ui.actions).toEqual(["focus:1"]);
    expect(ui.items()).toEqual(textItems("original"));
  });

  test("short typing revalidates the request after the awaited front-window read", async () => {
    const ui = fakeUI();
    let allowed = true;
    ui.afterLook(() => { allowed = false; });
    expect(await injectText(cfg, 1, "words", () => allowed, ui.options(1)))
      .toMatchObject({ via: "none", interrupted: true });
    expect(ui.actions).toEqual(["focus:1"]);
  });

  test("a focus change during pasteboard preparation is refused inside the paste script", async () => {
    const ui = fakeUI();
    ui.afterPrepare(() => ui.front("front:OtherApp"));
    expect(await injectText(cfg, 1, "first\nsecond", undefined, ui.options(1)))
      .toMatchObject({ via: "none", failed: true, reason: "front-window-changed" });
    expect(ui.actions).toEqual(["focus:1"]);
    expect(ui.items()).toEqual(textItems("original"));
  });

  test("a user copy during the final request check is never pasted or overwritten", async () => {
    const ui = fakeUI();
    let prepared = false;
    ui.afterPrepare(() => { prepared = true; });
    const mayInject = async () => {
      if (prepared) ui.replace(textItems("new user copy"));
      return true;
    };
    expect(await injectText(cfg, 1, "first\nsecond", mayInject, ui.options(1)))
      .toMatchObject({ via: "none", failed: true, reason: "clipboard-changed" });
    expect(ui.actions).toEqual(["focus:1"]);
    expect(ui.items()).toEqual(textItems("new user copy"));
  });

  test("a broken pasteboard helper still delivers, without preserving the clipboard", async () => {
    const ui = fakeUI();
    // The regression: prepare() threw for every clipboard with three or more
    // representations, and the send was abandoned with clipboard-unavailable.
    const result = await injectText(cfg, 1, "first\nsecond", undefined, {
      ...ui.options(1),
      pasteboard: {
        prepare: async () => { throw new Error("Pasteboard helper failed"); },
        restore: async () => { throw new Error("Pasteboard helper failed"); },
      },
    });
    // Delivered, and said to be delivered — the words reached the session.
    expect(result).toEqual({ via: "osascript-focused" });
    expect(ui.actions).toEqual(["focus:1", "paste:1:first\nsecond", "focus:1", "key:1"]);
    // The courtesy that was dropped: the sent text is left on the clipboard,
    // and conch never pretends the original was put back.
    expect(ui.items()).toEqual(textItems("first\nsecond"));
  });

  test("a failed tmux Return never reports submitted delivery", async () => {
    const ui = fakeUI();
    const result = await injectText(cfg, 1, "words", undefined, {
      ...ui.options(1), findTmuxPane: async () => "%fake",
      sendTmuxKeys: async (_pane, _text, literal) => ({ exitCode: literal ? 0 : 1 }),
    });
    expect(result).toEqual({ via: "none", failed: true, reason: "submit-failed" });
    expect(ui.actions).toEqual([]);
  });

  // Codex reads an Enter straight behind a burst of keys as a newline: measured on
  // codex-cli 0.156.0 in tmux, the words stayed in its composer as two lines.
  test("tmux pauses between the words and the Enter, and logs the Enter", async () => {
    const ui = fakeUI();
    const calls: string[] = [];
    const steps: string[] = [];
    const result = await injectText(cfg, 1, "words", undefined, {
      ...ui.options(1), findTmuxPane: async () => "%fake", steps,
      sleep: async (ms) => { calls.push(`sleep:${ms}`); },
      sendTmuxKeys: async (_pane, text, literal) => { calls.push(`${literal ? "text" : "key"}:${text}`); return { exitCode: 0 }; },
    });
    expect(result).toEqual({ via: "tmux" });
    expect(calls).toEqual(["text:words", `sleep:${TMUX_SUBMIT_GAP_MS}`, "key:Enter"]);
    expect(steps.at(-1)).toEndWith("] tmux Enter exit=0");
  });

  // 2026-10-05: 3,580 characters typed with `send-keys -l` reached Claude Code as 1,022-byte reads, each over
  // its 800-character paste line, and it recorded only the last 514. Long words now go as one bracketed paste.
  describe("long words reach a tmux pane as one paste", () => {
    const send = async (text: string, paste: (pane: string, text: string) => Promise<{ exitCode: number }> = async () => ({ exitCode: 0 })) => {
      const ui = fakeUI();
      const calls: string[] = [];
      const steps: string[] = [];
      // No keystroke route behind tmux, as in conch's own background sessions.
      const result = await injectText({ ...cfg, keystrokeFallback: false }, 1, text, undefined, {
        ...ui.options(1), findTmuxPane: async () => "conch:%7", steps,
        sleep: async (ms) => { calls.push(`sleep:${ms}`); },
        sendTmuxKeys: async (pane, sent, literal) => { calls.push(`${literal ? "text" : "key"}:${pane}:${sent}`); return { exitCode: 0 }; },
        pasteTmuxText: async (pane, sent) => { calls.push(`paste:${pane}:${sent}`); return paste(pane, sent); },
      });
      return { result, calls, steps, ui };
    };

    test("over the threshold, or across lines, the words are pasted and then Return is pressed", async () => {
      const long = "x".repeat(TMUX_PASTE_OVER_CHARS + 1);
      for (const text of [long, "two\nlines", "a carriage\rreturn", "y".repeat(3_580)]) {
        const { result, calls, steps, ui } = await send(text);
        expect(result).toEqual({ via: "tmux" });
        expect(calls).toEqual([`paste:conch:%7:${text}`, `sleep:${TMUX_SUBMIT_GAP_MS}`, "key:conch:%7:Enter"]);
        expect(steps.some((line) => line.endsWith(`] tmux paste-buffer exit=0 (${text.length} chars)`))).toBe(true);
        // Neither the Mac's clipboard nor any window was touched.
        expect(ui.items()).toEqual(textItems("original"));
        expect(ui.actions).toEqual([]);
      }
    });

    test("at or under it, on one line, the words are typed as before", async () => {
      for (const text of ["words", "z".repeat(TMUX_PASTE_OVER_CHARS)]) {
        const { result, calls } = await send(text);
        expect(result).toEqual({ via: "tmux" });
        expect(calls).toEqual([`text:conch:%7:${text}`, `sleep:${TMUX_SUBMIT_GAP_MS}`, "key:conch:%7:Enter"]);
      }
      expect(tmuxPastes("z".repeat(TMUX_PASTE_OVER_CHARS))).toBe(false);
      expect(tmuxPastes("z".repeat(TMUX_PASTE_OVER_CHARS + 1))).toBe(true);
    });

    test("a paste tmux refuses presses no Return, and is not reported delivered", async () => {
      const { result, calls } = await send("two\nlines", async () => ({ exitCode: 1 }));
      expect(calls).toEqual(["paste:conch:%7:two\nlines"]);
      expect(result).toEqual({ via: "none", failed: true, reason: "keystroke-fallback-off" });
    });
  });

  describe("the paste itself (`pasteIntoTmuxPane`)", () => {
    const runner = (fail?: (args: string[]) => boolean) => {
      const runs: Array<{ args: string[]; input?: string }> = [];
      const run = async (args: string[], input?: string) => {
        runs.push({ args, ...(input === undefined ? {} : { input }) });
        return { exitCode: fail?.(args) ? 1 : 0, timedOut: false };
      };
      return { runs, run };
    };
    const bufferOf = (args: string[]) => args[args.indexOf("-b") + 1]!;

    test("the words go in on stdin to a buffer of this send's own, pasted bracketed and deleted", async () => {
      const text = "a long message\nacross lines";
      const { runs, run } = runner();
      expect(await pasteIntoTmuxPane("conch:%7", text, run)).toEqual({ exitCode: 0 });
      const tmux = conchTmux();
      expect(runs.map(({ args }) => args.slice(tmux.length, tmux.length + 1)[0])).toEqual(["load-buffer", "paste-buffer"]);
      const [load, paste] = runs;
      const name = bufferOf(load!.args);
      expect(name).toMatch(/^conch-send-[0-9a-f-]{36}$/);
      expect(load).toEqual({ args: [...tmux, "load-buffer", "-b", name, "-"], input: text });
      // -p: the markers, when the agent asked for them; -d: the buffer goes once pasted; -r: newlines stay newlines.
      expect(paste).toEqual({ args: [...tmux, "paste-buffer", "-p", "-d", "-r", "-b", name, "-t", "%7"] });
      // Only conch's tmux runs, and never with -w, which would copy the buffer to the clipboard; no pbcopy, no osascript.
      for (const { args } of runs) {
        expect(args.slice(0, tmux.length)).toEqual(tmux);
        expect(args).not.toContain("-w");
      }

      const again = runner();
      await pasteIntoTmuxPane("conch:%7", text, again.run);
      expect(bufferOf(again.runs[0]!.args)).not.toBe(name);
    });

    test("a paste that fails deletes its buffer, and says so", async () => {
      const pasteFails = runner((args) => args.includes("paste-buffer"));
      expect((await pasteIntoTmuxPane("conch:%7", "words", pasteFails.run)).exitCode).not.toBe(0);
      const name = bufferOf(pasteFails.runs[0]!.args);
      expect(pasteFails.runs.at(-1)!.args).toEqual([...conchTmux(), "delete-buffer", "-b", name]);

      const loadFails = runner((args) => args.includes("load-buffer"));
      expect((await pasteIntoTmuxPane("conch:%7", "words", loadFails.run)).exitCode).not.toBe(0);
      expect(loadFails.runs.map(({ args }) => args[conchTmux().length])).toEqual(["load-buffer", "delete-buffer"]);
    });

    test("something that is not a pane gets nothing run", async () => {
      const { runs, run } = runner();
      expect(await pasteIntoTmuxPane("not-a-pane", "words", run)).toEqual({ exitCode: 1 });
      expect(runs).toEqual([]);
    });
  });

  // The Return was the one step the step log never showed, and it is the one that goes missing.
  test("the steps a caller collects say when the Return was pressed", async () => {
    const ui = fakeUI();
    const steps: string[] = [];
    expect(await injectText(cfg, 1, "words", undefined, { ...ui.options(1), steps })).toEqual({ via: "osascript-focused" });
    expect(steps.map((line) => line.replace(/^\[[^\]]*\] /, "")).slice(-2))
      .toEqual(["refocus before Return -> ok", "Return -> pressed"]);
  });

  test("a rejected transaction releases the queue for the next session", async () => {
    const ui = fakeUI();
    await expect(injectText(cfg, 1, "words", undefined, {
      ...ui.options(1), ttyForPid: async () => { throw new Error("fake failure"); },
    })).rejects.toThrow("fake failure");
    expect((await injectKey(cfg, 2, "Escape", undefined, ui.options(2))).via).toBe("osascript-focused");
    expect(ui.actions).toEqual(["focus:2", "key:2"]);
  });

  test("an unkillable native child seals every UI transaction until observed exit", async () => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    try {
      const outcome = await withUITransaction(() => runUICommand(["fake-unkillable"], undefined, {
        timeoutMs: 1, reapTimeoutMs: 1,
        spawn: () => ({ stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited, kill: () => {} }),
      }));
      expect(outcome.timedOut).toBe(true);
      let acted = false;
      await expect(withUITransaction(async () => { acted = true; })).rejects.toThrow("input is suspended");
      expect(acted).toBe(false);
    } finally {
      exit(137);
      await exited;
      await Promise.resolve();
    }
    expect(await withUITransaction(async () => "ready")).toBe("ready");
  });
});
