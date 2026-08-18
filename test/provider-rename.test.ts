import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  renameProviderSession,
  type ProviderRenameInjector,
} from "../src/provider-rename.ts";

const config = {
  autoSubmit: false,
  keystrokeFallback: true,
} as Config;

describe("provider rename routing", () => {
  test("the shared session controller invokes provider routing after local persistence", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

    expect(daemon).toMatch(
      /renameSessionLabel\([\s\S]*renameProviderSession\(cfg, target, renamed\.label\)/,
    );
    expect(daemon).toContain('backend: session?.backend ?? "claude"');
    expect(daemon).toContain("const pid = session?.pid ?? known?.pid");
  });

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
    expect(calls[0]?.options).toMatchObject({ allowBlindFallback: false });
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
