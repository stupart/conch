import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexHooksSettings,
  codexHooksAreWired,
  runCodexInstall,
} from "../src/install.ts";

const command = '"/opt/homebrew/bin/bun" "/Users/example/conch/src/cli.ts" codex-hook';

describe("Codex hook installer settings", () => {
  test("preserves unrelated settings and hooks and is idempotent", () => {
    const existing = {
      model: "gpt-example",
      hooks: {
        Notification: [
          {
            matcher: "permission_prompt",
            hooks: [
              {
                type: "command",
                command: "/usr/local/bin/existing-hook",
                timeout: 7,
              },
            ],
          },
        ],
      },
    };

    const first = buildCodexHooksSettings(existing, command);

    expect(first.changed).toBe(true);
    expect(first.settings.model).toBe("gpt-example");
    expect(first.settings.hooks.Notification).toEqual(existing.hooks.Notification);

    const second = buildCodexHooksSettings(first.settings, command);

    expect(second.settings).toEqual(first.settings);
    expect(second.changed).toBe(false);
    expect(second.addedEvents).toEqual([]);
    expect(codexHooksAreWired(first.settings)).toBeTrue();
    expect(codexHooksAreWired(existing)).toBeFalse();
  });

  test("writes the flat Codex hooks path with one backup, idempotently", async () => {
    const codexDir = mkdtempSync(join(tmpdir(), "conch-codex-install-"));
    const hooksPath = join(codexDir, "hooks.json");
    const instructionsPath = join(codexDir, "AGENTS.md");
    const obsoleteNestedPath = join(codexDir, "hooks", "hooks.json");
    const originalSettings = JSON.stringify({
      model: "gpt-existing",
      hooks: {
        Notification: [
          {
            hooks: [
              {
                type: "command",
                command: "/usr/local/bin/existing-hook",
              },
            ],
          },
        ],
      },
    }, null, 2) + "\n";
    const obsoleteNestedSettings = '{"marker":"obsolete nested path"}\n';
    const originalLog = console.log;

    try {
      mkdirSync(join(codexDir, "hooks"), { recursive: true });
      writeFileSync(hooksPath, originalSettings);
      writeFileSync(obsoleteNestedPath, obsoleteNestedSettings);
      console.log = () => {};

      await runCodexInstall(codexDir);

      const installed = JSON.parse(readFileSync(hooksPath, "utf8"));
      expect(installed.model).toBe("gpt-existing");
      expect(installed.hooks.Notification[0].hooks[0].command).toBe(
        "/usr/local/bin/existing-hook",
      );
      for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
        expect(installed.hooks[event]).toHaveLength(1);
        expect(installed.hooks[event][0].hooks[0].command).toContain("codex-hook");
      }
      expect(readFileSync(obsoleteNestedPath, "utf8")).toBe(obsoleteNestedSettings);
      // Wiring Codex's hooks does not touch Codex's global AGENTS.md. This
      // used to assert conch had CREATED that file to hold its own review
      // contract; the contract now travels with the plugin instead.
      expect(existsSync(instructionsPath)).toBe(false);

      const backupsAfterFirstInstall = readdirSync(codexDir)
        .filter((name) => name.startsWith("hooks.json.conch-backup-"));
      expect(backupsAfterFirstInstall).toHaveLength(1);
      expect(readFileSync(join(codexDir, backupsAfterFirstInstall[0]!), "utf8"))
        .toBe(originalSettings);

      await runCodexInstall(codexDir);

      expect(
        readdirSync(codexDir)
          .filter((name) => name.startsWith("hooks.json.conch-backup-")),
      ).toEqual(backupsAfterFirstInstall);
    } finally {
      console.log = originalLog;
      rmSync(codexDir, { recursive: true, force: true });
    }
  });
});
