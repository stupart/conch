import { describe, expect, test } from "bun:test";
import {
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
  REVIEW_INSTRUCTIONS_BLOCK,
  runCodexInstall,
} from "../src/install.ts";

const command = '"/opt/homebrew/bin/bun" "/Users/example/conch/src/cli.ts" codex-hook';

describe("Codex hook installer settings", () => {
  test("builds all three Codex lifecycle command hooks", () => {
    const result = buildCodexHooksSettings({}, command);

    expect(result).toEqual({
      settings: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: 15,
                },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: 15,
                },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: 15,
                },
              ],
            },
          ],
        },
      },
      changed: true,
      addedEvents: ["Stop", "UserPromptSubmit", "SessionStart"],
    });
  });

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

  test("writes the flat Codex hooks path with backup, idempotence, and verification instructions", async () => {
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
    const logs: string[] = [];
    const originalLog = console.log;

    try {
      mkdirSync(join(codexDir, "hooks"), { recursive: true });
      writeFileSync(hooksPath, originalSettings);
      writeFileSync(obsoleteNestedPath, obsoleteNestedSettings);
      console.log = (...data: any[]) => {
        logs.push(data.map(String).join(" "));
      };

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
      expect(readFileSync(instructionsPath, "utf8"))
        .toBe(`${REVIEW_INSTRUCTIONS_BLOCK}\n`);

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
      expect(
        readdirSync(codexDir)
          .filter((name) => name.startsWith("AGENTS.md.conch-backup-")),
      ).toEqual([]);
      expect(readFileSync(instructionsPath, "utf8").split("<!-- conch:begin -->"))
        .toHaveLength(2);

      const output = logs.join("\n");
      expect(output).toContain(`AGENTS.md: conch review contract created -> ${instructionsPath}`);
      expect(output).toContain("AGENTS.md: conch review contract already wired, skipping");
      expect(output).toContain(`hooks file: ${hooksPath}`);
      expect(output).toContain(
        "The first `codex` run shows Codex's hook trust-review screen",
      );
      expect(output).toContain("the conch hooks must be approved there");
      expect(output).toContain(
        "run `conch sessions` and check that the Codex session is listed",
      );
    } finally {
      console.log = originalLog;
      rmSync(codexDir, { recursive: true, force: true });
    }
  });
});
