import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import {
  isProviderCommandLine,
  renameProviderSession,
  type ProviderRenameInjector,
} from "../src/provider-rename.ts";

const config = {
  autoSubmit: false,
  keystrokeFallback: true,
} as Config;

describe("provider rename routing", () => {
  test("Claude receives an auto-submitted local slash command without clipboard fallback", async () => {
    const calls: Array<{ cfg: Config; pid: number | undefined; text: string; options: unknown }> = [];
    const inject: ProviderRenameInjector = async (cfg, pid, text, _before, options) => {
      calls.push({ cfg, pid, text, options });
      return { via: "tmux" };
    };

    await expect(renameProviderSession(
      config,
      { backend: "claude", pid: 42 },
      "Release train",
      inject,
    )).resolves.toEqual({ kind: "delivered", via: "tmux" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cfg.autoSubmit).toBeTrue();
    expect(calls[0]?.pid).toBe(42);
    expect(calls[0]?.text).toBe("/rename Release train");
    expect(calls[0]?.options).toEqual({ clipboardFallback: false });
  });

  test("Codex is skipped and an unroutable Claude session is explicit", async () => {
    let calls = 0;
    const inject: ProviderRenameInjector = async () => {
      calls += 1;
      return { via: "tmux" };
    };

    await expect(renameProviderSession(config, { backend: "codex", pid: 42 }, "Beta", inject))
      .resolves.toEqual({ kind: "unsupported" });
    await expect(renameProviderSession(config, { backend: "claude" }, "Beta", inject))
      .resolves.toEqual({ kind: "unroutable", reason: "session has no routable pid" });
    expect(calls).toBe(0);
  });

  test("a failed focused route does not claim the provider was renamed", async () => {
    const inject: ProviderRenameInjector = async () => ({
      via: "clipboard",
      reason: "window-not-focusable",
    });

    await expect(renameProviderSession(config, { pid: 42 }, "Beta", inject)).resolves.toEqual({
      kind: "unroutable",
      reason: "window-not-focusable",
    });
  });
});

/**
 * B4: a typed message that IS a slash command takes the door B2 built,
 * whoever typed it — the composer, the phone, or the palette. The message
 * route would match it against a pending question, offer it to voice Q&A,
 * honour auto-submit off, and re-press Return twice when the transcript did
 * not grow — into the picker a bare `/model` opens.
 */
describe("slash lines through inject", () => {
  test("a command line is one the agent would parse, not any leading slash", () => {
    for (const line of ["/compact", "/model opus", "  /model  ", "/ponytail:ponytail args", "/mcp__linear__issue x", "/fast"]) {
      expect(isProviderCommandLine(line), line).toBeTrue();
    }
    for (const line of ["/Users/me/notes.txt look at this", "/", "/ hello", "hello /compact", "", "//"]) {
      expect(isProviderCommandLine(line), line).toBeFalse();
    }
  });

  // The inject handler takes the provider door before the message route:
  // executed in voice-loop.test.ts ("a slash line takes the provider door").
});
