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

describe("scoping the uninstall to one agent", () => {
  test("--codex leaves Claude Code entirely alone", () => {
    // An integration can rot while the rest is healthy. Codex 0.144.1 does not
    // execute ~/.codex/hooks.json at all, so conch's Stop hook never fires and
    // no Codex session registers — while AGENTS.md still tells Codex to end
    // deliverables with `conch:review …`. Removing that side must not touch
    // Claude Code, which works.
    expect(parseUninstallArgs(["--codex"])).toEqual({ models: false, only: "codex" });
    expect(parseUninstallArgs(["--claude"])).toEqual({ models: false, only: "claude" });
    expect(parseUninstallArgs([])).toEqual({ models: false });
  });

  test("refuses to delete shared models under an agent scope", () => {
    // The speech models are shared by both agents and the terminal loop.
    // Deleting 1.6 GB while scoping to one agent is a surprise, not a shortcut.
    expect(() => parseUninstallArgs(["--codex", "--models"])).toThrow(/shared speech models/);
  });

  test("refuses an ambiguous scope", () => {
    expect(() => parseUninstallArgs(["--codex", "--claude"])).toThrow(/choose one/);
  });
});

describe("an agent scope never touches the install itself", () => {
  test("--codex leaves the service, tmux and models alone", async () => {
    // This is not hypothetical. `conch uninstall --codex` removed the Codex
    // hooks as asked and then deleted the launch agent and killed the daemon,
    // because the scope only guarded the hook and instruction loops. A flag
    // named for one integration took the whole install down on a live machine.
    let serviceOffCalled = false;
    let tmuxStopped = false;
    const summary = await runUninstall(
      { claudeDir: "/tmp/conch-scope-test/.claude" } as never,
      {
        models: false,
        only: "codex",
        log: () => {},
        error: () => {},
        paths: {
          claudeSettings: "/tmp/conch-scope-test/settings.json",
          claudeInstructions: "/tmp/conch-scope-test/CLAUDE.md",
          codexHooks: "/tmp/conch-scope-test/hooks.json",
          codexInstructions: "/tmp/conch-scope-test/AGENTS.md",
          servicePlist: "/tmp/conch-scope-test/com.conch.daemon.plist",
          modelsDir: "/tmp/conch-scope-test/models",
        },
      },
      {
        serviceOff: async () => { serviceOffCalled = true; },
        stopTmux: async () => { tmuxStopped = true; return "removed" as const; },
      },
    );
    expect(serviceOffCalled).toBeFalse();
    expect(tmuxStopped).toBeFalse();
    expect(summary.serviceRemoved).toBeFalse();
    expect(summary.modelsRemovedBytes).toBe(0);
  });
});
