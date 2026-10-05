import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import {
  findTmuxPane,
  injectKey,
  injectKeys,
  injectText,
  pastesIntoPane,
  tmuxPasteArgv,
  tmuxServers,
  TMUX_SUBMIT_GAP_MS,
  type TmuxPaneRef,
} from "../src/inject.ts";

// A session started "In conch" runs in conch's own tmux server (`tmux -L conch`, src/conch-tmux.ts). Delivery to it goes
// by send-keys into its pane on THAT server — never by raising Terminal — so there is no focus to steal.

const cfg = { autoSubmit: true, keystrokeFallback: true } as Config;
const CONCH = ["/Applications/conch.app/Contents/Helpers/tmux", "-L", "conch"] as const;
const hostedPane: TmuxPaneRef = { pane: "%7", tmux: CONCH };

/** A send whose every UI path is a trap: only the tmux seams may be used. */
function hostedOptions(calls: string[]) {
  return {
    clipboardFallback: false,
    findTmuxPane: async () => hostedPane,
    sleep: async (ms: number) => { calls.push(`sleep:${ms}`); },
    sendTmuxKeys: async (pane: string, text: string, literal: boolean, tmux?: readonly string[]) => {
      calls.push(`${(tmux ?? ["tmux"]).join(" ")} send-keys -t ${pane} ${literal ? "-l " : ""}${JSON.stringify(text)}`);
      return { exitCode: 0 };
    },
    pasteTmuxText: async (pane: string, text: string, tmux: readonly string[]) => {
      calls.push(`${tmux.join(" ")} paste -t ${pane} ${JSON.stringify(text)}`);
      return { exitCode: 0 };
    },
    osa: async () => { throw new Error("a hosted session is never delivered to through Terminal"); },
    ttyForPid: async () => { throw new Error("a hosted session's tty is never looked up"); },
    copyToClipboard: async () => { throw new Error("nothing goes to the clipboard"); },
  };
}

describe("delivery to a session conch hosts goes by send-keys on conch's server", () => {
  test("words then Enter, into the pane on conch's socket, with the submit gap", async () => {
    const calls: string[] = [];
    const result = await injectText(cfg, 4242, "fix the build", undefined, hostedOptions(calls));
    expect(result).toEqual({ via: "tmux" });
    expect(calls).toEqual([
      `${CONCH.join(" ")} send-keys -t %7 -l "fix the build"`,
      `sleep:${TMUX_SUBMIT_GAP_MS}`,
      `${CONCH.join(" ")} send-keys -t %7 "Enter"`,
    ]);
  });

  test("words across lines are one paste from a tmux buffer, then Enter after a longer gap", async () => {
    const calls: string[] = [];
    const text = "line one\nline two";
    const result = await injectText(cfg, 4242, text, undefined, hostedOptions(calls));
    expect(result).toEqual({ via: "tmux" });
    expect(calls).toEqual([
      `${CONCH.join(" ")} paste -t %7 ${JSON.stringify(text)}`,
      `sleep:${TMUX_SUBMIT_GAP_MS + text.length}`,
      `${CONCH.join(" ")} send-keys -t %7 "Enter"`,
    ]);
  });

  test("a staged send (no auto-submit) types the words and presses nothing", async () => {
    const calls: string[] = [];
    expect(await injectText({ ...cfg, autoSubmit: false }, 4242, "draft", undefined, hostedOptions(calls))).toEqual({ via: "tmux" });
    expect(calls).toEqual([`${CONCH.join(" ")} send-keys -t %7 -l "draft"`]);
  });

  test("the lost-Return check's Enter and a picker's keys go to the same server", async () => {
    const calls: string[] = [];
    expect(await injectKey(cfg, 4242, "Enter", undefined, hostedOptions(calls))).toEqual({ via: "tmux" });
    expect(await injectKeys(cfg, 4242, ["Down", { type: "a\nb" }, { type: "yes" }], undefined, hostedOptions(calls))).toEqual({ via: "tmux" });
    expect(calls.filter((call) => !call.startsWith("sleep:"))).toEqual([
      `${CONCH.join(" ")} send-keys -t %7 "Enter"`,
      `${CONCH.join(" ")} send-keys -t %7 "Down"`,
      `${CONCH.join(" ")} paste -t %7 "a\\nb"`,
      `${CONCH.join(" ")} send-keys -t %7 -l "yes"`,
    ]);
  });

  test("a failed paste is a failed send, never a Return pressed on nothing", async () => {
    const calls: string[] = [];
    const options = { ...hostedOptions(calls), pasteTmuxText: async () => ({ exitCode: 1 }) };
    // Falls through the tmux route; with keystrokes off it lands nowhere and says so.
    const result = await injectText({ ...cfg, keystrokeFallback: false }, 4242, "a\nb", undefined, options);
    expect(result).toEqual({ via: "none", failed: true, reason: "keystroke-fallback-off" });
    expect(calls.some((call) => call.includes("Enter"))).toBe(false);
  });

  test("the user's own tmux keeps its literal send-keys, newlines and all", async () => {
    const calls: string[] = [];
    const result = await injectText(cfg, 4242, "a\nb", undefined, { ...hostedOptions(calls), findTmuxPane: async () => "%3" });
    expect(result).toEqual({ via: "tmux" });
    expect(calls[0]).toBe(`tmux send-keys -t %3 -l "a\\nb"`);
  });
});

describe("which text is pasted", () => {
  test("only across lines, and only in conch's own server", () => {
    expect(pastesIntoPane(CONCH, "one\ntwo")).toBe(true);
    expect(pastesIntoPane(CONCH, "x".repeat(2_000))).toBe(false);
    expect(pastesIntoPane(tmuxServers(null)[0]!, "one\ntwo")).toBe(false);
  });

  test("the paste is a named buffer loaded from stdin, pasted bracketed and deleted", () => {
    expect(tmuxPasteArgv(CONCH, "%7", "conch-1-2")).toEqual([
      ...CONCH, "load-buffer", "-b", "conch-1-2", "-", ";", "paste-buffer", "-p", "-d", "-b", "conch-1-2", "-t", "%7",
    ]);
  });
});

describe("finding a session's pane", () => {
  const ancestors = async () => new Set([4242, 4100, 1]);

  test("conch's own server is asked first, and its pane comes back with its argv", async () => {
    const asked: string[] = [];
    const found = await findTmuxPane(4242, {
      servers: tmuxServers([...CONCH]),
      ancestorsOf: ancestors,
      run: async (argv) => {
        asked.push(argv.slice(0, argv.indexOf("list-panes")).join(" "));
        return argv.includes("-L")
          ? { text: "4100 %7\n9999 %8\n", exitCode: 0, timedOut: false }
          : { text: "4100 %1\n", exitCode: 0, timedOut: false };
      },
    });
    expect(found).toEqual({ pane: "%7", tmux: CONCH });
    expect(asked).toEqual([CONCH.join(" ")]);
  });

  test("with no conch server running, the user's own tmux is asked, as before", async () => {
    const found = await findTmuxPane(4242, {
      servers: tmuxServers([...CONCH]),
      ancestorsOf: ancestors,
      run: async (argv) => argv.includes("-L")
        ? { text: "", exitCode: 1, timedOut: false }
        : { text: "4100 %1\n", exitCode: 0, timedOut: false },
    });
    expect(found).toEqual({ pane: "%1", tmux: ["tmux"] });
  });

  test("a pid in neither server has no pane", async () => {
    const found = await findTmuxPane(4242, {
      servers: tmuxServers([...CONCH]),
      ancestorsOf: ancestors,
      run: async () => ({ text: "5000 %2\n", exitCode: 0, timedOut: false }),
    });
    expect(found).toBeNull();
  });

  test("with no tmux for conch at all, only the user's server is searched", () => {
    expect(tmuxServers(null)).toEqual([["tmux"]]);
    expect(tmuxServers([...CONCH])).toEqual([CONCH as unknown as string[], ["tmux"]]);
  });
});
