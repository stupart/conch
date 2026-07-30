import { describe, expect, test } from "bun:test";
import { buildCodexHooksSettings } from "../src/install.ts";

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
  });
});
