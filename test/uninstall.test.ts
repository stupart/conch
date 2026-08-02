import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  directorySize,
  parseUninstallArgs,
  removeConchHooks,
  removeManagedInstructionBlocks,
  runUninstall,
} from "../src/uninstall.ts";

const begin = "<!-- conch:begin -->";
const end = "<!-- conch:end -->";
const claudeCommand = '"/opt/homebrew/bin/conch" hook';
const codexCommand = '"/opt/homebrew/bin/conch" codex-hook';

describe("uninstall helpers", () => {
  test("removes managed blocks while preserving surrounding content", () => {
    const before = "# Keep before\n\n";
    const after = "Keep after exactly.\n";
    const existing = `${before}${begin}\nold managed instructions\n${end}\n${after}`;

    const result = removeManagedInstructionBlocks(existing);

    expect(result).toEqual({
      content: `${before}${after}`,
      changed: true,
      removedBlocks: 1,
    });
  });

  test("removes only Conch's hook commands and preserves unrelated hooks and settings", () => {
    const unrelated = {
      type: "command",
      command: "/usr/local/bin/team-hook",
      timeout: 7,
    };
    const existing = {
      model: "keep-me",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: claudeCommand, timeout: 15 }] },
          { matcher: "always", hooks: [unrelated] },
        ],
        Notification: [
          {
            matcher: "permission_prompt",
            hooks: [
              { type: "command", command: claudeCommand, timeout: 15 },
              unrelated,
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              // Right product, wrong entrypoint: this belongs to Codex's file.
              { type: "command", command: codexCommand, timeout: 15 },
            ],
          },
        ],
      },
    };

    const result = removeConchHooks(existing, "claude");

    expect(result.removedHooks).toBe(2);
    expect(result.removedByEvent).toEqual({ Stop: 1, Notification: 1 });
    expect(result.settings).toEqual({
      model: "keep-me",
      hooks: {
        Stop: [{ matcher: "always", hooks: [unrelated] }],
        Notification: [
          { matcher: "permission_prompt", hooks: [unrelated] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: codexCommand, timeout: 15 }] },
        ],
      },
    });
    expect(existing.hooks.Stop).toHaveLength(2);
  });

  test("rejects unknown flags and requires the explicit models flag", () => {
    expect(parseUninstallArgs([])).toEqual({ models: false });
    expect(parseUninstallArgs(["--models"])).toEqual({ models: true });
    expect(() => parseUninstallArgs(["--all"])).toThrow(
      "unknown uninstall option: --all",
    );
  });

  test("keeps models by default, reports their size, and cleans all managed files", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-uninstall-"));
    const claudeDir = join(root, ".claude");
    const codexDir = join(root, ".codex");
    const modelsDir = join(root, ".cache", "conch", "models");
    const servicePlist = join(root, "com.conch.daemon.plist");
    const logs: string[] = [];
    try {
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(modelsDir, { recursive: true });
      writeFileSync(join(modelsDir, "model.bin"), "1234567890");
      writeFileSync(servicePlist, "plist");
      writeFileSync(
        join(claudeDir, "settings.json"),
        `${JSON.stringify({
          theme: "keep",
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: claudeCommand }] }],
          },
        })}\n`,
      );
      writeFileSync(
        join(codexDir, "hooks.json"),
        `${JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: codexCommand }] }],
          },
        })}\n`,
      );
      writeFileSync(
        join(claudeDir, "CLAUDE.md"),
        `before\n${begin}\nmanaged\n${end}\nafter\n`,
      );
      writeFileSync(
        join(codexDir, "AGENTS.md"),
        `${begin}\nmanaged\n${end}\n`,
      );

      const summary = await runUninstall(
        { claudeDir } as Config,
        {
          models: false,
          paths: {
            codexHooks: join(codexDir, "hooks.json"),
            codexInstructions: join(codexDir, "AGENTS.md"),
            servicePlist,
            modelsDir,
          },
          log: (message) => logs.push(message),
          error: (message) => logs.push(message),
        },
        {
          serviceOff: async () => rmSync(servicePlist),
          stopTmux: () => "removed",
          pluginOff: () => true,
        },
      );

      expect(summary.ok).toBe(true);
      expect(summary.claudeHooks).toBe(1);
      expect(summary.codexHooks).toBe(1);
      expect(JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")))
        .toEqual({ theme: "keep" });
      expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8"))
        .toBe("before\nafter\n");
      expect(directorySize(modelsDir)).toBe(10);
      expect(logs.join("\n")).toContain("Speech models: kept 10 B");
      expect(logs.join("\n")).toContain("conch uninstall --models");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deletes models only with --models", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-uninstall-models-"));
    const modelsDir = join(root, "models");
    try {
      mkdirSync(modelsDir);
      writeFileSync(join(modelsDir, "model.bin"), "1234");

      const summary = await runUninstall(
        { claudeDir: join(root, ".claude") } as Config,
        {
          models: true,
          paths: {
            codexHooks: join(root, ".codex", "hooks.json"),
            codexInstructions: join(root, ".codex", "AGENTS.md"),
            servicePlist: join(root, "missing.plist"),
            modelsDir,
          },
          log: () => {},
          error: () => {},
        },
        {
          serviceOff: async () => {},
          stopTmux: () => "absent",
          pluginOff: () => true,
        },
      );

      expect(summary.modelsRemovedBytes).toBe(4);
      expect(exists(modelsDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
